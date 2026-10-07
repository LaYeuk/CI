#!/usr/bin/env node
/*
 * prepare_data.mjs — prépare les classeurs Excel publiés sur le site (aucune dépendance : Node ≥ 18 suffit).
 *
 * Usage (depuis la racine du dépôt CI) :
 *     1. déposer les classeurs à jour dans le dossier  data_source/   (ex. « R2 Data.xlsx », « Copy fixed Cycle and ESI.xlsx »)
 *     2. node prepare_data.mjs
 *     3. git add data && git commit -m "Mise à jour des données" && git push   (puis déploiement, voir LISEZMOI.txt)
 *
 * Le script reconnaît chaque classeur à ses feuilles :
 *   - contient une feuille « Copy Risk Map »  -> AM Dashboard : on ne garde QUE cette feuille (+ ses graphiques) ;
 *     le gros classeur d'origine (~90 Mo, 485 Mo décompressé) devient un fichier d'environ 1 à 3 Mo, lu en quelques secondes ;
 *   - sinon (« Monthly data », « Weekly data »…) -> Chart Pack : toutes les feuilles sont gardées, seul l'index de calcul
 *     d'Excel (calcChain, inutile pour la lecture) est retiré.
 * Les originaux ne sont jamais modifiés. Résultat dans data/ : R2_Data.xlsx, Risk_Map.xlsx et manifest.json
 * (le site lit manifest.json pour savoir quoi charger ; la limite de Cloudflare est de 25 Mo par fichier).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const SRC_DIR = process.argv[2] || 'data_source';
const OUT_DIR = 'data';
const LIMIT = 24 * 1024 * 1024;

/* ---------- lecture / écriture ZIP minimale ---------- */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('fichier ZIP/XLSX invalide');
  const total = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw new Error('ZIP64 non géré');
  const entries = new Map();
  let p = cdOff;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('répertoire ZIP corrompu');
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32);
    const e = {
      flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10), time: buf.readUInt16LE(p + 12), date: buf.readUInt16LE(p + 14),
      crc: buf.readUInt32LE(p + 16), csize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), off: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nameLen)
    };
    entries.set(e.name, e);
    p += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}
