// Interface : bibliothèque, import, lecteur, réglages, synchronisation.

import { tokenize, pivotIndex, indexAtOffset } from './text.js';
import { extractAny, extractPasted, extractPdf } from './extract.js';
import { searchGutenberg, downloadGutenberg, importFromUrl } from './sources.js';
import { store, textId, loadSettings, saveSettings, migrateLegacy } from './store.js';
import { RsvpEngine } from './engine.js';
import * as cloud from './cloud.js';

const $ = id => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
}

function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    svg.setAttribute('aria-hidden', 'true');
    return svg;
}

const wordsInText = text => (text.match(/\S+/g) || []).length;

function formatDuration(ms) {
    const min = Math.round(ms / 60000);
    if (min < 1) return 'moins d’une minute';
    if (min < 60) return `${min} min`;
    const hrs = Math.floor(min / 60), rest = min % 60;
    return rest ? `${hrs} h ${String(rest).padStart(2, '0')}` : `${hrs} h`;
}

// ---------------------------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------------------------

let settings = loadSettings();
let current = null;          // { book, text, tokens }
let lastSavedAt = 0;
let lastCloudAt = 0;
let wakeLock = null;

const engine = new RsvpEngine({
    onWord: renderWord,
    onState: playing => {
        $('reader').classList.toggle('playing', playing);
        const btn = $('btnPlay');
        btn.replaceChildren(icon(playing ? 'pause' : 'play'));
        btn.setAttribute('aria-label', playing ? 'Pause' : 'Lire');
        if (playing) { acquireWakeLock(); $('toast').hidden = true; } else { releaseWakeLock(); renderPaused(); saveProgress(true); }
    },
    onEnd: () => {
        showMessage('Fin du livre 🎉');
        saveProgress(true);
    }
});

// ---------------------------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------------------------

function applySettings() {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.font = settings.font;
    root.dataset.guide = settings.guide ? 'on' : 'off';
    root.dataset.progress = settings.progressLine ? 'on' : 'off';
    root.style.setProperty('--font-scale', settings.fontScale);
    engine.setWpm(settings.wpm);
    engine.rampUp = settings.rampUp;
    if (engine.pauses !== settings.pauses) engine.setPauses(settings.pauses);
    $('wpmOut').textContent = settings.wpm;
    if (current && !engine.playing) renderPaused();
}

let settingsPushTimer = null;
function updateSettings(patch) {
    const needRetokenize = current && patch.maxLen !== undefined && patch.maxLen !== settings.maxLen;
    settings = { ...settings, ...patch, updatedAt: Date.now() };
    saveSettings(settings);
    applySettings();
    if (needRetokenize) {
        const offset = engine.offset;
        current.tokens = tokenize(current.text, settings.maxLen);
        engine.load(current.tokens, indexAtOffset(current.tokens.offsets, offset));
    }
    clearTimeout(settingsPushTimer);
    settingsPushTimer = setTimeout(() => cloud.pushSettings(settings).catch(() => {}), 2000);
}

function fillSettingsForm() {
    $('sWpm').value = settings.wpm; $('sWpmOut').textContent = settings.wpm + ' mots/min';
    $('sPauses').value = String(settings.pauses);
    $('sMaxLen').value = settings.maxLen; $('sMaxLenOut').textContent = settings.maxLen + ' lettres';
    $('sRamp').checked = settings.rampUp;
    $('sFontScale').value = String(settings.fontScale);
    $('sFont').value = settings.font;
    $('sTheme').value = settings.theme;
    $('sGuide').checked = settings.guide;
    $('sProgress').checked = settings.progressLine;
}

