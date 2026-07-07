# Configuration Firebase — Liseuse RSVP

L'application intègre Firebase pour la page de connexion (Google + e-mail/mot
de passe) et la synchronisation cloud des livres et de la progression de
lecture. Tant que Firebase n'est pas configuré, l'app continue de fonctionner
normalement en local (`localStorage`) — seule la connexion/synchronisation
est indisponible.

Dès qu'un livre est ouvert (import PDF, Project Gutenberg, Google Books, ou
reprise d'un livre déjà sauvegardé), il est converti en PDF puis envoyé dans
Firebase Storage pour le compte connecté. C'est ce PDF qui sert de source de
vérité cloud : sur un nouvel appareil, il est retéléchargé et son texte
ré-extrait automatiquement.

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
remplacez directement les valeurs `"__FIREBASE_...__"` par votre config. Dans
ce cas, ne committez pas ces valeurs sur un dépôt public si vous préférez les
garder privées (elles ne sont pas secrètes au sens strict — voir la note sur
les règles de sécurité ci-dessous — mais autant garder l'habitude).

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

### Règles de sécurité Firestore

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

## 6. Activer Firebase Storage (stockage des PDF)

**Build > Storage > Get started**, choisissez le mode production et la même
région que Firestore.

### Règles de sécurité Storage

**Storage > Règles** :

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

⚠️ Note Firebase : `getDownloadURL()` génère une URL contenant un jeton
d'accès qui reste valide indépendamment de ces règles (comportement standard
de Firebase Storage — un lien "toute personne qui a l'URL peut lire"). Ne
partagez pas les liens `pdfUrl` stockés dans Firestore si vos livres sont
sensibles.

## 7. Structure des données

```
users/{uid}/books/{bookId}       → { id, title, author, addedDate, lastModified, pdfUrl }
users/{uid}/progress/{bookId}    → { bookId, wordIndex, totalWords, lastUpdate }
Storage: users/{uid}/books/{bookId}.pdf
```

Le tableau de mots n'est plus stocké dans Firestore (risque de dépasser la
limite de 1 Mo par document) : le PDF dans Storage fait foi, et le texte est
ré-extrait à la volée quand un livre doit être restauré sur un nouvel
appareil.

## 8. Fonctionnement du mode hors-ligne / sans compte

- Sans connexion : tout est stocké dans `localStorage` du navigateur, comme
  avant.
- À l'ouverture d'un livre (import PDF, Gutenberg, Google Books, reprise) :
  s'il n'a encore jamais été synchronisé, il est converti en PDF (ou le PDF
  original est réutilisé pour un import direct) et envoyé vers Firebase
  Storage, en tâche de fond, sans bloquer la lecture.
- À la connexion : les livres présents côté cloud mais absents de cet
  appareil sont retéléchargés et leur texte ré-extrait ; les progressions
  distantes et locales sont fusionnées (la plus récente l'emporte) ; les
  livres locaux absents du cloud y sont poussés.
- Ensuite, chaque sauvegarde de progression (toutes les 10 mots, fin de
  livre, retour au menu) est répercutée sur Firestore (document léger, pas de
  nouvel upload PDF).
