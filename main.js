require('dns').setDefaultResultOrder('ipv4first');

// TEMPORARY workaround: some antivirus products do HTTPS/SSL inspection in a
// way that breaks Node's TLS handshake specifically, even though browsers on
// the same machine work fine. This disables TLS certificate verification for
// Node's own outbound requests. SECURITY TRADE-OFF: makes those connections
// vulnerable to interception -- acceptable short-term; the real fix is
// disabling "HTTPS scanning" in the antivirus itself so this can be removed.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');

const launcherCore = require('./core/launcher');
const modsCore = require('./core/mods');
const modpackCore = require('./core/modpack');
const skinsCore = require('./core/skins');

const store = new Store();

let mainWindow;

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
    frame: false,
    backgroundColor: '#f6f9f6',
    icon: path.join(__dirname, 'build', 'icon.ico'),
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

process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err);
});

// ---------------------------------------------------------------------------
// Frameless window controls
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
  const profile = await launcherCore.microsoftLogin((status) => safeSend('auth:microsoft:status', status));
  store.set('lastProfile', profile);
  return profile;
});

ipcMain.handle('auth:get-saved-profile', () => store.get('lastProfile', null));

// ---------------------------------------------------------------------------
// Mod loader installation
// ---------------------------------------------------------------------------
ipcMain.handle('install:forge', async (_event, { mcVersion, forgeVersion }) =>
  launcherCore.installForge(mcVersion, forgeVersion, (p) => safeSend('install:progress', p))
);

ipcMain.handle('install:fabric', async (_event, { mcVersion, loaderVersion }) =>
  launcherCore.installFabric(mcVersion, loaderVersion, (p) => safeSend('install:progress', p))
);

ipcMain.handle('versions:list', async () => launcherCore.getVersionManifest());

// ---------------------------------------------------------------------------
// Skin
// ---------------------------------------------------------------------------
ipcMain.handle('skin:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a skin (64x64 PNG)',
    filters: [{ name: 'PNG Images', extensions: ['png'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  store.set('customSkin', filePath);
  return filePath;
});

ipcMain.handle('skin:get-saved', () => store.get('customSkin', null));
ipcMain.handle('skin:set-model', (_e, model) => {
  store.set('skinModel', model);
  return true;
});
ipcMain.handle('skin:get-model', () => store.get('skinModel', 'classic'));
ipcMain.handle('skin:clear', () => {
  store.delete('customSkin');
  skinsCore.clearSkin(launcherCore.GAME_ROOT);
  return true;
});

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------
ipcMain.handle('mods:search', (_e, { query, mcVersion, loader }) => modsCore.searchMods(query, { mcVersion, loader }));
ipcMain.handle('mods:install', (_e, { projectId, mcVersion, loader }) =>
  modsCore.installMod(launcherCore.GAME_ROOT, projectId, mcVersion, loader)
);
ipcMain.handle('mods:list', () => modsCore.listMods(launcherCore.GAME_ROOT));
ipcMain.handle('mods:remove', (_e, fileName) => modsCore.removeMod(launcherCore.GAME_ROOT, fileName));

// ---------------------------------------------------------------------------
// Modpacks
// ---------------------------------------------------------------------------
ipcMain.handle('modpack:search', (_e, query) => modpackCore.searchModpacks(query));
ipcMain.handle('modpack:install-by-id', (_e, projectId) =>
  modpackCore.installModpackFromProjectId(projectId, launcherCore.GAME_ROOT, (p) => safeSend('modpack:progress', p))
);
ipcMain.handle('modpack:install-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a Modrinth modpack (.mrpack)',
    filters: [{ name: 'Modrinth Modpack', extensions: ['mrpack'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return modpackCore.installMrpack(result.filePaths[0], launcherCore.GAME_ROOT, (p) => safeSend('modpack:progress', p));
});

// ---------------------------------------------------------------------------
// Launch -- hides the launcher once the game process actually spawns,
// restores it when the game closes.
// ---------------------------------------------------------------------------
ipcMain.handle('game:launch', async (_event, launchConfig) => {
  const skinPath = store.get('customSkin', null);
  const skinModel = store.get('skinModel', 'classic');

  let closed = false;
  let hideTimer = null;

  const result = await launcherCore.launch(
    { ...launchConfig, skin: skinPath ? { path: skinPath, model: skinModel } : null },
    {
      onDownloadStatus: (data) => safeSend('game:download-progress', data),
      onData: (line) => safeSend('game:log', line),
      onClose: (code) => {
        closed = true;
        if (hideTimer) clearTimeout(hideTimer);
        safeSend('game:closed', code);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    }
  );

  // Wait a few seconds before hiding instead of hiding immediately. If the
  // game process crashes right after spawning (e.g. an old MC version like
  // 1.3.0 with a too-new Java version), this avoids hiding the launcher
  // only to have it reappear a split second later -- which just looks like
  // "everything vanished" -- and gives a real chance to read the crash in
  // the log before the window disappears at all.
  hideTimer = setTimeout(() => {
    if (!closed && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  }, 3000);

  return result;
});
