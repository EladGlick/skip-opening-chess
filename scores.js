// Friends scoreboard: a "Skip rating" for everyone who played online, built from all saved results.
// Everyone starts from the rating they entered in their first game. After each game:
//   - with a handicap (the opening was tilted toward the weaker player) the game should be
//     about 50/50, so a win moves you up and a loss moves you down;
//   - without a handicap, the normal chess (Elo) expectation is used.
const K = 32;

export function skipRatings(results = []) {
  const players = new Map();
  const games = results
    .filter(r => r && r.mode === 'online' && r.white?.uid && r.black?.uid && r.result != null)
    .sort((a, b) => (a.date || 0) - (b.date || 0));
  const get = side => {
    let p = players.get(side.uid);
    if (!p) {
      p = { uid: side.uid, name: side.name, start: side.rating, rating: side.rating, games: 0, w: 0, d: 0, l: 0, last: 0, change: 0 };
      players.set(side.uid, p);
    }
    p.name = side.name || p.name;
    return p;
  };
  for (const r of games) {
    const W = get(r.white), B = get(r.black);
    const handicapped = (r.turns || 0) > 0 && Math.abs(r.gap || 0) >= 50;
    const expected = handicapped ? 0.5 : 1 / (1 + 10 ** ((B.rating - W.rating) / 400));
    const delta = K * (r.result - expected);
    W.rating += delta; B.rating -= delta;
    W.change = delta; B.change = -delta;
    W.games++; B.games++;
    W.last = B.last = r.date || 0;
    if (r.result === 1) { W.w++; B.l++; } else if (r.result === 0) { W.l++; B.w++; } else { W.d++; B.d++; }
  }
  for (const p of players.values()) { p.rating = Math.round(p.rating); p.change = Math.round(p.change); }
  return players;
}

/** Your record against each opponent. */
export function headToHead(results, uid) {
  const opp = new Map();
  for (const r of results) {
    if (!r || r.mode !== 'online' || r.result == null) continue;
    const meWhite = r.white?.uid === uid, meBlack = r.black?.uid === uid;
    if (!meWhite && !meBlack) continue;
    const o = meWhite ? r.black : r.white;
    if (!o?.uid) continue;
    const score = meWhite ? r.result : 1 - r.result;
    const e = opp.get(o.uid) || { uid: o.uid, name: o.name, games: 0, w: 0, d: 0, l: 0 };
    e.name = o.name || e.name;
    e.games++;
    if (score === 1) e.w++; else if (score === 0) e.l++; else e.d++;
    opp.set(o.uid, e);
  }
  return [...opp.values()].sort((a, b) => b.games - a.games);
}

/** Games you took part in (any mode), newest first. */
export function myGames(results, uid) {
  return results
    .filter(r => r && (r.owner === uid || r.white?.uid === uid || r.black?.uid === uid))
    .sort((a, b) => (b.date || 0) - (a.date || 0));
}
