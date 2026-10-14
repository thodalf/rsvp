// Relais Google Books exécuté par Netlify : /api/google-books?q=…&lang=…  ou  ?id=…
//
// Pourquoi : sans clé, Google limite très vite les requêtes (erreur 429), et ce quota est partagé
// avec tous les sites qui passent par les mêmes serveurs. Ce relais :
//   - ajoute la clé GOOGLE_BOOKS_API_KEY (variable Netlify) côté serveur, sans jamais l'exposer ;
//   - met chaque réponse en cache sur le CDN de Netlify pendant 24 h : une même recherche, faite
//     par n'importe qui, ne coûte qu'une seule requête à Google par jour ;
//   - réessaie une fois en douceur quand Google répond 429.

const API = 'https://www.googleapis.com/books/v1/volumes';

const json = (status, body, cache) => new Response(JSON.stringify(body), {
    status,
    headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        ...(cache ? {
            'cache-control': 'public, max-age=3600',
            'netlify-cdn-cache-control': 'public, durable, s-maxage=86400, stale-while-revalidate=604800'
        } : { 'cache-control': 'no-store' })
    }
});

async function callGoogle(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(url, { headers: { 'accept': 'application/json' } });
        if (res.status !== 429 || attempt === 1) return res;
        const wait = Math.min(3, Number(res.headers.get('retry-after')) || 1.5);
        await new Promise(r => setTimeout(r, wait * 1000));
    }
}

export default async (req) => {
    const params = new URL(req.url).searchParams;
    const key = process.env.GOOGLE_BOOKS_API_KEY || '';
    const id = (params.get('id') || '').trim();
    const q = (params.get('q') || '').trim().slice(0, 200);
    const lang = (params.get('lang') || '').trim().slice(0, 5);

    let url;
    if (id) {
        if (!/^[\w-]{6,20}$/.test(id)) return json(400, { error: 'bad_id' });
        url = `${API}/${id}?${new URLSearchParams(key ? { key } : {})}`;
    } else {
        if (!q) return json(400, { error: 'missing_query' });
        const p = new URLSearchParams({ q, filter: 'free-ebooks', printType: 'books', maxResults: '40', orderBy: 'relevance' });
        if (/^[a-z]{2}$/.test(lang)) p.set('langRestrict', lang);
        if (key) p.set('key', key);
        url = `${API}?${p}`;
    }

    let res;
    try {
        res = await callGoogle(url);
    } catch {
        return json(502, { error: 'upstream_unreachable' });
    }
    if (res.status === 429) return json(429, { error: 'quota', keyConfigured: !!key });
    if (!res.ok) return json(res.status, { error: 'upstream_' + res.status });
    return json(200, await res.json(), true);
};

export const config = { path: '/api/google-books' };
