// Stockage local : IndexedDB pour les livres (aucune limite pratique de taille, contrairement au
// localStorage de l'ancienne version qui saturait à ~5 Mo), localStorage pour les réglages.
//
// books : { id, title, author, source, sourceId?, sourceUrl?, addedAt, updatedAt, chars, words,
//           position (offset de caractère), ratio (0..1), progressAt, lastReadAt,
//           hasText (texte présent sur cet appareil), cloudText (texte présent dans le cloud),
//           legacyPdf (ancien livre cloud stocké en PDF) }
// texts : { id, text }

const DB_NAME = 'rsvp-reader';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts', { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { dbPromise = null; reject(req.error); };
        });
    }
    return dbPromise;
}

async function tx(storeNames, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const t = db.transaction(storeNames, mode);
        let result;
        Promise.resolve(fn(t)).then(r => { result = r; }, reject);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transaction annulée'));
    });
}

const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const store = {
    async listBooks() {
        const books = await tx(['books'], 'readonly', t => req(t.objectStore('books').getAll()));
        return books.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
    },
    getBook(id) {
        return tx(['books'], 'readonly', t => req(t.objectStore('books').get(id)));
    },
    putBook(book) {
        return tx(['books'], 'readwrite', t => req(t.objectStore('books').put(book)));
    },
    async patchBook(id, patch) {
        return tx(['books'], 'readwrite', async t => {
            const s = t.objectStore('books');
            const book = await req(s.get(id));
            if (!book) return null;
            Object.assign(book, patch);
            await req(s.put(book));
            return book;
        });
    },
    async getText(id) {
        const row = await tx(['texts'], 'readonly', t => req(t.objectStore('texts').get(id)));
        return row ? row.text : null;
    },
    async saveBookWithText(book, text) {
        return tx(['books', 'texts'], 'readwrite', t => {
            t.objectStore('texts').put({ id: book.id, text });
            t.objectStore('books').put({ ...book, hasText: true });
        });
    },
    deleteBook(id) {
        return tx(['books', 'texts'], 'readwrite', t => {
            t.objectStore('books').delete(id);
            t.objectStore('texts').delete(id);
        });
    },
    /** Demande au navigateur de ne pas effacer les livres en cas de manque d'espace. */
    async persist() {
        try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* facultatif */ }
    }
};

/** Identifiant stable d'un texte (évite les doublons si on importe deux fois le même fichier). */
export async function textId(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return 'b_' + Array.from(new Uint8Array(digest).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
    wpm: 300,
    pauses: 1,          // 0 = vitesse constante, 1 = pauses naturelles, 1.6 = pauses marquées
    maxLen: 13,         // longueur max d'un flash avant découpage
    fontScale: 1,
    font: 'sans',       // sans | serif | mono
    theme: 'auto',      // auto | dark | light | sepia
    guide: true,        // repère au-dessus/au-dessous de la lettre de fixation
    progressLine: true, // filet de progression discret pendant la lecture
    rampUp: true,       // démarrage en douceur après chaque pause
    updatedAt: 0
};

const SETTINGS_KEY = 'rsvp2_settings';

export function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        return { ...DEFAULT_SETTINGS, ...(saved || {}) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* stockage plein ou bloqué */ }
}

// ---------------------------------------------------------------------------------------------
// Reprise des données de l'ancienne version (localStorage : rsvp_saved_books, rsvp_book_*, …)
// ---------------------------------------------------------------------------------------------

const MIGRATED_KEY = 'rsvp2_migrated';

export async function migrateLegacy() {
    let ls;
    try { ls = window.localStorage; if (ls.getItem(MIGRATED_KEY)) return 0; } catch { return 0; }

    let count = 0;
    try {
        const list = JSON.parse(ls.getItem('rsvp_saved_books') || '[]');
        for (const entry of list) {
            const raw = ls.getItem(`rsvp_book_${entry.id}`);
            if (!raw) continue;
            let data;
            try { data = JSON.parse(raw); } catch { continue; }
            const words = Array.isArray(data.words) && data.words.length ? data.words : data.modifiedWords;
            if (!Array.isArray(words) || !words.length) continue;
            if (await store.getBook(entry.id)) continue;

            const text = words.join(' ');
            let ratio = 0;
            try {
                const p = JSON.parse(ls.getItem(`rsvp_progress_${entry.id}`) || 'null');
                if (p && p.totalWords) ratio = Math.min(1, p.wordIndex / p.totalWords);
            } catch { /* progression facultative */ }

            const now = Date.now();
            await store.saveBookWithText({
                id: entry.id,
                title: data.title || entry.title || 'Sans titre',
                author: data.author || entry.author || '',
                source: entry.id.startsWith('gutenberg_') ? 'gutenberg' : 'legacy',
                addedAt: Date.parse(data.addedDate) || now,
                updatedAt: now,
                chars: text.length,
                words: words.length,
                position: Math.floor(ratio * text.length),
                ratio,
                progressAt: now,
                lastReadAt: ratio > 0 ? now - 1 : 0
            }, text);
            count++;
        }

        const oldSettings = JSON.parse(ls.getItem('rsvp_global_settings') || 'null');
        if (oldSettings && !ls.getItem(SETTINGS_KEY)) {
            const s = loadSettings();
            if (oldSettings.wpm) s.wpm = Math.max(100, Math.min(1200, Number(oldSettings.wpm)));
            if (oldSettings.maxWordLength) s.maxLen = Math.max(8, Math.min(20, Number(oldSettings.maxWordLength)));
            saveSettings(s);
        }
        ls.setItem(MIGRATED_KEY, String(Date.now()));
    } catch (e) {
        console.warn('Migration de l’ancienne bibliothèque incomplète :', e);
    }
    return count;
}
