/*
 * Worker Cloudflare unique : sert le site statique (Outils_GIP.html et les autres fichiers du
 * dépôt) ET relaie les appels vers OFS (BFS), FRED et la BNS sous /api/... — remplace l'ancien
 * dossier functions/ (convention "Cloudflare Pages Functions", qui ne s'applique plus au mode de
 * déploiement actuel de ce projet, basé sur "npx wrangler deploy" / Workers + Static Assets).
 *
 * Routes propres : /api/snb-catalog, /api/snb-index et /api/ofs-index (index de recherche des onglets BNS et OFS, mémorisés
 * dans la base D1 partagée et complétés en arrière-plan par le cron), /api/index-status, /api/db/... (graphiques partagés).
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

  /* Langue : le catalogue DAM de l'OFS choisit la langue des titres d'après l'en-tête Accept-Language (le paramètre
     « language » ne filtre que la langue des fichiers). On transmet donc l'en-tête du navigateur, ou on le déduit du
     paramètre « language » quand il est présent (ex. /api/ofs-dam?language=fr). */
  const qLang = url.searchParams.get('language');
  const acceptLang = (qLang && /^(de|fr|it|en)$/i.test(qLang)) ? qLang.toLowerCase() : request.headers.get('Accept-Language');
  const init = {method: request.method, headers: {}};
  if (acceptLang) init.headers['Accept-Language'] = acceptLang;
  if (request.method === 'POST') {
    init.body = await request.text();
    init.headers['Content-Type'] = request.headers.get('Content-Type') || 'application/json';
  }

  /* Réponses GET rarement modifiées (métadonnées OFS, séries BNS) : servies depuis D1 si assez récentes. */
  const cacheKey = (ttlMs && request.method === 'GET' && env && env.DB) ? 'relay:' + target + '|' + (acceptLang || '') : null;
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

/* ----------------------------------------------------------------------------------------------
 * Index de recherche (BNS : /api/snb-index, OFS : /api/ofs-index) — alimentent les onglets « BNS » et « OFS ».
 * Chaque entrée (un cube BNS, une table OFS) est construite à partir d'appels aux API d'origine puis gardée
 * dans D1 (table api_cache), partagée par tous les visiteurs :
 *   - ?ids=… / ?offset=…&limit=… : construit (ou relit depuis D1) un petit lot — utilisé pour les entrées manquantes ;
 *   - ?bulk=1 : renvoie EN UNE REQUÊTE tout ce qui est déjà en D1 (+ la liste des identifiants manquants) — c'est ce
 *     qui rend l'ouverture des onglets instantanée pour tout le monde dès que l'index est complet ;
 *   - le cron (voir scheduled) complète l'index en arrière-plan, par petits lots, sans attendre qu'un visiteur le fasse.
 * Tout est « au mieux » : si D1 est indisponible, les appels vont directement à la BNS / l'OFS (comme avant).
 * ---------------------------------------------------------------------------------------------- */

const INDEX_FRESH_MS = 14 * DAY;   /* au-delà, l'entrée est reconstruite (par le cron ou un visiteur) */
const SNB_PREFIX = 'snb_meta/fr/';
const ofsPrefix = lang => 'ofs_meta/' + lang + '/';

/* Lecture groupée de quelques clés (une seule requête D1). */
async function cacheGetMany(env, keys) {
  const out = new Map();
  if (!env.DB || !keys.length) return out;
  try {
    await ensureSchema(env.DB);
    const rs = await env.DB.prepare('SELECT k, data, fetched_at FROM api_cache WHERE k IN (' + keys.map(() => '?').join(',') + ')').bind(...keys).all();
    rs.results.forEach(r => out.set(r.k, {data: r.data, age: Date.now() - r.fetched_at}));
  } catch (e) {}
  return out;
}
/* Toutes les lignes dont la clé commence par `prefix` (qui se termine par « / ») ; withData=false : clés et âges seulement. */
async function cacheRange(env, prefix, withData) {
  if (!env.DB) return [];
  try {
    await ensureSchema(env.DB);
    const hi = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rs = await env.DB.prepare('SELECT k, ' + (withData ? 'data, ' : '') + 'fetched_at FROM api_cache WHERE k >= ? AND k < ?').bind(prefix, hi).all();
    return rs.results.map(r => ({id: decodeURIComponent(r.k.slice(prefix.length)), data: r.data, age: Date.now() - r.fetched_at}));
  } catch (e) { return []; }
}
async function cachePutMany(env, rows) {
  try {
    if (!env.DB || !rows.length) return;
    await ensureSchema(env.DB);
    const now = Date.now();
    await env.DB.batch(rows.filter(r => r.data.length <= CACHE_MAX_BYTES).map(r =>
      env.DB.prepare('INSERT INTO api_cache (k, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at').bind(r.k, r.data, now)));
  } catch (e) {}
}

