# Configuration Firebase — Liseuse RSVP

L'application intègre Firebase pour la page de connexion (Google + e-mail/mot
de passe) et la synchronisation cloud des livres et de la progression de
lecture. Tant que Firebase n'est pas configuré, l'app continue de fonctionner
normalement en local (`localStorage`) — seule la connexion/synchronisation
est indisponible.

Seuls **Authentication** et **Firestore** sont utilisés (plan gratuit
Spark) : pas de Firebase Storage, qui nécessite désormais le plan payant
Blaze. Dès qu'un livre est ouvert (import PDF, Project Gutenberg, Google
Books, ou reprise d'un livre déjà sauvegardé), il est converti en PDF puis
enregistré directement en blob dans Firestore pour le compte connecté. C'est
ce PDF qui sert de source de vérité cloud : sur un nouvel appareil, il est
récupéré et son texte ré-extrait automatiquement.

## 1. Créer le projet Firebase

1. Rendez-vous sur [console.firebase.google.com](https://console.firebase.google.com)
2. Cliquez sur **Ajouter un projet**, donnez-lui un nom (ex. `rsvp-reader`)
3. Désactivez Google Analytics si vous n'en avez pas besoin, puis créez le projet

## 2. Ajouter une application web

1. Dans la console du projet, cliquez sur l'icône **</>** (Web)
2. Donnez un surnom à l'application (ex. `rsvp-web`)
3. Ne cochez pas "Firebase Hosting" (sauf si vous comptez l'utiliser)
4. Copiez l'objet `firebaseConfig` affiché, il ressemble à :

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "rsvp-reader.firebaseapp.com",
  projectId: "rsvp-reader",
  storageBucket: "rsvp-reader.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};
```

(Le champ `storageBucket` n'est pas utilisé par l'app mais peut rester dans
la config, il est sans effet.)

## 3. Renseigner la config — recommandé : variables d'environnement Netlify

`index.html` ne contient **pas** la config Firebase en clair : elle est
remplacée au moment du build à partir de variables d'environnement, pour ne
jamais committer de clés dans le dépôt Git.

Dans **Netlify > Site settings > Environment variables**, ajoutez :

| Variable | Valeur |
|---|---|
| `FIREBASE_API_KEY` | `apiKey` |
| `FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `FIREBASE_PROJECT_ID` | `projectId` |
| `FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `FIREBASE_APP_ID` | `appId` |

Le site doit être déployé via **Netlify relié à votre dépôt Git** (Import an
existing project), pas via Netlify Drop : `netlify.toml` déclenche
automatiquement `node build.js`, qui publie `dist/index.html` avec les jetons
`__FIREBASE_...__` remplacés par ces variables. Sans ces variables, le build
réussit quand même mais Firebase reste désactivé (voir la console du
navigateur).

**Test en local** sans passer par Netlify :

```bash
FIREBASE_API_KEY=... FIREBASE_AUTH_DOMAIN=... FIREBASE_PROJECT_ID=... \
FIREBASE_STORAGE_BUCKET=... FIREBASE_MESSAGING_SENDER_ID=... FIREBASE_APP_ID=... \
node build.js
```

puis servez `dist/index.html` (ex. `npx serve dist`).

**Alternative** (GitHub Pages, Netlify Drop, hébergement statique sans
build) : ouvrez `index.html`, cherchez le bloc `<script type="module">` et
remplacez directement les valeurs `"__FIREBASE_...__"` par votre config.

## 4. Activer l'authentification

Dans la console Firebase : **Build > Authentication > Get started**, puis
onglet **Sign-in method** :

- Activez **Google** (choisissez un e-mail de support)
- Activez **E-mail/Mot de passe**

Si votre site est déployé sur un domaine (Netlify, etc.), ajoutez ce domaine
dans **Settings > Authorized domains**.

## 5. Activer Firestore

**Build > Firestore Database > Create database** :

- Choisissez le mode **Production**
- Sélectionnez une région proche de vos utilisateurs
- Reste sur le plan **Spark (gratuit)** : Firestore fonctionne sans passer
  au plan payant Blaze, contrairement à Storage

### Règles de sécurité

Remplacez les règles par défaut (**Firestore > Règles**) par celles-ci, pour
que chaque utilisateur ne puisse lire/écrire que ses propres données :

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## 6. Structure des données

```
users/{uid}/books/{bookId}       → { id, title, author, addedDate, lastModified, hasPdf }
users/{uid}/bookFiles/{bookId}   → { pdfData: Bytes }   (le PDF lui-même)
users/{uid}/progress/{bookId}    → { bookId, wordIndex, totalWords, lastUpdate }
users/{uid}/settings/reader      → { wpm, maxWordLength, autoSpeedEnabled, pauseOnPunctuation,
                                      pauseOnProperNoun, pausePunctuationMultiplier,
                                      pauseProperNounMultiplier, ambientMusicEnabled, lastModified }
```

Le PDF est séparé de la fiche livre (`books/{bookId}`) pour que consulter la
liste des livres n'ait pas à retélécharger tous les PDF.

⚠️ Firestore limite un document à 1 Mo. Un PDF de plus de ~900 Ko n'est **pas**
envoyé vers Firestore : le livre reste alors disponible localement sur
l'appareil courant uniquement (`hasPdf: false`, message dans la console du
navigateur). Pour de gros ouvrages, c'est une limite du plan gratuit — il n'y
a pas de solution de contournement sans passer par un service de stockage de
fichiers payant.

## 7. Fonctionnement du mode hors-ligne / sans compte

- Sans connexion : tout est stocké dans `localStorage` du navigateur, comme
  avant.
- À l'ouverture d'un livre (import PDF, Gutenberg, Google Books, reprise) :
  s'il n'a encore jamais été synchronisé, il est converti en PDF (ou le PDF
  original est réutilisé pour un import direct) et enregistré dans Firestore,
  en tâche de fond, sans bloquer la lecture.
- À la connexion : les paramètres de lecture (vitesse, longueur max, pauses,
  musique) sont fusionnés en premier (le plus récent l'emporte, `lastModified`
  à l'appui), puis les livres présents côté cloud mais absents de cet
  appareil sont récupérés et leur texte ré-extrait, et les progressions
  distantes et locales sont fusionnées de la même façon ; les livres locaux
  absents du cloud y sont poussés.
- Chaque changement de réglage (vitesse, longueur max, pauses, musique) est
  aussi répercuté sur Firestore en tâche de fond, comme la progression.
- Ensuite, chaque sauvegarde de progression (toutes les 10 mots, fin de
  livre, retour au menu) est répercutée sur Firestore (document léger, pas de
  nouvel envoi du PDF).
