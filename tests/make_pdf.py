import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import glob
font = 'Helvetica'
for f in glob.glob('/usr/share/fonts/**/DejaVuSans.ttf', recursive=True):
    pdfmetrics.registerFont(TTFont('DV', f)); font = 'DV'; break
c = canvas.Canvas(sys.argv[1], pagesize=A4)
c.setTitle('Les Misérables (extrait)'); c.setAuthor('Victor Hugo')
W, H = A4
NAMES=['Marius','Cosette','Javert','Fantine','Gavroche','Éponine']
for p in range(1, 7):
    c.setFont(font, 9); c.drawString(72, H-40, 'LES MISÉRABLES — TOME I'); c.drawCentredString(W/2, 30, str(p))
    c.setFont(font, 11)
    y = H - 90
    lines = [
      (90, f'En 1815, M. Charles-François-Bienvenu Myriel était évêque de Digne. C’était un'),
      (72, 'vieillard d’environ soixante-quinze ans ; il occupait le siège de Digne de-'),
      (72, 'puis 1806. Le pro-'),
      (72, 'gramme de la page %d comptait 42 points et peut-' % p),
      (72, 'être davantage. Fin du paragraphe.'),
      (90, '— Qu’en dites-vous ? demanda-t-il.'),
      (90, '« Rien du tout », répondit-elle à %s, et elle sortit.' % NAMES[p-1]),
      (90, 'Ce paragraphe de %s continue sur la page suivante sans ponctuation finale et' % NAMES[p-1]),
    ]
    if p > 1: lines.insert(0, (72, 'donc reprend ici.'))
    for x, t in lines:
        c.drawString(x, y, t); y -= 14
        if t.endswith('.') and x == 72: y -= 0
    c.showPage()
c.save()
