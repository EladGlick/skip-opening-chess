// How big should the opening handicap be? We start from a rule of thumb
// (about 1 pawn per 200 rating points) and learn from real results:
// if the lower-rated player keeps losing, the handicap grows; if they keep winning, it shrinks.

export const DEFAULT_K = 0.5;          // centipawns of advantage per rating point of gap
const MIN_K = 0.15, MAX_K = 1.2, STEP = 0.04, CAP = 450;
export const JITTER = 20;              // random extra edge of up to 0.2 pawn, to either player

// results: [{ gap, result, mode, date }]  gap = White rating − Black rating, result = White's score
export function learnK(results = []) {
  let k = DEFAULT_K, n = 0;
  const games = results.filter(r => r && Math.abs(r.gap) >= 50 && r.mode !== 'bot' && r.result != null)
    .sort((a, b) => (a.date || 0) - (b.date || 0));
  for (const r of games) {
    const lowerIsWhite = r.gap < 0;
    const lowerScore = lowerIsWhite ? r.result : 1 - r.result;
    // bigger gaps carry a bit more information about the slope
    const w = Math.min(1.5, Math.abs(r.gap) / 200);
    k = Math.max(MIN_K, Math.min(MAX_K, k + STEP * w * (0.5 - lowerScore)));
    n++;
  }
  return { k, n };
}

export function planHandicap({ whiteRating, blackRating, results = [], random = Math.random }) {
  const gap = whiteRating - blackRating;
  const { k, n } = learnK(results);
  const base = Math.abs(gap) < 50 ? 0 : Math.min(CAP, Math.round(Math.abs(gap) * k));
  const baseWhite = gap > 0 ? -base : base;                       // the lower-rated side gets it
  const jitter = Math.round((random() * 2 - 1) * JITTER);           // −0.2 … +0.2 for White
  const positional = random() < 0.5;                              // half the games: no material handed over
  return { gap, k, learnedFrom: n, base, baseWhite, jitter, targetWhite: baseWhite + jitter, positional };
}

// Plain words for an evaluation, from White's point of view.
export function edgeWords(cp) {
  const a = Math.abs(cp) / 100;
  if (a < 0.15) return 'dead equal';
  if (a < 0.35) return 'a tiny edge';
  if (a < 0.8) return 'a small edge';
  if (a < 1.5) return 'a clear edge';
  return 'a big edge';
}
