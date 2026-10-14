// Extraction du texte depuis les différents formats : PDF, EPUB, TXT, HTML.
// Chaque fonction renvoie { text, title, author } avec `text` au format interne (cf. text.js).

import { cleanChars, finalizeParagraphs, joinLines, textFromPlain } from './text.js';

const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

const scriptPromises = new Map();
function loadScript(url, globalName) {
    if (globalThis[globalName]) return Promise.resolve(globalThis[globalName]);
    if (!scriptPromises.has(url)) {
        scriptPromises.set(url, new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.async = true;
            s.onload = () => globalThis[globalName] ? resolve(globalThis[globalName]) : reject(new Error(`${globalName} indisponible`));
            s.onerror = () => { scriptPromises.delete(url); reject(new Error('Impossible de charger le module de lecture (connexion ?)')); };
            document.head.appendChild(s);
        }));
    }
    return scriptPromises.get(url);
}

async function getPdfJs() {
    const lib = await loadScript(PDFJS_URL, 'pdfjsLib');
    if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc && typeof document !== 'undefined') {
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    }
    return lib;
}

export class ExtractError extends Error {}

// ---------------------------------------------------------------------------------------------
// Détection et décodage
// ---------------------------------------------------------------------------------------------

/** Devine le format d'après les premiers octets (fiable même sans extension ni type MIME). */
export function sniffFormat(bytes, nameOrType = '') {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';   // %PDF
    if (b[0] === 0x50 && b[1] === 0x4B) return 'epub';                                    // PK (zip)
    const hint = nameOrType.toLowerCase();
    const head = decodeBytes(b.subarray(0, 2048)).toLowerCase();
    if (/\.x?html?$|html/.test(hint) || /<!doctype html|<html[\s>]|<body[\s>]/.test(head)) return 'html';
    return 'txt';
}

/** Décode des octets en texte : UTF-8 strict, sinon UTF-16 (BOM), sinon Windows-1252. */
export function decodeBytes(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
        // Fichier tronqué au milieu d'un caractère multi-octets : on tolère la fin
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, Math.max(0, b.length - 3)));
        } catch {
            return new TextDecoder('windows-1252').decode(b);
        }
    }
}

/** Point d'entrée : n'importe quel fichier → { text, title, author }. */
export async function extractAny(bytes, { name = '', type = '', onProgress } = {}) {
    const format = sniffFormat(bytes, name || type);
    let result;
    if (format === 'pdf') result = await extractPdf(bytes, onProgress);
    else if (format === 'epub') result = await extractEpub(bytes, onProgress);
    else if (format === 'html') result = extractHtmlString(decodeBytes(bytes), { article: true });
    else result = { text: textFromPlain(decodeBytes(bytes)), title: '', author: '' };

    if (!result.title && name) result.title = prettifyFileName(name);
    if (!result.text || result.text.replace(/\s/g, '').length < 20) {
        throw new ExtractError(format === 'pdf'
            ? 'Ce PDF ne contient pas de texte lisible (probablement un scan d’images). Essayez une version EPUB ou texte du livre.'
            : 'Aucun texte lisible n’a été trouvé dans ce fichier.');
    }
    return result;
}

export function prettifyFileName(name) {
    return name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------

export async function extractPdf(bytes, onProgress) {
    const pdfjs = await getPdfJs();
    const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    let pdf;
    try {
        pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
    } catch (e) {
        console.warn('pdf.js:', e);
        if (e && e.name === 'PasswordException') throw new ExtractError('Ce PDF est protégé par un mot de passe.');
        throw new ExtractError('Ce fichier PDF est illisible ou endommagé.');
    }

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(pdfItemsToLines(content.items));
        page.cleanup();
        if (onProgress) onProgress(i / pdf.numPages);
    }

    let title = '', author = '';
    try {
        const meta = await pdf.getMetadata();
        title = (meta.info && meta.info.Title || '').trim();
        author = (meta.info && meta.info.Author || '').trim();
    } catch { /* métadonnées facultatives */ }
    pdf.destroy();
    if (/^(untitled|sans titre|microsoft word|document\d*)\b/i.test(title) || title.length > 200) title = '';

    return { text: assemblePdfPages(pages), title, author };
}