async function snbJson(url, headers) {
  try {
    const r = await fetch(url, {headers: Object.assign({Accept: 'application/json'}, headers || {}), signal: AbortSignal.timeout(15000)});
    if (!r.ok) return {status: r.status, json: null};
    return {status: r.status, json: await r.json()};
  } catch (e) {
    return {status: 0, json: null};
  }
}

/* ---------------- BNS ---------------- */
function snbPageViewTime() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '_' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}
function snbDimNames(dims) {
  const out = [], seen = new Set();
  let leaves = 0;
  (function walk(items) {
    (items || []).forEach(it => {
      const n = String(it.name || '').trim();
      const kids = it.dimensionItems || [];
      if (!kids.length) leaves++;
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
      walk(kids);
    });
  })((dims && dims.dimensions) || []);
  return {kw: out.join(' · ').slice(0, 900), leaves};
}
/* Titre / domaine / unité / fréquence (API interne du portail, exige « x-epb-ajax »), libellés des séries (= mots-clés)
   et date de dernière publication. Renvoie null si rien d'exploitable n'a pu être lu (non mis en cache, à retenter). */
async function snbBuildEntry(c, lang) {
  const enc = encodeURIComponent(c.id);
  const [info, dims, upd] = await Promise.all([
    snbJson('https://data.snb.ch/json/table/getCubeInfo?lang=' + lang + '&cubeId=' + enc + '&isWarehouse=false&pageViewTime=' + snbPageViewTime(), {'x-epb-ajax': 'true'}),
    snbJson('https://data.snb.ch/api/cube/' + enc + '/dimensions/' + lang),
    snbJson('https://data.snb.ch/api/cube/' + enc + '/lastUpdate')
  ]);
  const i = info.json || {}, d = snbDimNames(dims.json), u = upd.json || {};
  const gone = dims.status === 404 || dims.status === 410;
  const entry = {
    id: c.id, topic: c.topic, domaine: c.domaine,
    title: String(i.title || '').trim(),
    cat: String(i.publishingTitle || '').trim(),
    unit: String(i.unit || '').trim(),
    freq: String(i.frequencySpecification || '').trim(),
    upd: String(u.publicSinceDate || u.editionDate || ''),
    kw: d.kw, n: d.leaves, gone
  };
  return {entry, cacheable: !!(dims.json || gone)};
}
async function snbCatalogList(env, ctx) {
  const resp = await snbCatalog(env, ctx);
  if (!resp.ok) return null;
  try { return (await resp.json()).publication || []; } catch (e) { return null; }
}
async function snbIndex(url, env, ctx) {
  const lang = 'fr'; /* l'index est mémorisé en français (langue de l'interface) */
  const all = await snbCatalogList(env, ctx);
  if (!all) return jsonBody(JSON.stringify({error_message: 'Catalogue BNS indisponible.'}), 502);

  /* Lecture groupée : tout ce que D1 connaît déjà + identifiants encore manquants (ou périmés). */
  if (url.searchParams.get('bulk')) {
    const rows = await cacheRange(env, SNB_PREFIX, true);
    const have = new Set(rows.filter(r => r.age < INDEX_FRESH_MS).map(r => r.id));
    const missing = all.filter(c => !have.has(c.id)).map(c => c.id);
    const inCat = new Set(all.map(c => c.id));
    const body = '{"total":' + all.length + ',"missing":' + JSON.stringify(missing) + ',"entries":[' + rows.filter(r => inCat.has(r.id)).map(r => r.data).join(',') + ']}';
    return jsonBody(body, 200, {'Cache-Control': 'no-cache'});
  }

  let slice;
  const idsParam = url.searchParams.get('ids');
  if (idsParam) {
    const want = new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean));
    slice = all.filter(c => want.has(c.id)).slice(0, 15);
  } else {
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.min(15, Math.max(1, parseInt(url.searchParams.get('limit') || '15', 10) || 15));
    slice = all.slice(offset, offset + limit);
  }
  const cached = await cacheGetMany(env, slice.map(c => SNB_PREFIX + encodeURIComponent(c.id)));
  const entries = new Array(slice.length), toWrite = [];
  await Promise.all(slice.map(async (c, i) => {
    const hit = cached.get(SNB_PREFIX + encodeURIComponent(c.id));
    if (hit && hit.age < INDEX_FRESH_MS) { try { entries[i] = JSON.parse(hit.data); return; } catch (e) {} }
    try {
      const r = await snbBuildEntry(c, lang);
      entries[i] = r.entry;
      if (r.cacheable) toWrite.push({k: SNB_PREFIX + encodeURIComponent(c.id), data: JSON.stringify(r.entry)});
    } catch (e) { entries[i] = {id: c.id, topic: c.topic, domaine: c.domaine}; }
  }));
  if (toWrite.length) ctx.waitUntil(cachePutMany(env, toWrite));
  const offset = idsParam ? 0 : Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  return jsonBody(JSON.stringify({total: all.length, offset, lang, entries}), 200, {'Cache-Control': 'no-cache'});
}

