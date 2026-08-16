// core/mods.js
// Search and install individual mods directly from Modrinth's public API
// (no API key required, unlike CurseForge's third-party API).

const fs = require('fs');
const path = require('path');
const { retryFetch } = require('./net');

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'my-launcher/1.0 (github.com/yourname/my-launcher)' };

async function searchMods(query, { mcVersion, loader } = {}) {
  const facets = [];
  facets.push(['project_type:mod']);
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);

  const params = new URLSearchParams({ query: query || '', facets: JSON.stringify(facets), limit: '20' });
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

async function getBestVersionFile(projectId, mcVersion, loader) {
  const params = new URLSearchParams({ game_versions: JSON.stringify([mcVersion]), loaders: JSON.stringify([loader]) });
  const res = await retryFetch(`${API}/project/${projectId}/version?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Modrinth versions fetch failed: ${res.status}`);
  const versions = await res.json();
  if (!versions.length) throw new Error('No compatible version found for this mod/MC version/loader combo.');
  const file = versions[0].files.find((f) => f.primary) || versions[0].files[0];
  return { url: file.url, filename: file.filename };
}

async function installMod(gameRoot, projectId, mcVersion, loader) {
  const { url, filename } = await getBestVersionFile(projectId, mcVersion, loader);
  const modsDir = path.join(gameRoot, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, filename);

  const res = await retryFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Failed to download ${filename}: ${res.status}`);
  const buf = await res.buffer();
  fs.writeFileSync(dest, buf);
  return { filename };
}

function listMods(gameRoot) {
  const dir = path.join(gameRoot, 'mods');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.jar'))
    .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
}

function removeMod(gameRoot, fileName) {
  const dir = path.join(gameRoot, 'mods');
  const target = path.join(dir, fileName);
  if (!target.startsWith(dir)) throw new Error('Invalid mod file path.'); // guard against path traversal
  if (fs.existsSync(target)) fs.unlinkSync(target);
  return true;
}

module.exports = { searchMods, installMod, listMods, removeMod };
