// Opening names (Lichess chess-openings dataset, CC0) + short explanations.

// The dataset is loaded straight from the Lichess repo, pinned to a fixed commit.
const DATA = 'https://raw.githubusercontent.com/lichess-org/chess-openings/a6189a30dc273ccb21fc2536a9a2fefd5592a67a/';

let DB = null;
let loading = null;
export function loadOpenings() {
  if (DB) return Promise.resolve(DB);
  if (!loading) {
    loading = Promise.all('abcde'.split('').map(x => fetch(DATA + x + '.tsv').then(r => r.ok ? r.text() : '')))
      .then(parts => {
        const named = new Map();  // "e4 c5 Nf3" → [eco, name]
        const count = new Map();  // move-sequence prefix → number of named lines through it
        for (const text of parts) {
          for (const line of text.split('\n').slice(1)) {
            const [eco, name, pgn] = line.split('\t');
            if (!pgn) continue;
            const sans = pgn.replace(/\d+\.+/g, ' ').trim().split(/\s+/);
            const key = sans.join(' ');
            if (!named.has(key) || named.get(key)[1].length > name.length) named.set(key, [eco, name]);
            for (let i = 1; i <= sans.length; i++) {
              const k = sans.slice(0, i).join(' ');
              count.set(k, (count.get(k) || 0) + 1);
            }
          }
        }
        DB = { named, count };
        return DB;
      })
      .catch(() => { DB = { named: new Map(), count: new Map() }; return DB; });
  }
  return loading;
}

// How many named lines continue through this exact move sequence (a rough popularity measure).
export const bookCount = sans => (DB && DB.count.get(sans.join(' '))) || 0;

/** Identify the opening reached by a list of SAN moves. */
export function identify(moves) {
  if (!DB) return null;
  let found = null, bookPly = 0;
  for (let i = 1; i <= moves.length; i++) {
    const k = moves.slice(0, i).join(' ');
    if (DB.count.has(k)) bookPly = i; else break;
    const n = DB.named.get(k);
    if (n) found = { eco: n[0], name: n[1], ply: i };
  }
  if (!found) return { eco: '—', name: 'Uncharted opening', family: null, ply: 0, bookPly, moves };
  const family = found.name.split(/[:,]/)[0].trim();
  return { ...found, family, bookPly, moves };
}

