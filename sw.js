'use strict';

// Increase VERSION whenever index.html or the PWA assets change.
const VERSION = '2026-09-10-1';
const SCOPE = new URL(self.registration.scope);
const PREFIX = `budget-book-shell:${SCOPE.pathname}:`;
const CACHE = `${PREFIX}${VERSION}`;
const INDEX = new URL('index.html', SCOPE).href;
const SHELL = ['index.html', 'manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png']
  .map(path => new URL(path, SCOPE).href);
const LIBRARIES = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js'
];
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
const ALLOWED = new Set([...SHELL, ...LIBRARIES, FONT_CSS]);

function isInterFont(url) {
  return url.origin === 'https://fonts.gstatic.com' && url.pathname.startsWith('/s/inter/');
}

function canCache(response) {
  return response && (response.ok || response.type === 'opaque');
}

async function download(url) {
  const local = new URL(url).origin === SCOPE.origin;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      cache: 'reload',
      mode: local ? 'same-origin' : 'cors',
      credentials: local ? 'same-origin' : 'omit',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Shell download failed: ${url}`);
    // Keep the timeout active through the body, not just the response headers.
    await response.clone().arrayBuffer();
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function warmFont(cache) {
  try {
    const response = await download(FONT_CSS);
    const css = await response.clone().text();
    await cache.put(FONT_CSS, response);
    const urls = [...css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)]
      .map(match => new URL(match[1], FONT_CSS))
      .filter(isInterFont);
    await Promise.allSettled([...new Set(urls.map(url => url.href))].map(async url => {
      await cache.put(url, await download(url));
    }));
  } catch (_) {
    // A font outage must not prevent installation. The UI has a system fallback.
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const urls = [...SHELL, ...LIBRARIES];
    const responses = await Promise.all(urls.map(download));
    const cache = await caches.open(CACHE);
    await Promise.all(urls.map((url, i) => cache.put(url, responses[i])));
    await warmFont(cache);
    // An update stays waiting until the user presses Update.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

async function staleWhileRevalidate(event, key) {
  let cache;
  let cached;
  try {
    cache = await caches.open(CACHE);
    cached = await cache.match(key);
  } catch (_) {
    // Storage restrictions must not break an otherwise working network request.
  }
  const refresh = fetch(event.request, { cache: 'no-cache' }).then(async response => {
    if (cache && canCache(response)) {
      try { await cache.put(key, response.clone()); } catch (_) { /* Storage may be full. */ }
    }
    return response;
  });
  event.waitUntil(refresh.catch(() => undefined));
  if (cached) return cached;
  try {
    return await refresh;
  } catch (_) {
    return Response.error();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  // Budget requests and authenticated traffic always go directly to the network.
  if (request.method !== 'GET' || request.headers.has('authorization')) return;
  const url = new URL(request.url);
  const document = request.mode === 'navigate' && url.origin === SCOPE.origin &&
    (url.pathname === SCOPE.pathname || url.pathname === new URL(INDEX).pathname);
  if (document) {
    event.respondWith(staleWhileRevalidate(event, INDEX));
  } else if (ALLOWED.has(url.href) || isInterFont(url)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});
