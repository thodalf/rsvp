// Traitement du texte : normalisation, assemblage en paragraphes, découpage en "flashs" RSVP.
//
// Format interne d'un livre : une seule chaîne, un paragraphe par ligne ('\n' entre paragraphes),
// espaces simples, Unicode NFC. Tout le reste (mots, pauses, phrases) est recalculé à l'ouverture,
// ce qui permet de changer les réglages (longueur max…) sans perdre la position de lecture :
// la position est mémorisée en offset de caractère dans ce texte, pas en numéro de mot.

const COMPOUND_SUFFIXES = new Set([
    'il', 'ils', 'elle', 'elles', 'on', 'je', 'tu', 'nous', 'vous', 'le', 'la', 'les', 'lui', 'leur',
    'moi', 'toi', 'en', 'y', 'ce', 'ci', 'là', 'même', 'mêmes', 'être', 't', 'dessus', 'dessous',
    'dedans', 'dehors', 'delà', 'devant', 'derrière', 'haut', 'bas', 'unes', 'uns'
]);

/** Nettoyage caractère par caractère, sans toucher à la structure des lignes. */
export function cleanChars(s) {
    return s
        .normalize('NFC')
        .replace(/^﻿/, '')
        .replace(/\r\n?/g, '\n')
        .replace(/­/g, '')                       // césure conditionnelle invisible
        .replace(/[​-‍⁠﻿]/g, '')  // caractères de largeur nulle
        .replace(/[\u00A0    - \t\f\v]/g, ' ')
        .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
        .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
        .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g, '');
}

function collapse(s) {
    return s.replace(/ {2,}/g, ' ').trim();
}

/**
 * Assemble des lignes physiques en un paragraphe.
 * mode 'plain' : une coupure "mot-\nmot" garde le tiret (les .txt ne coupent pas les mots).
 * mode 'pdf'   : une coupure en fin de ligne est une césure typographique, sauf mots composés connus.
 */
export function joinLines(lines, mode = 'plain') {
    let out = '';
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (!out) { out = line; continue; }
        const m = /([\p{L}])-$/u.exec(out);
        if (m) {
            const next = /^[\p{L}]+/u.exec(line);
            if (next) {
                if (mode === 'pdf' && /^\p{Ll}/u.test(line) && !COMPOUND_SUFFIXES.has(next[0].toLowerCase())) {
                    out = out.slice(0, -1) + line;      // pro-\ngramme → programme
                } else {
                    out = out + line;                   // peut-\nêtre → peut-être
                }
                continue;
            }
        }
        out += ' ' + line;
    }
    return collapse(out);
}

/** Nettoyages communs appliqués à chaque paragraphe final. */
export function tidyParagraph(p) {
    p = p
        .replace(/\[(?:Illustration|Ilustración|Abbildung|Image)[^\]]*\]/gi, '')
        .replace(/(^|[\s(«"“])_([^_\n]{1,200})_(?=$|[\s.,;:!?)»"”])/g, '$1$2') // _italique_ (Gutenberg)
        .replace(/\[\d{1,3}\]/g, '')            // appels de note [12]
        .replace(/\s+([,.](?!\.))/g, '$1');     // espace parasite avant virgule/point
    return collapse(p);
}

/** Vrai si le paragraphe ne contient aucune lettre ni chiffre (séparateurs "* * *", "-----"). */
function isDecoration(p) {
    return !/[\p{L}\p{N}]/u.test(p);
}

/** Construit le texte final à partir d'une liste de paragraphes bruts. */
export function finalizeParagraphs(paragraphs) {
    const out = [];
    for (const p of paragraphs) {
        const t = tidyParagraph(p);
        if (t && !isDecoration(t)) out.push(t);
    }
    return out.join('\n');
}

/** Texte brut (.txt, Gutenberg…) → texte interne. */
export function textFromPlain(raw) {
    let t = cleanChars(raw);
    if (/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i.test(t)) t = stripGutenberg(t);

    const lines = t.split('\n');
    const blank = lines.filter(l => !l.trim()).length;
    const nonBlank = lines.length - blank;
    const avgLen = nonBlank ? lines.reduce((a, l) => a + l.trim().length, 0) / nonBlank : 0;

    let paragraphs;
    if (nonBlank > 3 && blank / lines.length < 0.02 && avgLen > 100) {
        // Une ligne = un paragraphe (texte non coupé à 70 colonnes)
        paragraphs = lines;
    } else {
        paragraphs = t.split(/\n[ ]*\n+/).map(block => joinLines(block.split('\n'), 'plain'));
    }
    return finalizeParagraphs(dropGutenbergPreamble(paragraphs));
}

