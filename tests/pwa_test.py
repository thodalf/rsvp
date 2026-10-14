# Vérifie le comportement de webapp : manifeste, installation, service worker, hors ligne,
# partage de fichiers, raccourcis.   node build.js && python3 tests/pwa_test.py
import json, os, subprocess, sys, time, pathlib
os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', '/opt/pw-browsers')
os.environ.setdefault('PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS', '1')  # le SW passe aussi par les routes simulées
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
DIST = HERE.parent / 'dist'
NM = HERE / 'node_modules'
URL = 'http://localhost:8767/'
failures = []

def check(cond, msg):
    print(('  ✓ ' if cond else '  ✗ ') + msg)
    if not cond: failures.append(msg)

def cdn(ctx):
    ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', lambda r: r.fulfill(path=str(NM / 'pdfjs-dist/build/pdf.min.js'), content_type='application/javascript', headers={'access-control-allow-origin': '*'}))
    ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', lambda r: r.fulfill(path=str(NM / 'pdfjs-dist/build/pdf.worker.min.js'), content_type='application/javascript', headers={'access-control-allow-origin': '*'}))
    ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', lambda r: r.fulfill(path=str(NM / 'jszip/dist/jszip.min.js'), content_type='application/javascript', headers={'access-control-allow-origin': '*'}))

srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8767', '-d', str(DIST)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch()

    print('Manifeste')
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
    cdn(ctx)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    man = json.loads((DIST / 'manifest.json').read_text())
    check(man['display'] == 'standalone' and man['start_url'] and man['id'], 'affichage plein écran, adresse de départ et identifiant')
    sizes = {i['sizes'] for i in man['icons'] if i['purpose'] == 'any'}
    check({'192x192', '512x512'} <= sizes and any(i['purpose'] == 'maskable' for i in man['icons']), 'icônes 192/512 et icône adaptative')
    assets = [i['src'] for i in man['icons']] + [s['src'] for s in man['screenshots']] + [i['src'] for sc in man['shortcuts'] for i in sc['icons']]
    missing = [a for a in assets if page.request.get(URL + a).status != 200]
    check(not missing, 'toutes les images du manifeste existent' + (f' (manquantes : {missing})' if missing else ''))
    check(page.evaluate("document.querySelector('link[rel=manifest]').href").endswith('manifest.json'), 'manifeste lié à la page')

    print('Service worker et hors ligne')
    page.evaluate("navigator.serviceWorker.ready.then(() => true)")
    page.wait_for_function("!!navigator.serviceWorker.controller", timeout=15000)
    page.wait_for_timeout(1500)
    check(page.evaluate("!!navigator.serviceWorker.controller"), 'service worker actif')
    cached = page.evaluate("caches.keys().then(async ks => { const out = []; for (const k of ks) { const c = await caches.open(k); out.push(...(await c.keys()).map(r => r.url)); } return out; })")
    check(any('pdf.worker.min.js' in u for u in cached) and any('jszip' in u for u in cached), 'lecteurs PDF/EPUB mis en cache pour le hors ligne')

    page.click('#btnPaste'); page.fill('#pTitleInput', 'Texte hors ligne'); page.fill('#pText', 'Un texte à relire sans connexion. Il doit rester disponible.')
    page.click('#pForm button[type=submit]'); page.wait_for_selector('#reader:not([hidden])'); page.keyboard.press('Escape')

    ctx.set_offline(True)
    page.reload()
    page.wait_for_selector('.book', timeout=10000)
    check(page.locator('#offlinePill').is_visible(), 'application ouverte hors ligne, badge « Hors ligne »')
    page.click('.book-open >> text=Texte hors ligne'); page.wait_for_selector('#reader:not([hidden])')
    check(page.locator('#wPivot').inner_text() != '', 'livre lisible hors ligne')
    page.keyboard.press('Escape')
    page.set_input_files('#fileInput', str(HERE / 'sample.pdf'))
    page.wait_for_selector('#reader:not([hidden])', timeout=15000)
    check(page.locator('#readerTitle').inner_text() == 'Les Misérables (extrait)', 'import de PDF hors ligne')
    page.keyboard.press('Escape')
    page.click('#btnUrl'); page.fill('#uInput', 'https://example.com/article'); page.click('#uForm button[type=submit]')
    check('hors ligne' in page.locator('#toast').inner_text(), 'message clair pour l’import par lien hors ligne')
    ctx.set_offline(False)

    print('Partage d’un fichier vers l’app (Android)')
    page.goto(URL)
    page.wait_for_function("!!navigator.serviceWorker.controller")
    pdf_b64 = __import__('base64').b64encode((HERE / 'sample.pdf').read_bytes()).decode()
    page.evaluate("""b64 => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const form = document.createElement('form');
        form.method = 'POST'; form.action = './share-target'; form.enctype = 'multipart/form-data';
        const input = document.createElement('input'); input.type = 'file'; input.name = 'file';
        const dt = new DataTransfer(); dt.items.add(new File([bytes], 'partage.pdf', { type: 'application/pdf' }));
        input.files = dt.files; form.append(input); document.body.append(form); form.submit();
    }""", pdf_b64)
    page.wait_for_selector('#reader:not([hidden])', timeout=20000)
    check(page.locator('#readerTitle').inner_text() == 'Les Misérables (extrait)', 'fichier partagé ouvert directement')
    check('share' not in page.url and 'action' not in page.url, 'adresse nettoyée après le partage')

    print('Raccourcis de l’icône')
    page.goto(URL + '?action=paste')
    page.wait_for_selector('#dlgPaste[open]')
    check(True, 'raccourci « Coller un texte »')
    page.goto(URL + '?action=resume')
    page.wait_for_selector('#reader:not([hidden])')
    check(True, 'raccourci « Reprendre la lecture »')
    ctx.close()

    print('Installation sur iPhone')
    iphone = p.devices['iPhone 13']
    ictx = browser.new_context(**{k: v for k, v in iphone.items() if k != 'default_browser_type'})
    ip = ictx.new_page()
    ip.goto(URL)
    check(ip.locator('#btnInstall').is_visible(), 'bouton « Installer » visible dans Safari')
    ip.click('#btnInstall')
    check(ip.locator('#dlgInstall[open]').count() == 1, 'guide d’installation affiché (Partager › Sur l’écran d’accueil)')
    ictx.close()
    browser.close()
srv.terminate()
check(not errors, 'aucune erreur JavaScript' + (': ' + ' | '.join(errors[:3]) if errors else ''))
print('\n' + ('ÉCHECS : ' + str(len(failures)) if failures else 'Tout est OK'))
sys.exit(1 if failures else 0)
