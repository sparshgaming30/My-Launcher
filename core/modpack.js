// core/modpack.js
// Modrinth modpack search + .mrpack installer. A .mrpack is a zip containing
// modrinth.index.json (the file manifest + required MC version/loader) and
// an overrides/ folder (configs, resource packs bundled directly).

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { retryFetch } = require('./net');

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'my-launcher/1.0 (github.com/yourname/my-launcher)' };

async function searchModpacks(query) {
  const facets = JSON.stringify([['project_type:modpack']]);
  const params = new URLSearchParams({ query: query || '', facets, limit: '20' });
  const res = await retryFetch(`${API}/search?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Modrinth search failed: ${res.status}`);
  const data = await res.json();
  return data.hits.map((hit) => ({
    id: hit.project_id,
    title: hit.title,
    description: hit.description,
    downloads: hit.downloads,
    iconUrl: hit.icon_url,
  }));
}

async function getLatestMrpackUrl(projectId) {
  const res = await retryFetch(`${API}/project/${projectId}/version`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Modrinth versions fetch failed: ${res.status}`);
  const versions = await res.json();
  if (!versions.length) throw new Error('No versions found for this modpack.');
  const file = versions[0].files.find((f) => f.filename.endsWith('.mrpack')) || versions[0].files[0];
  return { url: file.url, filename: file.filename };
}

async function installModpackFromProjectId(projectId, gameRoot, onProgress) {
  onProgress?.({ message: 'Resolving modpack file...' });
  const { url } = await getLatestMrpackUrl(projectId);
  const tmpPath = path.join(gameRoot, 'installers', `${projectId}.mrpack`);
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });

  onProgress?.({ message: 'Downloading modpack...' });
  const res = await retryFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Failed to download modpack: ${res.status}`);
  fs.writeFileSync(tmpPath, await res.buffer());

  return installMrpack(tmpPath, gameRoot, onProgress);
}

async function installMrpack(mrpackPath, gameRoot, onProgress) {
  onProgress?.({ message: 'Reading modpack archive...' });
  const zip = new AdmZip(mrpackPath);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('Not a valid .mrpack file (missing modrinth.index.json).');
  const index = JSON.parse(zip.readAsText(indexEntry));

  const { name, dependencies, files } = index;
  const mcVersion = dependencies?.minecraft;
  let loader = null;
  if (dependencies?.['fabric-loader']) loader = { type: 'fabric', version: dependencies['fabric-loader'] };
  else if (dependencies?.forge) loader = { type: 'forge', version: dependencies.forge };
  else if (dependencies?.['quilt-loader']) loader = { type: 'quilt', version: dependencies['quilt-loader'] };

  const total = files.length;
  for (let i = 0; i < total; i++) {
    const file = files[i];
    const destPath = path.join(gameRoot, file.path);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const url = file.downloads?.[0];
    if (!url) continue;
    onProgress?.({ message: `Downloading ${path.basename(file.path)} (${i + 1}/${total})`, percent: Math.round(((i + 1) / total) * 100) });
    const res = await retryFetch(url);
    if (!res.ok) throw new Error(`Failed to download ${file.path}: ${res.status}`);
    fs.writeFileSync(destPath, await res.buffer());
  }

  onProgress?.({ message: 'Applying overrides...' });
  const entries = zip.getEntries().filter((e) => e.entryName.startsWith('overrides/') && !e.isDirectory);
  for (const entry of entries) {
    const relative = entry.entryName.replace(/^overrides\//, '');
    const destPath = path.join(gameRoot, relative);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, entry.getData());
  }

  onProgress?.({ message: 'Modpack installed.', percent: 100 });
  return { name, mcVersion, loader };
}

module.exports = { searchModpacks, installModpackFromProjectId, installMrpack };
