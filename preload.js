// preload.js — the ONLY bridge between the sandboxed renderer and Node/IPC.
// Runs in an isolated context with access to a limited set of Node APIs
// (contextBridge, ipcRenderer) even though the renderer itself has none.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---- window chrome (frameless window controls) ----
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },

  // ---- auth ----
  loginOffline: (username) => ipcRenderer.invoke('auth:offline', username),
  loginMicrosoft: () => ipcRenderer.invoke('auth:microsoft'),
  getSavedProfile: () => ipcRenderer.invoke('auth:get-saved-profile'),
  onMicrosoftStatus: (callback) =>
    ipcRenderer.on('auth:microsoft:status', (_e, status) => callback(status)),

  // ---- mod loader installers ----
  installForge: (mcVersion, forgeVersion) =>
    ipcRenderer.invoke('install:forge', { mcVersion, forgeVersion }),
  installFabric: (mcVersion, loaderVersion) =>
    ipcRenderer.invoke('install:fabric', { mcVersion, loaderVersion }),
  onInstallProgress: (callback) =>
    ipcRenderer.on('install:progress', (_e, data) => callback(data)),

  // ---- launch ----
  launchGame: (config) => ipcRenderer.invoke('game:launch', config),
  onDownloadProgress: (callback) =>
    ipcRenderer.on('game:download-progress', (_e, data) => callback(data)),
  onGameLog: (callback) => ipcRenderer.on('game:log', (_e, line) => callback(line)),
  onGameClosed: (callback) => ipcRenderer.on('game:closed', (_e, code) => callback(code)),

  // ---- misc ----
  listVersions: () => ipcRenderer.invoke('versions:list'),
  listInstances: () => ipcRenderer.invoke('instances:list'),
  computeInstanceId: (mcVersion, loaderType, instanceName) =>
    ipcRenderer.invoke('instances:compute-id', { mcVersion, loaderType, instanceName }),

  // ---- skins ----
  pickSkinFile: () => ipcRenderer.invoke('skins:pick-file'),
  applySkin: (skinPath, mcVersion, loaderType, instanceName, model) =>
    ipcRenderer.invoke('skins:apply', { skinPath, mcVersion, loaderType, instanceName, model }),

  // ---- mods & modpacks (Modrinth) ----
  searchMods: (query, mcVersion, loader, type) =>
    ipcRenderer.invoke('mods:search', { query, mcVersion, loader, type }),
  getModVersions: (projectId, mcVersion, loader) =>
    ipcRenderer.invoke('mods:get-versions', { projectId, mcVersion, loader }),
  installMod: (projectId, mcVersion, loaderType, instanceName) =>
    ipcRenderer.invoke('mods:install', { projectId, mcVersion, loaderType, instanceName }),
  installModpack: (mrpackUrl, packName) =>
    ipcRenderer.invoke('modpack:install', { mrpackUrl, packName }),
  onModpackProgress: (callback) =>
    ipcRenderer.on('modpack:progress', (_e, data) => callback(data)),
});
