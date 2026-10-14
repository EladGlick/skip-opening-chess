import { Chess } from './vendor/chess.js';
import { Chessground } from './vendor/chessground/chessground.min.js';
import { simulateOpening, getEngine, getBotEngine, botMove, quickEval, targetAdvantage, hintAnalysis } from './engine.js';
import { explainHint } from './explain.js';
import { loadOpenings, identify, describe, styleLabel, lichessOpeningUrl, lichessAnalysisUrl, wikipediaUrl } from './openings.js';

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
let viewPly = null;        // null = live position; otherwise number of plies shown while reviewing
let autoplay = null;
let clockOffset = 0;       // guest: host clock minus local clock
let liveTurn = 'w';        // side to move in the live position (cached by render)
let botThinking = false;
let uiNote = null;         // short-lived message shown under the buttons
let hint = null;           // { game, n, from, to, san } — the best move currently shown to this player
let hintBusy = false;
let hintHidden = '';       // `${game}|${n}` of a hint card the player closed (the arrow stays)
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
function parseTc(f) {
  const v = f.tc.value;
  if (!v) return null;
  if (v === 'custom') {
    const base = Math.max(0.5, +f.tcMin.value || 5) * 60000;
    return { base, inc: Math.max(0, +f.tcInc.value || 0) * 1000 };
  }
  const [m, i] = v.split('+').map(Number);
  return { base: m * 60000, inc: i * 1000 };
}
const tcLabel = tc => (tc ? `${+(tc.base / 60000).toFixed(1)}+${tc.inc / 1000}` : 'no clock');

const STYLE_LEVELS = [
  { name: 'Classic', value: 5, desc: 'Main lines straight out of the opening books.' },
  { name: 'Mainstream', value: 30, desc: 'Popular openings, with the occasional side line.' },
  { name: 'Offbeat', value: 55, desc: 'Less common but respectable lines your friend may not know.' },
  { name: 'Wild', value: 80, desc: 'Rare openings and sharp, unusual ideas.' },
  { name: 'Crazy', value: 100, desc: 'Almost anything goes, as long as it stays playable.' },
];
const styleLevelOf = v => STYLE_LEVELS.reduce((best, l, i) => (Math.abs(l.value - v) < Math.abs(STYLE_LEVELS[best].value - v) ? i : best), 0);