export function lichessOpeningUrl(name) {
  const slug = name.replace(/[:,]/g, '').replace(/'/g, '').replace(/\s+/g, '_');
  return `https://lichess.org/opening/${encodeURIComponent(slug).replace(/%2F/g, '/')}`;
}
export function lichessAnalysisUrl(fen) {
  return `https://lichess.org/analysis/standard/${fen.replace(/ /g, '_')}`;
}
export function wikipediaUrl(family) {
  return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(family + ' chess')}`;
}

// Short, beginner-friendly explanations of the main opening families.
export const FAMILY_INFO = {
  "Sicilian Defense": "Black answers 1.e4 with 1...c5, fighting for the centre from the side instead of copying White. It creates unbalanced positions where both sides attack: White often goes for the kingside, while Black counterattacks on the queenside along the half-open c-file.",
  "French Defense": "1.e4 e6 followed by ...d5. Black accepts a slightly cramped position in return for a very solid pawn chain. The usual plan is to strike back at White's centre with ...c5 and ...f6. Black's light-squared bishop is often the problem piece.",
  "Caro-Kann Defense": "1.e4 c6 followed by ...d5. Like the French, but Black keeps the light-squared bishop free to develop before playing ...e6. It's known for being solid and hard to crack, with fewer weaknesses than most defences.",
  "Ruy Lopez": "1.e4 e5 2.Nf3 Nc6 3.Bb5, also called the Spanish Game, one of the oldest and deepest openings. White pressures the knight that defends e5 and plays for slow, long-term pressure. Black has many solid set-ups (Morphy, Berlin, Marshall…).",
  "Italian Game": "1.e4 e5 2.Nf3 Nc6 3.Bc4. White's bishop aims at f7, Black's weakest square. It can lead to sharp attacking play (Evans Gambit, Fried Liver) or slow manoeuvring with c3 and d3 (Giuoco Pianissimo).",
  "Scotch Game": "1.e4 e5 2.Nf3 Nc6 3.d4. White opens the centre right away. Piece activity and open lines matter more here than the slow pawn structures of the Ruy Lopez.",
  "Four Knights Game": "Both sides develop their knights to the natural squares (Nc3, Nf3 / Nc6, Nf6). It's symmetrical and classical, a great way to learn sound development.",
  "Three Knights Opening": "A close relative of the Four Knights where Black delays or avoids ...Nf6. The play is classical and centre-focused.",
  "Petrov's Defense": "1.e4 e5 2.Nf3 Nf6. Black counterattacks e4 instead of defending e5. It's famous for being very solid and drawish at top level, but you must know the traps (don't copy White too long!).",
  "Philidor Defense": "1.e4 e5 2.Nf3 d6. Black defends e5 with a pawn and builds a compact but passive position. It's solid but gives White an easy space advantage.",
  "King's Gambit Accepted": "1.e4 e5 2.f4 exf4. A romantic 19th-century gambit: White gives a pawn to open the f-file and attack Black's king. The positions are wild, tactical and dangerous for both sides.",
  "King's Gambit Declined": "Black refuses the f4 pawn, often with ...Bc5 or ...d5. That keeps things calmer, while White's king stays a little exposed after f4.",
  "King's Gambit": "1.e4 e5 2.f4. White sacrifices a pawn for rapid development and an attack on the f-file. It's sharp and old-school.",
  "Vienna Game": "1.e4 e5 2.Nc3. A flexible move that often prepares f4 (the Vienna Gambit) with a delayed King's Gambit flavour.",
  "Bishop's Opening": "1.e4 e5 2.Bc4. An early bishop aiming at f7. It can transpose into Italian or Vienna-style positions.",
  "Center Game": "1.e4 e5 2.d4 exd5 3.Qxd4. White recaptures with the queen early. It's direct, but the queen can be chased with tempo.",
  "Danish Gambit": "White sacrifices one or two pawns (d4, c3) for a lead in development and two bishops raking the board. It's pure attacking chess.",
  "Ponziani Opening": "1.e4 e5 2.Nf3 Nc6 3.c3. An old, slightly offbeat way to prepare d4. It can lead to tricky tactics.",
  "Scandinavian Defense": "1.e4 d5. Black challenges e4 immediately, usually recapturing with the queen or knight. It's simple to learn, and Black gets fast development, but the queen can become a target.",
  "Alekhine Defense": "1.e4 Nf6. A provocative defence: Black invites White's pawns forward to e5, c4 and d4, then tries to prove they are overextended.",
  "Pirc Defense": "1.e4 d6 2.d4 Nf6 with ...g6. Black lets White build a big centre, plans to undermine it later, and develops the bishop to g7.",
  "Modern Defense": "Black fianchettoes with ...g6 and ...Bg7 and delays ...Nf6. It's very flexible and 'hypermodern': Black controls the centre from a distance.",
  "Queen's Gambit Declined": "1.d4 d5 2.c4 e6. Black declines the c4 pawn and keeps a strong point on d5. It's one of the most trusted classical defences. Black's main task is to free the light-squared bishop.",
  "Queen's Gambit Accepted": "1.d4 d5 2.c4 dxc4. Black takes the pawn but doesn't try to keep it. Instead Black uses the time to hit back at White's centre with ...c5 or ...e5.",
  "Queen's Gambit": "1.d4 d5 2.c4. White offers a flank pawn to gain central control. It isn't a real sacrifice, since White can usually win the pawn back.",
  "Slav Defense": "1.d4 d5 2.c4 c6. Black supports d5 with the c-pawn and keeps the light-squared bishop free. It's very solid.",
  "Semi-Slav Defense": "A combination of the Slav (...c6) and the Queen's Gambit Declined (...e6). It has some of the sharpest theory in chess (the Meran, the Botvinnik).",
  "Tarrasch Defense": "1.d4 d5 2.c4 e6 3.Nc3 c5. Black accepts an isolated d-pawn in return for free piece play.",
  "Catalan Opening": "White combines d4 and c4 with a fianchettoed bishop on g2 aiming at Black's queenside. It brings long-term pressure and is a favourite of positional players.",
  "King's Indian Defense": "1.d4 Nf6 2.c4 g6 with ...Bg7, ...d6 and ...O-O. Black lets White take the centre, then counterattacks. Often White attacks on the queenside while Black storms the kingside.",
  "Grünfeld Defense": "1.d4 Nf6 2.c4 g6 3.Nc3 d5. Black lets White build a big pawn centre, then attacks it with pieces and ...c5.",
  "Nimzo-Indian Defense": "1.d4 Nf6 2.c4 e6 3.Nc3 Bb4. Black pins the knight and is often happy to give up the bishop to double White's pawns. It's one of the most respected defences.",
  "Queen's Indian Defense": "1.d4 Nf6 2.c4 e6 3.Nf3 b6. Black fights for e4 with a fianchettoed bishop. It's solid and positional.",
  "Bogo-Indian Defense": "1.d4 Nf6 2.c4 e6 3.Nf3 Bb4+. A quieter cousin of the Nimzo-Indian.",
  "Benoni Defense": "Black plays ...c5 against d4, and White usually advances d5. The result is an unbalanced structure: White has more central space, Black has queenside play and an active g7 bishop.",
  "Benko Gambit": "Black sacrifices the b-pawn (...b5) to open the a- and b-files. It brings long-lasting queenside pressure, even in endgames.",
  "Dutch Defense": "1.d4 f5. Black grabs e4 and prepares a kingside attack. It's ambitious, but it slightly weakens Black's own king.",
  "Old Indian Defense": "Black plays ...Nf6, ...d6 and ...e5. It's solid and less theoretical than the King's Indian.",
  "English Opening": "1.c4. White controls d5 from the side and often fianchettoes the bishop to g2. It's flexible and can transpose to many 1.d4 openings or become a 'reversed Sicilian'.",
  "Réti Opening": "1.Nf3 with c4 and g3. A hypermodern system: White controls the centre with pieces from a distance instead of occupying it.",
  "Zukertort Opening": "1.Nf3 is a flexible first move that keeps many options open. What happens next depends on how Black replies.",
  "King's Indian Attack": "White sets up Nf3, g3, Bg2, O-O, d3 and e4, a reliable 'system' that works against almost anything and often leads to a kingside attack.",
  "London System": "White develops the bishop to f4 and builds a solid pyramid (d4, e3, c3). It's easy to learn and hard to beat quickly, so it's very popular at club level.",
  "Colle System": "White sets up d4, e3, Nf3, Bd3 and O-O and aims for a central e4 break. It's calm and systematic.",
  "Torre Attack": "1.d4 Nf6 2.Nf3 e6 3.Bg5. White pins the knight early and plays solid, flexible chess.",
  "Trompowsky Attack": "1.d4 Nf6 2.Bg5. White threatens to take on f6 and damage Black's pawns. It's an offbeat way to avoid main-line theory.",
  "Bird Opening": "1.f4. White takes control of e5 and often aims for a kingside attack. It's like a Dutch Defense with an extra move.",
  "Nimzo-Larsen Attack": "1.b3. White fianchettoes the queenside bishop to aim at the centre from afar. It's offbeat but sound.",
  "Polish Opening": "1.b4, the Sokolsky. White grabs queenside space at once. It's unusual and surprises opponents, but the b4 pawn can become a target.",
  "Grob Opening": "1.g4. A provocative attacking move that weakens White's kingside. It's rare and risky: crazy-mode territory.",
  "Hungarian Opening": "1.g3. A quiet fianchetto that keeps every option open.",
  "Van Geet Opening": "1.Nc3, the Dunst. White develops a knight and waits for Black to commit, often heading for e4.",
  "Amar Opening": "1.Nh3. The knight goes to the edge, which breaks classical principles. It's very rare.",
  "Englund Gambit": "1.d4 e5!? A trappy gambit. Its idea is to surprise unprepared opponents.",
  "Latvian Gambit": "1.e4 e5 2.Nf3 f5!? One of the wildest gambits in chess: Black attacks at once and takes big risks.",
  "Elephant Gambit": "1.e4 e5 2.Nf3 d5!? Black counter-sacrifices in the centre. It's offbeat and tactical.",
  "Blackmar-Diemer Gambit": "1.d4 d5 2.e4. White sacrifices a pawn for rapid development and attacking chances. It's very sharp.",
  "Owen Defense": "1.e4 b6. Black fianchettoes the queenside bishop to pressure e4. It's hypermodern and offbeat.",
  "Nimzowitsch Defense": "1.e4 Nc6. An unusual defence that often transposes to other openings.",
  "Hippopotamus Defense": "Black sets up quietly on the first three ranks (...g6, ...b6, ...d6, ...e6) and waits for White to overextend.",
  "Rat Defense": "1...d6 set-ups where Black stays flexible and avoids early commitments.",
  "Indian Defense": "1.d4 Nf6. Black controls e4 with a piece instead of a pawn. It's the gateway to the King's Indian, Nimzo-Indian, Grünfeld and more.",
  "Queen's Pawn Game": "1.d4 with a calm continuation. White builds a solid centre and keeps the more theoretical lines for later.",
  "King's Pawn Game": "1.e4 e5 with a less common follow-up. Open, classical chess where quick development matters.",
  "Kangaroo Defense": "1.d4 e6 2.c4 Bb4+. A rare and tricky check that often transposes to other systems.",
};

/** Short explanation for a named opening (falls back to a generic description). */
export function describe(info, style) {
  if (!info || !info.family) {
    return style >= 50
      ? "These moves left the opening books very early, so this is truly your own position. Nobody has a memorised plan here: count the material, look for loose pieces and develop quickly."
      : "This sequence doesn't match a named opening exactly. Use classic principles: control the centre, develop knights before bishops, and castle early.";
  }
  const total = info.moves ? info.moves.length : 0;
  if (info.bookPly <= 3 && total >= 8) {
    return `It started as the ${info.family}, but the engine left the known paths almost immediately, so this position is your own. ` +
      'Nobody has a memorised plan here: count the material, look for loose pieces, and develop quickly.';
  }
  const txt = FAMILY_INFO[info.family];
  if (txt) return txt;
  return `${info.family} is a less common opening (ECO ${info.eco}). Offbeat openings like this are rarely studied in depth, so ideas and calculation matter more than memorised theory.`;
}

export function styleLabel(v) {
  if (v < 20) return 'Classic';
  if (v < 45) return 'Mainstream';
  if (v < 70) return 'Offbeat';
  if (v < 90) return 'Wild';
  return 'Crazy';
}
