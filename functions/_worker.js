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

/* Ordre important : les préfixes les plus spécifiques d'abord (aucun souci ici, les 4 préfixes
   sont mutuellement exclusifs). */
const ROUTES = [
  {prefix: '/api/fred', target: 'https://api.stlouisfed.org/fred', methods: ['GET']},
  {prefix: '/api/ofs-dam', target: 'https://dam-api.bfs.admin.ch/hub/api/dam/assets', methods: ['GET'], noSubPath: true},
  {prefix: '/api/ofs-pxweb', target: 'https://www.pxweb.bfs.admin.ch/api/v1', methods: ['GET', 'POST']},
  {prefix: '/api/snb', target: 'https://data.snb.ch/api/cube', methods: ['GET']}
];

export default {
  async fetch(request, env){
    const url = new URL(request.url);

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

    /* Tout le reste : fichiers statiques du site (Outils_GIP.html, images, etc.). */
    return env.ASSETS.fetch(request);
  }
};