function bindSettingsForm() {
    $('sWpm').addEventListener('input', e => { $('sWpmOut').textContent = e.target.value + ' mots/min'; updateSettings({ wpm: Number(e.target.value) }); });
    $('sPauses').addEventListener('change', e => updateSettings({ pauses: Number(e.target.value) }));
    $('sMaxLen').addEventListener('input', e => { $('sMaxLenOut').textContent = e.target.value + ' lettres'; });
    $('sMaxLen').addEventListener('change', e => updateSettings({ maxLen: Number(e.target.value) }));
    $('sRamp').addEventListener('change', e => updateSettings({ rampUp: e.target.checked }));
    $('sFontScale').addEventListener('change', e => updateSettings({ fontScale: Number(e.target.value) }));
    $('sFont').addEventListener('change', e => updateSettings({ font: e.target.value }));
    $('sTheme').addEventListener('change', e => updateSettings({ theme: e.target.value }));
    $('sGuide').addEventListener('change', e => updateSettings({ guide: e.target.checked }));
    $('sProgress').addEventListener('change', e => updateSettings({ progressLine: e.target.checked }));
}

function changeSpeed(delta) {
    const wpm = Math.max(100, Math.min(1200, Math.round((settings.wpm + delta) / 5) * 5));
    updateSettings({ wpm });
    if (engine.playing) flash(`${wpm} mots/min`);
}

// ---------------------------------------------------------------------------------------------
// Notifications, chargement, confirmation
// ---------------------------------------------------------------------------------------------

let toastTimer = null;
function toast(msg, { error = false, ms = 4000 } = {}) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', error);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const flash = msg => toast(msg, { ms: 900 });

let busyCtrl = null;
function busy(msg, { progress = false } = {}) {
    busyCtrl = new AbortController();
    $('busyMsg').textContent = msg;
    $('busyBarWrap').hidden = !progress;
    $('busyBar').style.width = '0%';
    $('busy').hidden = false;
    return {
        signal: busyCtrl.signal,
        status: m => { $('busyMsg').textContent = m; },
        progress: r => { $('busyBarWrap').hidden = false; $('busyBar').style.width = Math.round(r * 100) + '%'; }
    };
}
function unbusy() { $('busy').hidden = true; busyCtrl = null; }

function confirmDialog(title, text, okLabel = 'Supprimer') {
    const dlg = $('dlgConfirm');
    $('cTitle').textContent = title;
    $('cText').textContent = text;
    $('cOk').textContent = okLabel;
    return new Promise(resolve => {
        const done = ok => { dlg.close(); resolve(ok); };
        $('cOk').onclick = () => done(true);
        $('cCancel').onclick = () => done(false);
        dlg.oncancel = () => resolve(false);
        dlg.showModal();
    });
}

// ---------------------------------------------------------------------------------------------
// Bibliothèque
// ---------------------------------------------------------------------------------------------

function remainingFor(book) {
    const words = book.words || 0;
    return words * (1 - (book.ratio || 0)) / settings.wpm * 60000;
}

async function renderLibrary() {
    const books = await store.listBooks();
    const list = $('bookList');
    list.replaceChildren();
    $('emptyState').hidden = books.length > 0;

    const inProgress = books.find(b => b.lastReadAt && (b.ratio || 0) < 0.995);
    $('resume').hidden = !inProgress;
    if (inProgress) {
        $('resumeTitle').textContent = inProgress.title;
        $('resumeAuthor').textContent = inProgress.author || '';
        $('resumeBar').style.width = Math.round((inProgress.ratio || 0) * 100) + '%';
        $('resumeMeta').textContent = `${Math.round((inProgress.ratio || 0) * 100)} % · encore ${formatDuration(remainingFor(inProgress))}`;
        $('resumeCard').onclick = () => openBook(inProgress.id);
    }

    for (const b of books) {
        const pct = Math.round((b.ratio || 0) * 100);
        const meta = pct >= 100 ? 'Terminé'
            : pct > 0 ? `${pct} % · encore ${formatDuration(remainingFor(b))}`
            : b.words ? `${formatDuration(remainingFor(b))} de lecture` : 'Non commencé';
        list.append(h('li', { class: 'book' },
            h('button', { class: 'book-open', onclick: () => openBook(b.id) },
                h('span', { class: 'book-title' }, b.title),
                b.author ? h('span', { class: 'book-author' }, b.author) : null,
                h('span', { class: 'book-meta' },
                    h('span', { class: 'bar' }, h('span', { style: `width:${pct}%` })),
                    h('span', {}, meta),
                    !b.hasText ? h('span', { title: 'Enregistré dans votre compte : téléchargé à l’ouverture' }, icon('cloud')) : null
                )
            ),
            h('div', { class: 'book-actions' },
                h('button', { class: 'icon-btn', 'aria-label': `Supprimer « ${b.title} »`, onclick: () => removeBook(b) }, icon('trash'))
            )
        ));
    }
}

