// Turns engine output into a short, plain-language explanation of a hint.
// Everything here is rule-based (no AI service): it looks at what the move does on
// the board, what the engine expects next, and how much better it is than the rest.
import { Chess } from './vendor/chess.js';

const MATE = 10000;
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const CENTER = new Set(['d4', 'e4', 'd5', 'e5']);
const article = w => (/^[aeiou]/.test(w) ? 'an ' : 'a ') + w;

const uciMove = u => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });

function materialOf(c, color) {
  let n = 0;
  for (const row of c.board()) for (const sq of row) if (sq && sq.color === color) n += VALUE[sq.type];
  return n;
}

// Pieces of `color` that are attacked and either undefended or attacked by something cheaper.
function hanging(c, color) {
  const opp = color === 'w' ? 'b' : 'w';
  const out = [];
  for (const row of c.board()) for (const sq of row) {
    if (!sq || sq.color !== color || sq.type === 'k') continue;
    const attackers = c.attackers(sq.square, opp);
    if (!attackers.length) continue;
    const defended = c.attackers(sq.square, color).length > 0;
    const cheapest = Math.min(...attackers.map(a => VALUE[c.get(a).type] || 0));
    if (!defended || cheapest < VALUE[sq.type]) out.push(sq);
  }
  return out;
}

// Play a UCI line on a copy; returns the SAN moves (stops at the first illegal move).
function playLine(fen, pv, max) {
  const c = new Chess(fen);
  const sans = [];
  for (const u of pv.slice(0, max)) {
    try { sans.push(c.move(uciMove(u)).san); } catch { break; }
  }
  return { c, sans };
}

function lineText(fen, sans) {
  const parts = fen.split(' ');
  let num = +parts[5];
  let white = parts[1] === 'w';
  const out = [];
  sans.forEach((s, i) => {
    if (white) out.push(`${num}.${s}`);
    else out.push(i === 0 ? `${num}…${s}` : s);
    if (!white) num++;
    white = !white;
  });
  return out.join(' ');
}

const pawns = cp => {
  const p = Math.abs(cp) / 100;
  return p < 0.95 ? `${p.toFixed(1)} of a pawn` : `${p.toFixed(1)} pawns`;
};

/**
 * @param {string} fen   position before the move (hint-taker to move)
 * @param {{lines: Array<{uci,score,pv}>, threat: ?{uci,score,pv,fen}}} analysis
 * @returns {{san:string, from:string, to:string, reasons:string[], line:string, verdict:string}}
 */
