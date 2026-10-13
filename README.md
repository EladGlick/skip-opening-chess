# ♞ Skip Opening Chess

Play chess with a friend online — without the opening, and without the rating gap ruining the game.

1. Enter your name and rating, choose how many moves to simulate (0–20), the **opening style**
   (Classic → Mainstream → Offbeat → Wild → Crazy) and your color.
2. Send the link to your friend. They enter their name and rating.
3. Stockfish plays the first moves for both sides. If you're rated differently, the opening is
   tilted toward the lower-rated player (~1 pawn of advantage per 200 rating points, max 4 pawns;
   gaps under 50 points get a fair opening).
4. Play the rest normally. Draw offers, resign, and rematch (colors swap) are built in.
5. See the material score (pawn 1, knight/bishop 3, rook 5, queen 9) next to each player, open
   **📖 Learn this opening** for its name, ECO code, ideas and links, and click any move to replay the game.

## How it works

- **Pure static site** — runs on GitHub Pages, no server of our own.
- **Online play**: a direct browser-to-browser connection (WebRTC) using [PeerJS](https://peerjs.com).
  The free PeerJS cloud server only introduces the two browsers. The game creator's tab
  holds the game, so keep it open; either player can refresh and reconnect.
- **Opening simulation** (`engine.js`): Stockfish 18 lite (WASM) scores every legal move. The
  favored side plays near-best moves; the other side picks slightly weaker moves each turn so the
  engine eval drifts toward the target edge. The first two moves of each side stay natural.
- **Opening style**: moves are picked at random, weighted by engine score and by how popular the line
  is in the opening database. Classic sticks to well-known theory, Crazy prefers rare and unknown moves.
  Recent openings are remembered so the same start isn't repeated.
- **Opening names**: loaded at runtime from the [Lichess chess-openings](https://github.com/lichess-org/chess-openings)
  dataset (CC0, pinned commit), with short explanations in `openings.js`.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Ideas for later

Clocks / time controls, sounds, chat, move takeback, PGN export, a TURN server for strict networks.

## License

GPL-3.0 (Stockfish and chessground are GPLv3). See `vendor/` for third-party code.
