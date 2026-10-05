/*
 * Worker Cloudflare unique : sert le site statique (Outils_GIP.html et les autres fichiers du
 * dépôt) ET relaie les appels vers OFS (BFS), FRED et la BNS sous /api/... — remplace l'ancien
 * dossier functions/ (convention "Cloudflare Pages Functions", qui ne s'applique plus au mode de
 * déploiement actuel de ce projet, basé sur "npx wrangler deploy" / Workers + Static Assets).
 *
 * Rien à changer côté Outils_GIP.html : les modules OFS/FRED/BNS appellent déjà ces mêmes adresses
 * relatives ("/api/fred/...", "/api/ofs-dam", "/api/ofs-pxweb/...", "/api/snb/...") — ce script
 * répond simplement à leur place de ce qui aurait été les fonctions séparées.
 *
 * Fichiers compagnons à la racine du dépôt (CI/) :
 *   - wrangler.jsonc   : config du Worker (assets.directory = ".", main = "_worker.js")
 *   - .assetsignore    : empêche ce fichier et wrangler.jsonc d'être servis comme fichiers publics
 *   - _redirects       : fait que "/" affiche directement Outils_GIP.html
 */

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}

async function relay(request, targetBase, stripPrefix, methods){
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {status: 204, headers: corsHeaders()});
  }
  if (methods && methods.indexOf(request.method) < 0) {
    return new Response(JSON.stringify({error_message: 'Méthode non supportée par ce relais.'}), {
      status: 405, headers: {'Content-Type': 'application/json', ...corsHeaders()}
    });
  }

  const path = url.pathname.startsWith(stripPrefix) ? url.pathname.slice(stripPrefix.length) : url.pathname;
  const target = targetBase + path + url.search;

  const init = {method: request.method};
  if (request.method === 'POST') {
    init.body = await request.text();
    init.headers = {'Content-Type': request.headers.get('Content-Type') || 'application/json'};
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return new Response(JSON.stringify({error_message: 'Relais : échec de connexion à l\'hôte externe (' + e.message + ')'}), {
      status: 502,
      headers: {'Content-Type': 'application/json', ...corsHeaders()}
    });
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {'Content-Type': upstream.headers.get('Content-Type') || 'application/json', ...corsHeaders()}
  });
}

/* ----------------------------------------------------------------------------------------------
 * Catalogue complet BNS (/api/snb-catalog) : la BNS n'offre aucune API de recherche — la seule
 * source exhaustive est son plan de site XML (https://data.snb.ch/sitemap, ~1'149 entrées). Ce
 * fichier est trop gros pour les outils de navigation web utilisés côté agent pour l'explorer (ils
 * le tronquent), mais AUCUN souci ici : ce Worker tourne sur le réseau de Cloudflare et fait un
 * fetch() normal, sans cette limite. On le télécharge, on en extrait tous les cubes "publication"
 * (topics/{domaine}/cube/{id}, langue EN pour éviter les triplons de/fr/en), on les classe par
 * domaine, et on met le résultat en cache (Cache API, 24h) pour ne pas re-télécharger le sitemap à
 * chaque recherche. Les cubes "warehouse" (statistique bancaire détaillée, API différente, non
 * gérée par ce Worker) sont volontairement exclus du résultat.
 * ---------------------------------------------------------------------------------------------- */

const SNB_TOPIC_FR = {
  snb: 'BNS (bilan, réserves, billets)',
  banken: 'Banques',
  ziredev: "Taux d'intérêt, rendements et changes",
  finma: 'Marché des capitaux et transactions de paiement',
  uvo: 'Conjoncture suisse',
  aube: 'Conjoncture internationale',
  cross: 'Transversal'
};

const SNB_PUB_CUBE_RE = /<loc>https:\/\/data\.snb\.ch\/en\/topics\/([^/]+)\/cube\/([^<]+)<\/loc>/g;

async function snbCatalog(ctx){
  const cache = caches.default;
  const cacheKey = new Request('https://internal-cache.invalid/snb-catalog-v1');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let xml;
  try {
    const r = await fetch('https://data.snb.ch/sitemap');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    xml = await r.text();
  } catch (e) {
    return new Response(JSON.stringify({error_message: 'Impossible de récupérer le plan du site de la BNS (' + e.message + ')'}), {
      status: 502, headers: {'Content-Type': 'application/json', ...corsHeaders()}
    });
  }

  const seen = new Set();
  const publication = [];
  let m;
  SNB_PUB_CUBE_RE.lastIndex = 0;
  while ((m = SNB_PUB_CUBE_RE.exec(xml))) {
    const topic = m[1], id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    publication.push({id, topic, domaine: SNB_TOPIC_FR[topic] || topic});
  }

  const resp = new Response(JSON.stringify({publication, generated: new Date().toISOString()}), {
    status: 200,
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400', ...corsHeaders()}
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

/* Ordre important : les préfixes les plus spécifiques d'abord (aucun souci ici, les 4 préfixes
   sont mutuellement exclusifs). */
const ROUTES = [
  {prefix: '/api/fred', target: 'https://api.stlouisfed.org/fred', methods: ['GET']},
  {prefix: '/api/ofs-dam', target: 'https://dam-api.bfs.admin.ch/hub/api/dam/assets', methods: ['GET'], noSubPath: true},
  {prefix: '/api/ofs-pxweb', target: 'https://www.pxweb.bfs.admin.ch/api/v1', methods: ['GET', 'POST']},
  {prefix: '/api/snb', target: 'https://data.snb.ch/api/cube', methods: ['GET']}
];

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if (url.pathname === '/api/snb-catalog') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      return snbCatalog(ctx);
    }

    for (const r of ROUTES) {
      if (url.pathname === r.prefix || url.pathname.startsWith(r.prefix + '/')) {
        if (r.noSubPath) {
          /* /api/ofs-dam n'a jamais de sous-chemin : on retire le préfixe entier, il ne reste que
             la query string (ex. "/api/ofs-dam?language=fr&..." -> "?language=fr&..."). */
          return relay(request, r.target, r.prefix, r.methods);
        }
        return relay(request, r.target, r.prefix, r.methods);
      }
    }

    /* Racine du site -> sert directement Outils_GIP.html (le fichier "_redirects" seul ne suffit
       pas ici : un Worker personnalisé intercepte la requête avant que ce mécanisme ne s'applique,
       donc on fait la même chose explicitement). */
    if (url.pathname === '/') {
      return env.ASSETS.fetch(new Request(new URL('/Outils_GIP.html', request.url), request));
    }

    /* Tout le reste : fichiers statiques du site (Outils_GIP.html, images, etc.). */
    return env.ASSETS.fetch(request);
  }
};
