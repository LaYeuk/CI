// Cloudflare Pages Function — relais OFS PxWeb (STAT-TAB)
// Route : /api/ofs-pxweb/<chemin PxWeb>
//   GET  /api/ofs-pxweb/fr/px-x-0502010000_101/px-x-0502010000_101.px     -> métadonnées de la table
//   POST /api/ofs-pxweb/fr/px-x-0502010000_101/px-x-0502010000_101.px     -> données (corps JSON PxWeb "query")
//   -> https://www.pxweb.bfs.admin.ch/api/v1/<chemin>
// Si le chemin ne commence pas par une langue (de|fr|it|en), "fr" est ajouté.

const UPSTREAM = "https://www.pxweb.bfs.admin.ch/api/v1/";
const LANGS = new Set(["de", "fr", "it", "en"]);
const CACHE_TTL = 6 * 3600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function buildTarget(request, params) {
  const segs = Array.isArray(params.path) ? [...params.path] : params.path ? [params.path] : [];
  if (!segs.length) return null;
  if (!LANGS.has(segs[0])) segs.unshift("fr");
  const target = new URL(UPSTREAM + segs.map(encodeURIComponent).join("/"));
  target.search = new URL(request.url).search;
  return target;
}

function relay(upstream, cacheable) {
  const headers = new Headers(CORS);
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json; charset=utf-8");
  headers.set("Cache-Control", cacheable ? `public, max-age=${CACHE_TTL}` : "no-store");
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, params }) {
  const target = buildTarget(request, params);
  if (!target) return json({ error: "Chemin PxWeb manquant, ex. /api/ofs-pxweb/fr/px-x-…/px-x-….px" }, 400);
  try {
    const upstream = await fetch(target.toString(), {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
    return relay(upstream, true);
  } catch (e) {
    return json({ error: "Échec de la requête PxWeb", detail: String(e) }, 502);
  }
}

export async function onRequestPost({ request, params }) {
  const target = buildTarget(request, params);
  if (!target) return json({ error: "Chemin PxWeb manquant" }, 400);

  const body = await request.text();
  if (body.length > 100_000) return json({ error: "Requête trop volumineuse" }, 413);

  // Cache manuel des POST (la requête PxWeb est idempotente) : clé = URL + hash du corps
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const cacheKey = new Request(`${target.toString()}${target.search ? "&" : "?"}__q=${hash}`, { method: "GET" });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const upstream = await fetch(target.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
    const res = relay(upstream, upstream.ok);
    if (upstream.ok) await cache.put(cacheKey, res.clone());
    return res;
  } catch (e) {
    return json({ error: "Échec de la requête PxWeb", detail: String(e) }, 502);
  }
}
