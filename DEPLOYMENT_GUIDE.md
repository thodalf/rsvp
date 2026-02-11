# 🚀 Guide de Déploiement - Liseuse RSVP

## Options de Déploiement (du plus simple au plus avancé)

### Option 1 : GitHub Pages (GRATUIT et SIMPLE) ⭐ RECOMMANDÉ

**Étapes :**

1. **Créer un compte GitHub** (si vous n'en avez pas) : https://github.com

2. **Créer un nouveau repository** :
   - Cliquez sur "New repository"
   - Nom : `rsvp-reader` (ou ce que vous voulez)
   - Cochez "Public"
   - Cliquez "Create repository"

3. **Uploader votre fichier** :
   - Cliquez sur "uploading an existing file"
   - Glissez-déposez le fichier `google-books-rsvp-reader.html`
   - Renommez-le en `index.html` (IMPORTANT !)
   - Cliquez "Commit changes"

4. **Activer GitHub Pages** :
   - Allez dans Settings > Pages
   - Source : sélectionnez "main" branch
   - Cliquez "Save"

5. **Votre site sera accessible à** :
   ```
   https://[votre-username].github.io/rsvp-reader/
   ```

**⏱️ Temps : 5 minutes**

---

### Option 2 : Netlify Drop (GRATUIT, ULTRA-SIMPLE)

**Étapes :**

1. Allez sur : https://app.netlify.com/drop

2. **Glissez-déposez** votre fichier HTML (renommé en `index.html`)

3. **C'est tout !** Vous obtenez immédiatement une URL comme :
   ```
   https://random-name-12345.netlify.app
   ```

4. (Optionnel) Vous pouvez personnaliser le nom de domaine dans les settings

**⏱️ Temps : 30 secondes**

---

### Option 3 : Vercel (GRATUIT)

**Étapes :**

1. Créer un compte sur : https://vercel.com

2. Installer Vercel CLI :
   ```bash
   npm install -g vercel
   ```

3. Dans le dossier contenant votre fichier :
   ```bash
   vercel
   ```

4. Suivre les instructions à l'écran

**⏱️ Temps : 2 minutes**

---

### Option 4 : Cloudflare Pages (GRATUIT)

**Étapes :**

1. Créer un compte sur : https://pages.cloudflare.com

2. Connecter votre GitHub (option 1) ou upload direct

3. Sélectionner le repository et déployer

**⏱️ Temps : 3 minutes**

---

### Option 5 : Serveur Web Personnel (Apache/Nginx)

Si vous avez déjà un serveur web :

1. Copiez le fichier dans le dossier web :
   ```bash
   sudo cp google-books-rsvp-reader.html /var/www/html/index.html
   ```

2. Assurez-vous que les permissions sont correctes :
   ```bash
   sudo chmod 644 /var/www/html/index.html
   ```

3. Accédez via : `http://votre-serveur-ip/`

---

## ⚠️ IMPORTANT : Configuration Google OAuth

Après le déploiement, vous devez **mettre à jour votre Google Cloud Console** :

1. Allez sur : https://console.cloud.google.com

2. Sélectionnez votre projet

3. **APIs & Services** > **Credentials**

4. Cliquez sur votre Client ID OAuth 2.0

5. Dans **"Authorized JavaScript origins"**, ajoutez :
   ```
   https://[votre-nouveau-domaine]
   ```
   Par exemple :
   - `https://votre-username.github.io`
   - `https://votre-site.netlify.app`
   - `https://votre-site.vercel.app`

6. Dans **"Authorized redirect URIs"**, ajoutez :
   ```
   https://[votre-nouveau-domaine]/
   ```

7. **Sauvegarder**

---

## 🎯 Recommandation

Pour un déploiement rapide sans configuration :
→ **Netlify Drop** (Option 2) - 30 secondes, zéro configuration

Pour un contrôle long terme et versioning :
→ **GitHub Pages** (Option 1) - Simple et professionnel

---

## 🔧 Dépannage

**Problème : "L'authentification Google ne fonctionne pas"**
- Vérifiez que vous avez ajouté le domaine dans Google Cloud Console
- Utilisez HTTPS (pas HTTP)

**Problème : "Le site n'est pas accessible"**
- Attendez 2-3 minutes après le déploiement
- Videz le cache du navigateur (Ctrl+Shift+R)

**Problème : "Les PDFs ne se chargent pas"**
- Vérifiez que PDF.js CDN est accessible
- Testez avec un petit PDF d'abord

---

## 📞 Besoin d'aide ?

Si vous rencontrez des problèmes, les communautés suivantes peuvent vous aider :
- GitHub Discussions
- Stack Overflow
- Discord des services respectifs
