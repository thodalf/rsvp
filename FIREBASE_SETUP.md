# Configuration Firebase — Liseuse RSVP

L'application intègre Firebase pour la page de connexion (Google + e-mail/mot
de passe) et la synchronisation cloud des livres et de la progression de
lecture. Tant que Firebase n'est pas configuré, l'app continue de fonctionner
normalement en local (`localStorage`) — seule la connexion/synchronisation
est indisponible.

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

5. Ouvrez `index.html`, cherchez le bloc `<script type="module">` juste avant
   le script principal, et remplacez les valeurs `"REMPLACER..."` par les
   vôtres.

## 3. Activer l'authentification

Dans la console Firebase : **Build > Authentication > Get started**, puis
onglet **Sign-in method** :

- Activez **Google** (choisissez un e-mail de support)
- Activez **E-mail/Mot de passe**

Si votre site est déployé sur un domaine (GitHub Pages, Netlify, etc.),
ajoutez ce domaine dans **Settings > Authorized domains**.

## 4. Activer Firestore

**Build > Firestore Database > Create database** :

- Choisissez le mode **Production**
- Sélectionnez une région proche de vos utilisateurs

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

## 5. Structure des données

```
users/{uid}/books/{bookId}       → { id, title, author, words[], addedDate, lastModified }
users/{uid}/progress/{bookId}    → { bookId, wordIndex, totalWords, lastUpdate }
```

⚠️ Firestore limite un document à 1 Mo. Un livre dont le tableau de mots
dépasse ~900 Ko reste automatiquement stocké en local uniquement (l'app
l'indique dans la console du navigateur) — la lecture continue de fonctionner
normalement sur l'appareil courant.

## 6. Fonctionnement du mode hors-ligne / sans compte

- Sans connexion : tout est stocké dans `localStorage` du navigateur, comme
  avant.
- À la connexion : les livres/progressions distants et locaux sont fusionnés
  (la version la plus récente l'emporte), puis les livres locaux absents du
  cloud y sont poussés.
- Une fois connecté, chaque sauvegarde de progression (toutes les 10 mots,
  fin de livre, retour au menu) est répercutée sur Firestore en tâche de
  fond, sans bloquer la lecture.