function initCreate() {
  show('screen-create');
  const f = $('create-form');
  if (profile.name) f.name.value = profile.name;
  if (profile.rating) f.rating.value = profile.rating;
  if (profile.name2) f.name2.value = profile.name2;
  if (profile.rating2) f.rating2.value = profile.rating2;
  if (profile.botRating) f.botRating.value = profile.botRating;
  const tcRadios = [...f.querySelectorAll('input[name=tc]')];
  if (profile.tc != null && tcRadios.some(r => r.value === profile.tc)) f.tc.value = profile.tc;
  if (profile.mode) f.mode.value = profile.mode;
  const out = $('turns-out');
  const sync = () => { out.textContent = f.turns.value === '0' ? 'Off' : `${f.turns.value} moves`; };
  f.turns.addEventListener('input', sync); sync();
  // Opening style: five fixed levels (no in-between values)
  if (profile.style != null) f.styleLevel.value = styleLevelOf(profile.style);
  const syncStyle = () => {
    const lvl = +f.styleLevel.value;
    $('style-out').textContent = STYLE_LEVELS[lvl].name;
    $('style-desc').textContent = STYLE_LEVELS[lvl].desc;
    for (const b of document.querySelectorAll('#style-ticks button')) b.classList.toggle('on', +b.dataset.level === lvl);
  };
  f.styleLevel.addEventListener('input', syncStyle);
  for (const b of document.querySelectorAll('#style-ticks button')) {
    b.addEventListener('click', () => { f.styleLevel.value = b.dataset.level; f.styleLevel.dispatchEvent(new Event('input')); });
  }
  syncStyle();
  const botLevel = v => v < 800 ? 'Beginner' : v < 1200 ? 'Casual' : v < 1600 ? 'Club player' : v < 2000 ? 'Strong' : v < 2400 ? 'Expert' : 'Master';
  const syncBot = () => { $('bot-out').textContent = `${f.botRating.value} · ${botLevel(+f.botRating.value)}`; };
  f.botRating.addEventListener('input', syncBot); syncBot();
  const tcCategory = (min, inc) => {
    const est = min + (inc * 40) / 60;           // estimated minutes per player for a 40-move game
    return est < 3 ? 'Bullet' : est < 8 ? 'Blitz' : est < 25 ? 'Rapid' : 'Classical';
  };
  // Time control in two steps: pick a type, then a length within it.
  const typeOf = v => {
    if (v === 'custom' || v === '') return 'custom';
    const [m, i] = v.split('+').map(Number);
    return tcCategory(m, i).toLowerCase();
  };
  const lastPick = {};
  const showType = type => {
    for (const el of f.querySelectorAll('.tc-lengths')) el.hidden = el.dataset.type !== type;
  };
  for (const r of f.tcType) r.addEventListener('change', () => {
    const type = f.tcType.value;
    showType(type);
    const opts = [...f.querySelectorAll(`.tc-lengths[data-type="${type}"] input[name=tc]`)];
    const keep = opts.find(o => o.value === lastPick[type]) || opts[0];
    keep.checked = true;
    syncTc();
  });
  const syncTc = () => {
    const v = f.tc.value;
    const type = typeOf(v);
    lastPick[type] = v;
    if (f.tcType.value !== type) { f.tcType.value = type; showType(type); }
    $('tc-custom').hidden = v !== 'custom';
    let label;
    if (!v) label = 'No clock';
    else {
      const [min, inc] = v === 'custom' ? [+f.tcMin.value || 0, +f.tcInc.value || 0] : v.split('+').map(Number);
      label = `${inc ? `${min} | ${inc}` : `${min} min`} · ${tcCategory(min, inc)}`;
    }
    $('tc-out').textContent = label;
  };
  for (const r of tcRadios) r.addEventListener('change', syncTc);
  f.tcMin.addEventListener('input', syncTc);
  f.tcInc.addEventListener('input', syncTc);
  for (const b of f.querySelectorAll('.step')) {
    b.addEventListener('click', () => {
      const inp = f[b.dataset.step];
      const step = inp.name === 'tcMin' && +inp.value < 2 ? 0.5 : 1;
      const v = Math.min(+inp.max, Math.max(+inp.min, (+inp.value || 0) + step * +b.dataset.delta));
      inp.value = v;
      inp.dispatchEvent(new Event('input'));
      syncTc();
    });
  }
  syncTc();

  if (profile.hints != null) f.hints.value = profile.hints;
  if (profile.takebacks != null) f.takebacks.value = profile.takebacks;
  const syncHelp = () => {
    const h = +f.hints.value || 0, t = +f.takebacks.value || 0;
    $('help-out').textContent = !h && !t ? 'Off' : `${h} hint${h === 1 ? '' : 's'} · ${t} takeback${t === 1 ? '' : 's'}`;
  };
  f.hints.addEventListener('input', syncHelp);
  f.takebacks.addEventListener('input', syncHelp);
  syncHelp();

  // slider fill
  for (const r of f.querySelectorAll('.range')) {
    const paint = () => r.style.setProperty('--pct', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
    r.addEventListener('input', paint);
    paint();
  }

  const syncMode = () => {
    const mode = f.mode.value;
    for (const el of f.querySelectorAll('[data-show]')) el.hidden = el.dataset.show !== mode;
    for (const el of f.querySelectorAll('[data-label-local]')) {
      if (!el.dataset.labelDefault) el.dataset.labelDefault = el.textContent;
      el.textContent = mode === 'local' ? el.dataset.labelLocal : el.dataset.labelDefault;
    }
    $('create-btn').textContent = mode === 'online' ? 'Create game & get link' : mode === 'bot' ? 'Play the computer' : 'Start game';
  };
  for (const r of f.mode) r.addEventListener('change', syncMode);
  syncMode();

  f.addEventListener('submit', e => {
    e.preventDefault();
    const mode = f.mode.value;
    const name = f.name.value.trim() || (mode === 'local' ? 'Player 1' : 'Host');
    const rating = Math.round(+f.rating.value) || 1200;
    const name2 = f.name2.value.trim() || 'Player 2';
    const rating2 = Math.round(+f.rating2.value) || 1200;
    const botRating = +f.botRating.value;
    const clampInt = (v, max) => Math.max(0, Math.min(max, Math.round(+v) || 0));
    const help = { hints: clampInt(f.hints.value, 10), takebacks: clampInt(f.takebacks.value, 5) };
    const style = STYLE_LEVELS[+f.styleLevel.value].value;
    store.set('profile', { ...profile, name, rating, style, mode, tc: f.tc.value,
      botRating, name2: f.name2.value.trim(), rating2, hints: help.hints, takebacks: help.takebacks });
    gameId = randId();
    state = {
      id: gameId, v: 0, game: 1,
      mode,
      phase: 'lobby',
      turns: +f.turns.value,
      style,
      tc: parseTc(f),
      clock: null,
      help,
      used: freshUsed(),
      autoFlip: f.autoFlip.checked,
      colorPref: f.color.value,
      host: { name, rating },
      guest: mode === 'bot' ? { name: 'Computer', rating: botRating, bot: true }
        : mode === 'local' ? { name: name2, rating: rating2 } : null,
      white: null,
      moves: [], simCount: 0, sim: null,
      result: null, drawOffer: null, rematch: { host: false, guest: false },
    };
    role = 'host';
    saveHost();
    history.replaceState(null, '', `?game=${gameId}` + (SIGNAL ? `&signal=${SIGNAL}` : ''));
    getEngine(); // start loading Stockfish now so it's warm
    if (mode === 'online') {
      startHost();
      render();
    } else {
      if (mode === 'bot') getBotEngine();
      setConn(mode === 'bot' ? 'vs computer' : 'Same device', 'on');
      startGame(pickWhite());
    }
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
  if (conn && conn.open) conn.send({ t: 'state', state, now: Date.now() });
  render();
  maybeBotMove();
}

function hostHandle(c, msg) {
  if (!msg || typeof msg !== 'object') return;
  const isGuest = c === conn;
  switch (msg.t) {
    case 'hello':
      if (state.guest && state.guest.token === msg.token) {
        conn = c;
        setConn(`Connected to ${state.guest.name}`, 'on');
        c.send({ t: 'state', state, now: Date.now() });
      } else if (!state.guest) {
        c.send({ t: 'invite', host: state.host, turns: state.turns, style: state.style ?? 25, tc: state.tc || null, help: state.help || null });
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
  viewPly = null; stopAutoplay();
  Object.assign(state, {
    white, phase: 'simulating', moves: [], simCount: 0, sim: null, clock: null,
    result: null, drawOffer: null, rematch: { host: false, guest: false },
    used: freshUsed(), lastTakeback: null, undos: 0,
  });
  hint = null;
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
      const recent = store.get('recentStarts') || [];
      const res = await simulateOpening({
        whiteRating, blackRating, turns: state.turns, style: state.style ?? 25, avoid: recent,
        onMove: ({ san }) => { state.moves.push(san); broadcast(); },
      });
      state.sim = { evalWhite: res.evalWhite, target: res.target, favored: res.favored };
      const starts = [res.moves.slice(0, 4).join(' '), res.moves.slice(0, 8).join(' ')];
      store.set('recentStarts', [...starts, ...recent].slice(0, 40));
    } else {
      state.sim = { evalWhite: 0, target: 0, favored: null };
    }
    state.simCount = state.moves.length;
    const r = resultOf(chessFrom(state.moves));
    state.phase = r ? 'over' : 'playing';
    state.result = r;
    state.clock = state.tc && !r ? { w: state.tc.base, b: state.tc.base, since: Date.now() } : null;
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
      if (state.clock?.since) {
        const now = Date.now();
        const rem = state.clock[color] - (now - state.clock.since);
        if (rem <= 0) { flag(color); return; }
        state.clock[color] = rem + state.tc.inc;
        state.clock.since = now;
      }
      state.moves.push(m.san);
      state.drawOffer = null;
      const r = resultOf(c);
      if (r) endGame(r);
      break;
    }
    case 'resign':
      if (state.phase !== 'playing') return;
      endGame({ winner: other(color), reason: `${colorName(color)} resigned` });
      break;
    case 'offerDraw':
      if (state.phase !== 'playing' || state.drawOffer) return;
      if (state.mode === 'local') { endGame({ winner: null, reason: 'agreement' }); break; }
      state.drawOffer = color;
      if (state.mode === 'bot') botConsiderDraw();
      break;
    case 'acceptDraw':
      if (state.phase !== 'playing' || state.drawOffer !== other(color)) return;
      state.drawOffer = null;
      endGame({ winner: null, reason: 'agreement' });
      break;
    case 'declineDraw':
      if (state.drawOffer !== other(color)) return;
      state.drawOffer = null;
      break;
    case 'hint': {
      // The player's own browser computes the move; the host only keeps count.
      if (state.phase !== 'playing' || helpLeft(who, 'hints') <= 0) return;
      const c = chessFrom(state.moves);
      if (c.turn() !== color) return;
      state.used[who].hints++;
      break;
    }
    case 'takeback': {
      if (state.phase !== 'playing') return;
      // Same device: either player may take back their own last move.
      const col = state.mode === 'local' && (msg.color === 'w' || msg.color === 'b') ? msg.color : color;
      const owner = whoOf(col);
      const plies = takebackPlies(col);
      if (!plies || helpLeft(owner, 'takebacks') <= 0) return;
      if (state.clock?.since) {
        const t = chessFrom(state.moves).turn();
        const now = Date.now();
        state.clock[t] = Math.max(0, state.clock[t] - (now - state.clock.since));
        state.clock.since = now;
      }
      state.moves.splice(state.moves.length - plies, plies);
      state.used[owner].takebacks++;
      state.undos = (state.undos || 0) + 1;
      state.drawOffer = null;
      state.lastTakeback = { color: col, n: state.moves.length, undos: state.undos };
      break;
    }
    case 'rematch':
      if (state.phase !== 'over') return;
      state.rematch[who] = true;
      if (state.mode !== 'online' || (state.rematch.host && state.rematch.guest)) {
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

function endGame(result) {
  if (state.clock?.since) {
    const t = chessFrom(state.moves).turn();
    state.clock[t] = Math.max(0, state.clock[t] - (Date.now() - state.clock.since));
    state.clock.since = null;
  }
  state.result = result;
  state.phase = 'over';
}

/* ---------- hints & takebacks ---------- */
function freshUsed() { return { host: { hints: 0, takebacks: 0 }, guest: { hints: 0, takebacks: 0 } }; }
function helpLeft(who, kind) {
  if (!state?.help || state[who]?.bot) return 0;
  return Math.max(0, (state.help[kind] || 0) - (state.used?.[who]?.[kind] || 0));
}
// How many plies a takeback by `col` removes: 1 if they just moved, 2 if the opponent
// has already replied. 0 when they have no move of their own to take back (the
// simulated opening can't be undone).
function takebackPlies(col) {
  if (!state || state.phase !== 'playing') return 0;
  const n = state.moves.length;
  const plies = chessFrom(state.moves).turn() === col ? 2 : 1;
  return n - plies >= state.simCount ? plies : 0;
}

// Can `col` still deliver mate? (Used for "timeout vs insufficient material".)
function canMate(col, c) {
  const pieces = c.board().flat().filter(p => p && p.color === col && p.type !== 'k');
  if (pieces.length === 0) return false;
  if (pieces.length === 1 && (pieces[0].type === 'n' || pieces[0].type === 'b')) return false;
  return true;
}

function flag(color) {
  if (state.phase !== 'playing') return;
  state.clock[color] = 0;
  state.clock.since = null;
  const c = chessFrom(state.moves);
  const result = canMate(other(color), c)
    ? { winner: other(color), reason: 'time' }
    : { winner: null, reason: 'timeout vs insufficient material' };
  state.result = result;
  state.phase = 'over';
  broadcast();
}

/* ---------- computer opponent ---------- */
const botColor = () => (state.white === 'guest' ? 'w' : 'b');

async function maybeBotMove() {
  if (!state || state.mode !== 'bot' || role !== 'host' || state.phase !== 'playing' || botThinking) return;
  const c = chessFrom(state.moves);
  if (c.turn() !== botColor()) return;
  botThinking = true;
  const n = state.moves.length, game = state.game, undos = state.undos || 0;
  let stale = false;
  try {
    const rem = clockRemaining(botColor());
    const movetime = rem == null ? 900 : Math.max(120, Math.min(1500, rem / 40));
    const t0 = Date.now();
    const mv = await botMove(c.fen(), state.guest.rating, movetime);
    const humanPause = Math.min(300 + Math.random() * 600, rem == null ? 1e9 : rem / 60);
    const wait = humanPause - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    if (state.game === game && state.moves.length === n && (state.undos || 0) === undos && state.phase === 'playing') {
      botThinking = false;
      actOn('guest', { t: 'move', move: mv, n });
      return;
    }
    stale = true;
  } catch (err) {
    console.error('computer move failed', err);
  } finally {
    botThinking = false;
  }
  if (stale) setTimeout(maybeBotMove, 0); // the position changed (e.g. a takeback) while it was thinking
}

async function botConsiderDraw() {
  const game = state.game, n = state.moves.length;
  let accept = false;
  try {
    const c = chessFrom(state.moves);
    const ev = await quickEval(c.fen(), 10);              // side to move's view
    const botEval = c.turn() === botColor() ? ev : -ev;
    accept = botEval < -120 || (Math.abs(botEval) < 25 && state.moves.length > 80);
  } catch { /* decline */ }
  await sleep(700);
  if (state.game !== game || state.phase !== 'playing' || !state.drawOffer) return;
  if (accept) {
    state.drawOffer = null;
    endGame({ winner: null, reason: 'agreement' });
  } else {
    state.drawOffer = null;
    uiNote = 'The computer declined your draw offer.';
    setTimeout(() => { uiNote = null; render(); }, 4000);
  }
  if (state.moves.length >= n) broadcast();
}

/* ---------- clocks ---------- */
const hostNow = () => (role === 'guest' ? Date.now() + clockOffset : Date.now());
function clockRemaining(color) {
  const c = state?.clock;
  if (!c) return null;
  let r = c[color];
  if (c.since && state.phase === 'playing' && liveTurn === color) r -= hostNow() - c.since;
  return Math.max(0, r);
}
function fmtClock(ms) {
  if (ms >= 3600000) {
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  if (ms < 10000) return `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}.${Math.floor(ms / 100) % 10}`;
  const m = Math.floor(ms / 60000), sec = Math.floor(ms / 1000) % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function updateClocks() {
  if (!state) return;
  for (const el of document.querySelectorAll('.clock[data-color]')) {
    const col = el.dataset.color;
    const ms = clockRemaining(col);
    if (ms == null) { el.hidden = true; continue; }
    el.hidden = false;
    el.textContent = fmtClock(ms);
    el.classList.toggle('running', state.phase === 'playing' && !!state.clock.since && liveTurn === col);
    el.classList.toggle('low', ms < 20000 && state.phase === 'playing');
  }
}
setInterval(() => {
  if (!state) return;
  updateClocks();
  // the host (or the single device in offline modes) decides when a flag falls
  if (role === 'host' && state.phase === 'playing' && state.clock?.since) {
    const t = chessFrom(state.moves).turn();
    if (state.clock[t] - (Date.now() - state.clock.since) <= 0) flag(t);
  }
}, 100);

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
      if (msg.now) clockOffset = msg.now - Date.now();
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
    ? `The engine plays the first ${inv.turns} moves (${styleLabel(inv.style ?? 25).toLowerCase()} opening style), tilted toward the lower-rated player. Then it’s your game.`
    : 'A normal game from the starting position.';
  if (inv.tc) $('join-sub').textContent += ` Time control: ${tcLabel(inv.tc)}.`;
  if (inv.help && (inv.help.hints || inv.help.takebacks)) $('join-sub').textContent += ` Each player gets ${inv.help.hints} best-move hint${inv.help.hints === 1 ? '' : 's'} and ${inv.help.takebacks} takeback${inv.help.takebacks === 1 ? '' : 's'}.`;
  const f = $('join-form');
  f.hidden = false;
  if (profile.name) f.name.value = profile.name;
  if (profile.rating) f.rating.value = profile.rating;
  f.onsubmit = e => {
    e.preventDefault();
    const name = f.name.value.trim() || 'Friend';
    const rating = Math.round(+f.rating.value) || 1200;
    store.set('profile', { ...profile, name, rating });
    f.querySelector('button').disabled = true;
    conn.send({ t: 'join', name, rating, token: guestToken });
  };
}

/* ------------------------------------------------------------------ */
/* Player actions (both roles)                                         */
/* ------------------------------------------------------------------ */
const whoOf = col => (col === 'w' ? state.white : (state.white === 'host' ? 'guest' : 'host'));

function act(msg) {
  if (role === 'host') actOn(state.mode === 'local' ? whoOf(chessFrom(state.moves).turn()) : 'host', msg);
  else if (conn && conn.open) conn.send(msg);
}

function myColor() {
  if (!state || !state.white) return 'w';
  if (state.mode === 'local') return chessFrom(state.moves).turn();   // whoever is to move
  return state.white === role ? 'w' : 'b';
}

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

  const live = chessFrom(state.moves);
  if (viewPly != null && (viewPly >= state.moves.length || state.phase === 'simulating')) viewPly = null;
  const c = viewPly == null ? live : chessFrom(state.moves.slice(0, viewPly));
  liveTurn = live.turn();
  const mine = myColor();
  let base = mine;
  if (state.mode === 'local') base = state.autoFlip ? live.turn() : (state.white === 'host' ? 'w' : 'b');
  const orientation = flipped ? other(base) : base;
  const canMove = viewPly == null && state.phase === 'playing' && live.turn() === mine;
  const hist = c.history({ verbose: true });
  const last = hist[hist.length - 1];

  const key = `${state.game}|${state.moves.length}|${state.undos || 0}|${state.phase}|${orientation}|${viewPly}`;
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
  const showHint = hint && hint.game === state.game && hint.n === state.moves.length && viewPly == null && state.phase === 'playing';
  if (!showHint) hint = null;
  cg.setAutoShapes(showHint ? [{ orig: hint.from, dest: hint.to, brush: 'green' }] : []);
  const vb = $('viewing');
  vb.hidden = viewPly == null;
  if (viewPly != null) {
    const n = Math.ceil(viewPly / 2);
    const at = viewPly === 0 ? 'the start position' : `${n}${viewPly % 2 ? '.' : '…'} ${state.moves[viewPly - 1]}`;
    vb.textContent = `Viewing ${at} · tap to return to the game`;
  }

  renderPlayers(c, orientation, live);
  renderStatus(live, mine);
  renderHandicap();
  renderLearn();
  renderMoves();
  renderReview();
  renderActions(mine);
  renderOverlay(mine);
  updateClocks();
}

function playerOf(color) {
  const r = color === 'w' ? state.white : (state.white === 'host' ? 'guest' : 'host');
  return { ...state[r], role: r };
}

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const GLYPH = { w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕' }, b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' } };

// Material on the board: points per side, and which enemy pieces each side has captured.
function material(c) {
  const pts = { w: 0, b: 0 };
  const have = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of c.board()) for (const sq of row) {
    if (!sq || sq.type === 'k') continue;
    pts[sq.color] += VALUE[sq.type];
    have[sq.color][sq.type]++;
  }
  const captured = { w: [], b: [] }; // captured[w] = black pieces White has taken
  for (const col of ['w', 'b']) {
    const opp = other(col);
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const missing = Math.max(0, START[t] - have[opp][t]);
      for (let i = 0; i < missing; i++) captured[col].push(GLYPH[opp][t]);
    }
  }
  return { diff: pts.w - pts.b, captured };
}

function renderPlayers(c, orientation, live) {
  const mat = material(c);
  const fill = (el, color) => {
    const p = playerOf(color);
    el.innerHTML = '';
    const av = document.createElement('div');
    av.className = 'avatar ' + color;
    av.textContent = color === 'w' ? '♔' : '♚';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = p.name + (state.mode !== 'local' && p.role === role ? ' (you)' : '') + (p.bot ? ' 🤖' : '');
    const rt = document.createElement('span');
    rt.className = 'rating';
    rt.textContent = `(${p.rating})`;
    nm.appendChild(rt);
    const caps = document.createElement('div');
    caps.className = 'caps';
    const g = document.createElement('span');
    g.className = 'cap-glyphs';
    g.textContent = mat.captured[color].join('');
    caps.appendChild(g);
    const lead = color === 'w' ? mat.diff : -mat.diff;
    if (lead > 0) {
      const sc = document.createElement('span');
      sc.className = 'score';
      sc.textContent = `+${lead}`;
      sc.title = `${lead} point${lead > 1 ? 's' : ''} of material ahead (pawn 1, knight/bishop 3, rook 5, queen 9)`;
      caps.appendChild(sc);
    }
    // Counters on the player bars: your own are on the toolbar, so show them only for the
    // opponent (both players on a shared device).
    const helpOn = state.help && (state.help.hints || state.help.takebacks) && !p.bot && state.phase !== 'simulating'
      && (state.mode === 'local' || p.role !== role);
    if (helpOn) {
      const aids = document.createElement('span');
      aids.className = 'aids';
      const h = helpLeft(p.role, 'hints'), t = helpLeft(p.role, 'takebacks');
      const hs = document.createElement('span');
      hs.className = 'aid' + (h ? '' : ' out');
      hs.textContent = `💡${h}`;
      hs.title = `${h} best-move hint${h === 1 ? '' : 's'} left`;
      // On a shared device each player can tap their own ↶ to take back their last move.
      const local = state.mode === 'local';
      const ts = document.createElement(local ? 'button' : 'span');
      ts.className = 'aid' + (t ? '' : ' out');
      ts.textContent = `↶${t}`;
      ts.title = `${t} takeback${t === 1 ? '' : 's'} left` + (local ? ' — tap to take back this player’s last move' : '');
      if (local) {
        ts.type = 'button';
        ts.disabled = !t || !takebackPlies(color) || viewPly != null;
        ts.onclick = () => act({ t: 'takeback', color });
      }
      aids.append(hs, ts);
      caps.appendChild(aids);
    }
    nm.appendChild(caps);
    const dot = document.createElement('div');
    dot.className = 'turn-dot';
    const clk = document.createElement('div');
    clk.className = 'clock';
    clk.dataset.color = color;
    clk.hidden = true;
    el.append(av, nm, dot, clk);
    el.classList.toggle('to-move', state.phase === 'playing' && live.turn() === color);
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
    const check = c.inCheck() ? ' — check!' : '';
    if (state.mode === 'local') el.textContent = `${playerOf(c.turn()).name} to move (${colorName(c.turn())})${check}`;
    else if (state.mode === 'bot' && c.turn() !== mine) el.textContent = 'The computer is thinking…';
    else el.textContent = c.turn() === mine ? (c.inCheck() ? 'Your move — you’re in check!' : 'Your move') : `Waiting for ${opp}…`;
  } else if (state.phase === 'over') {
    el.textContent = resultText(mine);
  }
  if (state.phase !== 'simulating' || state.moves.length) {
    const d = material(c).diff;
    const line = document.createElement('div');
    line.className = 'material-line';
    line.textContent = (d === 0 ? 'Material: even' : `Material: ${playerOf(d > 0 ? 'w' : 'b').name} +${Math.abs(d)}`)
      + (state.tc ? ` · ⏱ ${tcLabel(state.tc)}` : '');
    line.title = 'Pawn = 1, knight/bishop = 3, rook = 5, queen = 9';
    el.appendChild(line);
  }
}

function resultText(mine) {
  const r = state.result;
  if (!r) return '';
  if (!r.winner) return `Draw — ${r.reason}`;
  const who = state.mode !== 'local' && r.winner === mine ? 'You won' : `${playerOf(r.winner).name} won`;
  return `${who} — ${r.reason === 'time' ? 'on time' : r.reason}`;
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
  $('moves-sub').textContent = !total ? '' : viewPly != null ? `Reviewing move ${Math.ceil(viewPly / 2) || 0}`
    : `${Math.ceil(total / 2)} move${total > 2 ? 's' : ''}` + (state.simCount && state.phase !== 'simulating' ? ` · ${Math.ceil(state.simCount / 2)} by the engine` : '');
  for (let i = 0; i < total; i += 2) {
    if (i === simEnd && simEnd > 0) ol.appendChild(divider());
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = (i / 2 + 1) + '.';
    li.appendChild(n);
    for (const j of [i, i + 1]) {
      const m = document.createElement('span');
      const shown = viewPly == null ? total : viewPly;
      m.className = 'm' + (j < simEnd ? ' sim' : '') + (j === shown - 1 ? ' last' : '');
      m.textContent = state.moves[j] || '';
      if (state.moves[j] && state.phase !== 'simulating') {
        m.classList.add('click');
        m.onclick = () => goTo(j + 1);
      }
      li.appendChild(m);
    }
    ol.appendChild(li);
    // the sim can end on White's move — put the divider inside the move pair
    if (simEnd === i + 1 && simEnd < total && state.phase !== 'simulating') ol.appendChild(divider());
  }
  if (total === simEnd && simEnd > 0 && state.phase !== 'simulating') ol.appendChild(divider());
  if (viewPly == null) ol.scrollTop = ol.scrollHeight;
  else ol.querySelector('.m.last')?.scrollIntoView({ block: 'nearest' });
  function divider() {
    const d = document.createElement('li');
    d.className = 'divider';
    d.textContent = 'Your game starts here';
    return d;
  }
}

/* ---------- reviewing moves ---------- */
function goTo(ply) {
  stopAutoplay();
  if (!state || state.phase === 'simulating') return;
  ply = Math.max(0, Math.min(state.moves.length, ply));
  viewPly = ply >= state.moves.length ? null : ply;
  render();
}
function stopAutoplay() { if (autoplay) { clearInterval(autoplay); autoplay = null; } }
function playThroughOpening() {
  stopAutoplay();
  viewPly = 0;
  render();
  autoplay = setInterval(() => {
    if (viewPly == null || viewPly >= state.simCount) { stopAutoplay(); render(); return; }
    viewPly++;
    if (viewPly >= state.moves.length) viewPly = null;
    render();
  }, 900);
}
function renderReview() {
  const cur = viewPly == null ? state.moves.length : viewPly;
  const off = state.phase === 'simulating' || !state.moves.length;
  $('nav-first').disabled = off || cur === 0;
  $('nav-prev').disabled = off || cur === 0;
  $('nav-next').disabled = off || viewPly == null;
  $('nav-last').disabled = off || viewPly == null;
}
$('nav-first').onclick = () => goTo(0);
$('nav-prev').onclick = () => goTo((viewPly == null ? state.moves.length : viewPly) - 1);
$('nav-next').onclick = () => goTo((viewPly ?? state.moves.length) + 1);
$('nav-last').onclick = () => goTo(Infinity);
$('viewing').onclick = () => goTo(Infinity);
document.addEventListener('keydown', e => {
  if (!state || $('screen-game').hidden || e.target.closest('input, textarea')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); $('nav-prev').click(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); $('nav-next').click(); }
});

/* ---------- learn about the opening ---------- */
let learnKey = '';
function renderLearn() {
  const box = $('learn');
  if (state.phase === 'simulating' || !state.simCount) { box.hidden = true; learnKey = ''; return; }
  const simMoves = state.moves.slice(0, state.simCount);
  const key = state.game + '|' + simMoves.join(' ');
  if (key === learnKey) return;
  const info = identify(simMoves);
  if (!info) { loadOpenings().then(() => render()); return; }
  learnKey = key;
  box.hidden = false;
  $('learn-name').textContent = info.name;
  const body = $('learn-body');
  body.innerHTML = '';
  const add = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; body.appendChild(e); return e; };

  const head = add('div', 'learn-head');
  const eco = document.createElement('span'); eco.className = 'eco'; eco.textContent = info.eco;
  const nm = document.createElement('b'); nm.textContent = info.name;
  const st = document.createElement('span'); st.className = 'chip'; st.textContent = `${styleLabel(state.style ?? 25)} style`;
  head.append(eco, nm, st);

  add('p', null, describe(info, state.style ?? 25));

  let theory;
  const bp = info.bookPly;
  if (bp === 0) theory = 'The engine left known opening theory on the very first move.';
  else if (bp >= simMoves.length) theory = `Every simulated move is known opening theory.`;
  else if (bp === 1) theory = 'Only the first move is known theory; after that the engine improvised.';
  else theory = `Known theory up to ${Math.ceil(bp / 2)}${bp % 2 ? '.' : '…'} ${simMoves[bp - 1]}; after that the engine improvised.`;
  add('p', 'muted-p', theory);

  const row = add('div', 'learn-actions');
  const replay = btn('▶ Replay on the board', 'primary small', () => playThroughOpening());
  row.appendChild(replay);
  const links = add('div', 'learn-links');
  const link = (href, text) => { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text; links.appendChild(a); };
  const end = chessFrom(simMoves).fen();
  if (info.family) link(lichessOpeningUrl(info.name), 'Opening on Lichess ↗');
  link(lichessAnalysisUrl(end), 'Analyze this position ↗');
  if (info.family) link(wikipediaUrl(info.family), 'Read on Wikipedia ↗');
}

