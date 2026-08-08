// core/skins.js
// -----------------------------------------------------------------------------
// CUSTOM SKIN SUPPORT — how it actually works here:
//
// Offline accounts don't have a real Mojang profile, so there's no "official"
// skin to fetch, and singleplayer doesn't hit any skin API at all — it just
// renders the built-in Steve/Alex model. To show a custom skin, this module
// builds a small resource pack that overrides the vanilla player texture and
// auto-enables it for the target instance. This is the same mechanism any
// vanilla texture pack uses — it does NOT contact Mojang, does not spoof any
// authentication/session API, and works the same whether you're offline or
// signed in with Microsoft.
//
// LIMITATION: this overrides YOUR client's view of your own skin locally.
// Other players on a server won't see it unless the server also has your
// skin applied somehow (e.g. everyone running the same launcher/pack, or the
// server running its own skin system). Making a custom skin visible to
// OTHERS on arbitrary servers normally requires a Yggdrasil-compatible
// session-server replacement (the open-source `authlib-injector` project is
// the standard tool people use for that on self-hosted/offline-mode
// networks) — that's a heavier, server-side-coordinated setup and is out of
// scope here; this module only handles the "see it yourself, locally" case.
//
// VERSION SCOPE: targets the modern (1.13+) texture path structure
// (assets/minecraft/textures/entity/player/{wide,slim}/...). Versions
// before 1.13 used a different, flatter path (entity/steve.png), and
// versions before 1.8 used a single 64x32 texture with no second skin
// layer — those older layouts aren't handled by this module as written.
// -----------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const Jimp = require('jimp');
const { instanceDir } = require('./instances');

// Resource pack format numbers Mojang bumps periodically; using a safe
// modern default is fine since the game only reads it to decide whether to
// show a "may not work" nag — it still loads regardless.
const PACK_FORMAT = 22; // valid for roughly 1.20.x; harmless if slightly off

/**
 * Apply a custom skin to a given instance.
 * @param {string} skinPngPath - absolute path to a skin PNG the user picked
 * @param {string} instanceIdStr - the instance to apply it to (see instances.js)
 * @param {'wide'|'slim'} model - Steve (wide/classic arms) or Alex (slim arms)
 */
async function applySkin(skinPngPath, instanceIdStr, model = 'wide') {
  if (!fs.existsSync(skinPngPath)) throw new Error('Skin file not found.');
  if (!['wide', 'slim'].includes(model)) throw new Error('model must be "wide" or "slim".');

  const image = await Jimp.read(skinPngPath);

  // Normalize to the standard 64x64 modern skin canvas. If the source isn't
  // already 64x64, this resizes it — results look best if you supply a
  // proper 64x64 skin PNG to begin with (the format Minecraft itself uses).
  if (image.bitmap.width !== 64 || image.bitmap.height !== 64) {
    image.resize(64, 64, Jimp.RESIZE_NEAREST_NEIGHBOR);
  }

  const dir = instanceDir(instanceIdStr);
  const packDir = path.join(dir, 'resourcepacks', 'custom_skin');
  const texDir = path.join(packDir, 'assets', 'minecraft', 'textures', 'entity', 'player', model);
  fs.mkdirSync(texDir, { recursive: true });

  const outPng = path.join(texDir, model === 'wide' ? 'steve.png' : 'alex.png');
  await image.writeAsync(outPng);

  fs.writeFileSync(
    path.join(packDir, 'pack.mcmeta'),
    JSON.stringify({ pack: { pack_format: PACK_FORMAT, description: 'Custom Skin (auto-generated)' } }, null, 2)
  );

  // Zip it — MC reads resource packs from .zip files just as happily as
  // loose folders, and zipping avoids leaving an unpacked folder MC might
  // ignore depending on version quirks.
  const zipPath = path.join(dir, 'resourcepacks', 'custom_skin.zip');
  const zip = new AdmZip();
  zip.addLocalFolder(packDir);
  zip.writeZip(zipPath);
  fs.rmSync(packDir, { recursive: true, force: true }); // keep only the zip

  enableResourcePack(dir, 'file/custom_skin.zip');

  return { zipPath, model };
}

/**
 * Ensures options.txt lists our pack in resourcePacks and marks it enabled.
 * MC's options.txt stores resourcePacks as a JSON-ish array string, e.g:
 *   resourcePacks:["vanilla","file/custom_skin.zip"]
 */
function enableResourcePack(instancePath, packEntry) {
  const optionsPath = path.join(instancePath, 'options.txt');
  let lines = [];
  if (fs.existsSync(optionsPath)) {
    lines = fs.readFileSync(optionsPath, 'utf8').split('\n').filter(Boolean);
  }

  const idx = lines.findIndex((l) => l.startsWith('resourcePacks:'));
  let packs = [];
  if (idx !== -1) {
    try {
      packs = JSON.parse(lines[idx].slice('resourcePacks:'.length));
    } catch {
      packs = [];
    }
  }
  if (!packs.includes(packEntry)) packs.push(packEntry);

  const newLine = `resourcePacks:${JSON.stringify(packs)}`;
  if (idx !== -1) lines[idx] = newLine;
  else lines.push(newLine);

  fs.writeFileSync(optionsPath, lines.join('\n') + '\n');
}

module.exports = { applySkin };
