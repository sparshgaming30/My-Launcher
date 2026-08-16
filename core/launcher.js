// core/launcher.js
// Runs in the MAIN process (required by main.js, called over IPC) since the
// sandboxed renderer has no Node access. See README for the full explanation
// of offline-auth mechanics and the Forge/Fabric injection approach.

const { Client, Authenticator } = require('minecraft-launcher-core');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); // used directly only for streamed file downloads
const { retryFetch } = require('./net');
const skins = require('./skins');

const GAME_ROOT = path.join(app.getPath('appData'), 'CustomMCLauncher');
if (!fs.existsSync(GAME_ROOT)) fs.mkdirSync(GAME_ROOT, { recursive: true });

// =============================================================================
// AUTHENTICATION
// =============================================================================

/**
 * OFFLINE / "CRACKED" LOGIN
 * Authenticator.getAuth(username) never contacts Microsoft or Mojang. It
 * derives an offline UUID locally by hashing "OfflinePlayer:<username>" (the
 * same convention Mojang's own server software uses for offline mode) and
 * fills in a placeholder access_token that's never verified. The client only
 * checks that token against Mojang's session servers when joining a server
 * running online-mode=true; for singleplayer or online-mode=false servers,
 * it's accepted unverified.
 */
async function offlineLogin(username) {
  if (!username || !/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    throw new Error('Invalid username: 3-16 chars, letters/numbers/underscore only.');
  }
  const auth = await Authenticator.getAuth(username);
  return { ...auth, type: 'offline' };
}

/**
 * PREMIUM / MICROSOFT LOGIN via msmc (real OAuth -> Xbox Live -> XSTS ->
 * Minecraft Services chain). msmc's API has shifted across major versions --
 * this targets msmc@5.x; check msmc's README if method names don't match
 * after an upgrade.
 */
async function microsoftLogin(onStatus) {
  const { Auth } = require('msmc');
  const authManager = new Auth('select_account');
  const xboxManager = await authManager.launch('electron', undefined, (msg) => {
    if (onStatus) onStatus({ stage: 'xbox', message: msg });
  });
  const token = await xboxManager.getMinecraft();
  return { ...token.mclc(), type: 'microsoft' };
}

// =============================================================================
// VERSION MANIFEST
// =============================================================================

async function getVersionManifest() {
  const res = await retryFetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  if (!res.ok) throw new Error(`Failed to fetch version manifest: ${res.status}`);
  return res.json(); // { latest: {release, snapshot}, versions: [{id, type, url, releaseTime}, ...] }
}

// =============================================================================
// FORGE INSTALLATION
// =============================================================================

async function resolveForgeVersion(mcVersion, channel = 'recommended') {
  const res = await retryFetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
    headers: { 'User-Agent': 'my-launcher/1.0' },
  });
  if (!res.ok) throw new Error(`Failed to fetch Forge promotions: ${res.status}`);
  const data = await res.json();
  let version = data.promos[`${mcVersion}-${channel}`];
  if (!version && channel === 'recommended') version = data.promos[`${mcVersion}-latest`];
  if (!version) throw new Error(`No Forge build found for Minecraft ${mcVersion}.`);
  return version;
}

async function installForge(mcVersion, forgeVersion, onProgress) {
  let resolvedVersion = forgeVersion;
  if (!resolvedVersion || resolvedVersion === 'latest') {
    onProgress?.({ message: 'Resolving latest Forge build...' });
    resolvedVersion = await resolveForgeVersion(mcVersion, 'recommended');
  }
  const fullVersion = `${mcVersion}-${resolvedVersion}`;
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`;

  const forgeDir = path.join(GAME_ROOT, 'installers', 'forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  const dest = path.join(forgeDir, `forge-${fullVersion}-installer.jar`);

  onProgress?.({ message: `Fetching Forge ${fullVersion} installer...` });
  await downloadFile(installerUrl, dest, (pct) => onProgress?.({ percent: pct }));

  onProgress?.({ message: 'Forge installer ready.' });
  return { installerPath: dest, mcVersion, forgeVersion: resolvedVersion, versionId: `${mcVersion}-forge-${resolvedVersion}` };
}

// =============================================================================
// FABRIC INSTALLATION
// =============================================================================

async function installFabric(mcVersion, loaderVersion, onProgress) {
  onProgress?.({ message: 'Resolving loader version...' });

  let resolvedLoader = loaderVersion;
  if (!resolvedLoader) {
    const loaders = await (await retryFetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`)).json();
    resolvedLoader = loaders?.[0]?.loader?.version;
    if (!resolvedLoader) throw new Error(`No Fabric loader found for MC ${mcVersion}`);
  }

  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${resolvedLoader}/profile/json`;
  const profile = await (await retryFetch(profileUrl)).json();

  const versionId = profile.id; // e.g. "fabric-loader-0.15.11-1.20.4"
  const versionDir = path.join(GAME_ROOT, 'versions', versionId);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(profile, null, 2));

  onProgress?.({ message: `Fabric ${resolvedLoader} ready.`, percent: 100 });
  return { versionId, mcVersion, loaderVersion: resolvedLoader };
}

// =============================================================================
// LAUNCH
// =============================================================================

/**
 * config = {
 *   profile, root, version: { number, type },
 *   loader: null | { type: 'forge', forge: '<installerPath>' } | { type: 'fabric', versionId },
 *   memory: { min, max }, javaPath: 'auto' | '<path>',
 *   skin: null | { path: '<png path>' },
 * }
 */
async function launch(config, hooks = {}) {
  const opts = {
    root: config.root || GAME_ROOT,
    version: config.version,
    authorization: config.profile,
    memory: config.memory || { min: '2G', max: '4G' },
    javaPath: config.javaPath && config.javaPath !== 'auto' ? config.javaPath : undefined,
  };

  if (config.loader?.type === 'forge') {
    opts.forge = config.loader.forge;
  } else if (config.loader?.type === 'fabric') {
    opts.version = {
      number: config.version.number,
      type: config.version.type || 'release',
      custom: config.loader.versionId,
    };
  }

  if (config.skin?.path) {
    try {
      await skins.applySkin(GAME_ROOT, config.skin.path, config.skin.model || 'classic');
      hooks.onData?.('[launcher]: Custom skin resource pack applied.');
    } catch (err) {
      hooks.onData?.(`[launcher]: Skin apply failed: ${err.message}`);
    }
  }

  // A fresh Client per launch avoids stale event listeners stacking up
  // across repeated PLAY clicks in the same running app.
  const launcher = new Client();
  launcher.on('download-status', (data) => hooks.onDownloadStatus?.(data));
  launcher.on('data', (line) => hooks.onData?.(line.toString()));
  launcher.on('close', (code) => hooks.onClose?.(code));
  launcher.on('debug', (line) => hooks.onData?.(`[debug] ${line}`));

  await launcher.launch(opts);
  return { started: true };
}

// =============================================================================
// helper
// =============================================================================

async function downloadFile(url, dest, onProgress) {
  const res = await retryFetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    res.body.on('data', (chunk) => {
      received += chunk.length;
      if (total && onProgress) onProgress(Math.round((received / total) * 100));
    });
    res.body.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

module.exports = {
  GAME_ROOT,
  offlineLogin,
  microsoftLogin,
  getVersionManifest,
  installForge,
  installFabric,
  launch,
};