/**
 * Reconstruit les lignes d'une page à partir des fragments pdf.js.
 * L'ordre du flux est conservé (il respecte les colonnes) ; un changement de ligne est
 * détecté par hasEOL ou par un saut vertical. Les espaces manquants entre fragments sont
 * recréés d'après la distance horizontale : c'est ce qui évite les mots collés ou coupés.
 */
export function pdfItemsToLines(items) {
    const lines = [];
    let cur = null;
    let breakNext = false;

    for (const it of items) {
        if (typeof it.str !== 'string') continue;
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        const x = tr[4], y = tr[5];
        const h = Math.abs(it.height || tr[3] || tr[0] || 10) || 10;
        const w = it.width || 0;

        if (!it.str.length) { if (it.hasEOL) breakNext = true; continue; }

        const newLine = !cur || breakNext ||
            Math.abs(y - cur.y) > Math.max(1.5, Math.min(h, cur.h) * 0.5) ||
            x < cur.xEnd - Math.max(cur.h, h) * 4;     // retour très à gauche = nouvelle ligne/colonne

        if (newLine) {
            if (cur) lines.push(cur);
            cur = { text: it.str, x, y, h, xEnd: x + w };
        } else {
            const gap = x - cur.xEnd;
            const needsSpace = gap > h * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
            cur.text += (needsSpace ? ' ' : '') + it.str;
            cur.xEnd = Math.max(cur.xEnd, x + w);
            cur.h = Math.max(cur.h, h);
        }
        breakNext = !!it.hasEOL;
    }
    if (cur) lines.push(cur);

    for (const l of lines) l.text = cleanChars(l.text).replace(/\s+/g, ' ').trim();
    return lines.filter(l => l.text.length > 0);
}

function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[s.length >> 1];
}

const lineKey = t => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const PAGE_NUMBER = /^[-–—\s]*(page|p\.)?\s*([#]|[ivxlcdm]+)(\s*(\/|sur|of|de)\s*#)?[-–—\s]*$/i;

/** Pages de lignes → texte interne (en-têtes/pieds supprimés, paragraphes reconstitués). */
export function assemblePdfPages(pages) {
    // 1. En-têtes et pieds de page répétés + numéros de page
    const counts = new Map();
    for (const lines of pages) {
        const seen = new Set();
        const edge = [...lines.slice(0, 2), ...lines.slice(-2)];
        for (const l of edge) {
            const k = lineKey(l.text);
            if (!seen.has(k)) { seen.add(k); counts.set(k, (counts.get(k) || 0) + 1); }
        }
    }
    const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
    const cleanPages = pages.map(lines => lines.filter((l, i) => {
        const atEdge = i < 2 || i >= lines.length - 2;
        if (!atEdge) return true;
        const k = lineKey(l.text);
        if (PAGE_NUMBER.test(k)) return false;
        return !(pages.length >= 3 && (counts.get(k) || 0) >= threshold);
    }));

    // 2. Statistiques de mise en page
    const gaps = [], widths = [], lefts = [];
    for (const lines of cleanPages) {
        for (let i = 0; i < lines.length; i++) {
            widths.push(lines[i].xEnd - lines[i].x);
            lefts.push(lines[i].x);
            if (i > 0) {
                const g = lines[i - 1].y - lines[i].y;
                if (g > 0) gaps.push(g);
            }
        }
    }
    const medGap = median(gaps) || 14;
    const medWidth = median(widths) || 400;
    const medLeft = median(lefts) || 0;

    // 3. Paragraphes
    const paragraphs = [];
    let buf = [];
    const flush = () => { if (buf.length) paragraphs.push(joinLines(buf, 'pdf')); buf = []; };
    const endsSentence = t => /[.!?…:»”"]$/.test(t);

    let prev = null;
    for (const lines of cleanPages) {
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (prev) {
                const samePage = i > 0;
                const gap = samePage ? prev.y - l.y : 0;
                const prevShort = (prev.xEnd - prev.x) < medWidth * 0.8;
                const indented = l.x > medLeft + l.h * 0.8;
                const dialog = /^[—–-]\s/.test(l.text) || /^«/.test(l.text);
                let br = false;
                if (samePage && gap > medGap * 1.6) br = true;
                else if (samePage && gap < 0 && endsSentence(prev.text)) br = true;   // changement de colonne
                else if (endsSentence(prev.text) && (prevShort || indented || dialog)) br = true;
                else if (!samePage && endsSentence(prev.text) && prevShort) br = true;
                if (br) flush();
            }
            buf.push(l.text);
            prev = l;
        }
    }
    flush();
    return finalizeParagraphs(paragraphs);
}

// ---------------------------------------------------------------------------------------------
// HTML (pages web, chapitres EPUB, Gutenberg HTML)
// ---------------------------------------------------------------------------------------------

const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'blockquote', 'li', 'ul', 'ol', 'dd', 'dt',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'tr', 'table', 'figure', 'figcaption', 'header', 'footer',
    'aside', 'br', 'hr', 'body', 'center', 'address', 'td', 'th']);
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'math', 'head', 'title', 'template', 'iframe',
    'object', 'video', 'audio', 'canvas', 'rt', 'rp', 'button', 'select', 'form', 'input', 'nav']);

