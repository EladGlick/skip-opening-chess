// Opening simulator.
// Uses Stockfish (WASM, runs in a Web Worker in the browser) to score every legal
// move, then picks moves so the lower-rated player comes out of the opening ahead.
import { Chess } from './vendor/chess.js';
import { loadOpenings, bookCount } from './openings.js';

const ENGINE_URL = new URL('./vendor/stockfish/stockfish-18-lite-single.js', import.meta.url);
const MATE = 10000;

class Stockfish {
  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.listeners = new Set();
    this.worker.onmessage = e => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      for (const l of [...this.listeners]) l(line);
    };
    this.ready = this.cmd('uci', l => l === 'uciok').then(() => this.isReady());
  }
  send(s) { this.worker.postMessage(s); }
  // Send a command and resolve when a line satisfies `until`. Collects all lines.
  cmd(s, until) {
    return new Promise(resolve => {
      const lines = [];
      const fn = l => {
        lines.push(l);
        if (until(l)) { this.listeners.delete(fn); resolve(lines); }
      };
      this.listeners.add(fn);
      this.send(s);
    });
  }
  isReady() { return this.cmd('isready', l => l === 'readyok'); }

  // Returns [{uci, score}] best first; score in centipawns for the side to move.
  async analyse(fen, { multipv = 1, depth = 10 } = {}) {
    await this.ready;
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${fen}`);
    await this.isReady();
    const lines = await this.cmd(`go depth ${depth}`, l => l.startsWith('bestmove'));
    const byPv = new Map();
    for (const l of lines) {
      if (!l.startsWith('info') || !l.includes(' pv ')) continue;
      const t = l.split(' ');
      const get = k => t[t.indexOf(k) + 1];
      const pvIdx = t.includes('multipv') ? +get('multipv') : 1;
      const si = t.indexOf('score');
      let score = +t[si + 2];
      if (t[si + 1] === 'mate') score = score > 0 ? MATE - score : -MATE - score;
      const uci = t[t.indexOf('pv') + 1];
      byPv.set(pvIdx, { uci, score }); // later (deeper) lines overwrite earlier ones
    }
    return [...byPv.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }
  terminate() { this.worker.terminate(); }
}

let engine = null;
export function getEngine() {
  if (!engine) engine = new Stockfish();
  return engine;
}

// A second engine instance plays as the computer opponent (its strength settings
// must not leak into the opening simulator).
let botEngine = null;
export function getBotEngine() {
  if (!botEngine) botEngine = new Stockfish();
  return botEngine;
}

/**
 * Choose a move for the computer opponent.
 * @param {string} fen
 * @param {number} elo  400 … 2800
 * @param {number} movetime  ms to think (strong levels)
 * @returns {Promise<{from:string,to:string,promotion?:string}>}
 */
export async function botMove(fen, elo, movetime = 800) {
  const sf = getBotEngine();
  await sf.ready;
  let uci;
  if (elo >= 1400) {
    // Stockfish's own strength limiter (valid from ~1320 Elo).
    sf.send('setoption name MultiPV value 1');
    sf.send('setoption name UCI_LimitStrength value true');
    sf.send(`setoption name UCI_Elo value ${Math.min(3190, Math.round(elo))}`);
    sf.send(`position fen ${fen}`);
    await sf.isReady();
    const lines = await sf.cmd(`go movetime ${movetime}`, l => l.startsWith('bestmove'));
    uci = lines[lines.length - 1].split(' ')[1];
  } else {
    // Weaker levels: look at several candidate moves and pick one at random,
    // with more randomness (bigger mistakes) the lower the rating.
    sf.send('setoption name UCI_LimitStrength value false');
    const depth = elo < 800 ? 4 : 7;
    const scored = await sf.analyse(fen, { multipv: 8, depth });
    const temp = Math.max(25, (1450 - elo) / 3.2);      // cp
    const best = scored[0].score;
    const weights = scored.map(s => Math.exp((s.score - best) / temp));
    uci = weightedPick(scored, weights).uci;
  }
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

/** Engine evaluation (centipawns, side to move's point of view). */
export async function quickEval(fen, depth = 11) {
  const sf = getBotEngine();
  sf.send('setoption name UCI_LimitStrength value false');
  const [top] = await sf.analyse(fen, { multipv: 1, depth });
  return top ? top.score : 0;
}

// How big an edge (centipawns) the lower-rated player gets out of the opening.
// ~1 pawn per 200 rating points, capped at 4 pawns. Gaps under 50 → fair opening.
export function targetAdvantage(gap) {
  const g = Math.abs(gap);
  if (g < 50) return 0;
  return Math.min(400, Math.round(g / 2));
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

/**
 * Simulate the first `turns` full moves.
 * @param {object} o
 * @param {number} o.style   0 = classic book openings … 100 = crazy, unusual openings
 * @param {string[]} [o.avoid]  recent openings (space-joined SAN prefixes) not to repeat
 * @returns {Promise<{moves:string[], fen:string, evalWhite:number, target:number, favored:'w'|'b'|null}>}
 */
export async function simulateOpening({ whiteRating, blackRating, turns, style = 30, avoid = [], onMove }) {
  const sf = getEngine();
  await loadOpenings();
  const chess = new Chess();
  const gap = whiteRating - blackRating;          // > 0 → White is stronger
  const target = targetAdvantage(gap);
  const favored = target === 0 ? null : (gap > 0 ? 'b' : 'w');
  const totalPlies = turns * 2;
  const s = Math.max(0, Math.min(100, style)) / 100;
  const avoidSet = new Set(avoid);
  const sans = [];

  for (let ply = 0; ply < totalPlies; ply++) {
    if (chess.isGameOver()) break;
    const side = chess.turn();
    const legal = chess.moves().length;
    const scored = await sf.analyse(chess.fen(), { multipv: Math.min(legal, 40), depth: 10 });
    const best = scored[0].score;
    // Never walk into a forced mate during the simulation.
    const safe = scored.filter(m => m.score > -MATE + 100);
    const options = safe.length ? safe : scored;

    // How much may this side give away (in cp) to land on the handicap target?
    const sideTarget = !favored ? 0 : side === favored ? target : -target;
    const remaining = Math.max(1, Math.ceil((totalPlies - ply) / 2));
    const nearEnd = remaining <= 1;
    const natural = ply < 4 && totalPlies >= 8;          // first moves: no handicap concessions
    const budget = natural ? 0 : Math.max(0, best - sideTarget);
    const desired = Math.min(180, budget / remaining);

    // Style: a "free" variety allowance on top of the handicap; shrinks to 0 on the last move.
    // A side that is behind its handicap target plays the crazy stuff more carefully.
    const ahead = Math.max(0.25, Math.min(1, 1 + (best - sideTarget) / 200));
    const center = desired + (nearEnd ? 0 : s * s * 55 * ahead);
    const sigma = nearEnd ? 12 : 12 + Math.pow(s, 1.5) * 45;
    const maxLoss = Math.min(220, center + 2 * sigma + 10);

    const cands = [];
    for (const m of options) {
      const loss = best - m.score;
      if (loss > maxLoss) continue;
      const u = m.uci;
      const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      const count = bookCount([...sans, mv.san]);
      chess.undo();
      const kingWalk = mv.piece === 'k' && !mv.flags.includes('k') && !mv.flags.includes('q');
      cands.push({ ...m, san: mv.san, loss, book: count > 0, pop: Math.log2(1 + count), kingWalk, earlyQueen: mv.piece === 'q' && ply < 12 && !mv.captured });
    }
    if (!cands.length) cands.push({ ...options[0], loss: 0, book: false, pop: 0, kingWalk: false, san: null });

    // Classic games stick to known theory when possible.
    let pool = cands;
    if (s < 0.25) {
      const bookOnes = cands.filter(c => c.book && c.loss <= center + sigma + 10);
      if (bookOnes.length) pool = bookOnes;
    }
    // Don't recreate the start of a recent game.
    if (ply === 3 || ply === 7) {
      const fresh = pool.filter(c => !avoidSet.has([...sans, c.san].join(' ')));
      if (fresh.length) pool = fresh;
    }
    const weights = pool.map(c => {
      let w = Math.exp(-((c.loss - center) ** 2) / (2 * sigma * sigma)) + 1e-6;
      if (s < 0.6) w *= Math.exp(c.pop * (0.6 - s) * 1.2);    // classic: favour popular theory
      else w *= 1 + (s - 0.6) * 12 / (1 + c.pop);             // crazy: favour rare / unknown moves
      if (c.kingWalk && s < 0.9) w *= 0.1;                    // king walks look silly
      if (c.earlyQueen && s < 0.5) w *= 0.3;                  // so do early queen trips
      return w;
    });
    const choice = weightedPick(pool, weights);

    const u = choice.uci;
    const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    sans.push(mv.san);
    if (onMove) onMove({ ply, san: mv.san, fen: chess.fen(), total: totalPlies });
  }

  let evalWhite = 0;
  if (!chess.isGameOver()) {
    const [top] = await sf.analyse(chess.fen(), { multipv: 1, depth: 12 });
    evalWhite = chess.turn() === 'w' ? top.score : -top.score;
  }
  return { moves: sans, fen: chess.fen(), evalWhite, target, favored };
}
