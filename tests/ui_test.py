# Test de bout en bout dans Chromium headless.
# Le CDN et les sites de livres sont simulés : le test vérifie l'app, pas le réseau.
#   cd tests && python3 ui_test.py   (après `node ../build.js`)
import io, json, os, subprocess, sys, time, pathlib, zipfile
os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', '/opt/pw-browsers')
os.environ.setdefault('PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS', '1')  # le SW passe aussi par les routes simulées
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
DIST = HERE.parent / 'dist'
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else HERE / 'shots')
OUT.mkdir(exist_ok=True)
NM = HERE / 'node_modules'

server = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', str(DIST)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
errors, failures = [], []

def check(cond, msg):
    print(('  ✓ ' if cond else '  ✗ ') + msg)
    if not cond: failures.append(msg)

GUTENDEX = {"results": [
    {"id": 17489, "title": "Les misérables Tome I: Fantine", "authors": [{"name": "Hugo, Victor"}], "languages": ["fr"], "download_count": 5000,
     "formats": {"text/plain; charset=utf-8": "https://www.gutenberg.org/ebooks/17489.txt.utf-8"}},
    {"id": 13951, "title": "Les trois mousquetaires", "authors": [{"name": "Dumas, Alexandre"}], "languages": ["fr"], "download_count": 4000, "formats": {}}
]}
BOOK = ("The Project Gutenberg eBook of Les misérables\r\n\r\n*** START OF THE PROJECT GUTENBERG EBOOK LES MISÉRABLES ***\r\n\r\n"
        "Produced by Volunteers\r\n\r\nLIVRE PREMIER--UN JUSTE\r\n\r\n"
        + "\r\n\r\n".join(f"En 1815, M. Charles-François-Bienvenu Myriel était évêque de Digne. C'était un\r\nvieillard d'environ soixante-quinze ans ; paragraphe numéro {i}." for i in range(1, 200))
        + "\r\n\r\n*** END OF THE PROJECT GUTENBERG EBOOK ***\r\nlicence...")

def make_epub():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('mimetype', 'application/epub+zip')
        z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
        z.writestr('content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Candide</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>')
        body = ''.join(f'<p>Il y avait en Westphalie, dans le château de monsieur le baron, un jeune garçon numéro {i}.</p>' for i in range(60))
        z.writestr('c.xhtml', f'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapitre premier</h1>{body}</body></html>')
    return buf.getvalue()
EPUB = make_epub()
GOOGLE = {"items": [
    {"id": "abc123XYZ_0", "volumeInfo": {"title": "Candide", "authors": ["Voltaire"], "publishedDate": "1759"},
     "accessInfo": {"viewability": "ALL_PAGES", "publicDomain": True,
                    "epub": {"isAvailable": True, "downloadLink": "http://books.google.fr/books/download/Candide.epub?id=abc123XYZ_0&output=epub&source=gbs_api"},
                    "pdf": {"isAvailable": True, "downloadLink": "http://books.google.fr/books/download/Candide.pdf?id=abc123XYZ_0&output=pdf"}}},
    {"id": "lecture000", "volumeInfo": {"title": "Livre en aperçu seulement"}, "accessInfo": {"viewability": "PARTIAL", "epub": {"isAvailable": False}, "pdf": {"isAvailable": False}}}
]}

def proxy_body(url):
    if 'gutendex' in url: return json.dumps(GUTENDEX).encode(), 'application/json'
    if 'books.google' in url: return EPUB, 'application/epub+zip'
    return BOOK.encode('utf-8'), 'text/plain; charset=utf-8'

