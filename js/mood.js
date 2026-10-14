// Détection de l'ambiance du passage en cours, pour la musique d'ambiance.
//
// Le livre est analysé une seule fois à l'ouverture : on obtient une "carte" des ambiances par
// tranches de 150 mots. Pendant la lecture, il suffit de lire la case correspondante.
// Un mot finissant par * est un radical (« mystér* » couvre mystère, mystérieux, mystérieusement).

export const MOODS = {
    calm: 'Calme', tense: 'Tension', adventure: 'Aventure', romantic: 'Romance', mysterious: 'Mystère',
    sad: 'Mélancolie', epic: 'Épique', upbeat: 'Joyeux', dark: 'Sombre'
};

const KEYWORDS = {
    calm: `paisible* calme* tranquill* serein* sérénité douceur doux douce silence* silencieu* repos repose*
        reposa* détend* détente apais* harmonie méditation contempl* quiétude paix pacifique endormi* sommeil
        rêve* rêvai* nuage* brise jardin* prairie* ruisseau* lac rivière
        peaceful* calm* quiet* gentl* serene* tranquil* silence rest resting relax* peace sleep* dream* cloud* breeze
        meadow* garden* stream`,
    tense: `danger* peur* terreur terrifi* angoiss* menac* effroi épouvant* frayeur* anxi* nerveu* alerte urgen*
        péril* piège* attaqu* combat* fuir fuyai* fuit fuite échapp* poursui* hurl* cri cris criai* sursaut* trembl*
        panique* affol* haletant* haleta* précipit* soudain*
        fear* terror* threat* scared frighten* scream* panic* chase* chasing escape* attack* trap* danger* urgent*
        tremb* suddenly`,
    adventure: `aventur* exploration explor* voyage* découvr* découvert* quête expédition* carte* trésor* mission*
        route* chemin* horizon* lointain* inconnu* navire* vaisseau* bateau* voile* océan* montagne* forêt* jungle*
        désert* caverne* île* galop* cheval chevaux sommet*
        adventur* quest* journey* discover* expedition* travel* map treasure* road* path* ship* sail* ocean*
        mountain* forest* desert* island* horizon* gallop*`,
    romantic: `amour* amoureu* aimer aimait aimais aime aimée cœur* baiser* tendresse tendre* amant* passion*
        désir* caress* étrein* embrass* séduisant* séduire charme* charmant* beauté mariage fiancé* époux épouse
        bien-aimé* chéri* adoré* sourire* soupir* rougi* frisson*
        love* lover* heart* kiss* romance romantic* beloved passion* desire* embrace* charm* tender* darling
        sweetheart blush* sigh*`,
    mysterious: `mystèr* mystér* énigm* secret* étrange* caché* cachai* ombre* obscur* inconnu* indice* clé clef
        déchiffr* enquête* enquêt* suspect* coupable* crime* détective* inspecteur* commissaire* bizarre* curieu*
        inexplicable* paranormal* surnaturel* fantôme* spectre* murmur* chuchot* silhouette*
        myster* enigma* secret* strange* hidden clue* cipher* investigat* suspect* detective* inspector* bizarre*
        curious* uncanny ghost* whisper*`,
    sad: `triste* tristesse chagrin* larme* pleur* pleura* sanglot* mélancoli* deuil* perte* perdu* perdue* seul seule seuls seules
        solitude* abandon* regret* nostalgi* adieu* adieux mourut mourir mourant* funéraill* tombe* tombeau* cimetière
        orphelin* misère* malheur* désespoir* désespér*
        sad* sorrow* grief* griev* tear* tears weep* wept sob* melanchol* mourn* loss lost alone lonel* regret*
        farewell* funeral* grave* despair* misery`,
    epic: `bataille* guerre* guerrier* armée* soldat* chevalier* épée* bouclier* victoire* héro* héroï* gloire*
        glorieu* conquête* conquér* empire* royaume* roi reine trône* légion* triomph* destin* légende* légendaire*
        canon* assaut* drapeau* étendard*
        battle* war warrior* army armies soldier* knight* sword* shield* victor* hero* glory glorious conquer*
        empire* kingdom* king queen throne* legion* triumph* destiny legend*`,
    upbeat: `joie* joyeu* heureu* bonheur rire riai* rit rirent riant* sourire* gai gaie gaiement amusant*
        drôle* humour plaisant* fête* célébr* danse* dansa* dansè* dansant* chanta* chanson* musique* énergi* excité* enthousias* optimis*
        soleil* lumière* lumineu* brillant* éclat*
        joy* happy happi* laugh* smil* cheer* fun funny humou* party parties celebrat* danc* music* energ*
        excit* bright* sunny sunshine singing`,
    dark: `sombre* noir* noire* ténèbr* obscurité nuit* sinistre* macabre* maléfique* démon* diable* enfer* cauchemar*
        horreur* horribl* malédiction* maudit* damné* corrompu* corruption cruel* cruauté* tortur* souffr* agonie
        vengeance* venge* haine* haï* rage* colère* sang* sanglant* cadavre* meurtr* tuer tua tué tuée
        dark* shadow* sinister evil demon* devil* hell nightmare* horror* curse* damned corrupt* cruel* tortur*
        agony revenge* hate* hatred rage wrath blood* corpse* murder* kill*`
};