async function removeBook(b) {
    const signedIn = !!cloud.currentUser();
    const ok = await confirmDialog(`Supprimer « ${b.title} » ?`,
        signedIn ? 'Le livre et sa progression seront supprimés de tous vos appareils.' : 'Le livre et sa progression seront supprimés de cet appareil.');
    if (!ok) return;
    await store.deleteBook(b.id);
    if (signedIn) cloud.deleteRemoteBook(b.id).catch(() => {});
    renderLibrary();
}

/** Enregistre un texte extrait et l'ouvre. */
async function addBook({ text, title, author }, extra = {}) {
    const id = extra.id || await textId(text);
    const existing = await store.getBook(id);
    if (existing && existing.hasText) { await openBook(id); return; }

    const now = Date.now();
    const book = {
        id,
        title: (title || 'Sans titre').trim(),
        author: (author || '').trim(),
        source: extra.source || 'file',
        sourceId: extra.sourceId, sourceUrl: extra.sourceUrl,
        addedAt: existing ? existing.addedAt : now,
        updatedAt: now,
        chars: text.length,
        words: wordsInText(text),
        position: existing ? existing.position || 0 : 0,
        ratio: existing ? existing.ratio || 0 : 0,
        progressAt: existing ? existing.progressAt || 0 : 0,
        lastReadAt: now
    };
    for (const k of Object.keys(book)) if (book[k] === undefined) delete book[k];
    await store.saveBookWithText(book, text);
    store.persist();
    if (cloud.currentUser()) cloud.pushBook(book, text).catch(e => console.warn('Envoi cloud :', e));
    await openBook(id);
}

async function importFile(file) {
    const b = busy(`Lecture de « ${file.name} »…`, { progress: true });
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await extractAny(bytes, { name: file.name, type: file.type, onProgress: b.progress });
        if (b.signal.aborted) return;
        unbusy();
        await addBook(result, { source: 'file' });
    } catch (e) {
        unbusy();
        if (!b.signal.aborted) toast(e.message || 'Fichier illisible.', { error: true, ms: 7000 });
    } finally {
        $('fileInput').value = '';
    }
}

// ---------------------------------------------------------------------------------------------
// Gutenberg, lien, texte collé
// ---------------------------------------------------------------------------------------------

let gSearchCtrl = null;
async function runGutenbergSearch() {
    if (gSearchCtrl) gSearchCtrl.abort();
    gSearchCtrl = new AbortController();
    const signal = gSearchCtrl.signal;
    const ul = $('gResults');
    ul.replaceChildren(h('li', { class: 'status' }, 'Recherche…'));
    try {
        const results = await searchGutenberg($('gQuery').value.trim(), $('gLang').value, { signal });
        if (signal.aborted) return;
        ul.replaceChildren();
        if (!results.length) { ul.append(h('li', { class: 'status' }, 'Aucun livre trouvé. Essayez un autre nom ou une autre langue.')); return; }
        for (const r of results) {
            ul.append(h('li', {}, h('button', { onclick: () => openGutenbergBook(r) },
                h('span', { class: 'result-title' }, r.title),
                h('span', { class: 'result-author' }, r.author || 'Auteur inconnu')
            )));
        }
    } catch (e) {
        if (signal.aborted) return;
        ul.replaceChildren(h('li', { class: 'status' }, 'Le catalogue ne répond pas. Vérifiez votre connexion puis réessayez.'));
    }
}

async function openGutenbergBook(r) {
    const id = 'pg_' + r.id;
    const existing = await store.getBook(id);
    $('dlgGutenberg').close();
    if (existing && existing.hasText) { await openBook(id); return; }
    const b = busy(`Téléchargement de « ${r.title} »…`);
    try {
        const result = await downloadGutenberg(r, { signal: b.signal, onStatus: b.status });
        unbusy();
        await addBook(result, { id, source: 'gutenberg', sourceId: r.id });
    } catch (e) {
        unbusy();
        if (!b.signal.aborted) toast(e.message, { error: true, ms: 7000 });
    }
}

