// Accès aux livres en ligne : Project Gutenberg (catalogue + téléchargement) et import par lien.
//
// Les navigateurs bloquent souvent les téléchargements directs (CORS). Chaque requête essaie donc
// plusieurs routes dans l'ordre, jusqu'à la première qui réussit :
//   1. le proxy du site lui-même (/proxy/... déclaré dans netlify.toml) — le plus fiable ;
//   2. le site d'origine en direct ;
//   3. des proxys CORS publics, en dernier recours.

import { extractAny, extractHtmlString, decodeBytes, ExtractError } from './extract.js';
import { textFromPlain } from './text.js';

const SAME_ORIGIN_PROXIES = [
    { host: /^(www\.)?gutenberg\.org$/i, prefix: '/proxy/gutenberg' },
    { host: /^gutendex\.com$/i, prefix: '/proxy/gutendex' },
    { host: /^books\.google\.[a-z.]+$/i, prefix: '/proxy/googlebooks' }
];

const PUBLIC_PROXIES = [
    url => 'https://corsproxy.io/?url=' + encodeURIComponent(url),
    url => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    url => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url)
];

function routesFor(url) {
    const u = new URL(url);
    const routes = [];
    const canProxyLocally = typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
    const local = SAME_ORIGIN_PROXIES.find(p => canProxyLocally && p.host.test(u.hostname));
    if (local && local.directFirst) routes.push(url, local.prefix + u.pathname + u.search);
    else if (local) routes.push(local.prefix + u.pathname + u.search, url);
    else routes.push(url);
    for (const p of PUBLIC_PROXIES) routes.push(p(url));
    return routes;
}

async function fetchWithTimeout(url, ms, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
        return await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Télécharge `url` en essayant toutes les routes. `validate(bytes)` peut rejeter une réponse
 * (page d'erreur d'un proxy, fichier vide…) pour passer à la route suivante.
 */
export class RateLimitError extends Error {}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Annulé', 'AbortError')); }, { once: true });
});

export async function fetchBytes(url, { timeout = 25000, validate, signal, routes } = {}) {
    let lastError = null;
    let rateLimited = false;
    for (const route of routes || routesFor(url)) {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (signal && signal.aborted) throw new DOMException('Annulé', 'AbortError');
            try {
                const res = await fetchWithTimeout(route, timeout, signal);
                if (res.status === 429) {
                    // Trop de requêtes : une seconde chance après une courte pause, puis route suivante
                    rateLimited = true;
                    lastError = new Error('HTTP 429');
                    if (attempt === 0) { await sleep(Math.min(3, Number(res.headers.get('retry-after')) || 1.5) * 1000, signal); continue; }
                    break;
                }
                if (!res.ok) { lastError = new Error('HTTP ' + res.status); break; }
                const bytes = new Uint8Array(await res.arrayBuffer());
                if (bytes.length < 64) { lastError = new Error('Réponse vide'); break; }
                if (validate && !validate(bytes)) { lastError = new Error('Réponse invalide'); break; }
                return { bytes, contentType: res.headers.get('content-type') || '' };
            } catch (e) {
                if (signal && signal.aborted) throw e;
                lastError = e;
                break;
            }
        }
    }
    if (rateLimited) throw new RateLimitError('Google limite temporairement le nombre de requêtes (erreur 429).');
    throw new Error('Téléchargement impossible (' + (lastError ? lastError.message : 'réseau') + ')');
}

const looksLikeHtml = bytes => /<!doctype html|<html[\s>]/i.test(decodeBytes(bytes.subarray(0, 1024)));

// ---------------------------------------------------------------------------------------------
// Project Gutenberg
// ---------------------------------------------------------------------------------------------

/** Recherche dans le catalogue. Retourne [{ id, title, author, languages, downloads, formats }]. */
export async function searchGutenberg(query, lang, { signal } = {}) {
    const params = new URLSearchParams();
    if (query) params.set('search', query);
    if (lang) params.set('languages', lang);
    if (!query) params.set('sort', 'popular');
    try {
        const { bytes } = await fetchBytes('https://gutendex.com/books/?' + params, {
            timeout: 15000, signal,
            validate: b => decodeBytes(b.subarray(0, 64)).trimStart().startsWith('{')
        });
        const data = JSON.parse(decodeBytes(bytes));
        return (data.results || []).map(b => ({
            id: b.id,
            title: b.title || 'Sans titre',
            author: (b.authors || []).map(a => formatAuthor(a.name)).join(', '),
            languages: b.languages || [],
            downloads: b.download_count || 0,
            formats: b.formats || {}
        }));
    } catch (e) {
        if (signal && signal.aborted) throw e;
        return searchGutenbergOpds(query, lang, signal);   // catalogue de secours
    }
}

