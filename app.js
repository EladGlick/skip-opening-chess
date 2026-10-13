import { Chess } from './vendor/chess.js';
import { Chessground } from './vendor/chessground/chessground.min.js';
import { simulateOpening, getEngine, targetAdvantage } from './engine.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const $ = id => document.getElementById(id);
const PEER_PREFIX = 'skipopening-v1-';
// `?signal=host:port` points at a self-hosted PeerJS server (used for local testing).
const SIGNAL = new URLSearchParams(location.search).get('signal');
const PEER_OPTS = {
  debug: 1,
  ...(SIGNAL ? { host: SIGNAL.split(':')[0], port: +SIGNAL.split(':')[1] || 9000, path: '/', secure: false } : {}),
  config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ] },
};
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const randId = (n = 10) => {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map(x => a[x % a.length]).join('');
};
const colorName = c => (c === 'w' ? 'White' : 'Black');
const other = c => (c === 'w' ? 'b' : 'w');
const fmtEval = cp => (cp >= 0 ? '+' : '−') + (Math.abs(cp) / 100).toFixed(1);

function chessFrom(moves) {
  const c = new Chess();
  for (const san of moves) c.move(san);
  return c;
}
function resultOf(c) {
  if (c.isCheckmate()) return { winner: other(c.turn()), reason: 'checkmate' };
  if (c.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (c.isInsufficientMaterial()) return { winner: null, reason: 'insufficient material' };
  if (c.isThreefoldRepetition()) return { winner: null, reason: 'threefold repetition' };
  if (c.isDraw()) return { winner: null, reason: '50-move rule' };
  return null;
}

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */
const params = new URLSearchParams(location.search);
let gameId = params.get('game');
let role = null;           // 'host' | 'guest'
let state = null;          // shared game state (host is the source of truth)
let peer = null;
let conn = null;           // host: the guest's connection; guest: connection to host
let guestToken = null;
let flipped = false;
let cg = null;
let simulating = false;
let lastRenderedKey = '';

const profile = store.get('profile') || {};

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */
function show(id) {
  for (const s of ['screen-create', 'screen-wait', 'screen-join', 'screen-game']) $(s).hidden = s !== id;
}
function setConn(text, cls) {
  const el = $('conn');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = 'conn ' + (cls || '');
}

/* ------------------------------------------------------------------ */
/* Create screen                                                       */
/* ------------------------------------------------------------------ */
function initCreate() {
  show('screen-create');
  const f = $('create-form');
  if (profile.name) f.name.value = profile.name;
  if (profile.rating) f.rating.value = profile.rating;
  const out = $('turns-out');
  const sync = () => { out.textContent = f.turns.value === '0' ? '0 (normal game)' : f.turns.value; };
  f.turns.addEventListener('input', sync); sync();
  f.addEventListener('submit', e => {
    e.preventDefault();
    const name = f.name.value.trim() || 'Host';
    const rating = Math.round(+f.rating.value) || 1200;
    store.set('profile', { name, rating });
    gameId = randId();
    state = {
      id: gameId, v: 0, game: 1,
      phase: 'lobby',
      turns: +f.turns.value,
      colorPref: f.color.value,
      host: { name, rating },
      guest: null,
      white: null,
      moves: [], simCount: 0, sim: null,
      result: null, drawOffer: null, rematch: { host: false, guest: false },
    };
    role = 'host';
    saveHost();
    history.replaceState(null, '', `?game=${gameId}` + (SIGNAL ? `&signal=${SIGNAL}` : ''));
    getEngine(); // start loading Stockfish now so it's warm when the friend joins
    startHost();
    render();
  });
}

/* ------------------------------------------------------------------ */
/* Host                                                                */
/* ------------------------------------------------------------------ */
function saveHost() { store.set('host:' + gameId, state); }

function startHost() {
  setConn('Starting…');
  peer = new Peer(PEER_PREFIX + gameId, PEER_OPTS);
  peer.on('open', () => {
    setConn(state.guest ? `Waiting for ${state.guest.name} to reconnect…` : 'Online', state.guest ? '' : 'on');
    render();
    if (state.phase === 'simulating') runSimulation(); // resume after a refresh
  });
  peer.on('connection', c => {
    c.on('data', msg => hostHandle(c, msg));
    c.on('close', () => {
      if (c === conn) { conn = null; setConn(`${state.guest?.name || 'Friend'} disconnected`, 'off'); }
    });
  });
  peer.on('disconnected', () => safeReconnect(peer));
  peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      // Our old id is still held by the server (e.g. after a refresh). Retry shortly.
      setConn('Reconnecting…', 'off');
      peer.destroy();
      setTimeout(startHost, 3000);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      setConn('Connection problem — retrying…', 'off');
      if (!peer.open && !peer.destroyed) { peer.destroy(); setTimeout(startHost, 5000); }
    } else {
      console.warn('peer error', err);
    }
  });
}