export function explainHint(fen, { lines, threat, follow }, voice = 'you') {
  // voice 'you': the hint-taker's move. voice 'they': the opponent's move, told to you.
  const T = voice === 'they'
    ? { you: 'they', your: 'their', Your: 'Their', They: 'You', their: 'your', opp: 'you', oppS: 'your', has: 'have' }
    : { you: 'you', your: 'your', Your: 'Your', They: 'They', their: 'their', opp: 'your opponent', oppS: 'your opponent’s', has: 'has' };
  const best = lines[0];
  const me = fen.split(' ')[1];
  const opp = me === 'w' ? 'b' : 'w';
  const before = new Chess(fen);
  const moving = before.get(best.uci.slice(0, 2));
  const after = new Chess(fen);
  const m = after.move(uciMove(best.uci));
  const reasons = [];
  const add = r => { if (r && reasons.length < 3 && !reasons.includes(r)) reasons.push(r); };

  // 1. Forced mate
  if (best.score > MATE - 200) {
    const n = MATE - best.score;            // moves until mate, counting this one
    add(n <= 1 ? 'It’s checkmate!' : `It starts a forced checkmate in ${n} moves.`);
  }

  // 2. Material won along the main line (let the exchanges finish)
  // Measure at a "quiet" point: after our ply pair, where the next engine move is not a capture
  // (otherwise we'd count half of an exchange that is still going on).
  let quiet = 0;
  {
    const { c: walk } = playLine(fen, [], 0);
    for (let i = 0; i < Math.min(best.pv.length, 8); i++) {
      let mv;
      try { mv = walk.move(uciMove(best.pv[i])); } catch { break; }
      if ((i + 1) % 2 === 0) {
        const next = best.pv[i + 1];
        const nextCaptures = next ? !!walk.get(next.slice(2, 4)) : false;
        if (!nextCaptures) quiet = i + 1;
      }
    }
  }
  if (quiet >= 2) {
    const { c: end } = playLine(fen, best.pv, quiet);
    const balance = materialOf(before, me) - materialOf(before, opp);
    let gain = (materialOf(end, me) - materialOf(end, opp)) - balance;
    // Only claim it if the engine's eval agrees the extra material is real (not won back later).
    if (best.score < 100 * (balance + gain) - 60) gain = 0;
    if (gain >= 2) {
      const what = gain >= 8 ? 'a queen' : gain >= 5 ? 'a rook' : gain >= 3 ? 'a piece' : `${gain} pawns`;
      add(`It wins material: after the exchanges ${T.you} gain about ${what}.`);
    } else if (gain === 1) add('It wins a pawn.');
  }

  // 2b. What it threatens next (our best move if the opponent could pass)
  if (follow?.uci && !after.isCheckmate()) {
    const fc = new Chess(follow.fen);
    let fm = null;
    try { fm = fc.move(uciMove(follow.uci)); } catch { /* ignore */ }
    if (fm) {
      if (fc.isCheckmate() || follow.score > MATE - 200) add(`It threatens ${fm.san}${fc.isCheckmate() ? ' — checkmate' : ', leading to checkmate'}!`);
      else if (fm.captured && follow.score - best.score > 150) add(`It threatens ${fm.san}, winning the ${NAME[fm.captured]}.`);
    }
  }

  // 3. What the move itself does
  if (/[kq]/.test(m.flags)) {
    add(`Castling tucks ${T.your} king into safety and brings the rook into the game.`);
  }
  if (m.captured && !reasons.some(r => r.includes('material'))) {
    const giveBack = after.attackers(m.to, opp).length > 0 && VALUE[moving.type] > VALUE[m.captured];
    add(giveBack
      ? `It takes the ${NAME[m.captured]} on ${m.to}. ${T.They} can take ${T.your} ${NAME[moving.type]}, but what follows makes it worth it.`
      : `It captures the ${NAME[m.captured]} on ${m.to}.`);
  }
  if (m.promotion) add(`The pawn promotes to ${article(NAME[m.promotion])}.`);
  if (after.isCheckmate()) add('It’s checkmate!');
  else if (after.inCheck()) add(`It comes with check, so ${T.opp} ${T.has} to react.`);

  // 4. Saving a piece that was in danger
  const danger = hanging(before, me);
  if (danger.length) {
    const nowSafe = danger.filter(p => !hanging(after, me).some(q => q.square === (p.square === m.from ? m.to : p.square)));
    const big = nowSafe.sort((a, b) => VALUE[b.type] - VALUE[a.type])[0];
    if (big) add(big.square === m.from
      ? `${T.Your} ${NAME[big.type]} on ${big.square} was under attack — this moves it to safety.`
      : `It protects ${T.your} ${NAME[big.type]} on ${big.square}, which was under attack.`);
  }

  // 5. Stopping the opponent's threat (what they'd do if it were their move)
  if (threat && threat.pv?.length && reasons.length < 3 && !after.isCheckmate()) {
    const tc = new Chess(threat.fen);
    let tm = null;
    try { tm = tc.move(uciMove(threat.uci)); } catch { /* ignore */ }
    const threatGain = threat.score + best.score; // how much better their position would be than after our move
    const real = tm && (tm.captured || tc.isCheckmate() || tc.inCheck());
    if (real && threatGain > 150 && tm.to !== m.to) {
      const what = tc.isCheckmate() ? `checkmate with ${tm.san}`
        : tm.captured ? `${tm.san}, taking ${T.your} ${NAME[tm.captured]}` : `${tm.san} (a dangerous check)`;
      add(`It stops ${T.oppS} threat of ${what}.`);
    }
  }

  // 6. New attacks created by the moved piece
  if (reasons.length < 3 && !after.isCheckmate()) {
    const targets = [];
    for (const row of after.board()) for (const sq of row) {
      if (!sq || sq.color !== opp) continue;
      const atk = after.attackers(sq.square, me);
      if (!atk.includes(m.to)) continue;
      const defended = after.attackers(sq.square, opp).length > 0;
      if (sq.type === 'k' || !defended || VALUE[sq.type] > VALUE[moving.type]) targets.push(sq);
    }
    const named = targets.filter(t => t.type !== 'k');
    if (targets.length >= 2) add(`Fork! ${T.Your} ${NAME[moving.type]} attacks ${targets.length} things at once (${targets.map(t => t.type === 'k' ? 'the king' : `the ${NAME[t.type]}`).join(' and ')}).`);
    else if (named.length === 1) add(`It attacks the ${NAME[named[0].type]} on ${named[0].square}.`);
  }

  // 7. Opening principles (early in the game)
  const moveNo = +fen.split(' ')[5];
  if (reasons.length < 2 && moveNo <= 15) {
    const backRank = me === 'w' ? '1' : '8';
    if ((moving.type === 'n' || moving.type === 'b') && m.from[1] === backRank) add(`It develops ${T.your} ${NAME[moving.type]} so it joins the fight.`);
    else if (moving.type === 'p' && !m.captured && CENTER.has(m.to)) add('It grabs space in the center of the board.');
  }

  // 8. The plan: the engine's expected continuation
  const { sans } = playLine(fen, best.pv, 4);
  const line = sans.length > 1 ? lineText(fen, sans) : '';
  if (reasons.length < 3 && sans.length >= 3) add(`It prepares ${sans[2]} as ${T.your} next move.`);
  if (!reasons.length) add(`It improves ${T.your} position more than any other move, even if there’s no immediate tactic.`);

  // Verdict: how good, and how unique
  let verdict;
  if (best.score > MATE - 200) verdict = 'Winning by force.';
  else {
    const ev = best.score;
    verdict = Math.abs(ev) < 40 ? 'After it, the position is about equal.'
      : ev > 0 ? `After it, you’re ahead by about ${pawns(ev)}.` : `You’re behind by about ${pawns(ev)}, but this is your best try.`;
    const second = lines[1];
    if (second) {
      const gap = best.score - second.score;
      const altSan = (() => { try { return new Chess(fen).move(uciMove(second.uci)).san; } catch { return null; } })();
      if (gap >= 150) verdict += ' It’s much stronger than anything else here.';
      else if (gap < 30 && altSan) verdict += ` ${altSan} is about as good.`;
    }
  }

  return { san: m.san, from: m.from, to: m.to, reasons, line, verdict };
}
