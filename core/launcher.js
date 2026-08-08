// core/launcher.js
// -----------------------------------------------------------------------------
// This is the module the spec calls the "Renderer Process Backend" logic.
// It is required by main.js and executed in the MAIN process, then exposed to
// the UI through ipcMain/preload — NOT loaded directly into the renderer.
// Reason: minecraft-launcher-core spawns child processes and touches the
// filesystem (Java, jars, natives). With contextIsolation + a sandboxed
// renderer (the secure setup main.js sets up), the renderer cannot require()
// Node modules at all — so this logic must live main-side and be called via
// IPC. Functionally it's exactly the "backend for the UI" the spec describes.
// -----------------------------------------------------------------------------

const { Client, Authenticator } = require('minecraft-launcher-core');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); // still used directly for streamed downloads (downloadFile)
const { retryFetch } = require('./net');
const { SHARED_ROOT, instanceId, instanceDir } = require('./instances');

// =============================================================================
// AUTHENTICATION
// =============================================================================

/**
 * OFFLINE / "CRACKED" LOGIN
 * -----------------------------------------------------------------------------
 * How this bypasses official Mojang/Microsoft auth:
 *   Authenticator.getAuth(username) does NOT contact any Microsoft or Mojang
 *   server. It locally fabricates an auth payload: it generates an offline
 *   UUID by hashing "OfflinePlayer:<username>" (the same convention Mojang's
 *   own server software uses for offline-mode servers), and sets a dummy
 *   access_token. The Minecraft client only *validates* that token against
 *   Mojang's session servers when it needs to join an online-mode server or
 *   fetch a signed player skin — for singleplayer and offline-mode/cracked
 *   servers, the client never checks it, so a locally-generated fake token
 *   works fine. This is why offline mode requires the target server (if any)
 *   to have `online-mode=false` in server.properties.
 */
async function offlineLogin(username) {
  if (!username || !/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    throw new Error('Invalid username: 3-16 chars, letters/numbers/underscore only.');
  }
  const auth = await Authenticator.getAuth(username);
  return { ...auth, type: 'offline' };
}

/**
 * PREMIUM / MICROSOFT LOGIN
 * -----------------------------------------------------------------------------
 * Uses msmc to run the real OAuth device-code / browser flow against
 * Microsoft, exchange it for an Xbox Live -> XSTS -> Minecraft services
 * token, and verify game ownership. This produces a token that DOES pass
 * Mojang's session-server checks, so it works on online-mode servers.
 * NOTE: msmc's API has changed across major versions — check the installed
 * version's README (`npm ls msmc`) and adjust method names if they differ.
 */
async function microsoftLogin(onStatus) {
  const { Auth } = require('msmc');
  const authManager = new Auth('select_account');

  // msmc emits a URL + code for the device-code flow; surface it to the UI
  const xboxManager = await authManager.launch('electron', undefined, (msg) => {
    if (onStatus) onStatus({ stage: 'xbox', message: msg });
  });

  const token = await xboxManager.getMinecraft();

  // token.mclc() converts msmc's result into the exact shape MCLC expects
  return { ...token.mclc(), type: 'microsoft' };
}

// =============================================================================
// VERSION MANIFEST — every release, snapshot, and old_beta/old_alpha version
// Mojang has ever shipped, straight from their own manifest.
// =============================================================================

async function getVersionManifest() {
  const res = await retryFetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  if (!res.ok) throw new Error(`Failed to fetch version manifest: ${res.status}`);
  return res.json(); // { latest: {release, snapshot}, versions: [{id, type, url, releaseTime}, ...] }
}

// =============================================================================
// FORGE INSTALLATION
// =============================================================================

/**
 * Resolves "latest"/"recommended"/undefined into a real Forge build number
 * using Forge's own promotions feed, instead of guessing a version string
 * that likely 404s (as a plain "latest" in the installer URL would).
 */
async function resolveForgeVersion(mcVersion, channel = 'recommended') {
  const res = await retryFetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
    headers: { 'User-Agent': 'custom-mc-launcher/0.1' }, // Forge's CDN occasionally 403s bare/default-UA requests
  });
  if (!res.ok) throw new Error(`Failed to fetch Forge promotions: ${res.status}`);
  const data = await res.json();
  const promos = data.promos || {};

  const key = `${mcVersion}-${channel}`;
  let version = promos[key];
  if (!version && channel === 'recommended') version = promos[`${mcVersion}-latest`]; // fall back
  if (!version) throw new Error(`No Forge build found for Minecraft ${mcVersion}.`);
  return version;
}

/**
 * MCLC has built-in Forge support: you don't manually run the Forge
 * installer jar yourself — you pass a `forge` path into launch options and
 * MCLC handles downloading + patching the version JSON for you on first
 * launch. This function resolves the real version (see above), downloads
 * the installer, and returns its path for `launch()` to use.
 *
 * @param {string} mcVersion
 * @param {string} [forgeVersion] - a concrete build ("49.0.31"), or
 *   "latest"/"recommended"/undefined to auto-resolve via Forge's feed.
 */
