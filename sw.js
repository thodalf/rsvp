// Service worker de la webapp :
// - tout fonctionne hors ligne (application, livres déjà importés, ouverture de PDF/EPUB) ;
// - reçoit les fichiers et liens partagés depuis d'autres apps (cible de partage) ;
// - les mises à jour sont installées en arrière-plan puis appliquées quand l'app le demande,
//   pour ne jamais recharger la page au milieu d'une lecture.
const VERSION = 'v2.2.0';
const SHELL = `shell-${VERSION}`;
const RUNTIME = 'runtime-v2';
const INBOX = 'share-inbox';

const APP_SHELL = [
    './', './index.html', './manifest.json', './css/app.css',
    './js/app.js', './js/text.js', './js/extract.js', './js/sources.js', './js/store.js',
    './js/engine.js', './js/cloud.js', './js/config.js', './js/mood.js', './js/ambience.js', './js/pwa.js',
    './icons/favicon.svg', './icons/icon-32.png', './icons/icon-180.png', './icons/icon-192.png',
    './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png'
];
// Modules de lecture PDF/EPUB : mis en cache dès l'installation pour importer des fichiers hors ligne.
const CDN_LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|www\.gstatic\.com\/firebasejs)\//;

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const shell = await caches.open(SHELL);
        await shell.addAll(APP_SHELL);
        const runtime = await caches.open(RUNTIME);
        // Facultatif : sans réseau vers le CDN, l'installation réussit quand même.
        await Promise.allSettled(CDN_LIBS.map(async url => {
            if (!(await runtime.match(url))) await runtime.add(url);
        }));
        // Première installation : actif tout de suite. Mise à jour : attend le feu vert de l'app.
        if (!self.registration.active) await self.skipWaiting();
    })());
});

self.addEventListener('message', event => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => ![SHELL, RUNTIME, INBOX].includes(k)).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

async function receiveShare(request) {
    const form = await request.formData();
    const params = new URLSearchParams();
    for (const key of ['title', 'text', 'url']) {
        const v = form.get(key);
        if (typeof v === 'string' && v.trim()) params.set(key, v.trim());
    }
    const file = form.getAll('file').find(f => f && typeof f !== 'string' && f.size > 0);
    if (file) {
        const inbox = await caches.open(INBOX);
        await inbox.put('./share-inbox/file', new Response(file, {
            headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'fichier') }
        }));
        params.set('action', 'shared-file');
    }
    return Response.redirect(new URL('./?' + params, self.registration.scope).href, 303);
}

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    if (request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
        event.respondWith(receiveShare(request));
        return;
    }
    if (request.method !== 'GET') return;

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

    // Page d'accueil : on sert la copie en cache immédiatement si le réseau tarde (démarrage
    // instantané comme une app native), et on la rafraîchit en arrière-plan.
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cache = await caches.open(SHELL);
            const network = fetch(request).then(res => {
                if (res.ok) cache.put('./index.html', res.clone());
                return res;
            });
            const cached = await cache.match('./index.html');
            if (!cached) return network.catch(() => Response.error());
            event.waitUntil(network.catch(() => {}));
            return Promise.race([
                network.catch(() => cached),
                new Promise(resolve => setTimeout(() => resolve(cached), 1500))
            ]);
        })());
        return;
    }

    // Fichiers de l'application : réseau d'abord (dernière version), cache hors ligne
    event.respondWith(
        fetch(request)
            .then(res => {
                if (res.ok && url.search === '') {
                    const copy = res.clone();
                    caches.open(SHELL).then(c => c.put(request, copy));
                }
                return res;
            })
            .catch(() => caches.match(request, { ignoreSearch: true }).then(hit => hit || Response.error()))
    );
});
