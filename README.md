# Lecture rapide (RSVP)

Liseuse de lecture rapide : les mots s'affichent un par un au centre de l'écran, alignés sur leur
point de fixation (la lettre rouge), pour lire sans déplacer les yeux.

## Ce qu'on peut lire

| Source | Détails |
|---|---|
| **Fichier** | PDF (avec texte), EPUB (sans DRM), TXT, HTML. Glisser-déposer accepté. |
| **Classiques** | Recherche dans les 70 000 livres libres du Project Gutenberg, par titre/auteur et langue. |
| **Lien web** | Article de presse ou de blog (le contenu principal est isolé), page Gutenberg, lien direct vers un PDF/EPUB/TXT. |
| **Coller** | N'importe quel texte copié. Sur Android, « Partager → Lecture rapide » depuis une autre app. |

## Récupération des mots

Tout le texte passe par la même chaîne de nettoyage (`js/text.js`, `js/extract.js`) :

- **PDF** : lignes reconstruites à partir de la position des fragments (plus de mots collés ou
  coupés), en-têtes et pieds de page répétés et numéros de page retirés, **chiffres du texte
  conservés** (l'ancienne version supprimait tous les nombres), césures de fin de ligne réparées
  (`pro-/gramme` → `programme`, mais `peut-/être` → `peut-être`), paragraphes reconstitués.
- **EPUB** : chapitres dans l'ordre du livre, appels de note et numéros de page ignorés.
- **Gutenberg** : licence et en-tête retirés correctement, `_italique_` et `[Illustration]` nettoyés.
- **Encodage** : UTF-8, UTF-16 et Windows-1252 détectés automatiquement (plus d'accents cassés).
- **Ponctuation française** : `« Bonjour » ,` s'affiche en un seul flash, les tirets de dialogue
  restent attachés au mot, `M.` ou `J. K.` ne sont pas pris pour des fins de phrase.
- Les mots trop longs sont coupés en morceaux lisibles, de préférence sur leurs tirets.

## Accès aux livres en ligne

Les navigateurs bloquent souvent les téléchargements directs (CORS). Chaque requête essaie
dans l'ordre :

1. le proxy du site lui-même (`/proxy/gutenberg/…`, `/proxy/gutendex/…`, déclaré dans `netlify.toml`) ;
2. le site d'origine ;
3. trois proxys publics de secours.

Pour un livre Gutenberg, plusieurs formats sont tentés (texte UTF-8, EPUB, HTML) jusqu'au premier
qui fonctionne. Si le catalogue gutendex.com ne répond pas, la recherche bascule sur le catalogue
officiel de Gutenberg.

## Lecture

- Pendant la lecture, **seul le mot est affiché** : commandes, titre et compteurs disparaissent.
  Un filet de progression de 3 px (désactivable) reste en bas.
- En pause : phrase en cours (cliquer un mot pour s'y placer), curseur de position, pourcentage
  et temps restant.
- Pauses naturelles sur la ponctuation et les fins de paragraphe ; la vitesse affichée reste la
  vitesse réelle (la durée de base est compensée).
- Démarrage en douceur après chaque pause, écran maintenu allumé, pause automatique si l'onglet
  est quitté.
- Raccourcis : `Espace` lire/pause, `←` `→` phrase, `Maj`+`←` `→` mot, `↑` `↓` vitesse, `F` plein
  écran, `Échap` retour. Mobile : toucher pour lire/pause, glisser pour changer de phrase.

## Stockage et synchronisation

- Les livres sont stockés dans **IndexedDB** (aucune limite pratique, contrairement au
  localStorage de 5 Mo de l'ancienne version). Les livres de l'ancienne version sont repris
  automatiquement au premier lancement.
- La position est mémorisée en caractère dans le texte : changer un réglage ne la décale jamais.
- Synchronisation facultative entre appareils via Firebase : voir [FIREBASE_SETUP.md](FIREBASE_SETUP.md).
  Les livres déjà dans le cloud sous l'ancien format (PDF) restent récupérables.
- Fonctionne hors ligne une fois installé (PWA) pour les livres déjà importés.

## Structure

```
index.html        page unique
css/app.css       styles (thèmes auto / sombre / clair / sépia)
js/app.js         interface
js/engine.js      moteur RSVP (cadence, navigation, temps restant)
js/text.js        normalisation et découpage du texte
js/extract.js     extraction PDF / EPUB / HTML / TXT
js/sources.js     Gutenberg et import par lien
js/store.js       IndexedDB, réglages, reprise de l'ancienne version
js/cloud.js       synchronisation Firebase (facultative)
js/config.js      configuration Firebase (remplie par build.js)
sw.js             service worker (hors ligne)
build.js          build Netlify → dist/
tests/            tests de la chaîne texte (Node) et de bout en bout (Chromium)
```

Aucune dépendance à installer : pdf.js et JSZip sont chargés depuis cdnjs uniquement quand un PDF
ou un EPUB est ouvert.

## Déploiement

Netlify relié au dépôt (recommandé) : `netlify.toml` lance `node build.js` et publie `dist/`. Les
proxys `/proxy/…` ne fonctionnent que sur Netlify ; ailleurs (GitHub Pages, serveur local),
l'application passe automatiquement aux autres routes.

En local : `node build.js && npx serve dist`.

## Tests

```bash
cd tests && npm install
node run.mjs          # extraction et découpage (PDF, EPUB, HTML, Gutenberg, encodages)
python3 make_pdf.py sample.pdf && python3 ui_test.py   # parcours complet dans Chromium (Playwright)
```