/** "Hugo, Victor" → "Victor Hugo" */
export function formatAuthor(name) {
    const m = /^([^,]+),\s*([^,(]+)(.*)$/.exec(name || '');
    return m ? `${m[2].trim()} ${m[1].trim()}` : (name || '');
}

async function searchGutenbergOpds(query, lang, signal) {
    const q = [query, lang ? 'l.' + lang : ''].filter(Boolean).join(' ');
    const url = 'https://www.gutenberg.org/ebooks/search.opds/?' + new URLSearchParams(q ? { query: q } : { sort_order: 'downloads' });
    const { bytes } = await fetchBytes(url, { timeout: 15000, signal, validate: b => /<feed/i.test(decodeBytes(b.subarray(0, 2048))) });
    const doc = new DOMParser().parseFromString(decodeBytes(bytes), 'application/xml');
    const results = [];
    for (const entry of doc.getElementsByTagNameNS('*', 'entry')) {
        const idText = entry.getElementsByTagNameNS('*', 'id')[0]?.textContent || '';
        const links = Array.from(entry.getElementsByTagNameNS('*', 'link')).map(l => l.getAttribute('href') || '');
        const m = /ebooks\/(\d+)/.exec(idText) || links.map(h => /ebooks\/(\d+)/.exec(h)).find(Boolean);
        if (!m) continue;
        const author = entry.getElementsByTagNameNS('*', 'name')[0]?.textContent
            || entry.getElementsByTagNameNS('*', 'content')[0]?.textContent || '';
        results.push({
            id: Number(m[1]),
            title: entry.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || 'Sans titre',
            author: formatAuthor(author.trim()),
            languages: lang ? [lang] : [],
            downloads: 0,
            formats: {}
        });
    }
    return results;
}

/** Télécharge un livre Gutenberg en essayant ses différents formats. → { text, title, author } */
export async function downloadGutenberg(book, { signal, onStatus } = {}) {
    const id = book.id;
    const f = book.formats || {};
    const pick = pred => Object.entries(f).filter(([k, v]) => pred(k) && !/\.zip$/i.test(v)).map(([, v]) => v);

    const candidates = [
        { url: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`, kind: 'txt' },
        ...pick(k => k.startsWith('text/plain')).map(url => ({ url, kind: 'txt' })),
        { url: `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.epub`, kind: 'epub' },
        ...pick(k => k.startsWith('application/epub')).map(url => ({ url, kind: 'epub' })),
        { url: `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.html`, kind: 'html' },
        ...pick(k => k.startsWith('text/html')).map(url => ({ url, kind: 'html' }))
    ].filter((c, i, arr) => arr.findIndex(o => o.url === c.url) === i);

    let lastError = null;
    for (const c of candidates) {
        try {
            if (onStatus) onStatus(c.kind === 'txt' ? 'Téléchargement du texte…' : `Téléchargement (${c.kind.toUpperCase()})…`);
            const { bytes } = await fetchBytes(c.url, {
                signal,
                validate: b => c.kind === 'txt' ? !looksLikeHtml(b) && b.length > 2000
                    : c.kind === 'epub' ? b[0] === 0x50 && b[1] === 0x4B
                    : b.length > 2000
            });
            let result;
            if (c.kind === 'txt') result = { text: textFromPlain(decodeBytes(bytes)), title: '', author: '' };
            else if (c.kind === 'html') result = extractHtmlString(decodeBytes(bytes));
            else result = await extractAny(bytes, { name: 'livre.epub' });
            if (result.text.length < 500) throw new Error('Texte trop court');
            return { text: result.text, title: book.title || result.title, author: book.author || result.author };
        } catch (e) {
            if (signal && signal.aborted) throw e;
            lastError = e;
        }
    }
    throw new Error('Impossible de récupérer ce livre depuis Project Gutenberg. ' + (lastError ? lastError.message : ''));
}

// ---------------------------------------------------------------------------------------------
// Google Livres : ouvrages en accès libre et intégral (domaine public), téléchargeables en EPUB/PDF
//
// Les recherches passent d'abord par le relais du site (/api/google-books, fonction Netlify) qui
// ajoute la clé d'API côté serveur et met les réponses en cache 24 h : c'est ce qui évite l'erreur
// 429 de Google. Hors Netlify, ou si le relais est saturé, l'appareil interroge Google directement
// (son propre quota, distinct de celui du serveur). Les résultats sont aussi gardés 24 h sur
// l'appareil : rouvrir une recherche ne coûte rien.
// ---------------------------------------------------------------------------------------------

const GB_CACHE_KEY = 'rsvp2_google_cache';
const GB_CACHE_MS = 24 * 3600 * 1000;

function cacheGet(key) {
    try {
        const all = JSON.parse(localStorage.getItem(GB_CACHE_KEY) || '{}');
        const hit = all[key];
        return hit && Date.now() - hit.t < GB_CACHE_MS ? hit.data : null;
    } catch { return null; }
}

function cachePut(key, data) {
    try {
        const all = JSON.parse(localStorage.getItem(GB_CACHE_KEY) || '{}');
        all[key] = { t: Date.now(), data };
        const keys = Object.keys(all).sort((x, y) => all[y].t - all[x].t);
        for (const k of keys.slice(40)) delete all[k];
        localStorage.setItem(GB_CACHE_KEY, JSON.stringify(all));
    } catch { /* stockage plein : sans cache */ }
}

const isJson = b => decodeBytes(b.subarray(0, 64)).trimStart().startsWith('{');

/** Appelle l'API Google Books (relais du site, puis accès direct). params : { q, lang } ou { id }. */
async function googleApi(params, signal) {
    const cacheKey = JSON.stringify(params);
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const routes = [];
    if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
        routes.push('/api/google-books?' + new URLSearchParams(params));
    }
    if (params.id) {
        routes.push(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(params.id)}`);
    } else {
        const p = new URLSearchParams({ q: params.q, filter: 'free-ebooks', printType: 'books', maxResults: '40', orderBy: 'relevance' });
        if (params.lang) p.set('langRestrict', params.lang);
        routes.push('https://www.googleapis.com/books/v1/volumes?' + p);
    }
    const { bytes } = await fetchBytes(routes[routes.length - 1], { routes, signal, timeout: 15000, validate: isJson });
    const data = JSON.parse(decodeBytes(bytes));
    cachePut(cacheKey, data);
    return data;
}

const httpsGoogle = url => url.replace(/^http:/, 'https:').replace(/books\.google\.[a-z.]+\//, 'books.google.com/');

function toBook(item) {
    const v = item.volumeInfo || {}, a = item.accessInfo || {};
    return {
        id: item.id,
        title: [v.title, v.subtitle].filter(Boolean).join(' — ') || 'Sans titre',
        author: (v.authors || []).join(', '),
        year: (v.publishedDate || '').slice(0, 4),
        epub: a.epub && a.epub.isAvailable && a.epub.downloadLink ? httpsGoogle(a.epub.downloadLink) : '',
        pdf: a.pdf && a.pdf.isAvailable && a.pdf.downloadLink ? httpsGoogle(a.pdf.downloadLink) : '',
        free: /ALL_PAGES/.test(a.viewability || '') || !!a.publicDomain
    };
}

export async function searchGoogleBooks(query, lang, { signal } = {}) {
    const data = await googleApi({ q: query || (lang === 'en' ? 'classic novel' : 'roman'), lang: lang || '' }, signal);
    return (data.items || []).map(toBook).filter(b => b.epub || b.pdf);
}

export async function downloadGoogleBook(book, { signal, onStatus } = {}) {
    const candidates = [book.epub && { url: book.epub, kind: 'EPUB' }, book.pdf && { url: book.pdf, kind: 'PDF' }].filter(Boolean);
    let lastError = null;
    for (const c of candidates) {
        try {
            if (onStatus) onStatus(`Téléchargement depuis Google Livres (${c.kind})…`);
            const { bytes } = await fetchBytes(c.url, {
                signal, timeout: 40000,
                validate: b => (b[0] === 0x50 && b[1] === 0x4B) || (b[0] === 0x25 && b[1] === 0x50)
            });
            const result = await extractAny(bytes, { name: c.kind === 'EPUB' ? 'livre.epub' : 'livre.pdf' });
            return { text: result.text, title: book.title || result.title, author: book.author || result.author };
        } catch (e) {
            if (signal && signal.aborted) throw e;
            lastError = e;
        }
    }
    // Google bloque souvent les téléchargements en série (429) : la plupart des livres libres de
    // Google existent aussi chez Project Gutenberg, on y cherche automatiquement le même titre.
    if (onStatus) onStatus('Google ne répond pas, recherche du même livre sur Project Gutenberg…');
    const twin = await findOnGutenberg(book, signal).catch(() => null);
    if (twin) {
        const result = await downloadGutenberg(twin, { signal, onStatus });
        return { ...result, fallback: 'gutenberg', gutenbergId: twin.id };
    }
    if (lastError instanceof RateLimitError) throw lastError;
    throw new Error('Google Livres n’a pas fourni ce livre. ' + (lastError ? lastError.message : ''));
}

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Cherche sur Project Gutenberg le même livre (titre principal + nom de l'auteur). */
export async function findOnGutenberg(book, signal) {
    const mainTitle = norm((book.title || '').split(/ — |[:;(]/)[0]);
    if (mainTitle.length < 3) return null;
    const lastName = norm((book.author || '').split(',')[0]).split(' ').pop() || '';
    const results = await searchGutenberg([mainTitle, lastName].filter(Boolean).join(' '), '', { signal });
    return results.find(r => {
        const t = norm(r.title);
        return (t.startsWith(mainTitle) || mainTitle.startsWith(t.split(' ').slice(0, 4).join(' ')))
            && (!lastName || norm(r.author).includes(lastName));
    }) || null;
}

// ---------------------------------------------------------------------------------------------
// Import par lien (article web, fichier .txt/.epub/.pdf en ligne, page Gutenberg)
// ---------------------------------------------------------------------------------------------

export async function importFromUrl(rawUrl, { signal, onStatus } = {}) {
    let url;
    try { url = new URL(rawUrl.trim()); } catch { throw new ExtractError('Ce lien n’est pas valide.'); }
    if (!/^https?:$/.test(url.protocol)) throw new ExtractError('Seuls les liens http(s) sont acceptés.');

    const pg = /gutenberg\.org\/(?:ebooks|cache\/epub|files)\/(\d+)/.exec(url.href);
    if (pg) return { ...(await downloadGutenberg({ id: Number(pg[1]) }, { signal, onStatus })), source: 'gutenberg', sourceId: Number(pg[1]) };

    if (/^(books|play)\.google\./.test(url.hostname)) {
        const id = url.searchParams.get('id') || (/\/books\/(?:edition\/[^/]+\/)?([\w-]{12})/.exec(url.pathname) || [])[1];
        if (!id) throw new ExtractError('Lien Google Livres non reconnu.');
        return { ...(await importGoogleVolume(id, { signal, onStatus })), source: 'google', sourceId: id };
    }

    if (/(^|\.)(amazon|amzn)\.[a-z.]+$/.test(url.hostname)) {
        throw new ExtractError('Les livres Kindle sont protégés par Amazon (DRM) : leur texte ne peut pas être récupéré. Cherchez le même titre dans « Classiques » ou importez une version EPUB sans DRM.');
    }

    if (onStatus) onStatus('Téléchargement…');
    const { bytes, contentType } = await fetchBytes(url.href, { signal });
    const name = decodeURIComponent(url.pathname.split('/').pop() || '');
    const result = await extractAny(bytes, { name, type: contentType });
    if (!result.title) result.title = url.hostname;
    return { ...result, source: 'url', sourceUrl: url.href };
}

/** Livre Google Livres à partir de son identifiant (lien partagé). */
export async function importGoogleVolume(id, { signal, onStatus } = {}) {
    const book = toBook(await googleApi({ id }, signal));
    if ((!book.epub && !book.pdf) || !book.free) {
        throw new ExtractError('Ce livre Google n’est pas en accès libre. Si vous l’avez acheté, exportez-le depuis play.google.com/books (Plus › Exporter › EPUB) puis importez le fichier.');
    }
    return downloadGoogleBook(book, { signal, onStatus });
}
