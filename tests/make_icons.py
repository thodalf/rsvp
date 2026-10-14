# Génère les icônes de l'application (lancer depuis la racine : python3 tests/make_icons.py)
from PIL import Image, ImageDraw
BG = (18, 18, 18, 255); FG = (236, 236, 234, 255); RED = (255, 91, 77, 255)

def motif(size, scale):
    """Un « mot » : trois barres, la lettre de fixation en rouge, deux repères au-dessus/au-dessous."""
    S = 1024
    im = Image.new('RGBA', (S, S), BG)
    d = ImageDraw.Draw(im)
    c = S / 2
    u = S * 0.075 * scale              # unité
    h = u * 1.25                       # hauteur des barres
    def bar(x0, x1, col): d.rounded_rectangle([c + x0 * u, c - h / 2, c + x1 * u, c + h / 2], radius=h / 2, fill=col)
    bar(-4.6, -1.15, FG)
    bar(-0.75, 0.75, RED)
    bar(1.15, 3.4, FG)
    tw, th = u * 0.36, u * 1.15
    d.rounded_rectangle([c - tw / 2, c - h / 2 - u * 0.55 - th, c + tw / 2, c - h / 2 - u * 0.55], radius=tw / 2, fill=RED)
    d.rounded_rectangle([c - tw / 2, c + h / 2 + u * 0.55, c + tw / 2, c + h / 2 + u * 0.55 + th], radius=tw / 2, fill=RED)
    return im.resize((size, size), Image.LANCZOS)

for s in (192, 512):
    motif(s, 1.15).save(f'icons/icon-{s}.png')
    motif(s, 0.72).save(f'icons/maskable-{s}.png')     # contenu dans la zone sûre (80 %)
motif(180, 0.9).convert('RGB').save('icons/icon-180.png')
motif(32, 1.25).save('icons/icon-32.png')
motif(96, 1.0).save('icons/shortcut-read.png')