async function submitUrl(e) {
    e.preventDefault();
    const url = $('uInput').value;
    $('dlgUrl').close();
    const b = busy('Import du lien…');
    try {
        const result = await importFromUrl(url, { signal: b.signal, onStatus: b.status });
        unbusy();
        const extra = result.source === 'gutenberg'
            ? { id: 'pg_' + result.sourceId, source: 'gutenberg', sourceId: result.sourceId }
            : { source: 'url', sourceUrl: result.sourceUrl };
        await addBook(result, extra);
        $('uInput').value = '';
    } catch (err) {
        unbusy();
        if (!b.signal.aborted) toast(err.message || 'Import impossible.', { error: true, ms: 7000 });
    }
}

async function submitPaste(e) {
    e.preventDefault();
    const raw = $('pText').value;
    const result = extractPasted(raw);
    if (result.text.replace(/\s/g, '').length < 2) { toast('Le texte est vide.', { error: true }); return; }
    const t = $('pTitleInput').value.trim();
    if (t) result.title = t;
    $('dlgPaste').close();
    $('pText').value = ''; $('pTitleInput').value = '';
    await addBook(result, { source: 'paste' });
}

// ---------------------------------------------------------------------------------------------
// Lecteur
// ---------------------------------------------------------------------------------------------

async function openBook(id) {
    let book = await store.getBook(id);
    if (!book) return;
    let text = book.hasText ? await store.getText(id) : null;

    if (!text) {
        if (!cloud.currentUser()) { toast('Connectez-vous à votre compte (Réglages) pour récupérer ce livre.', { error: true, ms: 6000 }); return; }
        const b = busy(`Récupération de « ${book.title} »…`, { progress: true });
        try {
            const content = await cloud.pullBookContent(id);
            if (content.pdf) text = (await extractPdf(content.pdf, b.progress)).text;
            else text = content.text;
            book = { ...book, chars: text.length, words: wordsInText(text) };
            if (book.position === undefined || book.position === null) book.position = Math.floor((book.ratio || 0) * text.length);
            await store.saveBookWithText(book, text);
            if (content.pdf) cloud.pushBook(book, text).catch(() => {});   // convertit l'ancien format
            unbusy();
        } catch (e) {
            unbusy();
            toast('Impossible de récupérer ce livre : ' + e.message, { error: true, ms: 7000 });
            return;
        }
    }

    const tokens = tokenize(text, settings.maxLen);
    current = { book, text, tokens };
    $('readerTitle').textContent = book.title;
    $('readerAuthor').textContent = book.author || '';
    document.title = book.title + ' — Lecture rapide';
    showScreen('reader');

    const position = book.position !== undefined && book.position !== null
        ? book.position : Math.floor((book.ratio || 0) * text.length);
    engine.load(tokens, indexAtOffset(tokens.offsets, position));
    renderPaused();
    store.patchBook(id, { lastReadAt: Date.now() });
    $('btnPlay').focus({ preventScroll: true });
}

async function closeReader() {
    engine.pause();
    await saveProgress(true);
    current = null;
    document.title = 'Lecture rapide';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    showScreen('library');
    renderLibrary();
}

function showScreen(name) {
    $('library').hidden = name !== 'library';
    $('reader').hidden = name !== 'reader';
}

const wLeft = $('wLeft'), wPivot = $('wPivot'), wRight = $('wRight'), wordEl = $('word'), fill = $('progressFill');

function renderWord(i) {
    if (!current) return;
    const w = current.tokens.words[i];
    const chars = Array.from(w);
    const p = pivotIndex(w);
    if (wordEl.classList.contains('message')) wordEl.classList.remove('message');
    wLeft.textContent = chars.slice(0, p).join('');
    wPivot.textContent = chars[p] || '';
    wRight.textContent = chars.slice(p + 1).join('');
    fill.style.transform = `scaleX(${engine.ratio})`;
    if (engine.playing && Date.now() - lastSavedAt > 5000) saveProgress(false);
}