function broadcast() {
  state.v++;
  saveHost();
  if (conn && conn.open) conn.send({ t: 'state', state });
  render();
}

function hostHandle(c, msg) {
  if (!msg || typeof msg !== 'object') return;
  const isGuest = c === conn;
  switch (msg.t) {
    case 'hello':
      if (state.guest && state.guest.token === msg.token) {
        conn = c;
        setConn(`Connected to ${state.guest.name}`, 'on');
        c.send({ t: 'state', state });
      } else if (!state.guest) {
        c.send({ t: 'invite', host: state.host, turns: state.turns });
      } else {
        c.send({ t: 'full' });
      }
      return;
    case 'join':
      if (state.guest) { if (state.guest.token !== msg.token) c.send({ t: 'full' }); return; }
      state.guest = {
        name: String(msg.name || 'Friend').slice(0, 20),
        rating: Math.max(100, Math.min(3500, Math.round(+msg.rating) || 1200)),
        token: String(msg.token),
      };
      conn = c;
      setConn(`Connected to ${state.guest.name}`, 'on');
      startGame(pickWhite());
      return;
  }
  if (!isGuest) return;
  actOn('guest', msg);
}

function pickWhite() {
  if (state.colorPref === 'w') return 'host';
  if (state.colorPref === 'b') return 'guest';
  return Math.random() < 0.5 ? 'host' : 'guest';
}

function startGame(white) {
  Object.assign(state, {
    white, phase: 'simulating', moves: [], simCount: 0, sim: null,
    result: null, drawOffer: null, rematch: { host: false, guest: false },
  });
  broadcast();
  runSimulation();
}

async function runSimulation() {
  if (simulating) return;
  simulating = true;
  state.moves = [];
  const rating = r => (state.white === r ? state[r].rating : null);
  const whiteRating = rating('host') ?? rating('guest');
  const blackRating = state.white === 'host' ? state.guest.rating : state.host.rating;
  try {
    if (state.turns > 0) {
      const res = await simulateOpening({
        whiteRating, blackRating, turns: state.turns,
        onMove: ({ san }) => { state.moves.push(san); broadcast(); },
      });
      state.sim = { evalWhite: res.evalWhite, target: res.target, favored: res.favored };
    } else {
      state.sim = { evalWhite: 0, target: 0, favored: null };
    }
    state.simCount = state.moves.length;
    const r = resultOf(chessFrom(state.moves));
    state.phase = r ? 'over' : 'playing';
    state.result = r;
  } catch (err) {
    console.error(err);
    alert('The opening engine failed to load. Try refreshing the page.');
  } finally {
    simulating = false;
  }
  broadcast();
}

