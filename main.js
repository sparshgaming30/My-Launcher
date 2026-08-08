// main.js — Electron Main Process
// Owns all Node.js-privileged work: window lifecycle + the actual MCLC calls.
// The renderer (UI) never touches Node/fs/mclc directly — it only talks over
// ipcRenderer <-> ipcMain, bridged through preload.js's contextBridge.
// This is the modern, secure Electron pattern (contextIsolation: true,
// nodeIntegration: false, sandbox: true).

// Force IPv4-first DNS resolution. Some home routers/ISPs have broken IPv6
// Path MTU Discovery — small packets (like a plain TCP handshake) go
// through fine, but larger ones (like a real TLS handshake/data transfer)
// get silently dropped instead of fragmented. That shows up as exactly
// "socket hang up" / "TLS connection was established, retrying" loops
// during bulk asset downloads, even though a single browser request or a
// bare TCP test succeeds. Preferring IPv4 sidesteps the broken path
// entirely instead of requiring the user to disable IPv6 system-wide.
require('dns').setDefaultResultOrder('ipv4first');

// TEMPORARY workaround: some antivirus products do HTTPS/SSL inspection
// (re-signing traffic with their own root cert) in a way that breaks Node's
// TLS handshake specifically, even though browsers on the same machine work
// fine (browsers trust the AV's injected cert; Node's cert store doesn't).
// This disables TLS certificate verification for all of Node's own outbound
// requests (version manifest, Forge/Fabric/Modrinth lookups, asset
// downloads) so those connections stop being interrupted.
// SECURITY TRADE-OFF: this makes those connections vulnerable to
// man-in-the-middle interception — acceptable short-term to unblock
// development, but the real fix is disabling "HTTPS scanning" / "SSL scan"
// in the antivirus itself (leaving virus scanning on) so this line can be
// removed. Remove this once that's sorted out.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');

const launcherCore = require('./core/launcher'); // real MCLC/auth/forge/fabric logic
const skins = require('./core/skins');
const modrinth = require('./core/modrinth');
const { listInstancesWithMeta, instanceId, slugify } = require('./core/instances');

const store = new Store(); // persists profiles, last-used version, settings.json equivalent

let mainWindow;

// Guards every IPC push to the renderer. Background work (asset retries,
// installer progress) can outlive the window if it's closed/reloaded mid-task
// — calling webContents.send() on a destroyed window throws an uncaught
// "Object has been destroyed" error that crashes the whole main process.
// Routing every send() through this avoids that.
function safeSend(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    frame: false, // frameless -> we draw our own titlebar in renderer for the modern look
    backgroundColor: '#f6f9f6', // matches the current white/green theme's panel tone
    icon: path.join(__dirname, 'build', 'icon.ico'), // taskbar/title-bar icon (Windows)
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Safety net: without this, any error thrown inside an async callback that
// isn't awaited directly (like MCLC's retry loop firing after the window
// closed) shows as the native "A JavaScript error occurred in the main
// process" crash dialog and kills the app. Logging instead keeps the
// launcher alive so you can see what happened and retry.
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err);
});

// ---------------------------------------------------------------------------
// Custom frameless window controls (renderer sends these via preload bridge)
// ---------------------------------------------------------------------------
ipcMain.on('win:minimize', () => mainWindow.minimize());
ipcMain.on('win:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow.close());

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
ipcMain.handle('auth:offline', async (_event, username) => {
  const profile = await launcherCore.offlineLogin(username);
  store.set('lastProfile', profile);
  return profile;
});

ipcMain.handle('auth:microsoft', async () => {
  const profile = await launcherCore.microsoftLogin((status) => {
    // forward device-code / progress updates to the renderer as they happen
    safeSend('auth:microsoft:status', status);
  });
  store.set('lastProfile', profile);
  return profile;
});

ipcMain.handle('auth:get-saved-profile', () => store.get('lastProfile', null));

// ---------------------------------------------------------------------------
// Mod loader installation (Forge / Fabric)
// ---------------------------------------------------------------------------
ipcMain.handle('install:forge', async (_event, { mcVersion, forgeVersion }) => {
  return launcherCore.installForge(mcVersion, forgeVersion, (progress) =>
    safeSend('install:progress', progress)
  );
});

ipcMain.handle('install:fabric', async (_event, { mcVersion, loaderVersion }) => {
  return launcherCore.installFabric(mcVersion, loaderVersion, (progress) =>
    safeSend('install:progress', progress)
  );
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------
ipcMain.handle('game:launch', async (_event, launchConfig) => {
  const result = await launcherCore.launch(launchConfig, {
    onDownloadStatus: (data) => safeSend('game:download-progress', data),
    onData: (line) => safeSend('game:log', line),
    onClose: (code) => {
      safeSend('game:closed', code);
      // Game process has exited -> bring the launcher back.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    },
  });

  // launcherCore.launch() only resolves once MCLC has finished downloading
  // everything AND actually spawned the Java process — so this is the right
  // moment to disappear, right as the real Minecraft window is about to show.
  // If launch() throws instead (before the game ever starts), we never reach
  // here, so the launcher correctly stays visible on a failed launch.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  return result;
});

ipcMain.handle('versions:list', async () => launcherCore.getVersionManifest());

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------
ipcMain.handle('instances:list', () => listInstancesWithMeta());
ipcMain.handle('instances:compute-id', (_event, { mcVersion, loaderType, instanceName }) =>
  instanceId(mcVersion, loaderType, instanceName)
);

// ---------------------------------------------------------------------------
// Skins — renderer can't access the filesystem, so the file picker itself
// has to run here in main and hand back just the chosen path.
// ---------------------------------------------------------------------------
ipcMain.handle('skins:pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a skin PNG',
    filters: [{ name: 'PNG Images', extensions: ['png'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;

  const filePath = result.filePaths[0];
  // Sandboxed renderer can't load file:// images under our CSP, so read it
  // here and hand back a data URL for the preview instead.
  const fs = require('fs');
  const base64 = fs.readFileSync(filePath).toString('base64');
  return { path: filePath, dataUrl: `data:image/png;base64,${base64}` };
});

ipcMain.handle('skins:apply', async (_event, { skinPath, mcVersion, loaderType, instanceName, model }) => {
  const id = instanceId(mcVersion, loaderType, instanceName);
  return skins.applySkin(skinPath, id, model);
});

// ---------------------------------------------------------------------------
// Mods & Modpacks (Modrinth)
// ---------------------------------------------------------------------------
ipcMain.handle('mods:search', async (_event, { query, mcVersion, loader, type }) =>
  modrinth.search(query, { mcVersion, loader, type })
);

ipcMain.handle('mods:get-versions', async (_event, { projectId, mcVersion, loader }) =>
  modrinth.getVersions(projectId, { mcVersion, loader })
);

ipcMain.handle('mods:install', async (_event, { projectId, mcVersion, loaderType, instanceName }) => {
  const id = instanceId(mcVersion, loaderType, instanceName);
  return modrinth.installMod(projectId, id, { mcVersion, loader: loaderType });
});

ipcMain.handle('modpack:install', async (_event, { mrpackUrl, packName }) => {
  // Modpacks get their own instance keyed purely by the pack's name (a given
  // pack always pins its own MC version + loader internally, so we don't
  // need those in the id the way plain vanilla/forge/fabric instances do).
  const id = `modpack-${slugify(packName)}`;
  const result = await modrinth.installModpack(mrpackUrl, id, (progress) =>
    safeSend('modpack:progress', progress)
  );
  return { ...result, instanceId: id };
});
