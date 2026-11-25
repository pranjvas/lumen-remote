// Offline shell only: network-first for the app's static files, falling back to the cache.
// API, upload, MCP and the live WebSocket are never cached or intercepted.

const CACHE = 'lumen-shell-v33';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/browser',
  '/browser.webmanifest',
  '/icons/lumen-browser.svg',
  '/js/ui/install-hint.js',
  '/css/tokens.css',
  '/css/base.css',
  '/css/components.css',
  '/css/remote.css',
  '/css/views.css',
  '/css/screen.css',
  '/css/ask.css',
  '/js/boot-theme.js',
  '/js/main.js',
  '/icons/lumen.svg',
  '/fonts/geist-var.woff2',
  '/fonts/geist-mono-var.woff2',
];
const NEVER = /^\/(api|live|mcp|cast)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page reports the static files it actually loaded (all its ES modules), so the offline
// shell is complete from the first visit without a hand-kept list.
self.addEventListener('message', (event) => {
  if (event.data?.t !== 'shell' || !Array.isArray(event.data.paths)) return;
  const paths = event.data.paths.filter((p) => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !NEVER.test(p));
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(paths.map((p) => cache.add(p).catch(() => {})))));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match(url.pathname === '/browser' ? '/browser' : '/') : Response.error()))),
  );
});
