// After-game review: every move you played is checked by the engine and labelled the way
// chess.com does it (Brilliant, Great, Best, Excellent, Good, Inaccuracy, Mistake, Miss,
// Blunder), with a short plain-language explanation of why.
import { Chess } from './vendor/chess.js';
import { getEngine } from './engine.js';
import { explainHint } from './explain.js';

const MATE = 10000;
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const CLASSES = {
  brilliant:  { label: 'Brilliant',  sym: '!!', color: '#1baca6' },
  great:      { label: 'Great',      sym: '!',  color: '#5c8bb0' },
  best:       { label: 'Best',       sym: '★',  color: '#81b64c' },
  excellent:  { label: 'Excellent',  sym: '👍', color: '#96bc4b' },
  good:       { label: 'Good',       sym: '✓',  color: '#95af8a' },
  forced:     { label: 'Forced',     sym: '□',  color: '#97a0aa' },
  inaccuracy: { label: 'Inaccuracy', sym: '?!', color: '#f0c15c' },
  mistake:    { label: 'Mistake',    sym: '?',  color: '#e69f50' },
  miss:       { label: 'Miss',       sym: '✕',  color: '#ee6b55' },
  blunder:    { label: 'Blunder',    sym: '??', color: '#e0402e' },
};
export const SUMMARY_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'miss', 'blunder'];
export const KEY_CLASSES = new Set(['brilliant', 'great', 'mistake', 'miss', 'blunder']);

// Win probability (0..1) from a centipawn score, same curve Lichess uses.
export const winProb = cp => 1 / (1 + Math.exp(-0.00368208 * Math.max(-MATE, Math.min(MATE, cp))));

const uciMove = u => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
const lower = s => (s ? s[0].toLowerCase() + s.slice(1) : s);

function feel(wp) {
  if (wp >= 0.97) return 'winning';
  if (wp >= 0.8) return 'much better';
  if (wp >= 0.62) return 'better';
  if (wp >= 0.38) return 'about equal';
  if (wp >= 0.2) return 'worse';
  if (wp >= 0.03) return 'much worse';
  return 'lost';
}

// Did the move leave a piece (worth 3+) where the opponent can win it?  → a sacrifice.
function offersMaterial(before, after, move, color) {
  const opp = color === 'w' ? 'b' : 'w';
  const capturedValue = move.captured ? VALUE[move.captured] : 0;
  for (const row of after.board()) for (const sq of row) {
    if (!sq || sq.color !== color || sq.type === 'k' || VALUE[sq.type] < 3) continue;
    const attackers = after.attackers(sq.square, opp);
    if (!attackers.length) continue;
    const defended = after.attackers(sq.square, color).length > 0;
    const cheapest = Math.min(...attackers.map(a => VALUE[after.get(a).type] || 0));
    const enPrise = !defended || cheapest < VALUE[sq.type];
    if (!enPrise) continue;
    // ignore plain trades: capturing something at least as valuable isn't a sacrifice
    if (sq.square === move.to && capturedValue >= VALUE[sq.type]) continue;
    // was this piece already hanging before the move? then it's not a new offer
    const origin = sq.square === move.to ? move.from : sq.square;
    const prev = before.get(origin);
    if (prev && sq.square !== move.to) {
      const a0 = before.attackers(origin, opp);
      if (a0.length && (!before.attackers(origin, color).length || Math.min(...a0.map(a => VALUE[before.get(a).type] || 0)) < VALUE[prev.type])) continue;
    }
    return sq;
  }
  return null;
}

/**
 * Analyse a finished game.
 * @param {string[]} moves     SAN moves of the whole game
 * @param {number} from        first ply to judge (the engine-played opening is skipped)
 * @param {object} opts        { depth, viewer: 'w'|'b'|null, names: {w,b}, onProgress(done,total), isCancelled() }
 * @returns {Promise<{plies: Array, evals: number[], accuracy: {w,b}, counts: {w,b}}>}
 */