function rawData(buf, e) {
  const o = e.off;
  if (buf.readUInt32LE(o) !== 0x04034b50) throw new Error('en-tête local invalide : ' + e.name);
  return buf.subarray(o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28), o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28) + e.csize);
}
function text(buf, e) { return (e.method === 0 ? rawData(buf, e) : zlib.inflateRawSync(rawData(buf, e))).toString('utf8'); }
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function writeZip(items) { /* items: [{name, method, flags, time, date, crc, csize, size, data(compressed bytes)}] */
  const parts = [], central = [];
  let off = 0;
  for (const it of items) {
    const name = Buffer.from(it.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE((it.flags & ~8) | 0x800, 6); lh.writeUInt16LE(it.method, 8);
    lh.writeUInt16LE(it.time, 10); lh.writeUInt16LE(it.date, 12); lh.writeUInt32LE(it.crc, 14); lh.writeUInt32LE(it.csize, 18); lh.writeUInt32LE(it.size, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, it.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE((it.flags & ~8) | 0x800, 8); ch.writeUInt16LE(it.method, 10);
    ch.writeUInt16LE(it.time, 12); ch.writeUInt16LE(it.date, 14); ch.writeUInt32LE(it.crc, 16); ch.writeUInt32LE(it.csize, 20); ch.writeUInt32LE(it.size, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + it.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

/* ---------- XML (expressions régulières suffisantes pour workbook.xml / .rels / [Content_Types].xml) ---------- */
const attr = (tag, n) => { const m = new RegExp('\\b' + n + '="([^"]*)"').exec(tag); return m ? m[1] : null; };
const unesc = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
function resolvePart(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = baseDir ? baseDir.split('/') : [];
  target.split('/').forEach(s => { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); });
  return out.join('/');
}
const relsOf = part => { const i = part.lastIndexOf('/'); return (i < 0 ? '' : part.slice(0, i + 1)) + '_rels/' + part.slice(i + 1) + '.rels'; };
const dirOf = part => { const i = part.lastIndexOf('/'); return i < 0 ? '' : part.slice(0, i); };

function inspect(buf, entries) {
  const wb = text(buf, entries.get('xl/workbook.xml'));
  const rels = text(buf, entries.get('xl/_rels/workbook.xml.rels'));
  const relMap = {};
  (rels.match(/<Relationship\b[^>]*>/g) || []).forEach(t => { relMap[attr(t, 'Id')] = {type: attr(t, 'Type') || '', target: attr(t, 'Target') || '', tag: t}; });
  const sheets = (wb.match(/<sheet\b[^>]*>/g) || []).map(t => {
    const rid = attr(t, 'r:id'), r = relMap[rid];
    return {name: unesc(attr(t, 'name') || ''), rid, part: r ? resolvePart('xl', r.target) : null, tag: t};
  });
  return {wb, rels, relMap, sheets};
}

function buildSlim(buf, mode, riskName) {
  const entries = readZip(buf);
  const info = inspect(buf, entries);
  const keep = new Set();
  const drop = new Set();
  const calc = Object.values(info.relMap).filter(r => /\/calcChain$/.test(r.type)).map(r => resolvePart('xl', r.target));
  calc.forEach(p => drop.add(p));
  let keptSheets = info.sheets;

  if (mode === 'riskmap') {
    const target = info.sheets.find(s => s.name.trim().toLowerCase() === 'copy risk map') || info.sheets.find(s => /copy.*risk.*map/i.test(s.name));
    keptSheets = [target];
    const q = [target.part];
    while (q.length) {                    /* fermeture : la feuille, son dessin, ses graphiques, images… */
      const part = q.pop();
      if (keep.has(part)) continue;
      keep.add(part);
      const rp = relsOf(part);
      if (!entries.has(rp)) continue;
      keep.add(rp);
      (text(buf, entries.get(rp)).match(/<Relationship\b[^>]*>/g) || []).forEach(t => {
        if (/External/i.test(attr(t, 'TargetMode') || '')) return;
        const p = resolvePart(dirOf(part), attr(t, 'Target') || '');
        if (entries.has(p)) q.push(p);
      });
    }
    ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'].forEach(p => keep.add(p));
    Object.values(info.relMap).forEach(r => {     /* styles, thème, chaînes partagées… (tout sauf feuilles, calcChain, liens externes) */
      if (/\/(worksheet|chartsheet|dialogsheet|calcChain|externalLink)$/.test(r.type)) return;
      keep.add(resolvePart('xl', r.target));
    });
    if (entries.has('_rels/.rels')) (text(buf, entries.get('_rels/.rels')).match(/<Relationship\b[^>]*>/g) || []).forEach(t => keep.add(resolvePart('', attr(t, 'Target') || '')));
    entries.forEach((e, name) => { if (!keep.has(name)) drop.add(name); });
  } else {
    entries.forEach((e, name) => { if (!drop.has(name)) keep.add(name); });
  }

  /* workbook.xml : on retire les feuilles supprimées, les noms définis (peuvent viser des feuilles absentes) et les liens externes */
  let wb = info.wb;
  const keepRid = new Set(keptSheets.map(s => s.rid));
  info.sheets.forEach(s => { if (!keepRid.has(s.rid)) wb = wb.replace(s.tag, ''); });
  if (mode === 'riskmap') {
    wb = wb.replace(/<definedNames>[\s\S]*?<\/definedNames>/, '').replace(/<externalReferences>[\s\S]*?<\/externalReferences>/, '');
    wb = wb.replace(/\bactiveTab="\d+"/, 'activeTab="0"').replace(/\bfirstSheet="\d+"/, 'firstSheet="0"');
  }
  /* rels du classeur : retirer les liens vers les parties supprimées */
  let rels = info.rels;
  Object.values(info.relMap).forEach(r => { if (drop.has(resolvePart('xl', r.target)) || (/\/worksheet$/.test(r.type) && !keep.has(resolvePart('xl', r.target)))) rels = rels.replace(r.tag, ''); });
  /* types de contenu : retirer les « Override » des parties supprimées */
  let ct = text(buf, entries.get('[Content_Types].xml'));
  (ct.match(/<Override\b[^>]*>/g) || []).forEach(t => { const pn = (attr(t, 'PartName') || '').replace(/^\//, ''); if (drop.has(pn) || (!keep.has(pn))) ct = ct.replace(t, ''); });

  const replaced = {'xl/workbook.xml': wb, 'xl/_rels/workbook.xml.rels': rels, '[Content_Types].xml': ct};
  const items = [];
  entries.forEach((e, name) => {
    if (!keep.has(name) || drop.has(name)) return;
    if (replaced[name] !== undefined) {
      const raw = Buffer.from(replaced[name], 'utf8'), z = zlib.deflateRawSync(raw);
      items.push({name, method: 8, flags: e.flags, time: e.time, date: e.date, crc: crc32(raw), csize: z.length, size: raw.length, data: z});
    } else {
      items.push({name, method: e.method, flags: e.flags, time: e.time, date: e.date, crc: e.crc, csize: e.csize, size: e.size, data: rawData(buf, e)});
    }
  });
  items.sort((a, b) => (a.name === '[Content_Types].xml' ? -1 : b.name === '[Content_Types].xml' ? 1 : 0));
  return {zip: writeZip(items), sheetNames: info.sheets.map(s => s.name), kept: keptSheets.map(s => s.name), dropped: [...drop].length};
}

/* ---------- programme principal ---------- */
function kindOf(sheetNames) {
  if (sheetNames.some(n => /^copy\s*risk\s*map\s*$/i.test(n.trim()))) return 'riskmap';
  if (sheetNames.some(n => /monthly|weekly/i.test(n))) return 'base';
  return null;
}
const OUT = {base: {file: 'R2_Data.xlsx', name: 'R2 Data.xlsx'}, riskmap: {file: 'Risk_Map.xlsx', name: 'Risk Map (feuille « Copy Risk Map »)'}};

if (!fs.existsSync(SRC_DIR)) { console.error(`Dossier introuvable : ${SRC_DIR}\nCréez-le et déposez-y vos classeurs Excel (voir l'en-tête de ce script).`); process.exit(1); }
fs.mkdirSync(OUT_DIR, {recursive: true});
const manifestPath = path.join(OUT_DIR, 'manifest.json');
let manifest = {files: {}};
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); if (!manifest.files) manifest.files = {}; } catch (e) {}

const files = fs.readdirSync(SRC_DIR).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
if (!files.length) { console.error(`Aucun .xlsx dans ${SRC_DIR}.`); process.exit(1); }
let problems = 0;
for (const f of files) {
  const src = path.join(SRC_DIR, f);
  process.stdout.write(`• ${f} (${(fs.statSync(src).size / 1048576).toFixed(1)} Mo) … `);
  try {
    const buf = fs.readFileSync(src);
    const info = inspect(buf, readZip(buf));
    const kind = kindOf(info.sheets.map(s => s.name));
    if (!kind) { console.log(`type non reconnu (feuilles : ${info.sheets.map(s => s.name).join(', ')}) — ignoré.`); problems++; continue; }
    const res = buildSlim(buf, kind);
    const out = OUT[kind];
    fs.writeFileSync(path.join(OUT_DIR, out.file), res.zip);
    const hash = crypto.createHash('sha1').update(res.zip).digest('hex').slice(0, 10);
    manifest.files[kind] = {file: out.file, name: out.name, size: res.zip.length, hash, updated: new Date().toISOString(), source: f};
    const mb = (res.zip.length / 1048576).toFixed(1);
    console.log(`${kind === 'riskmap' ? 'AM Dashboard' : 'Chart Pack'} -> ${OUT_DIR}/${out.file} (${mb} Mo, feuilles gardées : ${res.kept.join(' | ')})`);
    if (res.zip.length > LIMIT) { console.log(`  ⚠ ${mb} Mo : trop gros pour Cloudflare (25 Mo max par fichier).`); problems++; }
  } catch (e) { console.log('ERREUR : ' + e.message); problems++; }
}
manifest.generated = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\n${manifestPath} mis à jour. Étape suivante : git add data && git commit && git push.`);
process.exit(problems ? 2 : 0);
