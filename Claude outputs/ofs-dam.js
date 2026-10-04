// Cloudflare Pages Function — relais OFS DAM (Office fédéral de la statistique, API DAM)
// Route : /api/ofs-dam
// Deux façons d'appeler :
//   1) ?path=<chemin relatif à https://dam-api.bfs.admin.ch/hub/api/dam/> (+ autres paramètres transmis)
//        ex. /api/ofs-dam?path=assets&orderNr=cc-d-05.02.08&language=fr
//        ex. /api/ofs-dam?path=assets/32008765/master
//   2) ?url=<URL complète> — limitée aux domaines OFS autorisés ci-dessous
//        ex. /api/ofs-dam?url=https://dam-api.bfs.admin.ch/hub/api/dam/assets/32008765/master

const BASE = "https://dam-api.bfs.admin.ch/hub/api/dam/";
const ALLOWED_HOSTS = new Set(["dam-api.bfs.admin.ch", "www.bfs.admin.ch", "bfs.admin.ch"]);
const CACHE_TTL = 6 * 3600; // 6 h — publications OFS peu fréquentes

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

export async function onRequestGet({ request }) {
  const inUrl = new URL(request.url);
  const qp = inUrl.searchParams;
  let target;

  if (qp.has("url")) {
    try {
      target = new URL(qp.get("url"));
    } catch {
      return json({ error: "Paramètre url invalide" }, 400);
    }
    if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
      return json({ error: `Domaine non autorisé : ${target.hostname}` }, 403);
    }
  } else if (qp.has("path")) {
    const path = qp.get("path").replace(/^\/+/, "");
    if (path.includes("..")) return json({ error: "Chemin invalide" }, 400);
    target = new URL(path, BASE);
    for (const [k, v] of qp) {
      if (k !== "path") target.searchParams.append(k, v);
    }
  } else {
    return json({ error: "Paramètre path ou url requis" }, 400);
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: { Accept: request.headers.get("Accept") || "*/*" },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      redirect: "follow",
    });
    const headers = new Headers(CORS);
    for (const h of ["Content-Type", "Content-Disposition", "Last-Modified"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return json({ error: "Échec de la requête OFS DAM", detail: String(e) }, 502);
  }
}