/** Supprime l'en-tête et la licence du Project Gutenberg. */
export function stripGutenberg(t) {
    const start = t.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*/i);
    if (start >= 0) {
        const nl = t.indexOf('\n', start);
        t = nl >= 0 ? t.slice(nl + 1) : '';
    }
    const end = t.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG|^\s*End of (the )?Project Gutenberg/im);
    if (end >= 0) t = t.slice(0, end);
    return t;
}

const PREAMBLE = /^(produced by|e-?text prepared by|transcribed (from|by)|this (e-?text|e-?book) (was|is)|updated editions will replace|ce livre (électronique|numérique) a été|note du transcripteur|transcriber'?s note)/i;

function dropGutenbergPreamble(paragraphs) {
    let i = 0, removed = 0;
    while (i < paragraphs.length && removed < 6 && i < 12) {
        const p = paragraphs[i].trim();
        if (!p) { i++; continue; }
        if (PREAMBLE.test(p) || /www\.(gutenberg|pgdp)\.(org|net)/i.test(p)) {
            paragraphs[i] = '';
            removed++;
        }
        i++;
    }
    return paragraphs;
}

// ---------------------------------------------------------------------------------------------
// Découpage en tokens pour la lecture
// ---------------------------------------------------------------------------------------------

const OPENING = /^[«“‘„‹(\[{—–-]+$/u;
const CLOSING = /^[»”’›)\]}.,;:!?…]+$/u;
const ATTACH_TIGHT = /^[.,)\]}’”…]/u;   // se colle sans espace au mot précédent
const OPEN_TIGHT = /^[(\[{“‘„]+$/u;     // se colle sans espace au mot suivant

export const FLAG_SENTENCE_START = 1;
export const FLAG_PARAGRAPH_END = 2;
export const FLAG_PROPER_NOUN = 4;

/** Nom propre probable : majuscule initiale hors début de phrase (ni sigle, ni titre en capitales). */
function looksProper(word) {
    const core = word.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}'’-]+$/u, '');
    if (!/^\p{Lu}/u.test(core) || core === 'I' || core.length < 2) return false;
    return core !== core.toUpperCase();
}

/** Nombre de lettres/chiffres d'un token (sert au point de fixation et aux pauses). */
function letterCount(w) {
    const m = w.match(/[\p{L}\p{N}]/gu);
    return m ? m.length : 0;
}

/** Découpe un mot trop long en morceaux ≤ maxLen, de préférence sur ses tirets. */
export function splitLong(word, maxLen) {
    if (word.length <= maxLen) return [word];
    const pieces = [];
    const hyphenParts = word.split(/(?<=[\p{L}\p{N}]-)(?=[\p{L}\p{N}])/u);
    let current = '';
    for (const part of hyphenParts) {
        if (current && (current + part).length <= maxLen) { current += part; continue; }
        if (current) pieces.push(current);
        current = part;
    }
    if (current) pieces.push(current);

    const result = [];
    for (const piece of pieces) {
        if (piece.length <= maxLen) { result.push(piece); continue; }
        const size = maxLen - 1;                       // place pour le tiret ajouté
        const n = Math.ceil(piece.length / size);
        const chunk = Math.ceil(piece.length / n);
        for (let i = 0; i < piece.length; i += chunk) {
            const seg = piece.slice(i, i + chunk);
            result.push(i + chunk < piece.length && !seg.endsWith('-') ? seg + '-' : seg);
        }
    }
    return result;
}

// Abréviations courantes : leur point ne termine pas la phrase (M. Dupont, p. 12, cf. …)
const ABBREVIATIONS = new Set(['m', 'mm', 'mme', 'mmes', 'mlle', 'mlles', 'dr', 'pr', 'me', 'mgr', 'st', 'ste',
    'cf', 'p', 'pp', 'vol', 'chap', 'ch', 'fig', 'env', 'av', 'apr', 'j.-c', 'mr', 'mrs', 'ms', 'jr', 'sr',
    'vs', 'no', 'n°', 'art', 'éd', 'ed', 'dir', 'trad', 'cie', 'ibid', 'op', 'cit', 'al', 'gén', 'col', 'cap', 'lt', 'sgt']);

const TRAILING_CLOSERS = /[»”’›)\]}"'\s\u00A0]+$/u;

