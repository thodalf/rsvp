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
    { host: /^gutendex\.com$/i, prefix: '/proxy/gutendex' }
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
    for (const p of SAME_ORIGIN_PROXIES) {
        if (canProxyLocally && p.host.test(u.hostname)) routes.push(p.prefix + u.pathname + u.search);
    }
    routes.push(url);
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
export async function fetchBytes(url, { timeout = 25000, validate, signal } = {}) {
    let lastError = null;
    for (const route of routesFor(url)) {
        if (signal && signal.aborted) throw new DOMException('Annulé', 'AbortError');
        try {
            const res = await fetchWithTimeout(route, timeout, signal);
            if (!res.ok) { lastError = new Error('HTTP ' + res.status); continue; }
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.length < 64) { lastError = new Error('Réponse vide'); continue; }
            if (validate && !validate(bytes)) { lastError = new Error('Réponse invalide'); continue; }
            return { bytes, contentType: res.headers.get('content-type') || '' };
        } catch (e) {
            if (signal && signal.aborted) throw e;
            lastError = e;
        }
    }
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
// Import par lien (article web, fichier .txt/.epub/.pdf en ligne, page Gutenberg)
// ---------------------------------------------------------------------------------------------

export async function importFromUrl(rawUrl, { signal, onStatus } = {}) {
    let url;
    try { url = new URL(rawUrl.trim()); } catch { throw new ExtractError('Ce lien n’est pas valide.'); }
    if (!/^https?:$/.test(url.protocol)) throw new ExtractError('Seuls les liens http(s) sont acceptés.');

    const pg = /gutenberg\.org\/(?:ebooks|cache\/epub|files)\/(\d+)/.exec(url.href);
    if (pg) return { ...(await downloadGutenberg({ id: Number(pg[1]) }, { signal, onStatus })), source: 'gutenberg', sourceId: Number(pg[1]) };

    if (onStatus) onStatus('Téléchargement…');
    const { bytes, contentType } = await fetchBytes(url.href, { signal });
    const name = decodeURIComponent(url.pathname.split('/').pop() || '');
    const result = await extractAny(bytes, { name, type: contentType });
    if (!result.title) result.title = url.hostname;
    return { ...result, source: 'url', sourceUrl: url.href };
}