def routes(page):
    page.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', lambda r: r.fulfill(path=str(NM / 'pdfjs-dist/build/pdf.min.js'), content_type='application/javascript'))
    page.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', lambda r: r.fulfill(path=str(NM / 'pdfjs-dist/build/pdf.worker.min.js'), content_type='application/javascript'))
    page.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', lambda r: r.fulfill(path=str(NM / 'jszip/dist/jszip.min.js'), content_type='application/javascript'))
    # gutendex direct : simule un blocage, le proxy public de secours répond
    page.route('https://gutendex.com/**', lambda r: r.abort())
    page.route('https://corsproxy.io/**', lambda r: r.fulfill(
        body=proxy_body(r.request.url)[0], content_type=proxy_body(r.request.url)[1],
        headers={'access-control-allow-origin': '*'}))
    page.route('https://www.googleapis.com/**', lambda r: r.fulfill(body=json.dumps(GOOGLE), content_type='application/json', headers={'access-control-allow-origin': '*'}))
    page.route('https://books.google.com/**', lambda r: r.abort())
    page.route('https://www.gutenberg.org/**', lambda r: r.abort())
    page.route('https://api.allorigins.win/**', lambda r: r.abort())
    page.route('https://api.codetabs.com/**', lambda r: r.abort())

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800}, color_scheme='dark')
    ctx.add_init_script("""(() => { const C = window.AudioContext; window.AudioContext = function (...a) { const c = new C(...a); window.__audio = c; return c; }; window.AudioContext.prototype = C.prototype; })();""")
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    routes(ctx)

    print('Migration de l’ancienne version')
    page.goto('http://localhost:8765/')
    page.evaluate("""() => {
        localStorage.clear();
        const words = 'Ancien livre de test avec quelques mots pour vérifier la reprise.'.split(' ');
        localStorage.setItem('rsvp_saved_books', JSON.stringify([{id:'pdf_old_1', title:'Ancien livre', author:'Moi'}]));
        localStorage.setItem('rsvp_book_pdf_old_1', JSON.stringify({id:'pdf_old_1', title:'Ancien livre', author:'Moi', words, modifiedWords: words}));
        localStorage.setItem('rsvp_progress_pdf_old_1', JSON.stringify({wordIndex: 5, totalWords: 10}));
        localStorage.setItem('rsvp_global_settings', JSON.stringify({wpm: 420, maxWordLength: 12}));
    }""")
    page.reload()
    page.wait_for_selector('.book')
    check(page.locator('.book-title').first.inner_text() == 'Ancien livre', 'ancien livre récupéré')
    check(page.locator('#resume').is_visible(), 'carte « Reprendre » affichée')
    check(json.loads(page.evaluate("localStorage.getItem('rsvp2_settings')"))['wpm'] == 420, 'ancienne vitesse reprise')

    print('Import PDF')
    page.set_input_files('#fileInput', str(HERE / 'sample.pdf'))
    page.wait_for_selector('#reader:not([hidden])', timeout=15000)
    check(page.locator('#readerTitle').inner_text() == 'Les Misérables (extrait)', 'titre lu dans le PDF')
    check(page.locator('#wPivot').inner_text() != '', 'premier mot affiché')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / '2-lecteur-pause.png'))

    print('Lecture')
    page.evaluate("""() => {
        window.__seen = [];
        new MutationObserver(() => window.__seen.push([performance.now(), document.getElementById('wLeft').textContent + document.getElementById('wPivot').textContent + document.getElementById('wRight').textContent]))
          .observe(document.getElementById('wPivot'), {childList: true, characterData: true, subtree: true});
    }""")
    page.keyboard.press('Space')
    page.wait_for_timeout(700)
    check(page.locator('#reader.playing').count() == 1, 'mode lecture actif')
    opacity = page.evaluate("getComputedStyle(document.querySelector('.chrome-bottom')).opacity")
    check(opacity == '0', 'commandes masquées pendant la lecture')
    page.screenshot(path=str(OUT / '3-lecteur-lecture.png'))
    page.wait_for_timeout(5000)
    page.keyboard.press('Space')
    seen = page.evaluate('window.__seen')
    words_shown = [w for _, w in seen]
    dupes = sum(1 for a, b in zip(words_shown, words_shown[1:]) if a == b)
    span = (seen[-1][0] - seen[5][0]) / 1000 if len(seen) > 6 else 0
    rate = (len(seen) - 6) / span * 60 if span else 0
    print(f'    {len(seen)} mots affichés, cadence mesurée ≈ {rate:.0f} mots/min (réglage 420, pauses naturelles)')
    check(len(seen) > 20, 'les mots défilent')
    check(250 < rate < 650, 'cadence cohérente avec le réglage')
    check(page.locator('#reader.playing').count() == 0, 'pause')
    ctx_text = page.locator('#context').inner_text()
    check(len(ctx_text) > 10 and page.locator('#context .current').count() == 1, 'phrase en contexte affichée en pause')
    joined = ' '.join(words_shown).replace(' ', ' ')
    check('programme' in joined or 'peut-être' in joined or 'Myriel' in joined, 'texte du PDF bien découpé')
    check('TOME I' not in joined, 'en-tête du PDF absent de la lecture')

    print('Navigation')
    before = page.locator('#context .current').inner_text()
    page.keyboard.press('ArrowRight')
    after = page.locator('#context .current').inner_text()
    check(before != after, 'phrase suivante')
    page.locator('#context span').nth(1).click()
    check(page.locator('#context span').nth(1).get_attribute('class') == 'current', 'clic sur un mot du contexte')
    page.keyboard.press('ArrowUp')
    check(page.locator('#wpmOut').inner_text() == '445', 'vitesse +25')
    page.screenshot(path=str(OUT / '4-lecteur-navigation.png'))

    print('Persistance')
    pct_before = page.locator('#pct').inner_text()
    page.keyboard.press('Escape')
    page.wait_for_selector('#library:not([hidden])')
    page.reload()
    page.wait_for_selector('.book')
    check(page.locator('#resumeTitle').inner_text() == 'Les Misérables (extrait)', 'dernier livre proposé en reprise')
    page.screenshot(path=str(OUT / '1-bibliotheque.png'))
    page.click('#resumeCard')
    page.wait_for_selector('#reader:not([hidden])')
    check(page.locator('#pct').inner_text() == pct_before, f'position conservée ({pct_before})')
    page.keyboard.press('Escape')

    print('Gutenberg (via proxy de secours)')
    page.click('#btnGutenberg')
    page.wait_for_selector('#gResults li button', timeout=15000)
    check('Victor Hugo' in page.locator('#gResults').inner_text(), 'résultats du catalogue (auteur remis dans l’ordre)')
    page.screenshot(path=str(OUT / '5-gutenberg.png'))
    page.locator('#gResults li button').first.click()
    page.wait_for_selector('#reader:not([hidden])', timeout=20000)
    page.wait_for_timeout(200)
    ctx_text = page.locator('#context').inner_text()
    check('START OF' not in ctx_text and 'Produced' not in ctx_text, 'licence Gutenberg retirée')
    check(page.locator('#readerTitle').inner_text().startswith('Les misérables'), 'livre Gutenberg ouvert')
    page.keyboard.press('Escape')

    print('Texte collé')
    page.click('#btnPaste')
    page.fill('#pText', '« Bonjour » , dit-il . Ceci est un texte collé, avec anticonstitutionnellement un mot très long.')
    page.click('#pForm button[type=submit]')
    page.wait_for_selector('#reader:not([hidden])')
    shown = page.evaluate("['wLeft','wPivot','wRight'].map(id => document.getElementById(id).textContent).join('')")
    check(shown.replace('\u00a0', ' ') == '« Bonjour »,', 'guillemets rattachés au mot affiché')
    page.keyboard.press('ArrowRight')
    check('anticonstitutionnellement' in page.locator('#context').inner_text(), 'mot long affiché entier dans le contexte')
    lens = page.evaluate("Array.from({length: 16}, (_, k) => k).map(() => { document.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true})); return ['wLeft','wPivot','wRight'].map(id => document.getElementById(id).textContent).join(''); })")
    check(any(w.endswith('-') for w in lens) and max(len(w) for w in lens) <= 13, 'mot très long coupé en morceaux à l’affichage')
    page.keyboard.press('Escape')

    print('Réglages')
    page.click('#btnSettings')
    page.select_option('#sTheme', 'sepia')
    page.screenshot(path=str(OUT / '6-reglages.png'))
    page.keyboard.press('Escape')
    check(page.evaluate("document.documentElement.dataset.theme") == 'sepia', 'thème appliqué')

    print('Musique, accélération, noms propres')
    page.click('#btnSettings')
    page.check('#sMusic')
    check(page.locator('#sProper').input_value() == '1.5' and page.locator('#sAuto').is_checked(), 'pause noms propres et accélération actives par défaut')
    page.keyboard.press('Escape')
    page.click('#resumeCard')
    page.wait_for_selector('#reader:not([hidden])')
    page.keyboard.press('Space')
    page.wait_for_timeout(1500)
    check(page.evaluate("window.__audio && window.__audio.state") == 'running', 'musique jouée pendant la lecture')
    page.keyboard.press('Space')
    check(page.locator('#moodChip').is_visible() and page.locator('#moodChip').inner_text().startswith('♪'), 'ambiance indiquée en pause : ' + page.locator('#moodChip').inner_text())
    page.wait_for_timeout(1500)
    check(page.evaluate("window.__audio.state") == 'suspended', 'musique coupée en pause')
    page.keyboard.press('Escape')
    page.click('#btnSettings'); page.uncheck('#sMusic'); page.keyboard.press('Escape')

    print('Google Livres')
    page.click('#btnGutenberg')
    page.click('#tabGoogle')
    page.wait_for_selector('#gResults li button >> text=Candide', timeout=15000)
    check(page.locator('#gResults li button').count() == 1, 'seuls les livres téléchargeables sont proposés')
    page.locator('#gResults li button').first.click()
    try:
        page.wait_for_selector('#reader:not([hidden])', timeout=20000)
    except Exception:
        print('    toast :', page.locator('#toast').inner_text(), page.locator('#busyMsg').inner_text())
        raise
    check(page.locator('#readerTitle').inner_text() == 'Candide', 'livre Google ouvert')
    check('Westphalie' in page.locator('#context').inner_text() or 'Chapitre' in page.locator('#context').inner_text(), 'texte Google extrait')
    page.keyboard.press('Escape')

    print('Liens Amazon / fichiers protégés')
    page.click('#btnUrl')
    page.fill('#uInput', 'https://www.amazon.fr/dp/B00ABCDEFG')
    page.click('#uForm button[type=submit]')
    page.wait_for_selector('#toast:not([hidden])')
    check('Kindle' in page.locator('#toast').inner_text(), 'lien Kindle : explication claire')
    acsm = HERE / 'shots_tmp.acsm'
    acsm.write_text('<fulfillmentToken fulfillmentType="buy" xmlns="http://ns.adobe.com/adept"></fulfillmentToken>')
    page.set_input_files('#fileInput', str(acsm))
    page.wait_for_timeout(500)
    check('.acsm' in page.locator('#toast').inner_text(), 'fichier .acsm : explication claire')
    acsm.unlink()
    page.screenshot(path=str(OUT / '10-acsm.png'))

    print('Mobile')
    m = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, color_scheme='light')
    mp = m.new_page()
    mp.on('pageerror', lambda e: errors.append(str(e)))
    routes(m)
    mp.goto('http://localhost:8765/')
    mp.evaluate("localStorage.clear()")
    mp.reload()
    mp.wait_for_selector('#emptyState:not([hidden])')
    mp.screenshot(path=str(OUT / '7-mobile-accueil.png'))
    mp.set_input_files('#fileInput', str(HERE / 'sample.pdf'))
    mp.wait_for_selector('#reader:not([hidden])', timeout=15000)
    mp.wait_for_timeout(300)
    mp.screenshot(path=str(OUT / '8-mobile-lecteur.png'))
    overflow = mp.evaluate("document.documentElement.scrollWidth > window.innerWidth")
    check(not overflow, 'pas de défilement horizontal sur mobile')
    mp.tap('#stage', position={'x': 195, 'y': 300})
    mp.wait_for_timeout(600)
    check(mp.locator('#reader.playing').count() == 1, 'toucher l’écran lance la lecture')
    mp.screenshot(path=str(OUT / '9-mobile-lecture.png'))
    mp.tap('#stage', position={'x': 195, 'y': 300})
    check(mp.locator('#reader.playing').count() == 0, 'toucher à nouveau met en pause')

    browser.close()

server.terminate()
real_errors = [e for e in errors if 'favicon' not in e and 'Failed to load resource' not in e]  # 404/blocages simulés du réseau
check(not real_errors, 'aucune erreur JavaScript' + ('' if not real_errors else ': ' + ' | '.join(real_errors[:5])))
print(f"\n{'ÉCHECS : ' + str(len(failures)) if failures else 'Tout est OK'}")
sys.exit(1 if failures else 0)
