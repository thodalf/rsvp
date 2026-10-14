// Tests de la chaîne texte : node tests/run.mjs  (après `npm install` dans tests/)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import JSZip from 'jszip';
import pdfjsDefault from 'pdfjs-dist/legacy/build/pdf.js';
const pdfjsLib = pdfjsDefault.getDocument ? pdfjsDefault : pdfjsDefault.default;

globalThis.DOMParser = DOMParser;
globalThis.JSZip = JSZip;
globalThis.pdfjsLib = pdfjsLib;

const { FLAG_PROPER_NOUN, tokenize, textFromPlain, splitLong, pivotIndex, indexAtOffset, joinLines, FLAG_SENTENCE_START, FLAG_PARAGRAPH_END } = await import('../js/text.js');
const { extractAny, extractHtmlString, decodeBytes, sniffFormat } = await import('../js/extract.js');

let passed = 0;
const test = async (name, fn) => {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.error('  ✗', name, '\n', e); process.exitCode = 1; }
};

console.log('Découpage');
await test('ponctuation française rattachée aux mots', () => {
    const { words } = tokenize('« Bonjour » , dit-il . — Vraiment ? Oui ; non : peut-être !');
    assert.deepEqual(words, ['«\u00A0Bonjour\u00A0»,', 'dit-il.', '—\u00A0Vraiment\u00A0?', 'Oui\u00A0;', 'non\u00A0:', 'peut-être\u00A0!']);
});
await test('mots composés courts non coupés, longs coupés proprement', () => {
    assert.deepEqual(splitLong('dit-il', 12), ['dit-il']);
    assert.deepEqual(splitLong('Charles-François-Bienvenu', 13), ['Charles-', 'François-', 'Bienvenu']);
    const parts = splitLong('anticonstitutionnellement', 13);
    assert.ok(parts.every(p => p.length <= 13), parts.join('|'));
    assert.equal(parts.map(p => p.replace(/-$/, '')).join(''), 'anticonstitutionnellement');
});
await test('aucun mot perdu ni modifié', () => {
    const text = 'Il était une fois, en 1815, un évêque.\nLe deuxième paragraphe commence ici et finit là.';
    const { words } = tokenize(text, 30);
    assert.equal(words.join(' ').replace(/\u00A0/g, ' '), text.replace('\n', ' '));
});
await test('drapeaux phrase / paragraphe et poids', () => {
    const t = tokenize('Un deux. Trois quatre\nCinq.');
    assert.ok(t.flags[0] & FLAG_SENTENCE_START);
    assert.ok(t.flags[2] & FLAG_SENTENCE_START);
    assert.ok(t.flags[3] & FLAG_PARAGRAPH_END);
    assert.ok(t.weights[1] > t.weights[0]);
});
await test('position par offset stable même après découpage', () => {
    const text = 'aaa anticonstitutionnellement bbb';
    const t = tokenize(text, 10);
    const i = indexAtOffset(t.offsets, text.indexOf('anti'));
    assert.equal(t.words[i].startsWith('anti'), true);
    assert.equal(t.words[indexAtOffset(t.offsets, text.indexOf('bbb'))], 'bbb');
});
await test('abréviations et initiales ne coupent pas la phrase', () => {
    const t = tokenize('En 1815, M. Myriel vit J. K. Rowling. Puis il partit. — Vraiment ? demanda-t-il. Oui.');
    const starts = t.words.filter((w, i) => t.flags[i] & FLAG_SENTENCE_START);
    assert.deepEqual(starts.map(w => w.replace(/\u00A0/g, ' ')), ['En', 'Puis', '— Vraiment ?', 'Oui.']);
});
await test('point de fixation', () => {
    assert.equal(pivotIndex('a'), 0);
    assert.equal(pivotIndex('chat'), 1);
    assert.equal(pivotIndex('«\u00A0Bonjour'), 4);
    assert.equal(pivotIndex('évêque'), 2);
});

