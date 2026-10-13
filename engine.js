// Opening simulator.
// Uses Stockfish (WASM, runs in a Web Worker in the browser) to score every legal
// move, then picks moves so the lower-rated player comes out of the opening ahead.
import { Chess } from './vendor/chess.js';

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

// How big an edge (centipawns) the lower-rated player gets out of the opening.
// ~1 pawn per 200 rating points, capped at 4 pawns. Gaps under 50 → fair opening.
export function targetAdvantage(gap) {
  const g = Math.abs(gap);
  if (g < 50) return 0;
  return Math.min(400, Math.round(g / 2));
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/**
 * Simulate the first `turns` full moves.
 * @returns {Promise<{moves:string[], fen:string, evalWhite:number, target:number, favored:'w'|'b'|null}>}
 */
export async function simulateOpening({ whiteRating, blackRating, turns, onMove }) {
  const sf = getEngine();
  const chess = new Chess();
  const gap = whiteRating - blackRating;          // > 0 → White is stronger
  const target = targetAdvantage(gap);
  const favored = target === 0 ? null : (gap > 0 ? 'b' : 'w');
  const totalPlies = turns * 2;
  const sans = [];

  for (let ply = 0; ply < totalPlies; ply++) {
    if (chess.isGameOver()) break;
    const side = chess.turn();
    const legal = chess.moves().length;
    const scored = await sf.analyse(chess.fen(), { multipv: Math.min(legal, 40), depth: 10 });
    const best = scored[0].score;
    // Never walk into a forced mate during the simulation.
    const pool = scored.filter(s => s.score > -MATE + 100);
    const options = pool.length ? pool : scored;
    let choice;

    if (!favored || side === favored) {
      // Play well, with some variety (wider in the first couple of moves).
      const window = ply < 4 ? 35 : 15;
      choice = pick(options.filter(s => best - s.score <= window));
    } else {
      // Concede a little each move so the favored side's edge drifts toward the target.
      // The very first moves stay natural when there is room to concede later.
      const natural = ply < 4 && totalPlies >= 8;
      if (natural) {
        choice = pick(options.filter(s => best - s.score <= 25));
      } else {
        const favoredEval = -best;
        const remaining = Math.max(1, Math.ceil((totalPlies - ply) / 2));
        const wantLoss = Math.min(150, Math.max(0, (target - favoredEval) / remaining));
        let bestFit = Infinity;
        for (const s of options) bestFit = Math.min(bestFit, Math.abs(best - s.score - wantLoss));
        choice = pick(options.filter(s => Math.abs(best - s.score - wantLoss) <= bestFit + 12));
      }
    }

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