function shouldSkip(el) {
    const tag = el.localName;
    if (SKIP.has(tag)) return true;
    const type = (el.getAttribute('epub:type') || el.getAttribute('role') || '').toLowerCase();
    if (/noteref|footnote|endnote|pagebreak|doc-noteref|doc-pagebreak|doc-footnote|doc-endnotes/.test(type)) return true;
    const cls = (el.getAttribute('class') || '').toLowerCase();
    if (/\b(pagenum|page-?num|footnote-?ref|noteref|calibre_pb|sr-only|visually-hidden)\b/.test(cls)) return true;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return true;
    if (tag === 'sup' && /^[\s\[\(]*[\d*†‡]+[\s\]\)]*$/.test(el.textContent || '')) return true;
    return false;
}

/** Texte d'un élément DOM, avec un paragraphe par bloc. */
export function domToParagraphs(root) {
    const paragraphs = [];
    let buf = '';
    const flush = () => { if (buf.trim()) paragraphs.push(buf); buf = ''; };

    const walk = node => {
        for (let n = node.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) { buf += n.nodeValue.replace(/\s+/g, ' '); continue; }
            if (n.nodeType !== 1) continue;
            if (shouldSkip(n)) continue;
            const tag = n.localName;
            if (tag === 'img') { const alt = n.getAttribute('alt'); if (alt && alt.length > 30) buf += ' ' + alt + ' '; continue; }
            const block = BLOCK.has(tag);
            if (block) flush();
            walk(n);
            if (block) flush();
        }
    };
    walk(root);
    flush();
    return paragraphs.map(p => cleanChars(p).replace(/\s+/g, ' ').trim());
}

function parseHtml(str) {
    return new DOMParser().parseFromString(str, 'text/html');
}

function metaContent(doc, selectors) {
    for (const sel of selectors) {
        const el = doc.querySelector(sel);
        const v = el && (el.getAttribute('content') || el.textContent);
        if (v && v.trim()) return v.trim();
    }
    return '';
}

/** Trouve le bloc principal d'une page web (là où se concentrent les paragraphes). */
function findMainContent(doc) {
    const explicit = doc.querySelector('article, [role="main"], main, #content, .entry-content, .post-content');
    const scores = new Map();
    for (const p of doc.querySelectorAll('p')) {
        const len = (p.textContent || '').trim().length;
        if (len < 40) continue;
        let el = p.parentElement, bonus = 1;
        for (let depth = 0; el && depth < 3; depth++, el = el.parentElement, bonus /= 2) {
            scores.set(el, (scores.get(el) || 0) + len * bonus);
        }
    }
    let best = null, bestScore = 0;
    for (const [el, s] of scores) if (s > bestScore) { best = el; bestScore = s; }
    if (explicit && (explicit.textContent || '').trim().length > bestScore * 0.6) return explicit;
    return best || doc.body || doc.documentElement;
}

/** Chaîne HTML → { text, title, author }. `article` : extraire seulement le contenu principal. */
export function extractHtmlString(html, { article = false } = {}) {
    const doc = parseHtml(html);
    const isGutenberg = /project gutenberg/i.test(doc.title || '') || !!doc.querySelector('#pg-header, .pg-boilerplate');
    if (isGutenberg) doc.querySelectorAll('#pg-header, #pg-footer, .pg-boilerplate, section.pg-boilerplate').forEach(e => e.remove());

    const title = metaContent(doc, ['meta[property="og:title"]', 'meta[name="dc.title"]', 'h1', 'title']);
    const author = metaContent(doc, ['meta[name="author"]', 'meta[property="article:author"]', 'meta[name="dc.creator"]']);
    const root = article && !isGutenberg ? findMainContent(doc) : (doc.body || doc.documentElement);
    return { text: finalizeParagraphs(domToParagraphs(root)), title: title.slice(0, 200), author: author.slice(0, 120) };
}

