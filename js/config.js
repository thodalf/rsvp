// Configuration Firebase (facultative). Les jetons __FIREBASE_…__ sont remplacés au déploiement
// Netlify par build.js à partir des variables d'environnement. Laissés tels quels, l'application
// fonctionne entièrement en local, sans compte.
export const FIREBASE_CONFIG = {
    apiKey: '__FIREBASE_API_KEY__',
    authDomain: '__FIREBASE_AUTH_DOMAIN__',
    projectId: '__FIREBASE_PROJECT_ID__',
    storageBucket: '__FIREBASE_STORAGE_BUCKET__',
    messagingSenderId: '__FIREBASE_MESSAGING_SENDER_ID__',
    appId: '__FIREBASE_APP_ID__'
};

// Clé d'API Google Books (facultative) : sans clé, la recherche Google Livres fonctionne avec le
// quota anonyme ; une clé (variable Netlify GOOGLE_BOOKS_API_KEY) évite d'atteindre la limite.
export const GOOGLE_BOOKS_API_KEY = '__GOOGLE_BOOKS_API_KEY__';
