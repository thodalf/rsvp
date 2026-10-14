// Build Netlify : copie l'application dans dist/ et injecte la configuration Firebase
// (variables d'environnement) dans js/config.js. Aucune dépendance npm.
//
// Usage local : FIREBASE_API_KEY=... FIREBASE_AUTH_DOMAIN=... node build.js
// Sans variables, l'application fonctionne sans compte (tout reste sur l'appareil).

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const VARS = ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'STORAGE_BUCKET', 'MESSAGING_SENDER_ID', 'APP_ID'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const entry of ['index.html', 'manifest.json', 'sw.js', 'css', 'js', 'icons', 'screens']) {
    fs.cpSync(path.join(ROOT, entry), path.join(OUT, entry), { recursive: true });
}

const configPath = path.join(OUT, 'js', 'config.js');
let config = fs.readFileSync(configPath, 'utf8');
const missing = [];
for (const v of VARS) {
    const value = process.env['FIREBASE_' + v];
    if (value) config = config.split(`__FIREBASE_${v}__`).join(value.replace(/'/g, "\\'"));
    else missing.push('FIREBASE_' + v);
}
fs.writeFileSync(configPath, config);

// Nouvelle version du service worker à chaque déploiement : les appareils récupèrent la mise à jour.
const swPath = path.join(OUT, 'sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*'/, `const VERSION = '${Date.now()}'`));

if (!process.env.GOOGLE_BOOKS_API_KEY) console.warn('ℹ️  GOOGLE_BOOKS_API_KEY absente : la recherche Google Livres utilisera le quota anonyme de Google (erreurs 429 possibles).');
if (missing.length) console.warn('⚠️  Firebase non configuré (' + missing.join(', ') + ') : synchronisation désactivée.');
console.log('✅ Build terminé :', OUT);