export async function analyseGame(moves, from, opts = {}) {
  const depth = opts.depth || 15;
  const sf = getEngine();
  await sf.ready;
  sf.send('ucinewgame');           // forget earlier searches so results don't depend on history
  await sf.isReady();
  const c = new Chess();
  const fens = [c.fen()];
  const uci = [];
  for (const san of moves) {
    const m = c.move(san);
    uci.push(m.from + m.to + (m.promotion || ''));
    fens.push(c.fen());
  }
  const N = moves.length;

  // 1. Engine eval of every position from `from` to the end (side-to-move's view).
  const A = [];
  const total = N - from + 1;
  for (let k = from; k <= N; k++) {
    if (opts.isCancelled?.()) return null;
    const pos = new Chess(fens[k]);
    if (pos.isCheckmate()) A[k] = { lines: [{ uci: null, score: -MATE, pv: [] }], over: 'mate' };
    else if (pos.isGameOver()) A[k] = { lines: [{ uci: null, score: 0, pv: [] }], over: 'draw' };
    else A[k] = { lines: await sf.analyse(fens[k], { multipv: k < N ? 2 : 1, depth }), legal: pos.moves().length };
    opts.onProgress?.(k - from + 1, total);
  }

  // Eval graph, White's point of view, in centipawns (clamped).
  const evals = [];
  for (let k = from; k <= N; k++) {
    const s = A[k].lines[0].score;
    const white = fens[k].split(' ')[1] === 'w' ? s : -s;
    evals.push(Math.max(-1000, Math.min(1000, white)));
  }

  // 2. Judge each move.
  const plies = [];
  for (let i = from; i < N; i++) {
    const mover = fens[i].split(' ')[1];
    const best = A[i].lines[0];
    const second = A[i].lines[1];
    const sBest = best.score;
    const played = uci[i];
    const isBest = played === best.uci;
    // What the move really led to: the engine's view of the next position (searched on its own,
    // so it catches refutations the first search missed).
    let sPlayed = -A[i + 1].lines[0].score;
    if (sPlayed > MATE - 200) sPlayed -= 1;   // mate distance counted from before this move
    let sRef = sBest;
    if (isBest) {
      // judged against the alternative if the "best" move turned out worse than it looked
      sRef = Math.max(sPlayed, second ? second.score : sPlayed);
      if (sPlayed > sBest) sPlayed = Math.max(sPlayed, sBest);
    }
    const wpBest = winProb(sRef), wpPlayed = winProb(sPlayed);
    const loss = Math.max(0, wpBest - wpPlayed);

    const before = new Chess(fens[i]);
    const after = new Chess(fens[i + 1]);
    const move = new Chess(fens[i]).move(moves[i]);

    let cls;
    if (A[i].legal === 1) cls = 'forced';
    else if ((isBest && loss < 0.02) || loss <= 0.005) cls = 'best';
    else if (loss < 0.02) cls = 'excellent';
    else if (loss < 0.05) cls = 'good';
    else if (loss < 0.1) cls = 'inaccuracy';
    else if (loss < 0.2) cls = 'mistake';
    else cls = 'blunder';

    // Already completely won (or lost): don't punish moves that keep it that way.
    if (['inaccuracy', 'mistake', 'blunder'].includes(cls)) {
      if (wpBest > 0.97 && wpPlayed > 0.93) cls = 'good';
      else if (wpBest < 0.05 && wpPlayed < 0.05) cls = 'good';
    }
    // Walking into a forced mate is always a blunder, even in a bad position.
    if (sPlayed < -(MATE - 200) && sRef > -(MATE - 200) && A[i].legal > 1) cls = 'blunder';
    // Great: the only good move in a position that mattered.
    if ((cls === 'best' || cls === 'excellent') && second && wpBest < 0.97 && wpPlayed > 0.25
        && winProb(sPlayed) - winProb(second.score) >= 0.15) cls = 'great';
    // Brilliant: a good sacrifice, when the game isn't already over.
    let sac = null;
    if (['best', 'excellent', 'great'].includes(cls) && wpPlayed >= 0.45) {
      sac = after.isCheckmate() ? null : offersMaterial(before, after, move, mover);
      // when already winning, only a big sacrifice (rook or queen) is worth the label
      if (sac && (wpBest < 0.97 || VALUE[sac.type] >= 5)) cls = 'brilliant';
      else sac = null;
    }
    // Miss: the opponent just made a real mistake and this move doesn't punish it.
    const prev = plies[plies.length - 1];
    if (prev && ['mistake', 'blunder', 'miss'].includes(prev.cls) && ['inaccuracy', 'mistake'].includes(cls)) cls = 'miss';

    plies.push({
      ply: i, color: mover, san: moves[i], uci: played,
      from: move.from, to: move.to,
      bestUci: best.uci, bestSan: best.uci ? new Chess(fens[i]).move(uciMove(best.uci)).san : null,
      sBest, sPlayed, wpBest, wpPlayed, loss, cls, sac: sac ? { type: sac.type, square: sac.square } : null,
      accuracy: Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss * 100) - 3.1669)),
    });
  }

  // 3. Plain-language text for each move.
  for (const p of plies) p.text = describe(p, fens, A, opts);

  const accuracy = {}, counts = {};
  for (const col of ['w', 'b']) {
    const mine = plies.filter(p => p.color === col && p.cls !== 'forced');
    accuracy[col] = mine.length ? mine.reduce((a, p) => a + p.accuracy, 0) / mine.length : null;
    counts[col] = Object.fromEntries(SUMMARY_ORDER.map(k => [k, plies.filter(p => p.color === col && p.cls === k).length]));
  }
  return { plies, evals, accuracy, counts, from };
}

