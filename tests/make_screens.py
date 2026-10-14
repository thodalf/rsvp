# Captures d'écran affichées par le navigateur lors de l'installation (manifest.json › screenshots).
#   node build.js && python3 tests/make_screens.py
import os, subprocess, sys, time, pathlib
os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', '/opt/pw-browsers')
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).parent.parent
OUT = ROOT / 'screens'
TEXT = ("Le matin se levait sur la ville encore endormie. Claire ouvrit la fenêtre, respira l'air frais "
        "et reprit le livre là où elle l'avait laissé la veille. Chaque mot venait à elle, un par un, "
        "sans effort, comme une conversation tranquille. Elle tourna la page sans même s'en apercevoir.")
BOOKS = [("Le Comte de Monte-Cristo", 0.42), ("Les Misérables", 0.18), ("Madame Bovary", 1.0), ("Vingt mille lieues sous les mers", 0)]
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8766', '-d', str(ROOT / 'dist')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, vp, dpr, scheme in [('mobile', {'width': 390, 'height': 844}, 2, 'dark'), ('large', {'width': 1440, 'height': 900}, 1, 'dark')]:
        page = b.new_context(viewport=vp, device_scale_factor=dpr, color_scheme=scheme).new_page()
        page.goto('http://localhost:8766/')
        page.evaluate("localStorage.clear(); localStorage.setItem('rsvp2_migrated', '1')")
        page.reload()
        for title, ratio in BOOKS:
            page.click('#btnPaste'); page.fill('#pTitleInput', title); page.fill('#pText', TEXT + ' ' + title + ' ' + ' '.join([TEXT] * int(180 * (1 + len(title) % 3))))
            page.click('#pForm button[type=submit]'); page.wait_for_selector('#reader:not([hidden])')
            page.evaluate(f"document.getElementById('seek').value = {int(ratio * 1000)}; document.getElementById('seek').dispatchEvent(new Event('input')); document.getElementById('seek').dispatchEvent(new Event('change'))")
            page.wait_for_timeout(100)
            page.keyboard.press('Escape'); page.wait_for_selector('#library:not([hidden])')
        page.click('.book-open >> text=Le Comte de Monte-Cristo'); page.wait_for_selector('#reader:not([hidden])')
        page.keyboard.press('Shift+ArrowRight')
        page.keyboard.press('Escape'); page.wait_for_selector('#library:not([hidden])')
        page.wait_for_timeout(4500)
        if name == 'mobile': page.screenshot(path=str(OUT / 'bibliotheque-mobile.png'))
        page.click('#resumeCard'); page.wait_for_selector('#reader:not([hidden])')
        page.keyboard.press('Space'); page.wait_for_timeout(1500); page.keyboard.press('Space')
        page.keyboard.press('Shift+ArrowLeft')
        if name == 'large': page.evaluate("document.getElementById('reader').classList.add('playing')")
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / f'lecture-{name}.png'))
    b.close()
srv.terminate()
print('ok', sorted(x.name for x in OUT.iterdir()))
