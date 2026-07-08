// Script de build Netlify : copie les fichiers statiques du projet vers dist/ en
// remplaçant les jetons __FIREBASE_...__ d'index.html par les variables d'environnement
// Netlify (Site settings > Environment variables). Aucune dépendance npm requise.
//
// Usage local : FIREBASE_API_KEY=... FIREBASE_AUTH_DOMAIN=... node build.js

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'dist');

const TOKENS = {
    '__FIREBASE_API_KEY__': process.env.FIREBASE_API_KEY || '__FIREBASE_API_KEY__',
    '__FIREBASE_AUTH_DOMAIN__': process.env.FIREBASE_AUTH_DOMAIN || '__FIREBASE_AUTH_DOMAIN__',
    '__FIREBASE_PROJECT_ID__': process.env.FIREBASE_PROJECT_ID || '__FIREBASE_PROJECT_ID__',
    '__FIREBASE_STORAGE_BUCKET__': process.env.FIREBASE_STORAGE_BUCKET || '__FIREBASE_STORAGE_BUCKET__',
    '__FIREBASE_MESSAGING_SENDER_ID__': process.env.FIREBASE_MESSAGING_SENDER_ID || '__FIREBASE_MESSAGING_SENDER_ID__',
    '__FIREBASE_APP_ID__': process.env.FIREBASE_APP_ID || '__FIREBASE_APP_ID__'
};

const missing = Object.entries(TOKENS).filter(([, value]) => value.startsWith('__FIREBASE_'));
if (missing.length > 0) {
    console.warn(
        '⚠️  Variables Firebase manquantes, laissées en placeholder : ' +
        missing.map(([token]) => token).join(', ') +
        '\n   L\'app se déploiera mais la connexion/synchronisation Firebase restera désactivée.' +
        '\n   Configurez ces variables dans Netlify (Site settings > Environment variables).'
    );
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

function replaceTokens(content) {
    let result = content;
    for (const [token, value] of Object.entries(TOKENS)) {
        result = result.split(token).join(value);
    }
    return result;
}

// index.html : copie avec substitution des jetons Firebase
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), replaceTokens(indexHtml));

// Fichiers de la webapp (manifeste, service worker, icônes) : copie telle quelle
fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(OUT_DIR, 'manifest.json'));
fs.copyFileSync(path.join(ROOT, 'sw.js'), path.join(OUT_DIR, 'sw.js'));
fs.cpSync(path.join(ROOT, 'icons'), path.join(OUT_DIR, 'icons'), { recursive: true });

console.log('✅ Build terminé :', path.join(OUT_DIR, 'index.html'));