console.log('Texte brut / Gutenberg');
await test('en-tête et licence Gutenberg supprimés, paragraphes reconstruits', () => {
    const raw = `The Project Gutenberg eBook of Test\r\n\r\n*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\r\n\r\nProduced by Someone\r\n\r\nCHAPITRE PREMIER\r\n\r\nEn 1815, M. Myriel était\r\névêque de Digne. Il avait 75\r\nans. _Vraiment._ [Illustration: portrait]\r\n\r\n* * *\r\n\r\nFin.\r\n\r\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\r\nLicense blah`;
    const t = textFromPlain(raw);
    assert.equal(t, 'CHAPITRE PREMIER\nEn 1815, M. Myriel était évêque de Digne. Il avait 75 ans. Vraiment.\nFin.');
});
await test('fichier Windows-1252 décodé sans caractères cassés', () => {
    const bytes = Uint8Array.from([0x45, 0x74, 0xE9, 0x20, 0xE0, 0x20, 0x4E, 0x6F, 0xEB, 0x6C]);
    assert.equal(decodeBytes(bytes), 'Eté à Noël');
});
await test('césure de fin de ligne', () => {
    assert.equal(joinLines(['le pro-', 'gramme et peut-', 'être dit-', 'il'], 'pdf'), 'le programme et peut-être dit-il');
    assert.equal(joinLines(['peut-', 'être'], 'plain'), 'peut-être');
});

console.log('HTML');
await test('article : contenu principal, sans menus ni notes', () => {
    const html = `<html><head><title>Titre page</title><meta property="og:title" content="Mon article"></head><body>
      <nav><a>Accueil</a><a>Contact</a></nav><header>Menu du site</header>
      <article><h1>Mon article</h1><p>Premier paragraphe assez long pour compter dans le score du contenu principal.</p>
      <p>Second paragraphe<sup><a href="#n1">1</a></sup> lui aussi suffisamment long pour être retenu ici.</p></article>
      <footer>© 2026 Mentions légales</footer><script>alert(1)</script></body></html>`;
    const r = extractHtmlString(html, { article: true });
    assert.equal(r.title, 'Mon article');
    assert.equal(r.text, 'Mon article\nPremier paragraphe assez long pour compter dans le score du contenu principal.\nSecond paragraphe lui aussi suffisamment long pour être retenu ici.');
});

console.log('EPUB');
await test('EPUB : ordre du spine, métadonnées, numéros de page ignorés', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml', `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
    zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Mon Livre</dc:title><dc:creator>Jeanne Autrice</dc:creator></metadata>
      <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c2" href="text/ch%202.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`);
    const x = b => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title></head><body>${b}</body></html>`;
    zip.file('OEBPS/nav.xhtml', x('<nav><ol><li>Sommaire</li></ol></nav>'));
    zip.file('OEBPS/text/ch1.xhtml', x('<h2>Chapitre 1</h2><p>Il était une fois<a epub:type="noteref" href="#n">1</a> un roi.</p><span class="pagenum">12</span>'));
    zip.file('OEBPS/text/ch 2.xhtml', x('<p>La suite&#160;: une reine.</p>'));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    assert.equal(sniffFormat(bytes), 'epub');
    const r = await extractAny(bytes, { name: 'livre.epub' });
    assert.equal(r.title, 'Mon Livre');
    assert.equal(r.author, 'Jeanne Autrice');
    assert.equal(r.text, 'Chapitre 1\nIl était une fois un roi.\nLa suite : une reine.');
});

console.log('PDF');
await test('PDF : en-têtes/numéros retirés, chiffres du texte conservés, césures réparées', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./sample.pdf', import.meta.url)));
    const r = await extractAny(bytes, { name: 'sample.pdf' });
    assert.equal(r.title, 'Les Misérables (extrait)');
    assert.equal(r.author, 'Victor Hugo');
    assert.ok(!r.text.includes('TOME I'), 'en-tête répété supprimé');
    assert.ok(r.text.includes('En 1815, M. Charles-François-Bienvenu Myriel'), 'nombres conservés');
    assert.ok(r.text.includes('de Digne depuis 1806. Le programme de la page 3 comptait 42 points et peut-être davantage.'), r.text.slice(0, 400));
    assert.ok(r.text.includes('— Qu’en dites-vous ? demanda-t-il.'));
    const paras = r.text.split('\n');
    assert.ok(paras.includes('— Qu’en dites-vous ? demanda-t-il.'), 'dialogue = paragraphe');
    assert.ok(paras.some(p => /sans ponctuation finale et donc reprend ici\.$/.test(p)), 'paragraphe continué entre pages');
    assert.ok(r.text.includes('« Rien du tout », répondit-elle à Gavroche, et elle sortit.'), 'aucune ligne perdue');
    assert.ok(!/(^|\s)[1-6](\s|$)/.test(paras.join(' ').replace(/page \d/g, '')), 'numéros de page isolés supprimés');
});