/** Vrai si le token termine réellement une phrase (et pas une abréviation ou une initiale). */
function endsSentence(token, next) {
    const core = token.replace(TRAILING_CLOSERS, '');
    if (next && /^\p{Ll}/u.test(next)) return false;   // « Qu'en dites-vous ? demanda-t-il. »
    if (/[!?…]$/.test(core)) return true;
    if (!/\.$/.test(core)) return false;
    const word = core.replace(/^[«“‘„‹(\[{—–\u00A0-]+/u, '').slice(0, -1).toLowerCase();
    if (ABBREVIATIONS.has(word)) return false;
    if (/^\p{L}$/u.test(word) && next && /^\p{Lu}/u.test(next)) return false;   // initiale : J. K. Rowling
    return true;
}

/** Poids relatif d'affichage d'un token (1 = durée de base). */
function weightOf(token, paragraphEnd, isPiece, sentenceEnd) {
    const core = token.replace(TRAILING_CLOSERS, '');
    let w = 1;
    if (sentenceEnd) w = 2.2;
    else if (/[,;:—–!?…]$/.test(core)) w = 1.5;
    if (paragraphEnd) w = Math.max(w, 2.8);
    const letters = letterCount(token);
    if (letters > 7) w *= Math.min(1.6, 1 + (letters - 7) * 0.05);
    if (/\d/.test(token)) w *= 1.3;
    if (isPiece) w *= 1.1;
    return w;
}

/**
 * Découpe le texte interne en tokens affichables.
 * Retourne { words, offsets, weights, flags } (tableaux parallèles).
 */
export function tokenize(text, maxLen = 13) {
    const words = [];
    const offsets = [];
    const weights = [];
    const flags = [];

    const raw = [];   // { w, off, paraEnd }
    const re = /\S+/g;
    let m;
    let prevEnd = 0;
    let pendingOpen = null;

    while ((m = re.exec(text)) !== null) {
        const gap = text.slice(prevEnd, m.index);
        if (gap.includes('\n') && raw.length) raw[raw.length - 1].paraEnd = true;
        prevEnd = m.index + m[0].length;
        let w = m[0];

        if (CLOSING.test(w) && raw.length && !raw[raw.length - 1].paraEnd && !pendingOpen) {
            const prev = raw[raw.length - 1];
            prev.w += (ATTACH_TIGHT.test(w) ? '' : '\u00A0') + w;
            continue;
        }
        if (OPENING.test(w)) {
            pendingOpen = pendingOpen
                ? { w: pendingOpen.w + '\u00A0' + w, off: pendingOpen.off }
                : { w, off: m.index };
            continue;
        }
        let off = m.index;
        if (pendingOpen) {
            w = pendingOpen.w + (OPEN_TIGHT.test(pendingOpen.w) ? '' : '\u00A0') + w;
            off = pendingOpen.off;
            pendingOpen = null;
        }
        raw.push({ w, off, paraEnd: false });
    }
    if (pendingOpen) raw.push({ w: pendingOpen.w, off: pendingOpen.off, paraEnd: false });
    if (raw.length) raw[raw.length - 1].paraEnd = true;

    let sentenceStart = true;
    for (let r = 0; r < raw.length; r++) {
        const t = raw[r];
        const next = r + 1 < raw.length ? raw[r + 1].w : '';
        const ends = endsSentence(t.w, next);
        const pieces = splitLong(t.w, maxLen);
        for (let i = 0; i < pieces.length; i++) {
            const last = i === pieces.length - 1;
            const paraEnd = last && t.paraEnd;
            words.push(pieces[i]);
            offsets.push(t.off);
            weights.push(weightOf(pieces[i], paraEnd, !last, last && ends));
            let f = 0;
            if (sentenceStart && i === 0) f |= FLAG_SENTENCE_START;
            else if (i === 0 && looksProper(t.w)) f |= FLAG_PROPER_NOUN;
            if (paraEnd) f |= FLAG_PARAGRAPH_END;
            flags.push(f);
        }
        sentenceStart = t.paraEnd || ends;
    }

    return {
        words,
        offsets: Int32Array.from(offsets),
        weights: Float32Array.from(weights),
        flags: Uint8Array.from(flags)
    };
}

/** Index du token qui contient (ou suit) l'offset de caractère donné. Recherche dichotomique. */
export function indexAtOffset(offsets, charOffset) {
    let lo = 0, hi = offsets.length - 1, ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] <= charOffset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // Plusieurs morceaux d'un même mot partagent le même offset : revenir au premier.
    while (ans > 0 && offsets[ans - 1] === offsets[ans]) ans--;
    return ans;
}

/**
 * Point de fixation (ORP) : légèrement à gauche du centre, compté en lettres
 * (la ponctuation d'ouverture « — ( est ignorée).
 */
export function pivotIndex(word) {
    const chars = Array.from(word);
    let first = chars.findIndex(c => /[\p{L}\p{N}]/u.test(c));
    if (first < 0) first = 0;
    let letters = 0;
    for (let i = first; i < chars.length && /[\p{L}\p{N}'’-]/u.test(chars[i]); i++) letters++;
    const orp = letters <= 1 ? 0 : letters <= 5 ? 1 : letters <= 9 ? 2 : letters <= 13 ? 3 : 4;
    return Math.min(first + orp, chars.length - 1);
}