/* ---------------- OFS ---------------- */
async function ofsBuildEntry(id, lang) {
  const base = 'https://www.pxweb.bfs.admin.ch/api/v1/';
  const enc = encodeURIComponent(id);
  let usedLang = lang, list = await snbJson(base + lang + '/' + enc);
  if (!list.json && list.status === 404 && lang !== 'de') { usedLang = 'de'; list = await snbJson(base + 'de/' + enc); }
  const meta = await snbJson(base + usedLang + '/' + enc + '/' + enc + '.px');
  if (!list.json && !meta.json) return {entry: {id, err: list.status || meta.status || 0}, cacheable: false};
  const tbl = Array.isArray(list.json) ? (list.json.find(x => x.type === 't') || list.json[0] || {}) : {};
  const vars = (meta.json && meta.json.variables) || [];
  const kw = [];
  vars.forEach(v => {
    kw.push(v.text || v.code);
    if (v.time) return;
    (v.valueTexts || []).slice(0, 40).forEach(t => { if (t && !/^\d+$/.test(t)) kw.push(t); });
  });
  const timeVar = vars.find(v => v.time);
  const entry = {
    id, lang: usedLang,
    title: String(tbl.text || (meta.json && meta.json.title) || '').trim(),
    updated: String(tbl.updated || ''),
    dims: vars.map(v => v.text || v.code).join(' · '),
    kw: Array.from(new Set(kw)).join(' · ').slice(0, 1200),
    t0: timeVar && timeVar.values ? timeVar.values[0] : '',
    t1: timeVar && timeVar.values ? timeVar.values[timeVar.values.length - 1] : ''
  };
  return {entry, cacheable: !!(list.json && meta.json)};
}
/* Identifiants de toutes les tables chiffrées (catalogue DAM, ~6 pages de 200), gardés 7 jours dans D1. */
async function ofsCatalogIds(env) {
  const hit = await cacheGet(env, 'ofs_ids_v1');
  if (hit && hit.age < 7 * DAY) { try { return JSON.parse(hit.data); } catch (e) {} }
  try {
    const ids = [];
    let skip = 0, total = Infinity;
    for (let page = 0; page < 15 && skip < total; page++) {
      const qs = new URLSearchParams({language: 'fr', articleModelGroup: '900029', articleModel: '900033', limit: '200', skip: String(skip)});
      const r = await fetch('https://dam-api.bfs.admin.ch/hub/api/dam/assets?' + qs.toString(), {headers: {'Accept-Language': 'fr', Accept: 'application/json'}, signal: AbortSignal.timeout(20000)});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      total = typeof j.total === 'number' ? j.total : Infinity;
      const batch = j.data || [];
      batch.forEach(it => { if (it && it.shop && it.shop.orderNr) ids.push(it.shop.orderNr); });
      if (!batch.length) break;
      skip += batch.length;
    }
    if (ids.length) await cachePut(env, 'ofs_ids_v1', JSON.stringify(ids));
    return ids;
  } catch (e) {
    if (hit) { try { return JSON.parse(hit.data); } catch (e2) {} }
    return null;
  }
}
async function ofsIndex(url, env, ctx) {
  const lang = ['fr', 'de', 'it', 'en'].indexOf(url.searchParams.get('lang')) >= 0 ? url.searchParams.get('lang') : 'fr';
  const pfx = ofsPrefix(lang);

  if (url.searchParams.get('bulk')) {
    const rows = await cacheRange(env, pfx, true);
    return jsonBody('{"lang":"' + lang + '","entries":[' + rows.map(r => r.data).join(',') + ']}', 200, {'Cache-Control': 'no-cache'});
  }

  const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(s => /^px-x-[0-9A-Za-z_]+$/.test(s)).slice(0, 10);
  const cached = await cacheGetMany(env, ids.map(id => pfx + encodeURIComponent(id)));
  const entries = new Array(ids.length), toWrite = [];
  let k = 0, hits = 0;
  async function worker() {
    while (k < ids.length) {
      const i = k++, id = ids[i];
      const hit = cached.get(pfx + encodeURIComponent(id));
      if (hit && hit.age < INDEX_FRESH_MS) { try { entries[i] = JSON.parse(hit.data); hits++; continue; } catch (e) {} }
      try {
        const r = await ofsBuildEntry(id, lang);
        entries[i] = r.entry;
        if (r.cacheable) toWrite.push({k: pfx + encodeURIComponent(id), data: JSON.stringify(r.entry)});
      } catch (e) { entries[i] = {id, err: 0}; }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (toWrite.length) ctx.waitUntil(cachePutMany(env, toWrite));
  return jsonBody(JSON.stringify({lang, entries, hits}), 200, {'Cache-Control': 'no-store'});
}

/* ---------------- Complétion de l'index en arrière-plan (cron) + état ----------------
   Un passage = soit un lot de tables OFS (≤ 10, soit 20 sous-requêtes), soit un lot de cubes BNS (≤ 12, soit 36), pour rester
   sous la limite de 50 sous-requêtes d'un passage ; les deux sources alternent. Priorité : entrées manquantes, puis périmées. */
async function indexStatus(env, ctx) {
  const ofsIds = await ofsCatalogIds(env);
  const snb = await snbCatalogList(env, ctx);
  const ofsHave = new Map((await cacheRange(env, ofsPrefix('fr'), false)).map(r => [r.id, r.age]));
  const snbHave = new Map((await cacheRange(env, SNB_PREFIX, false)).map(r => [r.id, r.age]));
  const plan = (list, have) => {
    const ids = list || [];
    const missing = ids.filter(id => !have.has(id));
    const stale = ids.filter(id => have.has(id) && have.get(id) > INDEX_FRESH_MS).sort((a, b) => have.get(b) - have.get(a));
    return {total: ids.length, indexed: ids.length - missing.length, missing, stale};
  };
  return {ofs: plan(ofsIds, ofsHave), snb: plan(snb && snb.map(c => c.id), snbHave), snbList: snb || []};
}
async function warmIndexBatch(env, ctx, preferSnb) {
  if (!env.DB) return {error: 'D1 absente'};
  const st = await indexStatus(env, ctx);
  const todoOf = p => p.missing.concat(p.stale);
  const order = preferSnb ? ['snb', 'ofs'] : ['ofs', 'snb'];
  for (const kind of order) {
    const todo = todoOf(st[kind]);
    if (!todo.length) continue;
    const rows = [];
    if (kind === 'ofs') {
      const batch = todo.slice(0, 10);
      let k = 0;
      const worker = async () => { while (k < batch.length) { const id = batch[k++]; try { const r = await ofsBuildEntry(id, 'fr'); if (r.cacheable) rows.push({k: ofsPrefix('fr') + encodeURIComponent(id), data: JSON.stringify(r.entry)}); } catch (e) {} } };
      await Promise.all([worker(), worker(), worker()]);
    } else {
      const byId = new Map(st.snbList.map(c => [c.id, c]));
      const batch = todo.slice(0, 12).map(id => byId.get(id)).filter(Boolean);
      for (let i = 0; i < batch.length; i += 4) {
        await Promise.all(batch.slice(i, i + 4).map(async c => { try { const r = await snbBuildEntry(c, 'fr'); if (r.cacheable) rows.push({k: SNB_PREFIX + encodeURIComponent(c.id), data: JSON.stringify(r.entry)}); } catch (e) {} }));
      }
    }
    await cachePutMany(env, rows);
    return {kind, processed: rows.length, remaining: todo.length - rows.length};
  }
  return {kind: null, remaining: 0};
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
    db.prepare('CREATE TABLE IF NOT EXISTS api_cache (k TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL)')
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
const KV_KEYS = ['wb_categories', 'mkt_watchlist'];
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


/* ----------------------------------------------------------------------------------------------
 * Market Data (/api/tv/...) — relais vers l'API tierce « TradingView Data API » (api.tradingviewapi.com,
 * clés gérées sur console.tvapis.com). La clé n'est JAMAIS envoyée au navigateur : elle vit dans le secret
 * Worker TV_API_KEY ("npx wrangler secret put TV_API_KEY"). Pour ménager le quota mensuel du forfait :
 *   - cache D1 partagé (cotes 60 s, bougies intrajournalières 60 s, journalières 15 min, hebdo/mensuelles 1 h,
 *     recherche de symboles 24 h) — tous les collègues partagent les mêmes réponses ;
 *   - compteur d'appels réellement envoyés à l'amont (clé D1 tv_usage_AAAA-MM) et plafond TV_MONTHLY_CAP
 *     (défaut 30 000, modifiable par variable) : au-delà, seul le cache est servi ;
 *   - seules les requêtes issues du site lui-même sont acceptées (en-tête Origin / Sec-Fetch-Site).
 * GET /api/tv/status -> {configured, used, cap, month}   (sans appel amont)
 * ---------------------------------------------------------------------------------------------- */
const TV_BASE = 'https://api.tradingviewapi.com/api';
const TV_ALLOWED = /^(search\/market\/[^/]+|price\/[^/]+|quote\/[^/]+|options\/[^/]+|etf\/[^/]+|quote\/batch|price\/batch)$/;
function tvMonth() { return new Date().toISOString().slice(0, 7); }
function tvTtl(sub, url, method) {
  if (sub.startsWith('search/')) return 24 * 3600 * 1000;
  if (sub.startsWith('quote') || sub.startsWith('options') || sub.startsWith('etf')) return 60 * 1000;
  if (sub.startsWith('price')) {
    const tf = url.searchParams.get('timeframe') || '5';
    if (method === 'POST') return 60 * 1000;
    if (tf === 'D') return 15 * 60 * 1000;
    if (tf === 'W' || tf === 'M') return 3600 * 1000;
    return 60 * 1000;
  }
  return 60 * 1000;
}
function tvJson(obj, status) {
  return new Response(JSON.stringify(obj), {status: status || 200, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
}
async function tvUsage(env) {
  try {
    await ensureSchema(env.DB);
    const r = await env.DB.prepare('SELECT data FROM kv_store WHERE k = ?').bind('tv_usage_' + tvMonth()).first();
    return r ? (parseInt(r.data, 10) || 0) : 0;
  } catch (e) { return 0; }
}
async function tvCount(env) {
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare("INSERT INTO kv_store (k, data, updated_at) VALUES (?, '1', ?) ON CONFLICT(k) DO UPDATE SET data = CAST(CAST(data AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at")
      .bind('tv_usage_' + tvMonth(), new Date().toISOString()).run();
  } catch (e) {}
}
async function tvProxy(request, env, ctx) {
  const url = new URL(request.url);
  const sub = url.pathname.replace(/^\/api\/tv\/?/, '');
  const cap = parseInt(env.TV_MONTHLY_CAP, 10) || 30000;
  /* Même origine uniquement (le Worker est public : sans cela, n'importe qui pourrait consommer le quota). */
  const origin = request.headers.get('Origin');
  const sfs = request.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== url.origin) || (sfs && sfs !== 'same-origin' && sfs !== 'none')) {
    return tvJson({error_message: 'Market Data : requête refusée (origine différente du site).'}, 403);
  }
  if (request.method === 'OPTIONS') return new Response(null, {status: 204});
  if (sub === 'status') {
    return tvJson({configured: !!env.TV_API_KEY, used: await tvUsage(env), cap: cap, month: tvMonth()});
  }
  if (!env.TV_API_KEY) {
    return tvJson({error_code: 'NO_KEY', error_message: 'Clé API Market Data non configurée sur le Worker (npx wrangler secret put TV_API_KEY).'}, 503);
  }
  if (!TV_ALLOWED.test(sub) || (request.method !== 'GET' && !(request.method === 'POST' && /\/batch$/.test(sub)))) {
    return tvJson({error_message: 'Route Market Data non autorisée.'}, 404);
  }
  const target = TV_BASE + '/' + sub + url.search;
  const body = request.method === 'POST' ? await request.text() : null;
  const ttl = tvTtl(sub, url, request.method);
  const cacheKey = 'tv:' + request.method + ':' + sub + url.search + (body ? '|' + body : '');
  const hit = await cacheGet(env, cacheKey);
  if (hit && hit.age < ttl) return new Response(hit.data, {status: 200, headers: {'Content-Type': 'application/json', 'X-GIP-Cache': 'HIT', 'Cache-Control': 'no-store'}});
  if (await tvUsage(env) >= cap) {
    if (hit) return new Response(hit.data, {status: 200, headers: {'Content-Type': 'application/json', 'X-GIP-Cache': 'STALE-CAP', 'Cache-Control': 'no-store'}});
    return tvJson({error_code: 'CAP', error_message: 'Plafond mensuel d\'appels Market Data atteint (' + cap + ') — modifiable via la variable TV_MONTHLY_CAP.'}, 429);
  }
  let up;
  try {
    const init = {method: request.method, headers: {Authorization: 'Bearer ' + env.TV_API_KEY, Accept: 'application/json'}};
    if (body) { init.body = body; init.headers['Content-Type'] = 'application/json'; }
    await tvCount(env);
    up = await fetch(target, init);
  } catch (e) {
    if (hit) return new Response(hit.data, {status: 200, headers: {'Content-Type': 'application/json', 'X-GIP-Cache': 'STALE', 'Cache-Control': 'no-store'}});
    return tvJson({error_message: 'Market Data : échec de connexion à l\'API (' + e.message + ')'}, 502);
  }
  const text = await up.text();
  if (up.status === 200 && ctx) {
    let ok = true; try { ok = JSON.parse(text).success !== false; } catch (e) { ok = false; }
    if (ok) ctx.waitUntil(cachePut(env, cacheKey, text));
  }
  if (up.status === 401 || up.status === 403) return tvJson({error_code: 'BAD_KEY', error_message: 'Clé Market Data refusée par le fournisseur (vérifiez TV_API_KEY et votre forfait sur console.tvapis.com).'}, 502);
  return new Response(text, {status: up.status, headers: {'Content-Type': up.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store'}});
}

/* Ordre important : les préfixes les plus spécifiques d'abord (aucun souci ici, les 4 préfixes
   sont mutuellement exclusifs). */
const ROUTES = [
  {prefix: '/api/fred', target: 'https://api.stlouisfed.org/fred', methods: ['GET']},
  {prefix: '/api/ofs-dam', target: 'https://dam-api.bfs.admin.ch/hub/api/dam/assets', methods: ['GET'], noSubPath: true, ttlMs: 24 * 3600 * 1000}, /* catalogue des tables : relu au plus une fois par jour */
  {prefix: '/api/ofs-pxweb', target: 'https://www.pxweb.bfs.admin.ch/api/v1', methods: ['GET', 'POST'], ttlMs: 7 * 24 * 3600 * 1000}, /* GET = métadonnées de table (stables) ; les POST de données ne sont jamais mis en cache */
  {prefix: '/api/snb', target: 'https://data.snb.ch/api/cube', methods: ['GET'], ttlMs: 6 * 3600 * 1000}
];

export default {
  /* Cron (voir wrangler.jsonc) : complète l'index de recherche OFS / BNS d'un petit lot à chaque passage (les deux sources alternent). */
  async scheduled(event, env, ctx){
    const preferSnb = Math.floor((event.scheduledTime || Date.now()) / 120000) % 2 === 1;
    ctx.waitUntil(warmIndexBatch(env, ctx, preferSnb).catch(() => {}));
  },

  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if (url.pathname === '/api/snb-catalog') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      return snbCatalog(env, ctx);
    }
    if (url.pathname === '/api/snb-index') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      return snbIndex(url, env, ctx);
    }
    if (url.pathname === '/api/ofs-index') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      return ofsIndex(url, env, ctx);
    }
    /* État de l'index (GET) ; ?run=1 fait avancer un lot à la demande (protégé par la clé d'équipe si elle est définie). */
    if (url.pathname === '/api/index-status') {
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: corsHeaders()});
      try {
        if (url.searchParams.get('run')) {
          const keyOk = writeAllowed(request, env) || (env.GIP_WRITE_KEY && url.searchParams.get('key') === env.GIP_WRITE_KEY);
          if (!keyOk) return jsonResponse({error_message: "Clé d'équipe manquante ou invalide."}, 401);
          return jsonResponse(await warmIndexBatch(env, ctx, url.searchParams.get('run') === 'snb'));
        }
        const st = await indexStatus(env, ctx);
        return jsonResponse({ofs: {total: st.ofs.total, indexed: st.ofs.indexed, stale: st.ofs.stale.length}, snb: {total: st.snb.total, indexed: st.snb.indexed, stale: st.snb.stale.length}});
      } catch (e) { return jsonResponse({error_message: 'État indisponible (' + e.message + ').'}, 500); }
    }
    if (url.pathname === '/api/tv' || url.pathname.startsWith('/api/tv/')) return tvProxy(request, env, ctx);
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