// Apply an action from a player ('host' | 'guest'). Host only.
function actOn(who, msg) {
  const color = state.white === who ? 'w' : 'b';
  switch (msg.t) {
    case 'move': {
      if (state.phase !== 'playing' || msg.n !== state.moves.length) { conn?.send({ t: 'state', state }); return; }
      const c = chessFrom(state.moves);
      if (c.turn() !== color) return;
      let m;
      try { m = c.move(msg.move); } catch { m = null; }
      if (!m) { conn?.send({ t: 'state', state }); return; }
      state.moves.push(m.san);
      state.drawOffer = null;
      const r = resultOf(c);
      if (r) { state.result = r; state.phase = 'over'; }
      break;
    }
    case 'resign':
      if (state.phase !== 'playing') return;
      state.result = { winner: other(color), reason: `${colorName(color)} resigned` };
      state.phase = 'over';
      break;
    case 'offerDraw':
      if (state.phase !== 'playing' || state.drawOffer) return;
      state.drawOffer = color;
      break;
    case 'acceptDraw':
      if (state.phase !== 'playing' || state.drawOffer !== other(color)) return;
      state.result = { winner: null, reason: 'agreement' };
      state.phase = 'over';
      state.drawOffer = null;
      break;
    case 'declineDraw':
      if (state.drawOffer !== other(color)) return;
      state.drawOffer = null;
      break;
    case 'rematch':
      if (state.phase !== 'over') return;
      state.rematch[who] = true;
      if (state.rematch.host && state.rematch.guest) {
        state.game++;
        startGame(state.white === 'host' ? 'guest' : 'host'); // swap colors
        return;
      }
      break;
    default:
      return;
  }
  broadcast();
}

/* ------------------------------------------------------------------ */
/* Guest                                                               */
/* ------------------------------------------------------------------ */
function startGuest() {
  role = 'guest';
  const saved = store.get('guest:' + gameId);
  guestToken = saved?.token || randId(16);
  store.set('guest:' + gameId, { token: guestToken, ...(saved || {}) });
  show('screen-join');
  $('join-title').textContent = 'Connecting to your friend…';
  $('join-sub').innerHTML = '<span class="muted"><span class="spinner"></span> Opening a direct connection</span>';
  setConn('Connecting…');

  makeGuestPeer();
}

function makeGuestPeer() {
  const me = peer = new Peer(PEER_OPTS);
  me.on('open', connectToHost);
  me.on('disconnected', () => safeReconnect(me));
  me.on('error', err => {
    if (me !== peer) return;
    if (!me.open && ['server-error', 'network', 'socket-error', 'socket-closed'].includes(err.type)) {
      // couldn't reach the matchmaking server at all — start over in a moment
      setConn('Can’t reach the server — retrying…', 'off');
      me.destroy();
      setTimeout(makeGuestPeer, 4000);
    } else if (err.type === 'peer-unavailable') {
      setConn('Host offline — retrying…', 'off');
      if (!state) {
        $('join-title').textContent = 'Your friend isn’t online right now';
        $('join-sub').textContent = 'The game creator needs to keep their tab open. Retrying automatically…';
      }
      setTimeout(connectToHost, 4000);
    } else {
      console.warn('peer error', err);
    }
  });
}

function safeReconnect(p) {
  setTimeout(() => { if (p === peer && !p.destroyed && p.disconnected) p.reconnect(); }, 2000);
}

function connectToHost() {
  if (conn && conn.open) return;
  if (!peer || peer.destroyed || !peer.open) return;
  const c = peer.connect(PEER_PREFIX + gameId, { reliable: true });
  conn = c;
  c.on('open', () => {
    setConn('Connected', 'on');
    c.send({ t: 'hello', token: guestToken });
  });
  c.on('data', msg => {
    if (!msg) return;
    if (msg.t === 'invite') showJoinForm(msg);
    else if (msg.t === 'full') {
      show('screen-join');
      $('join-title').textContent = 'This game is already full';
      $('join-sub').textContent = 'Two players are already in this game. Ask your friend for a new link.';
      $('join-form').hidden = true;
    } else if (msg.t === 'state') {
      if (!state || msg.state.v >= state.v || msg.state.game !== state.game) state = msg.state;
      if (state.host) setConn(`Connected to ${state.host.name}`, 'on');
      render();
    }
  });
  c.on('close', () => {
    if (conn === c) conn = null;
    setConn('Disconnected — reconnecting…', 'off');
    setTimeout(connectToHost, 2000);
  });
}

