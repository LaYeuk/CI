// Cloudflare Pages Function — relais FRED (Federal Reserve Bank of St. Louis)
// Route : /api/fred/<chemin FRED>?<paramètres>
//   ex. /api/fred/series/observations?series_id=DGS10&observation_start=2020-01-01
//   -> https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&...&api_key=***&file_type=json
// La clé API reste côté serveur : variable d'environnement FRED_API_KEY
// (Cloudflare Pages > Settings > Environment variables, en "Secret").

const UPSTREAM = "https://api.stlouisfed.org/fred/";
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

export async function onRequestGet({ request, params, env }) {
  if (!env.FRED_API_KEY) {
    return json({ error: "FRED_API_KEY non configurée sur Cloudflare Pages" }, 500);
  }

  const segs = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const path = segs.map(encodeURIComponent).join("/");
  if (!path) return json({ error: "Chemin FRED manquant, ex. /api/fred/series/observations?series_id=DGS10" }, 400);

  const inUrl = new URL(request.url);
  const target = new URL(UPSTREAM + path);
  for (const [k, v] of inUrl.searchParams) {
    if (k !== "api_key") target.searchParams.set(k, v);
  }
  target.searchParams.set("api_key", env.FRED_API_KEY);
  if (!target.searchParams.has("file_type")) target.searchParams.set("file_type", "json");

  try {
    const upstream = await fetch(target.toString(), {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
    const headers = new Headers(CORS);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json; charset=utf-8");
    headers.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return json({ error: "Échec de la requête FRED", detail: String(e) }, 502);
  }
}