async function installForge(mcVersion, forgeVersion, onProgress) {
  let resolvedVersion = forgeVersion;
  if (!resolvedVersion || resolvedVersion === 'latest' || resolvedVersion === 'recommended') {
    onProgress?.({ stage: 'forge', message: 'Resolving Forge build number...' });
    resolvedVersion = await resolveForgeVersion(mcVersion, resolvedVersion === 'latest' ? 'latest' : 'recommended');
  }

  const fullVersion = `${mcVersion}-${resolvedVersion}`;
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`;

  const forgeDir = path.join(SHARED_ROOT, 'installers', 'forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  const dest = path.join(forgeDir, `forge-${fullVersion}-installer.jar`);

  onProgress?.({ stage: 'forge', message: `Fetching Forge ${fullVersion} installer...` });
  await downloadFile(installerUrl, dest, (pct) =>
    onProgress?.({ stage: 'forge', percent: pct })
  );

  onProgress?.({ stage: 'forge', message: 'Forge installer ready.' });
  return { installerPath: dest, mcVersion, forgeVersion: resolvedVersion, versionId: `${mcVersion}-forge-${resolvedVersion}` };
}

// =============================================================================
// FABRIC INSTALLATION
// =============================================================================

/**
 * Fabric doesn't use an installer jar the way Forge does — you fetch a
 * "profile" JSON from Fabric's meta API describing the libraries/main-class
 * for a given (mcVersion, loaderVersion) pair, write it into
 * versions/<id>/<id>.json, and then launch that version id normally.
 * MCLC will pick up a custom version JSON as long as it exists in the
 * standard .minecraft/versions/<id>/ folder structure.
 */
async function installFabric(mcVersion, loaderVersion, onProgress) {
  onProgress?.({ stage: 'fabric', message: 'Resolving loader version...' });

  let resolvedLoader = loaderVersion;
  if (!resolvedLoader) {
    const loaders = await (
      await retryFetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`)
    ).json();
    resolvedLoader = loaders?.[0]?.loader?.version;
    if (!resolvedLoader) throw new Error(`No Fabric loader found for MC ${mcVersion}`);
  }

  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${resolvedLoader}/profile/json`;
  const profile = await (await retryFetch(profileUrl)).json();

  const versionId = profile.id; // e.g. "fabric-loader-0.15.11-1.20.4"
  const versionDir = path.join(SHARED_ROOT, 'versions', versionId);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(profile, null, 2));

  onProgress?.({ stage: 'fabric', message: `Fabric ${resolvedLoader} ready.`, percent: 100 });
  return { versionId, mcVersion, loaderVersion: resolvedLoader };
}

// =============================================================================
// LAUNCH — where auth + vanilla/forge/fabric options + instance data + skin
// resource pack all come together
// =============================================================================

/**
 * config = {
 *   profile,            // result of offlineLogin() or microsoftLogin()
 *   version: { number: '1.20.4', type: 'release' }, // vanilla
 *   loader: null | { type: 'forge', forge: '<installerPath from installForge>' }
 *          | { type: 'fabric', versionId: '<id from installFabric>' },
 *   memory: { min: '2G', max: '4G' },
 *   javaPath: 'auto' | '/custom/path/to/java',
 *   instanceName: optional string (e.g. a modpack name) to keep this
 *     install's mods/saves separate from a plain version+loader instance
 *   instanceId: optional explicit instance id — used for modpacks, which
 *     are keyed by pack name (see main.js's modpack:install handler)
 *     rather than the version+loader scheme plain installs use
 * }
 */
async function launch(config, hooks = {}) {
  const loaderType = config.loader?.type || 'vanilla';
  const id = config.instanceId || instanceId(config.version.number, loaderType, config.instanceName);
  const gameDirectory = instanceDir(id); // mods/, saves/, resourcepacks/, config/ live here

  const opts = {
    root: SHARED_ROOT, // shared cache: versions/, libraries/, assets/ — downloaded once, reused by every instance
    version: config.version,
    authorization: config.profile,
    memory: config.memory || { min: '2G', max: '4G' },
    javaPath: config.javaPath && config.javaPath !== 'auto' ? config.javaPath : undefined,
    overrides: {
      gameDirectory, // MCLC writes/reads mods, saves, options.txt, resourcepacks here instead of `root`
    },
  };

  // ---- Mod loader injection ----
  if (config.loader?.type === 'forge') {
    // MCLC hook: pointing `forge` at the installer jar path tells MCLC to
    // run Forge's install routine and patch the launch classpath/mainClass.
    opts.forge = config.loader.forge;
  } else if (config.loader?.type === 'fabric') {
    // Fabric has no MCLC-native hook; instead we point MCLC at the custom
    // Fabric version JSON written into versions/ during installFabric().
    // IMPORTANT: `number` must stay the real vanilla MC version (MCLC uses
    // it to resolve vanilla assets/libraries) — only `custom` points at
    // the Fabric version id.
    opts.version = {
      number: config.version.number,
      type: config.version.type || 'release',
      custom: config.loader.versionId,
    };
  }

  // A fresh Client per launch (instead of one module-level singleton) means
  // no leftover event listeners from a previous attempt — reusing one Client
  // across multiple PLAY clicks made every log line print once per past
  // attempt, since .on() listeners stack up and are never removed.
  const launcher = new Client();

  launcher.on('download-status', (data) => hooks.onDownloadStatus?.(data));
  launcher.on('data', (line) => hooks.onData?.(line.toString()));
  launcher.on('close', (code) => hooks.onClose?.(code));
  launcher.on('debug', (line) => hooks.onData?.(`[debug] ${line}`));

  await launcher.launch(opts);
  return { started: true, instanceId: id };
}

// =============================================================================
// small helper
// =============================================================================

async function downloadFile(url, dest, onProgress) {
  // Only the initial connection is retried — once headers arrive we're
  // streaming the body, and retrying a partially-streamed response isn't
  // safe to do transparently here.
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
  offlineLogin,
  microsoftLogin,
  getVersionManifest,
  installForge,
  resolveForgeVersion,
  installFabric,
  launch,
};
