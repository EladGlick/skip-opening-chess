// Service worker: makes Skip Opening Chess installable and playable offline.
//
// Strategy
//  - Big, versioned library files (vendor/…, icons): cache-first. They never change in place.
//  - Our own code (html/js/css/manifest): network-first, so updates show up right away
//    when online, with the cached copy as the offline fallback.
//  - Third-party data (Lichess opening names, Google Fonts): stale-while-revalidate.
const VERSION = 'v1';
const CORE = `core-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;

const VENDOR = [
  'vendor/chess.js',
  'vendor/peerjs.min.js',
  'vendor/chessground/chessground.min.js',
  'vendor/chessground/chessground.base.css',
  'vendor/chessground/chessground.cburnett.css',
  'vendor/stockfish/stockfish-18-lite-single.js',
  'vendor/stockfish/stockfish-18-lite-single.wasm',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];
const APP = ['./', 'index.html', 'app.js', 'engine.js', 'openings.js', 'style.css', 'manifest.webmanifest'];
const OPENINGS = 'https://raw.githubusercontent.com/lichess-org/chess-openings/a6189a30dc273ccb21fc2536a9a2fefd5592a67a/';
const EXTRA = [...'abcde'].map(x => `${OPENINGS}${x}.tsv`);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE);
    await core.addAll([...APP, ...VENDOR]);
    // Nice-to-have data: don't fail the install if it can't be fetched right now.
    const rt = await caches.open(RUNTIME);
    await Promise.all(EXTRA.map(u => rt.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CORE && key !== RUNTIME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const isVendor = url => url.pathname.includes('/vendor/') || url.pathname.includes('/icons/');

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never touch live game traffic (PeerJS signalling, Firebase, Google APIs).
  const live = ['peerjs', 'firebase', 'firebaseio', 'googleapis.com', 'gstatic.com/firebasejs'];
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!isFont && live.some(k => (url.hostname + url.pathname).includes(k))) return;

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      // Any page (e.g. ?game=abc) is the same app shell.
      event.respondWith(networkFirst(req, 'index.html'));
    } else if (isVendor(url)) {
      event.respondWith(cacheFirst(req));
    } else {
      event.respondWith(networkFirst(req));
    }
    return;
  }

  if (url.hostname === 'raw.githubusercontent.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CORE)).put(req, res.clone());
  return res;
}

async function networkFirst(req, fallbackPath) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CORE)).put(fallbackPath || req, res.clone());
    return res;
  } catch {
    const hit = await caches.match(fallbackPath || req, { ignoreSearch: true });
    if (hit) return hit;
    if (fallbackPath) return caches.match('./');
    throw new Error('offline and not cached');
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(req);
  const fresh = fetch(req).then(res => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await fresh) || new Response('', { status: 504 });
}
