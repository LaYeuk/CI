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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}

async function relay(request, targetBase, stripPrefix, methods, env, ctx, ttlMs){
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

  /* Réponses GET rarement modifiées (métadonnées OFS, séries BNS) : servies depuis D1 si assez récentes. */
  const cacheKey = (ttlMs && request.method === 'GET' && env && env.DB) ? 'relay:' + target : null;
  let stale = null;
  if (cacheKey) {
    const hit = await cacheGet(env, cacheKey);
    if (hit && hit.age < ttlMs) return new Response(hit.data, {status: 200, headers: {'Content-Type': 'application/json', 'X-GIP-Cache': 'HIT', ...corsHeaders()}});
    stale = hit;
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    if (stale) return new Response(stale.data, {status: 200, headers: {'Content-Type': 'application/json', 'X-GIP-Cache': 'STALE', ...corsHeaders()}});
    return new Response(JSON.stringify({error_message: 'Relais : échec de connexion à l\'hôte externe (' + e.message + ')'}), {
      status: 502,
      headers: {'Content-Type': 'application/json', ...corsHeaders()}
    });
  }

  const body = await upstream.text();
  if (cacheKey && upstream.status === 200 && ctx) ctx.waitUntil(cachePut(env, cacheKey, body));
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

async function snbCatalog(env, ctx){
  /* 1) D1 (durable, partagé, 7 jours) 2) sinon plan du site officiel, puis on mémorise 3) en cas d'échec : copie périmée si on en a une */
  const hit = env.DB ? await cacheGet(env, 'snb_catalog_v1') : null;
  if (hit && hit.age < 7 * DAY) return jsonBody(hit.data, 200, {'X-GIP-Cache': 'HIT', 'Cache-Control': 'public, max-age=3600'});

  let xml;
  try {
    const r = await fetch('https://data.snb.ch/sitemap');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    xml = await r.text();
  } catch (e) {
    if (hit) return jsonBody(hit.data, 200, {'X-GIP-Cache': 'STALE'});
    return jsonBody(JSON.stringify({error_message: 'Impossible de récupérer le plan du site de la BNS (' + e.message + ')'}), 502);
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
  const body = JSON.stringify({publication, generated: new Date().toISOString()});
  if (env.DB) ctx.waitUntil(cachePut(env, 'snb_catalog_v1', body));
  return jsonBody(body, 200, {'X-GIP-Cache': 'MISS', 'Cache-Control': 'public, max-age=3600'});
}

/* ----------------------------------------------------------------------------------------------
 * Cache d'index et de réponses d'API dans D1 (table api_cache) : partagé par tous les visiteurs et
 * durable (contrairement au cache du navigateur ou au cache de bord Cloudflare, propre à chaque
 * datacenter). Sert à accélérer le chargement des catalogues (OFS, BNS) et à éviter de re-télécharger
 * à chaque fois les métadonnées OFS / séries BNS qui changent rarement. Si D1 est indisponible,
 * tout continue de fonctionner sans cache (appel direct à l'API d'origine).
 * ---------------------------------------------------------------------------------------------- */
const CACHE_MAX_BYTES = 1800000; /* limite D1 : ~2 Mo par ligne */
async function cacheGet(env, k) {
  try {
    await ensureSchema(env.DB);
    const r = await env.DB.prepare('SELECT data, fetched_at FROM api_cache WHERE k = ?').bind(k).first();
    return r ? {data: r.data, age: Date.now() - r.fetched_at} : null;
  } catch (e) { return null; }
}
async function cachePut(env, k, data) {
  try {
    if (!env.DB || data.length > CACHE_MAX_BYTES) return;
    await ensureSchema(env.DB);
    await env.DB.prepare('INSERT INTO api_cache (k, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at')
      .bind(k, data, Date.now()).run();
  } catch (e) {}
}
function jsonBody(body, status, extra) {
  return new Response(body, {status: status || 200, headers: {'Content-Type': 'application/json', ...corsHeaders(), ...(extra || {})}});
}

const DAY = 24 * 3600 * 1000;

/* Catalogue OFS : toutes les tables chiffrées STAT-TAB (~plusieurs pages de 200 côté DAM), construit côté Worker
   puis gardé 7 jours dans D1 — le navigateur reçoit tout en UNE requête au lieu de paginer. */
async function ofsCatalog(request, env, ctx) {
  const lang = new URL(request.url).searchParams.get('language') === 'de' ? 'de' : (new URL(request.url).searchParams.get('language') || 'fr');
  const key = 'ofs_catalog_' + lang;
  const hit = await cacheGet(env, key);
  if (hit && hit.age < 7 * DAY) return jsonBody(hit.data, 200, {'X-GIP-Cache': 'HIT'});
  try {
    let all = [], skip = 0, total = Infinity;
    for (let page = 0; page < 15 && skip < total; page++) {
      const qs = new URLSearchParams({language: lang, articleModelGroup: '900029', articleModel: '900033', limit: '200', skip: String(skip)});
      const r = await fetch('https://dam-api.bfs.admin.ch/hub/api/dam/assets?' + qs.toString());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      total = typeof j.total === 'number' ? j.total : ((j.data || []).length + skip);
      const batch = j.data || [];
      all = all.concat(batch);
      if (!batch.length) break;
      skip += batch.length;
    }
    const catalog = all.filter(it => it && it.shop && it.shop.orderNr).map(it => ({
      title: (it.description && it.description.titles && it.description.titles.main) || it.shop.orderNr,
      dbid: it.shop.orderNr,
      themes: ((it.description && it.description.categorization && it.description.categorization.prodima) || [])
        .filter(p => p.level === 0).map(p => ({code: p.code, name: p.name}))
    }));
    const body = JSON.stringify({catalog, total, generated: new Date().toISOString()});
    ctx.waitUntil(cachePut(env, key, body));
    return jsonBody(body, 200, {'X-GIP-Cache': 'MISS'});
  } catch (e) {
    if (hit) return jsonBody(hit.data, 200, {'X-GIP-Cache': 'STALE'}); /* mieux vaut un index un peu ancien que pas d'index */
    return jsonBody(JSON.stringify({error_message: "Catalogue OFS indisponible (" + e.message + ")"}), 502);
  }
}

/* Index des séries BNS (table snb_series, un document compact par cube : {c: id, d: domaine, l: libellé, s: [noms de séries]}).
   Alimenté de deux façons : (1) par les navigateurs, quand quelqu'un charge un indicateur ; (2) par l'EXPLORATION AUTOMATIQUE
   ci-dessous, qui parcourt les ~900 cubes du catalogue BNS par petits lots (déclenchée par le cron toutes les 3 minutes). La recherche
   par mot-clé « 🔎 » de l'appli couvre ainsi toutes les séries, y compris celles que personne n'a encore ouvertes. */
async function handleSnbSeries(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
  try {
    await ensureSchema(env.DB);
    if (request.method === 'GET') {
      const rs = await env.DB.prepare('SELECT data FROM snb_series').all();
      const cubes = [];
      rs.results.forEach(r => { try { const c = JSON.parse(r.data); if (c && c.c && Array.isArray(c.s) && c.s.length) cubes.push(c); } catch (e) {} });
      return jsonBody(JSON.stringify({cubes}), 200, {'Cache-Control': 'public, max-age=120'});
    }
    if (request.method === 'POST') {
      if (!writeAllowed(request, env)) return jsonResponse({error_message: "Clé d'équipe manquante ou invalide."}, 401);
      let b; try { b = await request.json(); } catch (e) { return jsonResponse({error_message: 'JSON invalide.'}, 400); }
      if (!b || !b.cubeId || !Array.isArray(b.labels)) return jsonResponse({error_message: 'Requête invalide.'}, 400);
      const doc = {c: String(b.cubeId), d: String(b.cubeDomaine || ''), l: String(b.cubeLabel || b.cubeId), s: b.labels.map(String)};
      await env.DB.prepare('INSERT INTO snb_series (cube_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(cube_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .bind(doc.c, JSON.stringify(doc), new Date().toISOString()).run();
      return jsonResponse({ok: true});
    }
    return jsonResponse({error_message: 'Méthode non supportée.'}, 405);
  } catch (e) {
    return jsonResponse({error_message: 'Base partagée indisponible (' + e.message + ').'}, 500);
  }
}

/* ---- Exploration automatique des cubes BNS ----
   Chaque cube est téléchargé (data/json/fr) et on n'en extrait QUE les noms de séries (les "dimItem" des en-têtes), par balayage de
   texte — sans parser les valeurs, pour rester léger en CPU. Un lot = quelques cubes ; l'état d'avancement est simplement la
   présence (et l'âge) de chaque cube dans snb_series : manquants d'abord, puis les plus anciens (> 30 jours). */
const SNB_CRAWL_FRESH_MS = 30 * DAY;
const SNB_HEADER_RE = /"header"\s*:\s*\[([^\]]*)\]/g;
const SNB_DIMITEM_RE = /"dimItem"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function snbExtractLabels(text, fallback) {
  const labels = [];
  let m;
  SNB_HEADER_RE.lastIndex = 0;
  while ((m = SNB_HEADER_RE.exec(text))) {
    const items = [];
    let d;
    SNB_DIMITEM_RE.lastIndex = 0;
    while ((d = SNB_DIMITEM_RE.exec(m[1]))) {
      try { items.push(JSON.parse('"' + d[1] + '"')); } catch (e) { items.push(d[1]); }
    }
    labels.push(items.join(' — ') || fallback);
  }
  return labels;
}

async function snbCrawlStatus(env) {
  await ensureSchema(env.DB);
  const cat = await (await snbCatalog(env, {waitUntil: p => p})).json();
  const ids = (cat.publication || []);
  const rs = await env.DB.prepare('SELECT cube_id, updated_at FROM snb_series').all();
  const have = new Map(rs.results.map(r => [r.cube_id, Date.parse(r.updated_at) || 0]));
  const missing = ids.filter(c => !have.has(c.id));
  const stale = ids.filter(c => have.has(c.id) && Date.now() - have.get(c.id) > SNB_CRAWL_FRESH_MS);
  return {ids, have, missing, stale};
}

async function snbCrawlBatch(env, n) {
  if (!env.DB) return {error: 'D1 absente'};
  const st = await snbCrawlStatus(env);
  const todo = st.missing.concat(st.stale.sort((a, b) => st.have.get(a.id) - st.have.get(b.id))).slice(0, n);
  let done = 0, failed = 0;
  const writes = [];
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(async c => {
      try {
        const r = await fetch('https://data.snb.ch/api/cube/' + encodeURIComponent(c.id) + '/data/json/fr', {signal: AbortSignal.timeout(20000)});
        if (r.status >= 500) throw new Error('HTTP ' + r.status);
        const labels = r.ok ? snbExtractLabels(await r.text(), c.id) : []; /* 4xx : cube sans données exploitables, on le marque pour ne pas le rejouer sans cesse */
        const doc = {c: c.id, d: c.domaine, l: c.id, s: labels};
        writes.push(env.DB.prepare('INSERT INTO snb_series (cube_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(cube_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
          .bind(c.id, JSON.stringify(doc), new Date().toISOString()));
        done++;
      } catch (e) { failed++; }
    }));
  }
  if (writes.length) await env.DB.batch(writes);
  return {total: st.ids.length, indexed: st.have.size + done, processed: done, failed, remaining: Math.max(0, st.missing.length - done), stale: st.stale.length};
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
    db.prepare('CREATE TABLE IF NOT EXISTS chartpack_doc (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS kv_store (k TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS api_cache (k TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS snb_series (cube_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)')
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

/* Petit stockage clé/valeur partagé (ex. les catégories du Whiteboard) : un document JSON par clé. */
const KV_KEYS = ['wb_categories'];
async function handleKv(request, env, key) {
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
  if (KV_KEYS.indexOf(key) < 0) return jsonResponse({error_message: 'Clé inconnue.'}, 404);
  try {
    await ensureSchema(env.DB);
    if (request.method === 'GET') {
      const row = await env.DB.prepare('SELECT data, updated_at FROM kv_store WHERE k = ?').bind(key).first();
      if (!row) return jsonResponse({data: null});
      let data; try { data = JSON.parse(row.data); } catch (e) { data = null; }
      return jsonResponse({data, updated_at: row.updated_at});
    }
    if (request.method === 'PUT') {
      if (!writeAllowed(request, env)) return jsonResponse({error_message: "Clé d'équipe manquante ou invalide."}, 401);
      let doc;
      try { doc = await request.json(); } catch (e) { return jsonResponse({error_message: 'JSON invalide.'}, 400); }
      const now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO kv_store (k, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .bind(key, JSON.stringify(doc), now).run();
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
  {prefix: '/api/ofs-pxweb', target: 'https://www.pxweb.bfs.admin.ch/api/v1', methods: ['GET', 'POST'], ttlMs: 7 * 24 * 3600 * 1000}, /* GET = métadonnées de table (stables) ; les POST de données ne sont jamais mis en cache */
  {prefix: '/api/snb', target: 'https://data.snb.ch/api/cube', methods: ['GET'], ttlMs: 6 * 3600 * 1000}
];

export default {
  /* Cron (voir wrangler.jsonc) : fait avancer l'exploration du catalogue BNS d'un petit lot à chaque passage. */
  async scheduled(event, env, ctx){
    ctx.waitUntil(snbCrawlBatch(env, 12).catch(() => {}));
  },

  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if (url.pathname === '/api/snb-catalog') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      return snbCatalog(env, ctx);
    }

    if (url.pathname === '/api/ofs-catalog') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      return ofsCatalog(request, env, ctx);
    }
    if (url.pathname === '/api/db/snb-series') return handleSnbSeries(request, env);
    if (url.pathname === '/api/snb-crawl') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      try {
        if (url.searchParams.get('run')) {
          const keyOk = writeAllowed(request, env) || (env.GIP_WRITE_KEY && url.searchParams.get('key') === env.GIP_WRITE_KEY);
          if (!keyOk) return jsonResponse({error_message: "Clé d'équipe manquante ou invalide."}, 401);
          const n = Math.max(1, Math.min(20, parseInt(url.searchParams.get('n'), 10) || 10));
          return jsonResponse(await snbCrawlBatch(env, n));
        }
        const st = await snbCrawlStatus(env);
        return jsonResponse({total: st.ids.length, indexed: st.have.size, remaining: st.missing.length, stale: st.stale.length});
      } catch (e) { return jsonResponse({error_message: 'Exploration indisponible (' + e.message + ').'}, 500); }
    }
    if (url.pathname === '/api/db/chartpack') return handleChartpack(request, env);
    const kvMatch = url.pathname.match(/^\/api\/db\/kv\/([a-z_]+)$/);
    if (kvMatch) return handleKv(request, env, kvMatch[1]);
    const destItemMatch = url.pathname.match(/^\/api\/db\/dest\/([a-z]+)\/([^/]+)$/);
    if (destItemMatch) return handleDestItem(request, env, destItemMatch[1], decodeURIComponent(destItemMatch[2]));
    const destCollMatch = url.pathname.match(/^\/api\/db\/dest\/([a-z]+)$/);
    if (destCollMatch) return handleDestCollection(request, env, destCollMatch[1]);

    for (const r of ROUTES) {
      if (url.pathname === r.prefix || url.pathname.startsWith(r.prefix + '/')) {
        if (r.noSubPath) {
          /* /api/ofs-dam n'a jamais de sous-chemin : on retire le préfixe entier, il ne reste que
             la query string (ex. "/api/ofs-dam?language=fr&..." -> "?language=fr&..."). */
          return relay(request, r.target, r.prefix, r.methods, env, ctx, r.ttlMs);
        }
        return relay(request, r.target, r.prefix, r.methods, env, ctx, r.ttlMs);
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
