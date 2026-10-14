# Configuration Firebase — Liseuse RSVP

L'application intègre Firebase pour la page de connexion (Google + e-mail/mot
de passe) et la synchronisation cloud des livres et de la progression de
lecture. Tant que Firebase n'est pas configuré, l'app continue de fonctionner
normalement en local (IndexedDB du navigateur) — seule la connexion/synchronisation
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

`js/config.js` ne contient **pas** la config Firebase en clair : elle est
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
automatiquement `node build.js`, qui publie `dist/` avec les jetons
`__FIREBASE_...__` remplacés par ces variables. Sans ces variables, le build
réussit quand même mais Firebase reste désactivé (voir la console du
navigateur).

**Test en local** sans passer par Netlify :

```bash
FIREBASE_API_KEY=... FIREBASE_AUTH_DOMAIN=... FIREBASE_PROJECT_ID=... \
FIREBASE_STORAGE_BUCKET=... FIREBASE_MESSAGING_SENDER_ID=... FIREBASE_APP_ID=... \
node build.js
```

puis servez le dossier `dist/` (ex. `npx serve dist`).

**Alternative** (GitHub Pages, Netlify Drop, hébergement statique sans
build) : ouvrez `js/config.js` et remplacez directement les valeurs
`'__FIREBASE_...__'` par votre config.

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
users/{uid}/settings/reader      → { wpm, pauses, maxLen, fontScale, font, theme, guide, progressLine, rampUp, updatedAt }
users/{uid}/books/{bookId}       → { id, title, author, source, addedAt, chars, words, textChunks, gz, updatedAt }
users/{uid}/bookText/{bookId}__{n} → { data: Bytes, i, n, gz }   (texte compressé gzip, découpé en morceaux de 700 Ko)
users/{uid}/progress/{bookId}    → { position, ratio, updatedAt }
```

On ne stocke plus de PDF : seulement le **texte extrait**, compressé. Un roman
entier pèse ainsi 200 à 500 Ko au lieu de plusieurs Mo, et la limite de 1 Mo
par document Firestore ne pose plus de problème (le texte est découpé en
plusieurs documents si besoin). Tous les livres sont donc synchronisés, quelle
que soit leur taille.

**Compatibilité avec l'ancienne version** : les livres déjà enregistrés sous
l'ancien format (`books/{id}` avec `hasPdf`, PDF dans `bookFiles/{id}`, progression
en `wordIndex/totalWords`) apparaissent toujours dans la bibliothèque. À leur
première ouverture, le PDF est relu, son texte extrait, puis réenregistré au
nouveau format.

## 7. Fonctionnement hors ligne / sans compte

- Sans compte : tout est stocké dans le navigateur (IndexedDB, sans limite
  pratique de taille). Les livres de l'ancienne version (localStorage) sont
  repris automatiquement au premier lancement.
- À la connexion : les réglages sont fusionnés (le plus récent l'emporte), les
  livres du compte absents de l'appareil apparaissent dans la bibliothèque
  (icône nuage) et sont téléchargés à leur ouverture, les livres locaux absents
  du compte y sont envoyés, et chaque progression garde la version la plus
  récente.
- Pendant la lecture : la position est enregistrée localement toutes les 5
  secondes, et envoyée au compte à chaque pause, à la sortie du livre et au
  plus toutes les minutes.
- La position est mémorisée en caractère dans le texte (pas en numéro de mot) :
  changer la longueur maximale des mots ne décale jamais la lecture.