function describe(p, fens, A, opts) {
  const i = p.ply;
  const viewer = opts.viewer || p.color;               // shared screen: talk to whoever moved
  const mine = p.color === viewer;
  const voiceMover = mine ? 'you' : 'they';
  const voiceOther = mine ? 'they' : 'you';
  const name = opts.names?.[p.color];
  const subj = mine ? 'You' : (name || 'Your opponent');
  const pos = mine ? 'your' : 'their';
  const out = [];

  const playedLine = { uci: p.uci, score: p.sPlayed, pv: [p.uci, ...(A[i + 1].lines[0].pv || [])] };
  const why = (fen, lines, voice) => {
    try { return explainHint(fen, { lines }, voice).reasons; } catch { return []; }
  };

  switch (p.cls) {
    case 'brilliant': {
      const sac = p.sac ? `${mine ? 'You' : subj} offered ${mine ? 'your' : 'their'} ${({ n: 'knight', b: 'bishop', r: 'rook', q: 'queen' })[p.sac.type] || 'piece'} on ${p.sac.square}` : 'A daring sacrifice';
      out.push(`${sac} — and it works.`);
      const r = why(fens[i], [playedLine], voiceMover);
      if (r[0]) out.push(r[0]);
      out.push(`Taking it would cost ${mine ? 'your opponent' : 'you'} more than the material is worth.`);
      break;
    }
    case 'great': {
      out.push(`The only good move here — everything else would have let ${mine ? 'your' : 'the'} advantage slip.`);
      for (const r of why(fens[i], [playedLine], voiceMover).slice(0, 2)) out.push(r);
      break;
    }
    case 'best':
    case 'excellent': {
      out.push(p.cls === 'best' ? 'Exactly what the engine would play.' : `Almost as good as the engine’s choice (${p.bestSan}).`);
      const r = why(fens[i], [playedLine], voiceMover);
      if (r[0]) out.push(r[0]);
      break;
    }
    case 'forced':
      out.push('The only legal move.');
      break;
    case 'good': {
      out.push(`A solid move, but ${p.bestSan} was a little stronger.`);
      const r = why(fens[i], A[i].lines, voiceMover);
      if (r[0]) out.push(`${p.bestSan}: ${lower(r[0])}`);
      break;
    }
    default: { // inaccuracy, mistake, miss, blunder
      if (p.cls === 'miss') out.push(`${mine ? 'Your opponent' : 'You'} had just slipped, and this move doesn’t take advantage of it.`);
      // what goes wrong: the opponent's best reply
      const reply = A[i + 1].lines[0];
      if (reply?.uci) {
        let replySan = null;
        try { replySan = new Chess(fens[i + 1]).move(uciMove(reply.uci)).san; } catch { /* ignore */ }
        const r = why(fens[i + 1], A[i + 1].lines, voiceOther);
        if (replySan) out.push(`This lets ${mine ? 'your opponent' : 'you'} play ${replySan}${r[0] ? ` — ${lower(r[0])}` : '.'}`);
      }
      // what was better
      if (p.bestSan) {
        const r = why(fens[i], A[i].lines, voiceMover);
        out.push(`Better was ${p.bestSan}${r[0] ? `: ${lower(r[0])}` : '.'}`);
      }
      const a = feel(p.wpBest), b = feel(p.wpPlayed);
      if (a !== b) out.push(`${mine ? 'Your' : (name ? `${name}’s` : 'Their')} position went from ${a} to ${b}.`);
      break;
    }
  }
  return out;
}

// PGN of the whole game (for copying / Lichess).
export function toPgn(moves, { white = 'White', black = 'Black', result = '*' } = {}) {
  const head = `[Event "Skip Opening Chess"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n`;
  const body = moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + m).join(' ');
  return head + body + ' ' + result;
}
export const lichessPgnUrl = moves =>
  'https://lichess.org/analysis/pgn/' + encodeURIComponent(moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + m).join(' '));
