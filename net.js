// Talks to Firebase (free Spark plan) through its plain web (REST) interface:
// anonymous sign-in, reading/writing the Realtime Database, and live updates.
// No Firebase SDK and no other service is used.
import { firebaseConfig as CFG } from './firebase-config.js';

// `?fb=http://127.0.0.1:9100` points everything at a local fake Firebase (used for testing).
const FB = new URLSearchParams(location.search).get('fb');
const DB = FB ? `${FB}/db` : CFG.databaseURL;
const AUTH = FB ? `${FB}/auth` : 'https://identitytoolkit.googleapis.com';
const TOKEN = FB ? `${FB}/token` : 'https://securetoken.googleapis.com';
// `?slot=2` keeps a second, separate player on the same browser (for testing with two tabs).
const SLOT = new URLSearchParams(location.search).get('slot');
const LS = (FB ? 'fbAuth:test' : 'fbAuth') + (SLOT ? `:${SLOT}` : '');

export const TIMESTAMP = { '.sv': 'timestamp' };
export const NO_ETAG = 'null_etag';     // "only write if nothing is there yet"

let auth = null;
try { auth = JSON.parse(localStorage.getItem(LS)); } catch { /* ignore */ }
let signing = null;
let serverOffset = 0;

const save = () => { try { localStorage.setItem(LS, JSON.stringify(auth)); } catch { /* ignore */ } };
export const myUid = () => auth?.uid || null;
export const nowS = () => Date.now() + serverOffset;   // server-aligned clock

async function post(url, body, form) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `HTTP ${r.status}`), { status: r.status });
  return j;
}

async function doSignIn(force) {
  if (auth?.refreshToken && (force || !auth.idToken || Date.now() > auth.exp - 120000)) {
    try {
      const j = await post(`${TOKEN}/v1/token?key=${CFG.apiKey}`, { grant_type: 'refresh_token', refresh_token: auth.refreshToken }, true);
      auth = { uid: j.user_id, idToken: j.id_token, refreshToken: j.refresh_token, exp: Date.now() + (+j.expires_in || 3600) * 1000 };
      save();
      return;
    } catch (err) {
      if (err.status !== 400) throw err;     // 400 = the account is gone: make a new one below
      auth = null;
    }
  }
  if (!auth?.refreshToken) {
    const j = await post(`${AUTH}/v1/accounts:signUp?key=${CFG.apiKey}`, { returnSecureToken: true });
    auth = { uid: j.localId, idToken: j.idToken, refreshToken: j.refreshToken, exp: Date.now() + (+j.expiresIn || 3600) * 1000 };
    save();
  }
}

/** Make sure we have a (free, anonymous) account and a fresh token. */
export async function signIn(force = false) {
  if (!force && auth?.idToken && Date.now() < auth.exp - 120000) return auth.uid;
  if (!signing) signing = doSignIn(force).finally(() => { signing = null; });
  await signing;
  return auth.uid;
}

async function token() { await signIn(); return auth.idToken; }

/** One REST call. Returns { ok, status, val, etag }; never throws on HTTP errors (only on network errors). */
async function call(path, { method = 'GET', body, ifMatch, query = '' } = {}, retried = false) {
  const headers = { 'X-Firebase-ETag': 'true' };
  if (ifMatch) headers['if-match'] = ifMatch;
  const r = await fetch(`${DB}/${path}.json?auth=${await token()}${query}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 && !retried && /expired|token/i.test(await r.clone().text())) {
    await signIn(true);
    return call(path, { method, body, ifMatch, query }, true);
  }
  const text = await r.text();
  let val = null;
  try { val = JSON.parse(text); } catch { /* empty */ }
  return { ok: r.ok, status: r.status, val, etag: r.headers.get('ETag') };
}

export const db = {
  get: (path, query) => call(path, { query }),
  put: (path, val, ifMatch) => call(path, { method: 'PUT', body: val, ifMatch }),
  patch: (path, val) => call(path, { method: 'PATCH', body: val }),
  del: path => call(path, { method: 'DELETE' }),
};

/** Measure the difference between our clock and the server's (so both players' clocks agree). */
export async function syncClock() {
  const t0 = Date.now();
  const r = await db.put(`users/${myUid()}/seen`, TIMESTAMP);
  const t1 = Date.now();
  if (r.ok && typeof r.val === 'number') serverOffset = r.val - (t0 + t1) / 2;
  return serverOffset;
}

function setAt(root, path, data) {
  const keys = path.split('/').filter(Boolean);
  if (!keys.length) return data;
  const out = root && typeof root === 'object' ? root : {};
  let o = out;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!o[keys[i]] || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (data === null) delete o[last]; else o[last] = data;
  return out;
}

/**
 * Live updates for a path. onValue(value) gets the whole value at `path` after every change.
 * onStatus('on' | 'off' | 'denied'). Returns a stop() function.
 */
export function listen(path, onValue, onStatus = () => {}) {
  let es = null, stopped = false, value = null, retry = null;
  const open = async () => {
    if (stopped) return;
    let t;
    try { t = await token(); } catch { onStatus('off'); retry = setTimeout(open, 4000); return; }
    es = new EventSource(`${DB}/${path}.json?auth=${t}`);
    es.onopen = () => onStatus('on');
    const apply = (e, patch) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg) return;
      if (patch) {
        for (const [k, v] of Object.entries(msg.data || {})) value = setAt(value, `${msg.path}/${k}`, v);
      } else {
        value = setAt(value, msg.path, msg.data);
      }
      onValue(value);
    };
    es.addEventListener('put', e => apply(e, false));
    es.addEventListener('patch', e => apply(e, true));
    es.addEventListener('cancel', () => { onStatus('denied'); es.close(); });
    es.addEventListener('auth_revoked', async () => {   // token expired: reopen with a new one
      es.close();
      try { await signIn(true); } catch { /* retry below */ }
      open();
    });
    es.onerror = () => {
      onStatus('off');
      if (es.readyState === EventSource.CLOSED) { retry = setTimeout(open, 3000); }
    };
  };
  open();
  return () => { stopped = true; clearTimeout(retry); es?.close(); };
}
