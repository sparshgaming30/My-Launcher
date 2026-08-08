// core/modrinth.js
// -----------------------------------------------------------------------------
// Direct in-launcher mod & modpack browsing/installing via Modrinth's public
// API (https://docs.modrinth.com/api) — no API key required for search or
// downloads, unlike CurseForge which now requires a paid key for third-party
// apps. If you later get a CurseForge API key, add a parallel curseforge.js
// module with the same three functions (search, getVersions, install) and
// let the UI pick a source.
// -----------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); // still used directly for streamed file downloads
const { retryFetch } = require('./net');
const AdmZip = require('adm-zip');
const { instanceDir, writeInstanceMeta } = require('./instances');

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'custom-mc-launcher/0.1 (contact: you@example.com)' };

/**
 * Search mods or modpacks.
 * @param {string} query
 * @param {{ mcVersion?: string, loader?: string, type: 'mod'|'modpack' }} filters
 */
async function search(query, { mcVersion, loader, type = 'mod' } = {}) {
  const facets = [[`project_type:${type}`]];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (loader && type === 'mod') facets.push([`categories:${loader}`]);

  const url = `${API}/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(
    JSON.stringify(facets)
  )}&limit=20`;

  const res = await retryFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Modrinth search failed: ${res.status}`);
  const data = await res.json();

  return data.hits.map((hit) => ({
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    iconUrl: hit.icon_url,
    downloads: hit.downloads,
    author: hit.author,
    type,
  }));
}

/**
 * Get downloadable versions of a project filtered to a specific MC version
 * + loader, newest first.
 */
async function getVersions(projectId, { mcVersion, loader } = {}) {
  const params = new URLSearchParams();
  if (mcVersion) params.set('game_versions', JSON.stringify([mcVersion]));
  if (loader) params.set('loaders', JSON.stringify([loader]));

  const res = await retryFetch(`${API}/project/${projectId}/version?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Modrinth versions fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Install a single mod jar into an instance's mods/ folder.
 * @param {string} projectId
 * @param {string} instanceIdStr
 * @param {{ mcVersion?: string, loader?: string }} filters
 */
async function installMod(projectId, instanceIdStr, filters = {}) {
  const versions = await getVersions(projectId, filters);
  if (!versions.length) throw new Error('No compatible version found for this MC version/loader.');

  const primaryFile = versions[0].files.find((f) => f.primary) || versions[0].files[0];
  const dir = instanceDir(instanceIdStr);
  const dest = path.join(dir, 'mods', primaryFile.filename);

  await downloadFile(primaryFile.url, dest);
  return { filename: primaryFile.filename, versionNumber: versions[0].version_number };
}

/**
 * Install a full modpack from a Modrinth .mrpack file.
 * .mrpack is just a zip containing:
 *   modrinth.index.json  { name, dependencies: {minecraft, "fabric-loader"|"forge"|"quilt-loader"}, files: [{path, downloads:[url], ...}] }
 *   overrides/            (config files, resource packs, etc. copied as-is)
 *
 * @param {string} mrpackUrl - direct download URL for the .mrpack file
 * @param {string} instanceIdStr - target instance (should be named after the modpack)
 * @param {(progress:{message:string, percent?:number}) => void} onProgress
 */
async function installModpack(mrpackUrl, instanceIdStr, onProgress) {
  const dir = instanceDir(instanceIdStr);
  const tmpZip = path.join(dir, '__pack_download.mrpack');

  onProgress?.({ message: 'Downloading modpack...' });
  await downloadFile(mrpackUrl, tmpZip);

  const zip = new AdmZip(tmpZip);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('Not a valid .mrpack file (missing modrinth.index.json).');
  const index = JSON.parse(zip.readAsText(indexEntry));

  // Extract "overrides" (configs, resource packs, etc.) straight into the instance
  zip.getEntries()
    .filter((e) => e.entryName.startsWith('overrides/') && !e.isDirectory)
    .forEach((e) => {
      const rel = e.entryName.slice('overrides/'.length);
      const outPath = path.join(dir, rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, e.getData());
    });

  // Download every referenced mod file (mods, resource packs, shaders, etc.)
  const total = index.files.length;
  for (let i = 0; i < total; i++) {
    const f = index.files[i];
    const outPath = path.join(dir, f.path); // path already includes "mods/xyz.jar" etc.
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const url = f.downloads[0];
    await downloadFile(url, outPath);
    onProgress?.({ message: `Installing ${path.basename(f.path)}`, percent: Math.round(((i + 1) / total) * 100) });
  }

  fs.rmSync(tmpZip, { force: true });

  // dependencies block tells us which MC version + loader this pack needs,
  // e.g. { minecraft: "1.20.1", "fabric-loader": "0.15.7" }
  const deps = index.dependencies || {};
  const loaderKey = Object.keys(deps).find((k) => k !== 'minecraft');
  const loaderType = loaderKey?.includes('fabric') ? 'fabric' : loaderKey?.includes('forge') ? 'forge' : loaderKey?.includes('quilt') ? 'quilt' : null;

  const meta = {
    name: index.name,
    mcVersion: deps.minecraft,
    loaderType,
    loaderVersion: loaderKey ? deps[loaderKey] : null,
  };
  writeInstanceMeta(dir, meta);

  return { ...meta, instanceDir: dir };
}

async function downloadFile(url, dest) {
  const res = await retryFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    res.body.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

module.exports = { search, getVersions, installMod, installModpack };
