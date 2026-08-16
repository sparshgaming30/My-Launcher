const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },

  loginOffline: (username) => ipcRenderer.invoke('auth:offline', username),
  loginMicrosoft: () => ipcRenderer.invoke('auth:microsoft'),
  getSavedProfile: () => ipcRenderer.invoke('auth:get-saved-profile'),
  onMicrosoftStatus: (cb) => ipcRenderer.on('auth:microsoft:status', (_e, s) => cb(s)),

  installForge: (mcVersion, forgeVersion) => ipcRenderer.invoke('install:forge', { mcVersion, forgeVersion }),
  installFabric: (mcVersion, loaderVersion) => ipcRenderer.invoke('install:fabric', { mcVersion, loaderVersion }),
  onInstallProgress: (cb) => ipcRenderer.on('install:progress', (_e, d) => cb(d)),
  listVersions: () => ipcRenderer.invoke('versions:list'),

  chooseSkin: () => ipcRenderer.invoke('skin:choose'),
  getSavedSkin: () => ipcRenderer.invoke('skin:get-saved'),
  setSkinModel: (model) => ipcRenderer.invoke('skin:set-model', model),
  getSkinModel: () => ipcRenderer.invoke('skin:get-model'),
  clearSkin: () => ipcRenderer.invoke('skin:clear'),

  searchMods: (query, mcVersion, loader) => ipcRenderer.invoke('mods:search', { query, mcVersion, loader }),
  installMod: (projectId, mcVersion, loader) => ipcRenderer.invoke('mods:install', { projectId, mcVersion, loader }),
  listMods: () => ipcRenderer.invoke('mods:list'),
  removeMod: (fileName) => ipcRenderer.invoke('mods:remove', fileName),

  searchModpacks: (query) => ipcRenderer.invoke('modpack:search', query),
  installModpackById: (projectId) => ipcRenderer.invoke('modpack:install-by-id', projectId),
  installModpackFile: () => ipcRenderer.invoke('modpack:install-file'),
  onModpackProgress: (cb) => ipcRenderer.on('modpack:progress', (_e, d) => cb(d)),

  launchGame: (config) => ipcRenderer.invoke('game:launch', config),
  onDownloadProgress: (cb) => ipcRenderer.on('game:download-progress', (_e, d) => cb(d)),
  onGameLog: (cb) => ipcRenderer.on('game:log', (_e, line) => cb(line)),
  onGameClosed: (cb) => ipcRenderer.on('game:closed', (_e, code) => cb(code)),
});
