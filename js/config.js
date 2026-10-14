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
