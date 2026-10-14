// Tout ce qui fait du site une webapp : installation, service worker et mises à jour, ouverture
// de fichiers depuis le système, réception des partages, raccourcis, état hors ligne.

const $ = id => document.getElementById(id);

export const isStandalone = () =>
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: minimal-ui)').matches ||
    navigator.standalone === true;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * @param {object} hooks
 *   onFile(file)          un fichier à importer (ouvert depuis le système ou partagé)
 *   onAction(name)        'resume' | 'classics' | 'paste'
 *   onShared({title,text,url})
 *   isReading()           vrai pendant une lecture (on ne recharge pas la page à ce moment-là)
 *   toast(msg, opts)
 */
export function initPwa(hooks) {
    setupInstall(hooks);
    setupServiceWorker(hooks);
    setupLaunch(hooks);
    setupConnectivity(hooks);
}

// ---------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------

function setupInstall({ toast }) {
    const btn = $('btnInstall');
    let deferred = null;

    const refresh = () => {
        const canPrompt = !!deferred;
        const iosManual = isIos() && !isStandalone();
        btn.hidden = isStandalone() || (!canPrompt && !iosManual);
        document.documentElement.classList.toggle('standalone', isStandalone());
    };

    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();          // on garde l'invite pour notre propre bouton
        deferred = e;
        refresh();
    });
    window.addEventListener('appinstalled', () => {
        deferred = null;
        refresh();
        toast('Application installée : retrouvez « Lecture » sur votre écran d’accueil.');
    });
    matchMedia('(display-mode: standalone)').addEventListener?.('change', refresh);

    btn.addEventListener('click', async () => {
        if (deferred) {
            deferred.prompt();
            const { outcome } = await deferred.userChoice;
            if (outcome === 'accepted') deferred = null;
            refresh();
        } else {
            $('dlgInstall').showModal();
        }
    });
    refresh();
}

// ---------------------------------------------------------------------------------------------
// Service worker et mises à jour
// ---------------------------------------------------------------------------------------------

function setupServiceWorker({ isReading }) {
    if (!('serviceWorker' in navigator)) return;
    const secure = location.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (!secure) return;

    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Une nouvelle version vient de prendre la main : on recharge, sauf en pleine lecture.
        if (!hadController || reloading) return;
        if (isReading()) { window.__pendingReload = true; return; }
        reloading = true;
        location.reload();
    });

    navigator.serviceWorker.register('sw.js').then(reg => {
        const activate = worker => {
            if (!worker) return;
            const go = () => worker.postMessage('SKIP_WAITING');
            if (isReading()) {
                // Appliquée au retour à la bibliothèque, jamais pendant une lecture
                window.__applyUpdate = go;
            } else go();
        };
        if (reg.waiting && navigator.serviceWorker.controller) activate(reg.waiting);
        reg.addEventListener('updatefound', () => {
            const w = reg.installing;
            w && w.addEventListener('statechange', () => {
                if (w.state === 'installed' && navigator.serviceWorker.controller) activate(w);
            });
        });
        // Vérifie les mises à jour au retour sur l'app (utile une fois installée)
        document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(e => console.warn('Service worker non enregistré :', e));

    window.addEventListener('rsvp:library', () => {
        if (window.__applyUpdate) { const f = window.__applyUpdate; window.__applyUpdate = null; f(); }
        else if (window.__pendingReload && !reloading) { reloading = true; location.reload(); }
    });
}

// ---------------------------------------------------------------------------------------------
// Lancement : raccourcis, fichiers ouverts avec l'app, partages
// ---------------------------------------------------------------------------------------------

async function takeSharedFile() {
    try {
        const cache = await caches.open('share-inbox');
        const res = await cache.match('./share-inbox/file');
        if (!res) return null;
        await cache.delete('./share-inbox/file');
        const name = decodeURIComponent(res.headers.get('x-file-name') || 'fichier');
        const blob = await res.blob();
        return new File([blob], name, { type: res.headers.get('content-type') || blob.type });
    } catch {
        return null;
    }
}

function setupLaunch({ onFile, onAction, onShared }) {
    // Fichiers ouverts depuis le système (« Ouvrir avec › Lecture » sur ordinateur)
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async params => {
            if (!params.files || !params.files.length) return;
            const file = await params.files[0].getFile();
            onFile(file);
        });
    }

    const q = new URLSearchParams(location.search);
    const action = q.get('action');
    const shared = { title: q.get('title') || '', text: q.get('text') || '', url: q.get('url') || '' };
    if (q.toString()) history.replaceState(null, '', location.pathname);

    if (action === 'shared-file') {
        takeSharedFile().then(f => { if (f) onFile(f); });
    } else if (action === 'resume' || action === 'classics' || action === 'paste') {
        onAction(action);
    } else if (shared.url || shared.text) {
        onShared(shared);
    }
}

// ---------------------------------------------------------------------------------------------
// Hors ligne
// ---------------------------------------------------------------------------------------------

function setupConnectivity({ toast }) {
    const pill = $('offlinePill');
    const update = () => { pill.hidden = navigator.onLine; };
    window.addEventListener('online', () => { update(); toast('Connexion rétablie.'); });
    window.addEventListener('offline', () => { update(); toast('Hors ligne : vos livres restent lisibles, l’import en ligne reprendra avec la connexion.'); });
    update();
}