console.log('Noms propres, accélération, ambiance');
await test('noms propres repérés hors début de phrase', () => {
    const t = tokenize('Puis Javert regarda Paris. Le CHAPITRE suivant parle de Cosette.');
    const proper = t.words.filter((w, i) => t.flags[i] & FLAG_PROPER_NOUN);
    assert.deepEqual(proper, ['Javert', 'Paris.', 'Cosette.']);
});
await test('accélération : +5 mots/min tous les 50 mots, plafonnée', async () => {
    const { RsvpEngine } = await import('../js/engine.js');
    const e = new RsvpEngine({});
    e.autoSpeed = true; e.autoSpeedMax = 1.1; e.setWpm(300);
    e.load(tokenize(Array(2000).fill('mot').join(' ')));
    e.playing = true;
    for (let k = 0; k < 120; k++) { e._tick(); clearTimeout(e._timer); }
    assert.equal(e.effectiveWpm, 310);
    for (let k = 0; k < 1000; k++) { e._tick(); clearTimeout(e._timer); }
    assert.equal(e.effectiveWpm, 330, 'plafond à +10 %');
    e.setWpm(400);
    assert.equal(e.effectiveWpm, 400, 'changer la vitesse remet à zéro');
    e.playing = false;
});
await test('pause sur les noms propres allonge leur durée sans changer la vitesse moyenne', async () => {
    const { RsvpEngine } = await import('../js/engine.js');
    const e = new RsvpEngine({});
    e.pauses = 0; e.properMult = 2; e.setWpm(600);
    const t = tokenize('le chat de Victor mange une pomme verte');
    e.load(t);
    const w = i => e._weight(i) * e._unit();
    assert.ok(Math.abs(w(3) / w(0) - 2) < 1e-9);
    const total = t.words.reduce((a, _, i) => a + w(i), 0);
    assert.ok(Math.abs(total - t.words.length * 100) < 1e-6, 'moyenne = 100 ms à 600 mots/min');
});
await test('carte des ambiances', async () => {
    const { buildMoodMap, moodOfWord } = await import('../js/mood.js');
    assert.equal(moodOfWord('dans'), null);
    assert.equal(moodOfWord('mystérieusement'), 'mysterious');
    const calm = Array(300).fill('il marchait vers la maison').join(' ');
    const fight = Array(60).fill('la bataille et la victoire des soldats dans la guerre').join(' ');
    const map = buildMoodMap(tokenize(calm + ' ' + fight).words);
    assert.equal(map[0], 'calm');
    assert.equal(map[map.length - 1], 'epic');
});

console.log('Relais Google Books (fonction Netlify)');
await test('relais : clé ajoutée côté serveur, réponse mise en cache 24 h', async () => {
    const calls = [];
    globalThis.fetch = async url => { calls.push(String(url)); return new Response(JSON.stringify({ items: [] }), { status: 200 }); };
    process.env.GOOGLE_BOOKS_API_KEY = 'CLE_TEST';
    const { default: handler } = await import('../netlify/functions/google-books.mjs');
    const res = await handler(new Request('https://site/api/google-books?q=hugo&lang=fr'));
    assert.equal(res.status, 200);
    assert.ok(calls[0].includes('key=CLE_TEST') && calls[0].includes('filter=free-ebooks') && calls[0].includes('langRestrict=fr'));
    assert.match(res.headers.get('netlify-cdn-cache-control'), /s-maxage=86400/);
    delete process.env.GOOGLE_BOOKS_API_KEY;
});
await test('relais : 429 de Google réessayé une fois puis signalé, jamais mis en cache', async () => {
    let n = 0;
    globalThis.fetch = async () => { n++; return new Response('{}', { status: 429, headers: { 'retry-after': '0.01' } }); };
    const { default: handler } = await import('../netlify/functions/google-books.mjs');
    const res = await handler(new Request('https://site/api/google-books?q=hugo'));
    assert.equal(res.status, 429);
    assert.equal(n, 2);
    assert.equal(res.headers.get('netlify-cdn-cache-control'), null);
    assert.equal((await res.json()).error, 'quota');
});
await test('relais : identifiant invalide refusé', async () => {
    const { default: handler } = await import('../netlify/functions/google-books.mjs');
    assert.equal((await handler(new Request('https://site/api/google-books?id=../../x'))).status, 400);
});

console.log(`\n${passed} tests réussis`);