function showJoinForm(inv) {
  show('screen-join');
  $('join-title').textContent = `${inv.host.name} (${inv.host.rating}) invited you`;
  $('join-sub').textContent = inv.turns > 0
    ? `The first ${inv.turns} moves will be played by the engine, tilted toward the lower-rated player. Then it’s your game.`
    : 'A normal game from the starting position.';
  const f = $('join-form');
  f.hidden = false;
  if (profile.name) f.name.value = profile.name;
  if (profile.rating) f.rating.value = profile.rating;
  f.onsubmit = e => {
    e.preventDefault();
    const name = f.name.value.trim() || 'Friend';
    const rating = Math.round(+f.rating.value) || 1200;
    store.set('profile', { name, rating });
    f.querySelector('button').disabled = true;
    conn.send({ t: 'join', name, rating, token: guestToken });
  };
}

/* ------------------------------------------------------------------ */
/* Player actions (both roles)                                         */
/* ------------------------------------------------------------------ */
function act(msg) {
  if (role === 'host') actOn('host', msg);
  else if (conn && conn.open) conn.send(msg);
}

function myColor() { return state && state.white ? (state.white === role ? 'w' : 'b') : 'w'; }

function playMove(from, to, promotion) {
  const n = state.moves.length;
  const move = { from, to, promotion };
  if (role === 'guest') {
    // optimistic local update; the host's state will confirm it
    const c = chessFrom(state.moves);
    try {
      const m = c.move(move);
      state.moves.push(m.san);
      state.drawOffer = null;
      const r = resultOf(c);
      if (r) { state.result = r; state.phase = 'over'; }
    } catch { /* illegal; host will resync */ }
    render();
  }
  act({ t: 'move', move, n });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */
function ensureBoard() {
  if (cg) return;
  cg = Chessground($('board'), {
    coordinates: true,
    animation: { enabled: true, duration: 220 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: onUserMove } },
    premovable: { enabled: false },
    draggable: { enabled: true, showGhost: true },
  });
}

function onUserMove(orig, dest) {
  const c = chessFrom(state.moves);
  const piece = c.get(orig);
  if (piece && piece.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
    askPromotion(piece.color).then(p => {
      if (p) playMove(orig, dest, p);
      else { lastRenderedKey = ''; render(); } // cancelled: restore position
    });
  } else {
    playMove(orig, dest);
  }
}

function askPromotion(color) {
  return new Promise(resolve => {
    const el = $('promo');
    el.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'choices';
    const names = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    for (const p of ['q', 'r', 'b', 'n']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = names[p];
      b.setAttribute('aria-label', names[p]);
      // reuse chessground's piece sprites
      const probe = document.createElement('piece');
      probe.className = `${names[p]} ${color === 'w' ? 'white' : 'black'}`;
      $('board').appendChild(probe);
      b.style.backgroundImage = getComputedStyle(probe).backgroundImage;
      probe.remove();
      b.onclick = () => { el.hidden = true; resolve(p); };
      box.appendChild(b);
    }
    el.appendChild(box);
    el.onclick = e => { if (e.target === el) { el.hidden = true; resolve(null); } };
    el.hidden = false;
  });
}

function render() {
  if (!state) return;
  if (role === 'host' && !state.guest) { renderWait(); return; }
  if (!state.white) return;
  show('screen-game');
  ensureBoard();

  const c = chessFrom(state.moves);
  const mine = myColor();
  const orientation = flipped ? other(mine) : mine;
  const canMove = state.phase === 'playing' && c.turn() === mine;
  const hist = c.history({ verbose: true });
  const last = hist[hist.length - 1];

  const key = `${state.game}|${state.moves.length}|${state.phase}|${orientation}`;
  if (key !== lastRenderedKey) {
    lastRenderedKey = key;
    const dests = new Map();
    if (canMove) for (const m of c.moves({ verbose: true })) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      dests.get(m.from).push(m.to);
    }
    cg.set({
      fen: c.fen(),
      orientation: orientation === 'w' ? 'white' : 'black',
      turnColor: c.turn() === 'w' ? 'white' : 'black',
      lastMove: last ? [last.from, last.to] : undefined,
      check: c.inCheck(),
      viewOnly: false,
      movable: { color: canMove ? (mine === 'w' ? 'white' : 'black') : undefined, dests },
    });
  }

  renderPlayers(c, orientation);
  renderStatus(c, mine);
  renderHandicap();
  renderMoves();
  renderActions(mine);
  renderOverlay(mine);
}