function showMessage(msg) {
    wordEl.classList.add('message');
    wLeft.textContent = ''; wRight.textContent = '';
    wPivot.textContent = msg;
}

/** Affichage en pause : phrase en contexte, position, temps restant. */
function renderPaused() {
    if (!current || engine.playing) return;
    const i = engine.index;
    const [start, end] = engine.sentenceBounds(i);
    const from = Math.max(start, i - 40), to = Math.min(end, i + 40);
    const ctx = $('context');
    ctx.replaceChildren();
    if (from > start) ctx.append('… ');
    // Les morceaux d'un mot coupé partagent le même offset : on affiche le mot d'origine, tel
    // qu'il est dans le texte, en un seul élément cliquable.
    const { offsets } = current.tokens;
    for (let k = from; k < to;) {
        let e = k + 1;
        while (e < to && offsets[e] === offsets[k]) e++;
        const nextOff = e < offsets.length ? offsets[e] : current.text.length;
        const original = current.text.slice(offsets[k], nextOff).trim();
        ctx.append(h('span', { 'data-i': k, class: i >= k && i < e ? 'current' : null }, original));
        if (e < to) ctx.append(' ');
        k = e;
    }
    if (to < end) ctx.append(' …');

    const pct = engine.ratio * 100;
    $('seek').value = Math.round(engine.ratio * 1000);
    $('pct').textContent = (pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)) + ' %';
    $('remaining').textContent = 'encore ' + formatDuration(engine.remainingMs());
}

let pendingSave = null;
async function saveProgress(force) {
    if (!current) return;
    const { book } = current;
    const position = engine.offset;
    const ratio = engine.ratio;
    const now = Date.now();
    lastSavedAt = now;
    book.position = position; book.ratio = ratio; book.progressAt = now;
    pendingSave = store.patchBook(book.id, { position, ratio, progressAt: now, lastReadAt: now }).catch(() => {});
    if (cloud.currentUser() && (force || now - lastCloudAt > 60000)) {
        lastCloudAt = now;
        cloud.pushProgress(book.id, position, ratio, now).catch(() => {});
    }
    return pendingSave;
}

async function acquireWakeLock() {
    try {
        if ('wakeLock' in navigator && !wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch { wakeLock = null; }
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

function bindReader() {
    $('btnPlay').addEventListener('click', () => engine.toggle());
    $('btnPrev').addEventListener('click', () => { engine.stepSentence(-1); renderPaused(); });
    $('btnNext').addEventListener('click', () => { engine.stepSentence(1); renderPaused(); });
    $('btnSlower').addEventListener('click', () => changeSpeed(-25));
    $('btnFaster').addEventListener('click', () => changeSpeed(25));
    $('btnClose').addEventListener('click', closeReader);
    $('btnReaderSettings').addEventListener('click', openSettings);
    if (document.fullscreenEnabled) $('btnFullscreen').addEventListener('click', toggleFullscreen);
    else $('btnFullscreen').hidden = true;

    $('seek').addEventListener('input', e => { engine.seekRatio(Number(e.target.value) / 1000); renderPaused(); });
    $('seek').addEventListener('change', () => saveProgress(true));
    $('context').addEventListener('click', e => {
        const i = e.target.dataset && e.target.dataset.i;
        if (i !== undefined) { engine.seek(Number(i)); renderPaused(); }
    });

    // Toucher = lecture/pause ; glisser horizontalement = phrase précédente/suivante
    const stage = $('stage');
    let down = null;
    stage.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
    stage.addEventListener('pointerup', e => {
        if (!down) return;
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        down = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            const wasPlaying = engine.playing;
            engine.stepSentence(dx > 0 ? -1 : 1);
            if (!wasPlaying) renderPaused();
        } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
            engine.toggle();
        }
    });
    // Pendant la lecture, les commandes sont invisibles : tout toucher met en pause
    $('reader').addEventListener('pointerup', e => {
        if (engine.playing && !stage.contains(e.target)) engine.pause();
    });
}

function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || document.querySelector('dialog[open]') || !$('busy').hidden) return;
    if ($('reader').hidden) return;

    switch (e.key) {
        case ' ': case 'k': case 'K':
            if (tag === 'button' && e.key === ' ' && e.target.id !== 'btnPlay' && !engine.playing) return;
            e.preventDefault(); engine.toggle(); break;
        case 'ArrowLeft':
            e.preventDefault();
            e.shiftKey ? engine.stepWord(-1) : engine.stepSentence(-1);
            renderPaused(); break;
        case 'ArrowRight':
            e.preventDefault();
            e.shiftKey ? engine.stepWord(1) : engine.stepSentence(1);
            renderPaused(); break;
        case 'ArrowUp': e.preventDefault(); changeSpeed(25); break;
        case 'ArrowDown': e.preventDefault(); changeSpeed(-25); break;
        case 'f': case 'F': if (document.fullscreenEnabled) { e.preventDefault(); toggleFullscreen(); } break;
        case 'Escape':
            if (document.fullscreenElement) return;
            e.preventDefault(); closeReader(); break;
    }
}