const exact = new Map();
const stems = new Map();   // 3 premières lettres → [[radical, ambiance]]
for (const [mood, list] of Object.entries(KEYWORDS)) {
    for (const raw of list.split(/\s+/)) {
        if (!raw) continue;
        if (raw.endsWith('*')) {
            const stem = raw.slice(0, -1);
            const key = stem.slice(0, 3);
            if (!stems.has(key)) stems.set(key, []);
            stems.get(key).push([stem, mood]);
        } else {
            exact.set(raw, mood);
        }
    }
}

export function moodOfWord(word) {
    const w = word.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}-]+$/gu, '');
    if (w.length < 3) return null;
    if (exact.has(w)) return exact.get(w);
    const candidates = stems.get(w.slice(0, 3));
    if (!candidates) return null;
    let best = null, bestLen = 0;
    for (const [stem, mood] of candidates) {
        if (stem.length > bestLen && w.startsWith(stem)) { best = mood; bestLen = stem.length; }
    }
    return best;
}

export const MOOD_SEGMENT = 150;

/**
 * Carte des ambiances du livre : une ambiance par tranche de 150 mots.
 * Chaque tranche est jugée avec ses voisines (lissage), et l'ambiance ne change que si la
 * nouvelle domine nettement : la musique ne saute pas d'un style à l'autre toutes les phrases.
 */
export function buildMoodMap(words) {
    const nSeg = Math.ceil(words.length / MOOD_SEGMENT) || 1;
    const names = Object.keys(MOODS);
    const counts = names.map(() => new Float32Array(nSeg));
    for (let i = 0; i < words.length; i++) {
        const m = moodOfWord(words[i]);
        if (m) counts[names.indexOf(m)][(i / MOOD_SEGMENT) | 0]++;
    }

    const map = new Array(nSeg);
    let current = 'calm';
    for (let s = 0; s < nSeg; s++) {
        let best = -1, bestScore = 0, second = 0;
        for (let k = 0; k < names.length; k++) {
            const c = counts[k];
            const score = c[s] + 0.6 * ((c[s - 1] || 0) + (c[s + 1] || 0)) + 0.3 * ((c[s - 2] || 0) + (c[s + 2] || 0));
            if (score > bestScore) { second = bestScore; bestScore = score; best = k; }
            else if (score > second) second = score;
        }
        if (best >= 0 && names[best] !== current && bestScore >= 3 && bestScore > second * 1.3) current = names[best];
        map[s] = current;
    }
    return map;
}