function playerOf(color) {
  const r = color === 'w' ? state.white : (state.white === 'host' ? 'guest' : 'host');
  return { ...state[r], role: r };
}

function renderPlayers(c, orientation) {
  const fill = (el, color) => {
    const p = playerOf(color);
    el.innerHTML = '';
    const av = document.createElement('div');
    av.className = 'avatar ' + color;
    av.textContent = color === 'w' ? '♔' : '♚';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = p.name + (p.role === role ? ' (you)' : '');
    const rt = document.createElement('span');
    rt.className = 'rating';
    rt.textContent = `(${p.rating})`;
    nm.appendChild(rt);
    const dot = document.createElement('div');
    dot.className = 'turn-dot';
    el.append(av, nm, dot);
    el.classList.toggle('to-move', state.phase === 'playing' && c.turn() === color);
  };
  fill($('player-top'), other(orientation));
  fill($('player-bottom'), orientation);
}

function renderStatus(c, mine) {
  const el = $('status');
  if (state.phase === 'simulating') {
    el.innerHTML = '';
    const s = document.createElement('span');
    s.className = 'muted';
    s.innerHTML = '<span class="spinner"></span>';
    s.append(` Simulating the opening… ${Math.ceil(state.moves.length / 2)}/${state.turns}`);
    el.appendChild(s);
  } else if (state.phase === 'playing') {
    const opp = playerOf(other(mine)).name;
    el.textContent = c.turn() === mine ? (c.inCheck() ? 'Your move — you’re in check!' : 'Your move') : `Waiting for ${opp}…`;
  } else if (state.phase === 'over') {
    el.textContent = resultText(mine);
  }
}

function resultText(mine) {
  const r = state.result;
  if (!r) return '';
  if (!r.winner) return `Draw — ${r.reason}`;
  return (r.winner === mine ? 'You won' : `${playerOf(r.winner).name} won`) + ` — ${r.reason}`;
}

function renderHandicap() {
  const el = $('handicap');
  if (!state.sim || state.turns === 0) { el.hidden = true; return; }
  el.hidden = false;
  const { evalWhite, target, favored } = state.sim;
  const gap = Math.abs(state.host.rating - state.guest.rating);
  const lead = evalWhite === 0 ? 'Equal position' : `${colorName(evalWhite > 0 ? 'w' : 'b')} ${fmtEval(Math.abs(evalWhite))}`;
  el.innerHTML = '';
  const p = document.createElement('div');
  if (favored) {
    const fav = playerOf(favored);
    p.innerHTML = `Rating gap <b>${gap}</b> → opening tilted toward <b></b> (target ≈ ${fmtEval(target)}).<br>Engine eval after the opening: <b>${lead}</b>`;
    p.querySelectorAll('b')[1].textContent = fav.name;
  } else {
    p.innerHTML = `Ratings are close — a fair opening was simulated.<br>Engine eval: <b>${lead}</b>`;
  }
  const bar = document.createElement('div');
  bar.className = 'evalbar';
  bar.title = 'Engine eval after the opening (white = White’s share)';
  const fill = document.createElement('div');
  const pct = 50 + 50 * Math.tanh(evalWhite / 400);
  fill.style.width = pct + '%';
  bar.appendChild(fill);
  el.append(p, bar);
}

function renderMoves() {
  const ol = $('moves');
  ol.innerHTML = '';
  const total = state.moves.length;
  const simEnd = state.phase === 'simulating' ? total : state.simCount;
  for (let i = 0; i < total; i += 2) {
    if (i === simEnd && simEnd > 0) ol.appendChild(divider());
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = (i / 2 + 1) + '.';
    li.appendChild(n);
    for (const j of [i, i + 1]) {
      const m = document.createElement('span');
      m.className = 'm' + (j < simEnd ? ' sim' : '') + (j === total - 1 ? ' last' : '');
      m.textContent = state.moves[j] || '';
      li.appendChild(m);
    }
    ol.appendChild(li);
    // the sim can end on White's move — put the divider inside the move pair
    if (simEnd === i + 1 && simEnd < total && state.phase !== 'simulating') ol.appendChild(divider());
  }
  if (total === simEnd && simEnd > 0 && state.phase !== 'simulating') ol.appendChild(divider());
  ol.scrollTop = ol.scrollHeight;
  function divider() {
    const d = document.createElement('li');
    d.className = 'divider';
    d.textContent = 'Your game starts here';
    return d;
  }
}