// ---------------------------------------------------------------------------------------------
// Compte et synchronisation
// ---------------------------------------------------------------------------------------------

let createMode = false;
let syncing = false;

function openSettings() {
    engine.pause();
    fillSettingsForm();
    $('dlgSettings').showModal();
}

function renderAccount(user) {
    $('accountBox').hidden = !cloud.cloudConfigured;
    $('accountOut').hidden = !!user;
    $('accountIn').hidden = !user;
    if (user) $('accountEmail').textContent = user.email || user.displayName || 'compte';
}

async function syncAll({ silent = false } = {}) {
    if (!cloud.currentUser() || syncing) return;
    syncing = true;
    const msg = $('accountMsg');
    if (!silent) msg.textContent = 'Synchronisation…';
    try {
        const remoteSettings = await cloud.syncSettings(settings);
        if (remoteSettings) { settings = remoteSettings; saveSettings(settings); applySettings(); fillSettingsForm(); }

        const [remote, local] = await Promise.all([cloud.listRemoteBooks(), store.listBooks()]);
        const localMap = new Map(local.map(b => [b.id, b]));
        const remoteIds = new Set();
        for (const r of remote) {
            remoteIds.add(r.id);
            const l = localMap.get(r.id);
            if (!l) {
                await store.putBook({ ...r, hasText: false, lastReadAt: r.progressAt || 0 });
                continue;
            }
            const patch = {};
            if ((r.progressAt || 0) > (l.progressAt || 0)) {
                patch.ratio = r.ratio || 0;
                patch.position = r.position !== undefined ? r.position : Math.floor((r.ratio || 0) * (l.chars || 0));
                patch.progressAt = r.progressAt;
                patch.lastReadAt = Math.max(l.lastReadAt || 0, r.progressAt);
            } else if ((l.progressAt || 0) > (r.progressAt || 0)) {
                await cloud.pushProgress(l.id, l.position || 0, l.ratio || 0, l.progressAt);
            }
            if (Object.keys(patch).length) await store.patchBook(l.id, patch);
            if (!r.cloudText && l.hasText) {
                const text = await store.getText(l.id);
                if (text) await cloud.pushBook(l, text);
            }
        }
        for (const l of local) {
            if (remoteIds.has(l.id) || !l.hasText) continue;
            const text = await store.getText(l.id);
            if (!text) continue;
            await cloud.pushBook(l, text);
            if (l.progressAt) await cloud.pushProgress(l.id, l.position || 0, l.ratio || 0, l.progressAt);
        }
        if (!silent) msg.textContent = 'Bibliothèque synchronisée.';
        if (!current) renderLibrary();
    } catch (e) {
        console.warn('Synchronisation :', e);
        msg.textContent = 'Synchronisation impossible pour le moment.';
        if (!silent) toast('Synchronisation impossible pour le moment.', { error: true });
    } finally {
        syncing = false;
    }
}

