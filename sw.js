// Service worker : l'application fonctionne hors ligne (bibliothèque et lecture des livres déjà
// importés). Les modules PDF/EPUB chargés depuis le CDN sont mis en cache au premier usage.
const VERSION = 'v2.0.0';
const SHELL = `shell-${VERSION}`;
const RUNTIME = 'runtime-v2';
const APP_SHELL = [
    './', './index.html', './manifest.json', './css/app.css',
    './js/app.js', './js/text.js', './js/extract.js', './js/sources.js', './js/store.js',
    './js/engine.js', './js/cloud.js', './js/config.js', './js/mood.js', './js/ambience.js',
    './icons/icon-32.png', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|www\.gstatic\.com\/firebasejs)\//;

self.addEventListener('install', event => {
    event.waitUntil(caches.open(SHELL).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    // Bibliothèques versionnées du CDN : cache d'abord (elles ne changent jamais)
    if (CDN.test(request.url)) {
        event.respondWith(caches.open(RUNTIME).then(async cache => {
            const hit = await cache.match(request);
            if (hit) return hit;
            const res = await fetch(request);
            if (res.ok) cache.put(request, res.clone());
            return res;
        }));
        return;
    }

    if (url.origin !== self.location.origin || url.pathname.includes('/proxy/')) return;

    // Fichiers de l'application : réseau d'abord (toujours la dernière version), cache hors ligne
    event.respondWith(
        fetch(request)
            .then(res => {
                if (res.ok && url.search === '') {
                    const copy = res.clone();
                    caches.open(SHELL).then(c => c.put(request, copy));
                }
                return res;
            })
            .catch(() => caches.match(request, { ignoreSearch: true })
                .then(hit => hit || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
    );
});
