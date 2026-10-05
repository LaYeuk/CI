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
 * Routes propres à la BNS : /api/snb-catalog (liste des cubes, depuis le plan du site) et
 * /api/snb-index (titres + libellés des séries + date de publication, pour la recherche de l'écran BNS).
 * Route propre à l'OFS : /api/ofs-index (titres français + dimensions des tables STAT-TAB, écran OFS).
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

  /* Langue : le catalogue DAM de l'OFS choisit la langue des titres d'après l'en-tête Accept-Language
     (le paramètre "language" ne filtre que la langue des fichiers). On transmet donc l'en-tête du
     navigateur, ou on le déduit du paramètre "language" quand il est présent (ex. /api/ofs-dam?language=fr). */
  const qLang = url.searchParams.get('language');
  const acceptLang = (qLang && /^(de|fr|it|en)$/i.test(qLang)) ? qLang.toLowerCase() : request.headers.get('Accept-Language');
  const init = {method: request.method, headers: {}};
  if (acceptLang) init.headers['Accept-Language'] = acceptLang;
  if (request.method === 'POST') {
    init.body = await request.text();
    init.headers['Content-Type'] = request.headers.get('Content-Type') || 'application/json';
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
 * Index de recherche BNS (/api/snb-index?lang=fr&offset=0&limit=15) — utilisé par l'écran « BNS »
 * d'Outils_GIP.html pour une recherche plein texte façon data.snb.ch/fr/search.
 * Pour chaque cube du catalogue (sitemap, voir snbCatalog) on récupère, en parallèle :
 *   - son titre / domaine / unité / fréquence via l'API interne du portail (getCubeInfo), qui exige
 *     l'en-tête "x-epb-ajax: true" (sinon le pare-feu du portail renvoie une page HTML) ;
 *   - ses dimensions publiques (/api/cube/{id}/dimensions/{lang}) -> libellés des séries = mots-clés ;
 *   - sa date de dernière publication (/api/cube/{id}/lastUpdate).
 * Chaque résultat est mis en cache 7 jours (Cache API) : seule la toute première indexation interroge
 * réellement la BNS. Le navigateur appelle cet endpoint par tranches (limit <= 15 cubes, soit <= 45
 * sous-requêtes, sous la limite de 50 du plan gratuit Workers) et garde l'index complet en local.
 * Tout est « au mieux » : si getCubeInfo échoue, le cube reste trouvable par ses séries et son id.
 * ---------------------------------------------------------------------------------------------- */

const SNB_META_TTL = 7 * 24 * 3600;

function snbPageViewTime(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '_' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

async function snbJson(url, headers){
  try {
    const r = await fetch(url, {headers: Object.assign({Accept: 'application/json'}, headers || {})});
    if (!r.ok) return {status: r.status, json: null};
    return {status: r.status, json: await r.json()};
  } catch (e) {
    return {status: 0, json: null};
  }
}

function snbDimNames(dims){
  const out = [], seen = new Set();
  let leaves = 0;
  (function walk(items, depth){
    (items || []).forEach(it => {
      const n = String(it.name || '').trim();
      const kids = it.dimensionItems || [];
      if (!kids.length) leaves++;
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
      walk(kids, depth + 1);
    });
  })((dims && dims.dimensions) || [], 0);
  return {kw: out.join(' · ').slice(0, 900), leaves};
}

async function snbCubeMeta(id, lang, ctx){
  const cache = caches.default;
  const key = new Request('https://internal-cache.invalid/snb-meta-v1/' + lang + '/' + encodeURIComponent(id));
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const enc = encodeURIComponent(id);
  const [info, dims, upd] = await Promise.all([
    snbJson('https://data.snb.ch/json/table/getCubeInfo?lang=' + lang + '&cubeId=' + enc + '&isWarehouse=false&pageViewTime=' + snbPageViewTime(), {'x-epb-ajax': 'true'}),
    snbJson('https://data.snb.ch/api/cube/' + enc + '/dimensions/' + lang),
    snbJson('https://data.snb.ch/api/cube/' + enc + '/lastUpdate')
  ]);
  const i = info.json || {};
  const d = snbDimNames(dims.json);
  const u = upd.json || {};
  const meta = {
    title: String(i.title || '').trim(),
    cat: String(i.publishingTitle || '').trim(),
    unit: String(i.unit || '').trim(),
    freq: String(i.frequencySpecification || '').trim(),
    upd: String(u.publicSinceDate || u.editionDate || ''),
    kw: d.kw,
    n: d.leaves,
    gone: dims.status === 404 || dims.status === 410
  };
  /* On ne met en cache que les réponses exploitables (évite de figer une panne passagère 7 jours). */
  if (dims.json || meta.gone) {
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(meta), {headers: {'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + SNB_META_TTL}})));
  }
  return meta;
}

async function snbIndex(url, ctx){
  const lang = ['fr', 'de', 'en'].indexOf(url.searchParams.get('lang')) >= 0 ? url.searchParams.get('lang') : 'fr';
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const limit = Math.min(15, Math.max(1, parseInt(url.searchParams.get('limit') || '15', 10) || 15));

  const catResp = await snbCatalog(ctx);
  if (!catResp.ok) return catResp;
  const cat = await catResp.clone().json();
  const all = cat.publication || [];
  const slice = all.slice(offset, offset + limit);
  const metas = await Promise.all(slice.map(c => snbCubeMeta(c.id, lang, ctx).catch(() => ({}))));
  const entries = slice.map((c, k) => Object.assign({id: c.id, topic: c.topic, domaine: c.domaine}, metas[k]));

  return new Response(JSON.stringify({total: all.length, offset, limit, lang, entries}), {
    status: 200,
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...corsHeaders()}
  });
}

/* ----------------------------------------------------------------------------------------------
 * Index de recherche OFS (/api/ofs-index?lang=fr&ids=px-x-...,px-x-...) — utilisé par l'écran
 * « OFS » d'Outils_GIP.html. Le catalogue DAM de l'OFS ne donne les titres qu'en allemand ; les
 * titres français et les libellés des dimensions viennent de l'API STAT-TAB (PxWeb) :
 *   - /api/v1/{lang}/{id}              -> titre de la table + date de mise à jour ;
 *   - /api/v1/{lang}/{id}/{id}.px      -> variables (dimensions) et leurs valeurs = mots-clés.
 * 10 tables max par appel (20 sous-requêtes), 3 tables à la fois pour ménager la limite de débit de
 * STAT-TAB ; chaque table est mise en cache 7 jours. Repli sur l'allemand si la table n'existe pas en
 * français. Les échecs ne sont pas mis en cache (le navigateur les redemandera plus tard).
 * ---------------------------------------------------------------------------------------------- */

const OFS_META_TTL = 7 * 24 * 3600;

async function ofsTableMeta(id, lang, ctx){
  const cache = caches.default;
  const key = new Request('https://internal-cache.invalid/ofs-meta-v1/' + lang + '/' + encodeURIComponent(id));
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const base = 'https://www.pxweb.bfs.admin.ch/api/v1/';
  const enc = encodeURIComponent(id);
  let usedLang = lang, list = await snbJson(base + lang + '/' + enc);
  if (!list.json && list.status === 404 && lang !== 'de') { usedLang = 'de'; list = await snbJson(base + 'de/' + enc); }
  const meta = await snbJson(base + usedLang + '/' + enc + '/' + enc + '.px');
  if (!list.json && !meta.json) return {id, err: list.status || meta.status || 0};

  const tbl = Array.isArray(list.json) ? (list.json.find(x => x.type === 't') || list.json[0] || {}) : {};
  const vars = (meta.json && meta.json.variables) || [];
  const kw = [];
  vars.forEach(v => {
    kw.push(v.text || v.code);
    if (v.time) return;
    (v.valueTexts || []).slice(0, 40).forEach(t => { if (t && !/^\d+$/.test(t)) kw.push(t); });
  });
  const timeVar = vars.find(v => v.time);
  const out = {
    id,
    lang: usedLang,
    title: String(tbl.text || (meta.json && meta.json.title) || '').trim(),
    updated: String(tbl.updated || ''),
    dims: vars.map(v => v.text || v.code).join(' · '),
    kw: Array.from(new Set(kw)).join(' · ').slice(0, 1200),
    t0: timeVar && timeVar.values ? timeVar.values[0] : '',
    t1: timeVar && timeVar.values ? timeVar.values[timeVar.values.length - 1] : ''
  };
  if (list.json && meta.json) {
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(out), {headers: {'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + OFS_META_TTL}})));
  }
  return out;
}

async function ofsIndex(url, ctx){
  const lang = ['fr', 'de', 'it', 'en'].indexOf(url.searchParams.get('lang')) >= 0 ? url.searchParams.get('lang') : 'fr';
  const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(s => /^px-x-[0-9A-Za-z_]+$/.test(s)).slice(0, 10);
  const entries = new Array(ids.length);
  let k = 0;
  async function worker(){
    while (k < ids.length) {
      const i = k++;
      try { entries[i] = await ofsTableMeta(ids[i], lang, ctx); }
      catch (e) { entries[i] = {id: ids[i], err: 0}; }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return new Response(JSON.stringify({lang, entries}), {
    status: 200,
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders()}
  });
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

    if (url.pathname === '/api/snb-index') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      return snbIndex(url, ctx);
    }

    if (url.pathname === '/api/ofs-index') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      return ofsIndex(url, ctx);
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
