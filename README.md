# Lecture rapide (RSVP)

Liseuse de lecture rapide : les mots s'affichent un par un au centre de l'écran, alignés sur leur
point de fixation (la lettre rouge), pour lire sans déplacer les yeux.

## Ce qu'on peut lire

| Source | Détails |
|---|---|
| **Fichier** | PDF (avec texte), EPUB (sans DRM), TXT, HTML. Glisser-déposer accepté. |
| **Classiques** | Recherche par titre/auteur et langue dans le Project Gutenberg (70 000 livres) et dans Google Livres (ouvrages en accès libre et intégral, téléchargés en EPUB ou PDF). |
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

## Livres achetés (Google Play, Kindle)

- **Google Play Livres** : play.google.com › Bibliothèque › Livres › *Plus › Exporter › EPUB*. Un
  fichier .epub ou .pdf s'importe directement. Un fichier .acsm signifie que l'éditeur a protégé le
  livre (DRM) : l'application l'explique au lieu d'échouer en silence.
- **Kindle** : les livres sont chiffrés par Amazon, qui ne permet plus de les télécharger depuis
  février 2025. L'application ne contourne pas ces protections (illégal en France, loi DADVSI) ;
  un lien Amazon affiche une explication et oriente vers les classiques ou une version EPUB sans DRM.
- Un lien de livre Google (books.google… ou play.google…) collé dans « Lien web » est importé s'il
  est en accès libre.

## Accès aux livres en ligne

Les navigateurs bloquent souvent les téléchargements directs (CORS). Chaque requête essaie
dans l'ordre :

1. le proxy du site lui-même (`/proxy/gutenberg/…`, `/proxy/gutendex/…`, `/proxy/googlebooks/…`, déclarés dans `netlify.toml`) ;
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
- **Pause sur les noms propres** (aucune / légère / marquée) : un mot à majuscule hors début de
  phrase reste affiché plus longtemps.
- **Accélération progressive** : +5 mots/min tous les 50 mots, jusqu'à +25 %, +50 % ou +100 %.
  Changer la vitesse à la main repart de la nouvelle valeur.
- **Musique d'ambiance** : générée en direct par l'appareil (aucun fichier, fonctionne hors ligne).
  Le livre est analysé à l'ouverture pour repérer l'ambiance de chaque passage (calme, tension,
  aventure, romance, mystère, mélancolie, épique, joyeux, sombre) ; la musique change en fondu.
  Ambiance fixe possible, volume réglable, coupée à chaque pause.
- Raccourcis : `Espace` lire/pause, `←` `→` phrase, `Maj`+`←` `→` mot, `↑` `↓` vitesse, `F` plein
  écran, `Échap` retour. Mobile : toucher pour lire/pause, glisser pour changer de phrase.

## Webapp

L'application s'installe comme une app native et s'ouvre en plein écran, sans barre de navigateur :

- **Android / ordinateur (Chrome, Edge)** : bouton **Installer** en haut de la bibliothèque.
- **iPhone / iPad** : le bouton **Installer** affiche la marche à suivre (Safari › Partager › Sur
  l'écran d'accueil), Apple ne permettant pas d'installation en un clic.

Une fois installée :

- **Hors ligne** : l'application, les livres importés et l'import de PDF/EPUB (pdf.js et JSZip mis
  en cache dès l'installation) fonctionnent sans connexion ; un badge « Hors ligne » l'indique.
- **Partager vers Lecture** (Android) : un PDF, un EPUB, un texte ou un lien partagé depuis une autre
  app s'ouvre directement dans le lecteur.
- **Ouvrir avec Lecture** (ordinateur) : les fichiers PDF, EPUB, TXT et HTML peuvent s'ouvrir
  directement avec l'app.
- **Raccourcis** (appui long sur l'icône) : Reprendre la lecture, Classiques gratuits, Coller un texte.
- **Mises à jour** : téléchargées en arrière-plan et appliquées au retour à la bibliothèque, jamais
  au milieu d'une lecture.

Icônes : `tests/make_icons.py` ; captures d'écran de la fiche d'installation : `tests/make_screens.py`.

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
js/engine.js      moteur RSVP (cadence, navigation, accélération, temps restant)
js/mood.js        détection de l'ambiance des passages
js/ambience.js    musique d'ambiance synthétisée (Web Audio)
js/text.js        normalisation et découpage du texte
js/extract.js     extraction PDF / EPUB / HTML / TXT
js/sources.js     Gutenberg, Google Livres et import par lien
js/store.js       IndexedDB, réglages, reprise de l'ancienne version
js/cloud.js       synchronisation Firebase (facultative)
js/pwa.js         installation, mises à jour, partage, ouverture de fichiers, hors ligne
js/config.js      configuration Firebase (remplie par build.js)
netlify/functions relais Google Books (clé côté serveur, cache 24 h)
sw.js             service worker (hors ligne, partage, mises à jour)
screens/          captures affichées lors de l'installation
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

### Google Livres et l'erreur 429

Sans clé, Google limite très vite les requêtes anonymes (erreur 429 « Too Many Requests »). Les
recherches passent donc par le relais du site, `/api/google-books` (fonction Netlify dans
`netlify/functions/`), qui ajoute une clé d'API côté serveur (elle n'est jamais envoyée au
navigateur) et garde chaque réponse 24 h en cache sur le CDN. L'appareil garde aussi ses recherches
24 h. Si Google refuse malgré tout : l'app réessaie, interroge Google directement depuis l'appareil,
propose la même recherche sur Gutenberg, et pour un téléchargement refusé, récupère automatiquement
le même livre sur Gutenberg.

Pour créer la clé (gratuit) :

1. [console.cloud.google.com](https://console.cloud.google.com) › choisir un projet (celui de
   Firebase convient) › *API et services › Bibliothèque* › **Books API** › *Activer*.
2. *API et services › Identifiants › Créer des identifiants › Clé API*. Dans *Restrictions*,
   limiter la clé à la **Books API** (pas de restriction d'application : elle est utilisée par le
   serveur).
3. Netlify › *Site configuration › Environment variables* › ajouter `GOOGLE_BOOKS_API_KEY`, puis
   *Deploys › Trigger deploy*.

## Tests

```bash
cd tests && npm install
node run.mjs          # extraction et découpage (PDF, EPUB, HTML, Gutenberg, encodages)
python3 make_pdf.py sample.pdf && python3 ui_test.py   # parcours complet dans Chromium (Playwright)
python3 pwa_test.py   # webapp : manifeste, hors ligne, partage de fichiers, raccourcis, installation iPhone
```