function renderActions(mine) {
  const playing = state.phase === 'playing';
  $('btn-draw').disabled = !playing || !!state.drawOffer;
  setTbtn($('btn-draw'), '½', 'Draw');
  $('btn-draw').title = state.mode === 'local' ? 'Agree to a draw' : 'Offer a draw';
  $('btn-resign').disabled = !playing;
  if (!$('btn-resign').dataset.armed) setTbtn($('btn-resign'), '⚑', 'Resign');
  $('btn-resign').title = state.mode === 'local' && playing ? `${colorName(liveTurn)} resigns` : 'Resign';
  renderHelpButtons(mine, playing);
  const n = $('notice');
  n.innerHTML = '';
  n.hidden = true;
  n.classList.remove('hint-card');
  if (uiNote) { n.hidden = false; n.textContent = uiNote; }
  const tb = state.lastTakeback;
  if (playing && tb && tb.n === state.moves.length && tb.undos === state.undos && !uiNote) {
    n.hidden = false;
    n.textContent = state.mode !== 'local' && tb.color === mine ? 'You took back your last move.'
      : `${playerOf(tb.color).name} took back their last move.`;
  }
  if (playing && hint && hint.game === state.game && hint.n === state.moves.length && viewPly == null && hintHidden !== `${hint.game}|${hint.n}`) {
    n.hidden = false;
    n.innerHTML = '';
    n.classList.add('hint-card');
    const line = document.createElement('div');
    line.className = 'hint-line';
    line.append('💡 Best move: ');
    const b = document.createElement('b');
    b.textContent = hint.san;
    line.appendChild(b);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'hint-close';
    close.setAttribute('aria-label', 'Hide hint');
    close.textContent = '×';
    close.onclick = () => { hintHidden = `${hint.game}|${hint.n}`; render(); };
    line.appendChild(close);
    const ul = document.createElement('ul');
    ul.className = 'hint-why';
    for (const r of hint.reasons || []) { const li = document.createElement('li'); li.textContent = r; ul.appendChild(li); }
    const v = document.createElement('p');
    v.className = 'hint-verdict';
    v.textContent = hint.verdict || '';
    n.append(line, ul, v);
    if (hint.line) {
      const pl = document.createElement('p');
      pl.className = 'hint-pv';
      pl.textContent = `Engine’s expected line: ${hint.line}`;
      n.appendChild(pl);
    }
  }
  if (playing && state.drawOffer) {
    n.hidden = false;
    if (state.drawOffer === mine) {
      n.textContent = state.mode === 'bot' ? 'Draw offered. The computer is thinking about it…' : 'Draw offered. Waiting for a reply…';
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

// Toolbar buttons: an icon, a short label and an optional count badge.
function setTbtn(b, icon, label, count) {
  b.textContent = icon;
  const l = document.createElement('span');
  l.className = 'tl';
  l.textContent = label;
  b.appendChild(l);
  if (count != null) {
    const c = document.createElement('span');
    c.className = 'cnt';
    c.textContent = count;
    b.appendChild(c);
  }
}

function renderHelpButtons(mine, playing) {
  const cfg = state.help || { hints: 0, takebacks: 0 };
  const me = whoOf(mine);
  const isBot = state.mode === 'bot' && playerOf(mine).bot;
  const off = state.phase === 'simulating' || isBot;
  const live = viewPly == null;
  const myTurn = liveTurn === mine;
  const hLeft = helpLeft(me, 'hints'), tLeft = helpLeft(me, 'takebacks');
  const hb = $('btn-hint');
  hb.hidden = !cfg.hints || off;
  setTbtn(hb, '💡', hintBusy ? 'Thinking…' : 'Hint', hLeft);
  const showing = hint && hint.game === state.game && hint.n === state.moves.length;
  hb.disabled = !playing || !live || !myTurn || !hLeft || hintBusy || showing;
  hb.title = !hLeft ? 'No hints left this game' : !myTurn ? 'Hints are available on your turn' : 'Show the engine’s best move, and why';
  const tbtn = $('btn-takeback');
  tbtn.hidden = !cfg.takebacks || off;
  setTbtn(tbtn, '↶', 'Undo', tLeft);
  const plies = takebackPlies(mine);
  tbtn.disabled = !playing || !live || !tLeft || !plies;
  tbtn.title = !tLeft ? 'No takebacks left this game' : !plies ? 'You haven’t made a move yet'
    : plies === 2 ? 'Take back your last move and your opponent’s reply' : 'Take back your last move';
}

async function requestHint() {
  if (hintBusy || !state || state.phase !== 'playing' || viewPly != null) return;
  const mine = myColor();
  const live = chessFrom(state.moves);
  if (live.turn() !== mine || helpLeft(whoOf(mine), 'hints') <= 0) return;
  const game = state.game, n = state.moves.length, undos = state.undos || 0, fen = live.fen();
  hintBusy = true;
  // count it right away (the guest updates locally too; the host's state confirms)
  if (role === 'guest') state.used[whoOf(mine)].hints++;
  act({ t: 'hint', n });
  render();
  try {
    const analysis = await hintAnalysis(fen, 14);
    if (analysis.lines[0]?.uci && state.game === game && state.moves.length === n && (state.undos || 0) === undos) {
      const ex = explainHint(fen, analysis);
      hint = { game, n, ...ex };
    }
  } catch (err) {
    console.error('hint failed', err);
    uiNote = 'Couldn’t compute a hint — the engine failed to load.';
    setTimeout(() => { uiNote = null; render(); }, 4000);
  } finally {
    hintBusy = false;
  }
  render();
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
  h.textContent = !r?.winner ? 'Draw'
    : state.mode !== 'local' && r.winner === mine ? 'You won!' : `${playerOf(r.winner).name} won`;
  const p = document.createElement('p');
  p.textContent = r ? (r.reason === 'time' ? 'on time' : `by ${r.reason}`) : '';
  const meReq = state.rematch[role];
  const themReq = state.rematch[role === 'host' ? 'guest' : 'host'];
  const online = state.mode === 'online';
  const rb = btn(online ? (meReq ? 'Waiting for friend…' : themReq ? 'Accept rematch' : 'Rematch (swap colors)') : 'Play again (swap colors)', 'primary', () => act({ t: 'rematch' }));
  rb.disabled = online && meReq;
  const info = document.createElement('p');
  info.textContent = online && themReq && !meReq ? 'Your friend wants a rematch!' : '';
  const close = btn('View board', 'ghost', () => { ov.dataset.dismissed = `${state.game}`; ov.hidden = true; });
  const fresh = btn('New game', 'ghost', () => { location.href = location.pathname + (SIGNAL ? `?signal=${SIGNAL}` : ''); });
  box.append(h, p, info, rb, close, fresh);
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
  if (b.dataset.armed) { clearTimeout(resignTimer); delete b.dataset.armed; setTbtn(b, '⚑', 'Resign'); act({ t: 'resign' }); return; }
  b.dataset.armed = '1';
  setTbtn(b, '⚑', 'Sure?');
  resignTimer = setTimeout(() => { delete b.dataset.armed; setTbtn(b, '⚑', 'Resign'); }, 3000);
};
$('btn-draw').onclick = () => act({ t: 'offerDraw' });
$('btn-flip').onclick = () => { flipped = !flipped; render(); };
for (const head of document.querySelectorAll('.sec-head')) {
  head.addEventListener('click', () => {
    const sec = head.parentElement;
    const open = !sec.classList.contains('open');
    // accordion: one section at a time keeps the panel calm
    for (const other of document.querySelectorAll('.sec')) {
      other.classList.toggle('open', other === sec ? open : false);
      other.querySelector('.sec-head').setAttribute('aria-expanded', other.classList.contains('open'));
    }
    if (!open && sec.id === 'learn') { // closing the opening shows the moves again
      const mv = $('moves-sec'); mv.classList.add('open'); mv.querySelector('.sec-head').setAttribute('aria-expanded', 'true');
    }
  });
}
$('btn-hint').onclick = () => requestHint();
$('btn-takeback').onclick = () => { hint = null; act({ t: 'takeback' }); };

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
loadOpenings().then(() => { if (state) render(); });

/* ------------------------------------------------------------------ */
/* Installable app + offline support                                   */
/* ------------------------------------------------------------------ */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('service worker', err));
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('install-btn').hidden = false;
});
$('install-btn').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $('install-btn').hidden = true;
};
window.addEventListener('appinstalled', () => { $('install-btn').hidden = true; toast('Installed! You can now open Skip Chess from your home screen.'); });