function renderActions(mine) {
  const playing = state.phase === 'playing';
  $('btn-draw').disabled = !playing || !!state.drawOffer;
  $('btn-resign').disabled = !playing;
  const n = $('notice');
  n.innerHTML = '';
  n.hidden = true;
  if (playing && state.drawOffer) {
    n.hidden = false;
    if (state.drawOffer === mine) {
      n.textContent = 'Draw offered. Waiting for a reply…';
    } else {
      const t = document.createElement('div');
      t.textContent = `${playerOf(state.drawOffer).name} offers a draw.`;
      const row = document.createElement('div');
      row.className = 'row';
      const yes = btn('Accept', 'primary', () => act({ t: 'acceptDraw' }));
      const no = btn('Decline', '', () => act({ t: 'declineDraw' }));
      row.append(yes, no);
      n.append(t, row);
    }
  }
}

function btn(text, cls, onclick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ' + cls;
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function renderOverlay(mine) {
  const ov = $('overlay');
  if (state.phase !== 'over') { ov.hidden = true; return; }
  if (ov.dataset.dismissed === `${state.game}`) { ov.hidden = true; return; }
  ov.hidden = false;
  ov.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'box';
  const h = document.createElement('h3');
  const r = state.result;
  h.textContent = !r?.winner ? 'Draw' : r.winner === mine ? 'You won!' : `${playerOf(r.winner).name} won`;
  const p = document.createElement('p');
  p.textContent = r ? (r.winner ? `by ${r.reason}` : `by ${r.reason}`) : '';
  const meReq = state.rematch[role];
  const themReq = state.rematch[role === 'host' ? 'guest' : 'host'];
  const rb = btn(meReq ? 'Waiting for friend…' : themReq ? 'Accept rematch' : 'Rematch (swap colors)', 'primary', () => act({ t: 'rematch' }));
  rb.disabled = meReq;
  const info = document.createElement('p');
  info.textContent = themReq && !meReq ? 'Your friend wants a rematch!' : '';
  const close = btn('View board', 'ghost', () => { ov.dataset.dismissed = `${state.game}`; ov.hidden = true; });
  box.append(h, p, info, rb, close);
  ov.appendChild(box);
}

function renderWait() {
  show('screen-wait');
  const link = location.origin + location.pathname + `?game=${gameId}` + (SIGNAL ? `&signal=${SIGNAL}` : '');
  $('share-link').value = link;
  $('copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText(link); }
    catch { $('share-link').select(); document.execCommand('copy'); }
    $('copy-link').textContent = 'Copied!';
    setTimeout(() => ($('copy-link').textContent = 'Copy'), 1500);
  };
  if (navigator.share) {
    $('native-share').hidden = false;
    $('native-share').onclick = () => navigator.share({ title: 'Play chess with me', text: `${state.host.name} challenged you to a game of chess`, url: link }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */
let resignTimer = null;
$('btn-resign').onclick = () => {
  const b = $('btn-resign');
  if (b.dataset.armed) { clearTimeout(resignTimer); delete b.dataset.armed; b.textContent = '⚑ Resign'; act({ t: 'resign' }); return; }
  b.dataset.armed = '1';
  b.textContent = 'Click to confirm';
  resignTimer = setTimeout(() => { delete b.dataset.armed; b.textContent = '⚑ Resign'; }, 3000);
};
$('btn-draw').onclick = () => act({ t: 'offerDraw' });
$('btn-flip').onclick = () => { flipped = !flipped; render(); };

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
if (!gameId) {
  initCreate();
} else {
  const hosted = store.get('host:' + gameId);
  if (hosted) {
    role = 'host';
    state = hosted;
    render();
    if (state.phase === 'simulating' || !state.guest) getEngine();
    startHost();
  } else {
    startGuest();
  }
}

// exposed for debugging / tests
window.__skip = { get state() { return state; }, get role() { return role; }, targetAdvantage };
