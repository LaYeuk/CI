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

/* ----------------------------------------------------------------------------------------------
 * Base partagée (Cloudflare D1) pour les graphiques déposés : Whiteboard, AM Dashboard et Chart
 * Pack CI. Objectif demandé : tout le monde qui visite le site voit les mêmes graphiques déposés,
 * au lieu d'une copie par navigateur (ancien stockage localStorage — toujours utilisé côté client
 * comme repli hors-ligne / avant la 1ère réponse du serveur, voir shared_engine.js). Deux tables :
 *   - dest_items(id, dest, created_at, data)  -> Whiteboard et AM Dashboard, un item par ligne
 *   - chartpack_doc(id=1, data, updated_at)   -> Chart Pack CI, document unique partagé
 * Liaison D1 attendue dans wrangler.jsonc : binding "DB" (voir fichier fourni avec ce Worker).
 *
 * Protection optionnelle des écritures : ce Worker est public (pas d'authentification), donc par
 * défaut n'importe qui connaissant l'URL peut aussi bien lire qu'écrire dans cette base partagée.
 * Si le secret GIP_WRITE_KEY est défini pour ce Worker ("npx wrangler secret put GIP_WRITE_KEY"),
 * toute requête POST/PUT/DELETE sous /api/db/ doit fournir l'en-tête X-GIP-Key avec la même valeur,
 * sinon 401 (la lecture reste toujours libre). Tant qu'aucun secret n'est défini, les écritures
 * restent ouvertes comme aujourd'hui — ce mécanisme est donc facultatif, à activer si besoin.
 * ---------------------------------------------------------------------------------------------- */

let SCHEMA_READY = false;
async function ensureSchema(db) {
  if (SCHEMA_READY) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS dest_items (id TEXT PRIMARY KEY, dest TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_dest_items_dest ON dest_items(dest)'),
    db.prepare('CREATE TABLE IF NOT EXISTS chartpack_doc (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL)')
  ]);
  SCHEMA_READY = true;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {status: status || 200, headers: {'Content-Type': 'application/json', ...corsHeaders()}});
}

function writeAllowed(request, env) {
  const required = env.GIP_WRITE_KEY;
  if (!required) return true;
  return request.headers.get('X-GIP-Key') === required;
}

const DEST_NAMES = ['whiteboard', 'dashboard'];

async function handleDestCollection(request, env, destName) {
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
  if (DEST_NAMES.indexOf(destName) < 0) return jsonResponse({error_message: 'Destination inconnue.'}, 404);
  try {
    await ensureSchema(env.DB);

    if (request.method === 'GET') {
      const rs = await env.DB.prepare('SELECT data FROM dest_items WHERE dest = ? ORDER BY created_at ASC').bind(destName).all();
      const items = rs.results.map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } }).filter(Boolean);
      return jsonResponse({items});
    }

    if (request.method === 'POST') {
      if (!writeAllowed(request, env)) return jsonResponse({error_message: "Clé d'équipe manquante ou invalide."}, 401);
      let item;
      try { item = await request.json(); } catch (e) { return jsonResponse({error_message: 'JSON invalide.'}, 400); }
      if (!item || !item.id) return jsonResponse({error_message: 'Item invalide (id manquant).'}, 400);
      await env.DB.prepare('INSERT OR REPLACE INTO dest_items (id, dest, created_at, data) VALUES (?, ?, ?, ?)')
        .bind(item.id, destName, item.createdAt || new Date().toISOString(), JSON.stringify(item)).run();
      return jsonResponse({ok: true, id: item.id});
    }

    return jsonResponse({error_message: 'Méthode non supportée.'}, 405);
  } catch (e) {
    return jsonResponse({error_message: 'Base partagée indisponible (' + e.message + '). Le Worker a-t-il bien été redéployé avec la liaison D1 "DB" ?'}, 500);
  }
}

async function handleDestItem(request, env, destName, id) {
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
  if (DEST_NAMES.indexOf(destName) < 0) return jsonResponse({error_message: 'Destination inconnue.'}, 404);
  if (request.method !== 'DELETE') return jsonResponse({error_message: 'Méthode non supportée.'}, 405);
  if (!writeAllowed(request, env)) return jsonResponse({error_message: "Clé d'équipe manquante ou invalide."}, 401);
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare('DELETE FROM dest_items WHERE dest = ? AND id = ?').bind(destName, id).run();
    return jsonResponse({ok: true});
  } catch (e) {
    return jsonResponse({error_message: 'Base partagée indisponible (' + e.message + ').'}, 500);
  }
}

async function handleChartpack(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
  try {
    await ensureSchema(env.DB);

    if (request.method === 'GET') {
      const row = await env.DB.prepare('SELECT data, updated_at FROM chartpack_doc WHERE id = 1').first();
      if (!row) return jsonResponse({data: null});
      let data; try { data = JSON.parse(row.data); } catch (e) { data = null; }
      return jsonResponse({data, updated_at: row.updated_at});
    }

    if (request.method === 'PUT') {
      if (!writeAllowed(request, env)) return jsonResponse({error_message: "Clé d'équipe manquante ou invalide."}, 401);
      let doc;
      try { doc = await request.json(); } catch (e) { return jsonResponse({error_message: 'JSON invalide.'}, 400); }
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO chartpack_doc (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
        .bind(JSON.stringify(doc), now).run();
      return jsonResponse({ok: true, updated_at: now});
    }

    return jsonResponse({error_message: 'Méthode non supportée.'}, 405);
  } catch (e) {
    return jsonResponse({error_message: 'Base partagée indisponible (' + e.message + ').'}, 500);
  }
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

    if (url.pathname === '/api/db/chartpack') return handleChartpack(request, env);
    const destItemMatch = url.pathname.match(/^\/api\/db\/dest\/([a-z]+)\/([^/]+)$/);
    if (destItemMatch) return handleDestItem(request, env, destItemMatch[1], decodeURIComponent(destItemMatch[2]));
    const destCollMatch = url.pathname.match(/^\/api\/db\/dest\/([a-z]+)$/);
    if (destCollMatch) return handleDestCollection(request, env, destCollMatch[1]);

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