function toast(text, ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function syncOnline() {
  const f = $('create-form');
  const offline = !navigator.onLine;
  if (f) $('offline-note').hidden = !(offline && f.mode.value === 'online');
  const btn = $('create-btn');
  if (btn && f) btn.disabled = offline && f.mode.value === 'online';
}
window.addEventListener('online', () => { syncOnline(); if (state?.mode === 'online') toast('Back online.'); });
window.addEventListener('offline', () => { syncOnline(); if (state?.mode === 'online') toast('You are offline. The game will reconnect when the internet is back.'); });
for (const r of document.querySelectorAll('#create-form input[name=mode]')) r.addEventListener('change', syncOnline);
syncOnline();
if (!gameId) {
  initCreate();
} else {
  const hosted = store.get('host:' + gameId);
  if (hosted) {
    role = 'host';
    state = hosted;
    state.mode = state.mode || 'online';
    render();
    if (state.phase === 'simulating' || !state.guest) getEngine();
    if (state.mode === 'online') startHost();
    else {
      setConn(state.mode === 'bot' ? 'vs computer' : 'Same device', 'on');
      if (state.phase === 'simulating') runSimulation();
      maybeBotMove();
    }
  } else {
    startGuest();
  }
}

// exposed for debugging / tests
window.__skip = { get state() { return state; }, get role() { return role; }, targetAdvantage };
