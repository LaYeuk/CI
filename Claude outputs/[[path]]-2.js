// Cloudflare Pages Function — relais BNS / SNB data portal
// Route : /api/snb/<chemin data.snb.ch/api>?<paramètres>
//   ex. /api/snb/cube/snbbipo/data/json/fr?fromDate=2020-01
//   ex. /api/snb/cube/rendoblim/data/csv/fr
//   -> https://data.snb.ch/api/cube/snbbipo/data/json/fr?fromDate=2020-01

const UPSTREAM = "https://data.snb.ch/api/";
const CACHE_TTL = 3600; // 1 h

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, params }) {
  const segs = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  if (!segs.length) return json({ error: "Chemin BNS manquant, ex. /api/snb/cube/snbbipo/data/json/fr" }, 400);

  const target = new URL(UPSTREAM + segs.map(encodeURIComponent).join("/"));
  target.search = new URL(request.url).search;

  try {
    const upstream = await fetch(target.toString(), {
      headers: { Accept: request.headers.get("Accept") || "*/*" },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
    const headers = new Headers(CORS);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json; charset=utf-8");
    headers.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return json({ error: "Échec de la requête BNS", detail: String(e) }, 502);
  }
}
