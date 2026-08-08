// core/instances.js
// -----------------------------------------------------------------------------
// A lightweight "instance" model: one folder per (mcVersion + loader) combo,
// holding mods/, resourcepacks/, saves/, config/ — the stuff that's specific
// to that version+loader pairing. The big shared stuff (vanilla libraries,
// assets, version jars) stays in one shared cache under GAME_ROOT so it's
// only ever downloaded once no matter how many instances you create.
// This mirrors how MultiMC/Prism Launcher separate "shared" vs "instance"
// data, just without their full profile-management UI on top.
// -----------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const GAME_ROOT = path.join(app.getPath('appData'), 'CustomMCLauncher');
const SHARED_ROOT = GAME_ROOT; // versions/, libraries/, assets/ live here (MCLC's `root`)
const INSTANCES_ROOT = path.join(GAME_ROOT, 'instances');

if (!fs.existsSync(GAME_ROOT)) fs.mkdirSync(GAME_ROOT, { recursive: true });
if (!fs.existsSync(INSTANCES_ROOT)) fs.mkdirSync(INSTANCES_ROOT, { recursive: true });

/**
 * Deterministic instance id from version + loader, e.g. "1.20.4-fabric" or
 * "1.12.2-forge" or "1.16.5-vanilla". Modpacks can also pass an explicit
 * name (e.g. the modpack's own name) to keep them separate from a plain
 * install of the same version+loader.
 */
function instanceId(mcVersion, loaderType, customName) {
  const base = `${mcVersion}-${loaderType || 'vanilla'}`;
  return customName ? `${base}-${slugify(customName)}` : base;
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function instanceDir(id) {
  const dir = path.join(INSTANCES_ROOT, id);
  for (const sub of ['mods', 'resourcepacks', 'saves', 'config']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function listInstances() {
  if (!fs.existsSync(INSTANCES_ROOT)) return [];
  return fs.readdirSync(INSTANCES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

const META_FILENAME = 'launcher-instance.json';

/** Stores {name, mcVersion, loaderType, loaderVersion} alongside an instance
 * so the UI can later show a friendly name and know exactly what to launch
 * (this matters most for modpacks, which pin an exact loader version that
 * isn't derivable from the folder id alone). */
function writeInstanceMeta(dir, meta) {
  fs.writeFileSync(path.join(dir, META_FILENAME), JSON.stringify(meta, null, 2));
}

function readInstanceMeta(dir) {
  const file = path.join(dir, META_FILENAME);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listInstancesWithMeta() {
  return listInstances().map((id) => ({
    id,
    meta: readInstanceMeta(path.join(INSTANCES_ROOT, id)),
  }));
}

module.exports = {
  GAME_ROOT,
  SHARED_ROOT,
  INSTANCES_ROOT,
  instanceId,
  instanceDir,
  listInstances,
  listInstancesWithMeta,
  writeInstanceMeta,
  readInstanceMeta,
  slugify,
};
