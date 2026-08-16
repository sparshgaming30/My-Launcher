// core/skins.js
// -----------------------------------------------------------------------------
// Offline accounts have no Mojang skin to fetch, so instead of running a fake
// session server, this builds a small resource pack that overrides the
// vanilla Steve/Alex player texture and auto-enables it via options.txt.
// This is fully offline, needs no account/session verification, but is a
// LOCAL-ONLY override -- other players on a server won't see it unless that
// server runs its own skin system. Targets the modern 1.13+ texture path.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

async function applySkin(gameRoot, skinPngPath, model = 'classic') {
  if (!fs.existsSync(skinPngPath)) throw new Error('Skin file not found.');

  const image = await Jimp.read(skinPngPath);
  const { width, height } = image.bitmap;
  if (width !== 64 || (height !== 64 && height !== 32)) {
    throw new Error(`Skin must be 64x64 (or legacy 64x32) PNG — got ${width}x${height}.`);
  }
  // Normalize legacy 64x32 skins to 64x64 (transparent bottom half) so the
  // resource pack override always targets the modern texture layout.
  let finalImage = image;
  if (height === 32) {
    finalImage = new Jimp(64, 64, 0x00000000);
    finalImage.composite(image, 0, 0);
  }

  const packDir = path.join(gameRoot, 'resourcepacks', 'custom-skin');
  const variant = model === 'slim' ? 'slim' : 'wide';
  const texDir = path.join(packDir, 'assets', 'minecraft', 'textures', 'entity', 'player', variant);
  fs.mkdirSync(texDir, { recursive: true });

  await finalImage.writeAsync(path.join(texDir, `${variant === 'slim' ? 'alex' : 'steve'}.png`));

  fs.writeFileSync(
    path.join(packDir, 'pack.mcmeta'),
    JSON.stringify({ pack: { pack_format: 15, description: 'Custom player skin' } }, null, 2)
  );

  enablePack(gameRoot, 'custom-skin');
  return true;
}

function enablePack(gameRoot, packFolderName) {
  const optionsPath = path.join(gameRoot, 'options.txt');
  let lines = [];
  if (fs.existsSync(optionsPath)) {
    lines = fs.readFileSync(optionsPath, 'utf8').split('\n');
  }

  const packLabel = `"${packFolderName}"`;
  const idx = lines.findIndex((l) => l.startsWith('resourcePacks:'));
  if (idx === -1) {
    lines.push(`resourcePacks:[${packLabel}]`);
  } else {
    const match = lines[idx].match(/resourcePacks:\[(.*)\]/);
    const existing = match && match[1] ? match[1].split(',').filter(Boolean) : [];
    if (!existing.includes(packLabel)) existing.push(packLabel);
    lines[idx] = `resourcePacks:[${existing.join(',')}]`;
  }

  fs.writeFileSync(optionsPath, lines.join('\n'));
}

function clearSkin(gameRoot) {
  const packDir = path.join(gameRoot, 'resourcepacks', 'custom-skin');
  if (fs.existsSync(packDir)) fs.rmSync(packDir, { recursive: true, force: true });
}

module.exports = { applySkin, clearSkin };
