// Synchronisation facultative entre appareils via Firebase (Auth + Firestore).
// Chargé uniquement si la configuration est renseignée (cf. config.js / build.js).
//
// Structure Firestore (compatible avec l'ancienne version) :
//   users/{uid}/settings/reader      réglages { …, updatedAt }
//   users/{uid}/books/{bookId}       métadonnées { id, title, author, …, hasText, textChunks, updatedAt }
//   users/{uid}/bookText/{id}__{n}   texte compressé (gzip) découpé en morceaux < 1 Mo
//   users/{uid}/progress/{bookId}    { position, ratio, updatedAt }  (ancien format : wordIndex/totalWords)
//   users/{uid}/bookFiles/{bookId}   ancien format : PDF complet { pdfData } — lu pour la reprise

import { FIREBASE_CONFIG } from './config.js';

const V = '10.14.1';
const CHUNK = 700 * 1024;

export const cloudConfigured = !!(FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith('__'));

let fb = null;
let user = null;
const listeners = new Set();

export async function initCloud() {
    if (!cloudConfigured || fb) return !!fb;
    try {
        const [app, auth, fs] = await Promise.all([
            import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
            import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
            import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`)
        ]);
        const fapp = app.initializeApp(FIREBASE_CONFIG);
        fb = { auth: auth.getAuth(fapp), db: fs.getFirestore(fapp), A: auth, F: fs };
        try { await fb.A.getRedirectResult(fb.auth); } catch { /* pas de redirection en cours */ }
        fb.A.onAuthStateChanged(fb.auth, u => { user = u; listeners.forEach(l => l(u)); });
        return true;
    } catch (e) {
        console.warn('Firebase indisponible :', e);
        return false;
    }
}

export function onUser(cb) { listeners.add(cb); cb(user); return () => listeners.delete(cb); }
export function currentUser() { return user; }

export async function signInGoogle() {
    const provider = new fb.A.GoogleAuthProvider();
    try {
        await fb.A.signInWithPopup(fb.auth, provider);
    } catch (e) {
        if (/popup-blocked|operation-not-supported|cancelled-popup-request/.test(e.code || '')) {
            await fb.A.signInWithRedirect(fb.auth, provider);
        } else throw e;
    }
}

export async function signInEmail(email, password, create) {
    if (create) await fb.A.createUserWithEmailAndPassword(fb.auth, email, password);
    else await fb.A.signInWithEmailAndPassword(fb.auth, email, password);
}

export function signOut() { return fb.A.signOut(fb.auth); }

export function authErrorMessage(e) {
    const code = (e && e.code) || '';
    const map = {
        'auth/invalid-email': 'Adresse e-mail invalide.',
        'auth/invalid-credential': 'E-mail ou mot de passe incorrect.',
        'auth/wrong-password': 'E-mail ou mot de passe incorrect.',
        'auth/user-not-found': 'Aucun compte avec cet e-mail.',
        'auth/email-already-in-use': 'Un compte existe déjà avec cet e-mail.',
        'auth/weak-password': 'Mot de passe trop court (6 caractères minimum).',
        'auth/too-many-requests': 'Trop de tentatives, réessayez dans quelques minutes.',
        'auth/network-request-failed': 'Pas de connexion réseau.',
        'auth/popup-closed-by-user': 'Connexion annulée.',
        'auth/unauthorized-domain': 'Ce domaine n’est pas autorisé dans Firebase (Authentication › Settings › Authorized domains).'
    };
    return map[code] || 'Connexion impossible (' + (code || (e && e.message) || 'erreur inconnue') + ').';
}

// ---------------------------------------------------------------------------------------------

const ref = (...path) => fb.F.doc(fb.db, 'users', user.uid, ...path);
const col = name => fb.F.collection(fb.db, 'users', user.uid, name);
const toMs = v => typeof v === 'number' ? v : v && v.toMillis ? v.toMillis() : Date.parse(v) || 0;

async function gzip(text) {
    const bytes = new TextEncoder().encode(text);
    if (typeof CompressionStream === 'undefined') return { bytes, gz: false };
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), gz: true };
}

async function gunzip(bytes, gz) {
    if (!gz) return new TextDecoder().decode(bytes);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
}

/** Réglages : renvoie les réglages distants s'ils sont plus récents, sinon pousse les locaux. */
export async function syncSettings(local) {
    if (!user) return null;
    const snap = await fb.F.getDoc(ref('settings', 'reader'));
    const remote = snap.exists() ? snap.data() : null;
    const remoteAt = remote ? toMs(remote.updatedAt || remote.lastModified) : 0;
    if (remote && remoteAt > (local.updatedAt || 0)) {
        const merged = { ...local, updatedAt: remoteAt };
        if (remote.wpm) merged.wpm = Number(remote.wpm);
        for (const k of ['pauses', 'maxLen', 'fontScale', 'font', 'theme', 'guide', 'progressLine', 'rampUp']) {
            if (remote[k] !== undefined) merged[k] = remote[k];
        }
        if (remote.maxLen === undefined && remote.maxWordLength) merged.maxLen = Number(remote.maxWordLength);
        return merged;
    }
    await pushSettings(local);
    return null;
}

export async function pushSettings(settings) {
    if (!user) return;
    await fb.F.setDoc(ref('settings', 'reader'), { ...settings, updatedAt: settings.updatedAt || Date.now() });
}

/** Liste des livres du compte, avec leur progression. */
export async function listRemoteBooks() {
    if (!user) return [];
    const [books, progress] = await Promise.all([fb.F.getDocs(col('books')), fb.F.getDocs(col('progress'))]);
    const prog = new Map();
    progress.forEach(d => prog.set(d.id, d.data()));
    const out = [];
    books.forEach(d => {
        const b = d.data();
        const p = prog.get(d.id) || {};
        const ratio = p.ratio !== undefined ? p.ratio : (p.totalWords ? Math.min(1, p.wordIndex / p.totalWords) : 0);
        out.push({
            id: d.id,
            title: b.title || 'Sans titre',
            author: b.author || '',
            source: b.source || (d.id.startsWith('gutenberg_') ? 'gutenberg' : 'legacy'),
            sourceId: b.sourceId, sourceUrl: b.sourceUrl,
            addedAt: toMs(b.addedAt || b.addedDate) || Date.now(),
            updatedAt: toMs(b.updatedAt || b.lastModified),
            chars: b.chars || 0, words: b.words || 0,
            cloudText: !!b.textChunks,
            legacyPdf: !b.textChunks && !!b.hasPdf,
            ratio,
            position: p.position,
            progressAt: toMs(p.updatedAt || p.lastUpdate)
        });
    });
    return out;
}

const META_FIELDS = ['id', 'title', 'author', 'source', 'sourceId', 'sourceUrl', 'addedAt', 'chars', 'words'];

export async function pushBook(book, text) {
    if (!user) return;
    const { bytes, gz } = await gzip(text);
    const n = Math.max(1, Math.ceil(bytes.length / CHUNK));
    for (let i = 0; i < n; i++) {
        await fb.F.setDoc(ref('bookText', `${book.id}__${i}`), {
            data: fb.F.Bytes.fromUint8Array(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)), i, n, gz
        });
    }
    const meta = {};
    for (const k of META_FIELDS) if (book[k] !== undefined) meta[k] = book[k];
    await fb.F.setDoc(ref('books', book.id), { ...meta, textChunks: n, gz, updatedAt: Date.now() });
}

/** Télécharge le texte d'un livre du compte. Renvoie { text } ou { pdf } (ancien format). */
export async function pullBookContent(id) {
    const meta = await fb.F.getDoc(ref('books', id));
    const m = meta.exists() ? meta.data() : {};
    if (m.textChunks) {
        const parts = [];
        for (let i = 0; i < m.textChunks; i++) {
            const snap = await fb.F.getDoc(ref('bookText', `${id}__${i}`));
            if (!snap.exists()) throw new Error('Texte incomplet dans le cloud');
            parts.push(snap.data().data.toUint8Array());
        }
        const total = parts.reduce((a, p) => a + p.length, 0);
        const all = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { all.set(p, o); o += p.length; }
        return { text: await gunzip(all, m.gz !== false) };
    }
    const legacy = await fb.F.getDoc(ref('bookFiles', id));
    if (legacy.exists() && legacy.data().pdfData) return { pdf: legacy.data().pdfData.toUint8Array() };
    throw new Error('Ce livre n’a pas de contenu enregistré dans le cloud.');
}

export async function pushProgress(id, position, ratio, at = Date.now()) {
    if (!user) return;
    await fb.F.setDoc(ref('progress', id), { position, ratio, updatedAt: at, bookId: id });
}

export async function deleteRemoteBook(id) {
    if (!user) return;
    const meta = await fb.F.getDoc(ref('books', id));
    const n = meta.exists() ? meta.data().textChunks || 0 : 0;
    const ops = [fb.F.deleteDoc(ref('books', id)), fb.F.deleteDoc(ref('progress', id)), fb.F.deleteDoc(ref('bookFiles', id))];
    for (let i = 0; i < n; i++) ops.push(fb.F.deleteDoc(ref('bookText', `${id}__${i}`)));
    await Promise.allSettled(ops);
}