function bindAccount() {
    $('btnGoogle').addEventListener('click', async () => {
        $('accountMsg').textContent = '';
        try { await cloud.signInGoogle(); } catch (e) { $('accountMsg').textContent = cloud.authErrorMessage(e); }
    });
    $('btnToggleCreate').addEventListener('click', () => {
        createMode = !createMode;
        $('btnEmail').textContent = createMode ? 'Créer mon compte' : 'Se connecter';
        $('btnToggleCreate').textContent = createMode ? 'J’ai déjà un compte' : 'Créer un compte';
        $('aPass').autocomplete = createMode ? 'new-password' : 'current-password';
    });
    $('emailForm').addEventListener('submit', async e => {
        e.preventDefault();
        $('accountMsg').textContent = '';
        try { await cloud.signInEmail($('aEmail').value.trim(), $('aPass').value, createMode); $('aPass').value = ''; }
        catch (err) { $('accountMsg').textContent = cloud.authErrorMessage(err); }
    });
    $('btnSignOut').addEventListener('click', async () => { await cloud.signOut(); $('accountMsg').textContent = 'Déconnecté. Vos livres restent disponibles sur cet appareil.'; });
    $('btnSyncNow').addEventListener('click', () => syncAll());
}

// ---------------------------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------------------------

function bindLibrary() {
    $('fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) importFile(f); });
    $('btnSettings').addEventListener('click', openSettings);
    $('btnGutenberg').addEventListener('click', () => {
        $('dlgGutenberg').showModal();
        if (!$('gResults').children.length) runGutenbergSearch();
    });
    $('gForm').addEventListener('submit', e => { e.preventDefault(); runGutenbergSearch(); });
    $('gLang').addEventListener('change', runGutenbergSearch);
    $('btnUrl').addEventListener('click', () => { $('dlgUrl').showModal(); $('uInput').focus(); });
    $('uForm').addEventListener('submit', submitUrl);
    $('btnPaste').addEventListener('click', () => { $('dlgPaste').showModal(); $('pText').focus(); });
    $('pForm').addEventListener('submit', submitPaste);
    $('busyCancel').addEventListener('click', () => { if (busyCtrl) busyCtrl.abort(); unbusy(); });

    document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
    $('dlgSettings').addEventListener('close', () => { if (current) renderPaused(); });

    // Glisser-déposer
    let depth = 0;
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    document.addEventListener('dragenter', e => { if (!hasFiles(e) || !$('reader').hidden) return; depth++; document.body.classList.add('dragging'); });
    document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0; document.body.classList.remove('dragging');
        const f = e.dataTransfer.files[0];
        if (f && $('reader').hidden) importFile(f);
    });

    // Partage vers l'app (Android : "Partager → Lecture rapide") via ?url= / ?text=
    const q = new URLSearchParams(location.search);
    const sharedUrl = q.get('url') || (/^https?:\/\//.test(q.get('text') || '') ? q.get('text') : '');
    if (sharedUrl) { $('uInput').value = sharedUrl; history.replaceState(null, '', location.pathname); $('uForm').requestSubmit(); }
    else if (q.get('text')) { $('pText').value = q.get('text'); $('pTitleInput').value = q.get('title') || ''; history.replaceState(null, '', location.pathname); $('dlgPaste').showModal(); }
}

async function main() {
    applySettings();
    bindSettingsForm();
    bindLibrary();
    bindReader();
    bindAccount();
    document.addEventListener('keydown', onKey);

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { engine.pause(); saveProgress(true); }
    });
    window.addEventListener('pagehide', () => saveProgress(true));

    const migrated = await migrateLegacy();
    settings = loadSettings();
    applySettings();
    await renderLibrary();
    if (migrated) toast(`${migrated} livre${migrated > 1 ? 's' : ''} de l’ancienne version récupéré${migrated > 1 ? 's' : ''}.`);

    renderAccount(null);
    if (cloud.cloudConfigured) {
        cloud.initCloud().then(ok => {
            if (!ok) return;
            let lastUid = null;
            cloud.onUser(user => {
                renderAccount(user);
                if (user && user.uid !== lastUid) syncAll({ silent: true });
                lastUid = user ? user.uid : null;
            });
        });
    }

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
}

main();
