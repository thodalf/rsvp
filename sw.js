// Service worker minimal : met en cache la coquille de l'app (HTML/manifeste/icônes) pour
// permettre l'installation en webapp et un chargement hors-ligne de l'interface. Les livres,
// Firebase et les API externes (Gutenberg, Google Books) nécessitent toujours une connexion.
const CACHE_NAME = 'rsvp-shell-v1';
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) {
        return;
    }

    if (request.mode === 'navigate') {
        // Document principal : réseau d'abord (pour avoir la dernière version), repli sur le cache hors-ligne
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone));
                    return response;
                })
                .catch(() => caches.match('./index.html'))
        );
        return;
    }

    // Autres ressources same-origin (manifeste, icônes) : cache d'abord, repli sur le réseau
    event.respondWith(
        caches.match(request).then((cached) => cached || fetch(request))
    );
});