// ---------------------------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------------------------

function parseXml(str) {
    return new DOMParser().parseFromString(str, 'application/xml');
}

function byTag(doc, name) {
    let found = Array.from(doc.getElementsByTagNameNS('*', name));
    if (!found.length) found = Array.from(doc.getElementsByTagName(name));
    if (!found.length) found = Array.from(doc.getElementsByTagName('dc:' + name));
    if (!found.length) found = Array.from(doc.getElementsByTagName('opf:' + name));
    return found;
}

function resolvePath(base, href) {
    const clean = decodeURIComponent(href.split('#')[0]);
    if (clean.startsWith('/')) return clean.slice(1);
    const parts = (base ? base.split('/') : []);
    for (const seg of clean.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    return parts.join('/');
}

function zipFile(zip, path) {
    return zip.file(path) || zip.file(Object.keys(zip.files).find(k => k.toLowerCase() === path.toLowerCase()) || '\0');
}

export async function extractEpub(bytes, onProgress) {
    const JSZip = await loadScript(JSZIP_URL, 'JSZip');
    let zip;
    try { zip = await JSZip.loadAsync(bytes); } catch { throw new ExtractError('Ce fichier EPUB est illisible ou endommagé.'); }

    const containerFile = zipFile(zip, 'META-INF/container.xml');
    let opfPath = '';
    if (containerFile) {
        const container = parseXml(await containerFile.async('string'));
        const rf = byTag(container, 'rootfile')[0];
        opfPath = rf ? rf.getAttribute('full-path') : '';
    }
    if (!opfPath) opfPath = Object.keys(zip.files).find(k => /\.opf$/i.test(k)) || '';
    const opfFile = opfPath && zipFile(zip, opfPath);
    if (!opfFile) throw new ExtractError('EPUB invalide : sommaire introuvable.');

    if (zip.file('META-INF/encryption.xml')) {
        const enc = await zip.file('META-INF/encryption.xml').async('string');
        if (/EncryptedData/i.test(enc) && !/obfuscation|font/i.test(enc)) {
            throw new ExtractError('Cet EPUB est protégé par des DRM : son texte ne peut pas être lu.');
        }
    }

    const opf = parseXml(await opfFile.async('string'));
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const manifest = new Map();
    for (const item of byTag(opf, 'item')) {
        manifest.set(item.getAttribute('id'), { href: item.getAttribute('href'), type: item.getAttribute('media-type') || '', props: item.getAttribute('properties') || '' });
    }
    let spine = byTag(opf, 'itemref')
        .filter(r => r.getAttribute('linear') !== 'no')
        .map(r => manifest.get(r.getAttribute('idref')))
        .filter(it => it && /html|xml/.test(it.type) && !/\bnav\b/.test(it.props));
    if (!spine.length) spine = [...manifest.values()].filter(it => /x?html/.test(it.type));

    const title = (byTag(opf, 'title')[0]?.textContent || '').trim();
    const author = byTag(opf, 'creator').map(c => c.textContent.trim()).filter(Boolean).join(', ');

    const paragraphs = [];
    for (let i = 0; i < spine.length; i++) {
        const file = zipFile(zip, resolvePath(baseDir, spine[i].href));
        if (!file) continue;
        const src = await file.async('string');
        let doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
        if (doc.getElementsByTagName('parsererror').length) doc = parseHtml(src);
        const body = byTag(doc, 'body')[0] || doc.documentElement;
        paragraphs.push(...domToParagraphs(body));
        if (onProgress) onProgress((i + 1) / spine.length);
    }
    return { text: finalizeParagraphs(paragraphs), title, author };
}

/** Texte collé par l'utilisateur. */
export function extractPasted(str) {
    const text = textFromPlain(str);
    const first = text.split('\n')[0] || '';
    const title = first.length <= 80 ? first : first.split(/\s+/).slice(0, 8).join(' ') + '…';
    return { text, title, author: '' };
}

export { joinLines };
