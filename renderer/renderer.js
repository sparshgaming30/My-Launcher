// renderer/renderer.js — sandboxed, no Node access. Only calls window.api.

const log = (msg) => {
  const box = document.getElementById('log-box');
  box.textContent += `\n> ${msg}`;
  box.scrollTop = box.scrollHeight;
};

// ---------------- Window chrome ----------------
document.getElementById('btn-min').onclick = () => window.api.window.minimize();
document.getElementById('btn-max').onclick = () => window.api.window.maximize();
document.getElementById('btn-close').onclick = () => window.api.window.close();

// ---------------- Sidebar navigation ----------------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
  });
});

// ---------------- Login tabs ----------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------------- Active profile ----------------
let activeProfile = null;

function setProfileUI(profile) {
  activeProfile = profile;
  document.getElementById('account-avatar').textContent = profile.name?.[0]?.toUpperCase() || '?';
  document.getElementById('account-name').textContent = profile.name || 'Unknown';
  document.getElementById('account-type').textContent = profile.type === 'microsoft' ? 'Premium (Microsoft)' : 'Offline';
}

window.api.getSavedProfile().then((p) => { if (p) setProfileUI(p); });

document.getElementById('btn-login-offline').onclick = async () => {
  const username = document.getElementById('offline-username').value.trim();
  try {
    const profile = await window.api.loginOffline(username);
    setProfileUI(profile);
    log(`Logged in offline as ${profile.name}`);
  } catch (err) {
    log(`Offline login failed: ${err.message}`);
  }
};

window.api.onMicrosoftStatus((status) => {
  document.getElementById('ms-status').textContent = status.message || '';
});

document.getElementById('btn-login-microsoft').onclick = async () => {
  try {
    log('Opening Microsoft sign-in...');
    const profile = await window.api.loginMicrosoft();
    setProfileUI(profile);
    log(`Logged in as ${profile.name} (Premium)`);
  } catch (err) {
    log(`Microsoft login failed: ${err.message}`);
  }
};

// ---------------- Skin ----------------
async function refreshSkinPreview() {
  const skinPath = await window.api.getSavedSkin();
  const preview = document.getElementById('skin-preview');
  preview.textContent = skinPath ? skinPath.split(/[\\/]/).pop() : 'No skin selected';
  const model = await window.api.getSkinModel();
  document.getElementById('select-skin-model').value = model;
}
refreshSkinPreview();

document.getElementById('btn-choose-skin').onclick = async () => {
  try {
    const filePath = await window.api.chooseSkin();
    if (filePath) {
      log(`Skin selected: ${filePath.split(/[\\/]/).pop()}`);
      await refreshSkinPreview();
    }
  } catch (err) {
    log(`Skin selection failed: ${err.message}`);
  }
};

document.getElementById('btn-clear-skin').onclick = async () => {
  await window.api.clearSkin();
  await refreshSkinPreview();
  log('Custom skin removed.');
};

document.getElementById('select-skin-model').onchange = async (e) => {
  await window.api.setSkinModel(e.target.value);
};

// ---------------- Version dropdown (live from Mojang manifest) ----------------
let versionManifest = null;

function populateVersionDropdown() {
  if (!versionManifest) return;
  const showAll = document.getElementById('chk-snapshots').checked;
  const select = document.getElementById('select-version');
  const previous = select.value;
  select.innerHTML = '';
  const versions = versionManifest.versions.filter((v) => showAll || v.type === 'release');
  for (const v of versions) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.type === 'release' ? v.id : `${v.id} (${v.type})`;
    select.appendChild(opt);
  }
  if (versions.some((v) => v.id === previous)) select.value = previous;
}

window.api.listVersions().then((manifest) => {
  versionManifest = manifest;
  populateVersionDropdown();
}).catch((err) => log(`Failed to load version list: ${err.message}`));

document.getElementById('chk-snapshots').addEventListener('change', populateVersionDropdown);

// ---------------- Loader select ----------------
document.getElementById('select-loader').addEventListener('change', (e) => {
  document.getElementById('loader-version-row').hidden = e.target.value === 'none';
});

// ---------------- Mods: list / search / install / remove ----------------
async function refreshModsList() {
  const mods = await window.api.listMods();
  const list = document.getElementById('mods-list');
  list.innerHTML = '';
  for (const mod of mods) {
    const row = document.createElement('div');
    row.className = 'mod-item';
    row.innerHTML = `<span>${mod.name}</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.onclick = async () => {
      await window.api.removeMod(mod.name);
      refreshModsList();
      log(`Removed mod: ${mod.name}`);
    };
    row.appendChild(btn);
    list.appendChild(row);
  }
}
refreshModsList();

document.getElementById('btn-mod-search').onclick = async () => {
  const query = document.getElementById('mod-search-input').value.trim();
  const mcVersion = document.getElementById('select-version').value;
  const loaderSel = document.getElementById('select-loader').value;
  const resultsBox = document.getElementById('mod-search-results');
  resultsBox.innerHTML = 'Searching...';
  try {
    const results = await window.api.searchMods(query, mcVersion, loaderSel !== 'none' ? loaderSel : undefined);
    resultsBox.innerHTML = '';
    for (const mod of results) {
      const row = document.createElement('div');
      row.className = 'search-result-item';
      row.innerHTML = `<div class="info"><div class="title">${mod.title}</div><div class="desc">${mod.description || ''}</div></div>`;
      const btn = document.createElement('button');
      btn.className = 'accent-button';
      btn.textContent = 'Install';
      btn.onclick = async () => {
        if (loaderSel === 'none') { log('Select a mod loader (Fabric/Forge) on the Dashboard first.'); return; }
        try {
          log(`Installing ${mod.title}...`);
          const result = await window.api.installMod(mod.id, mcVersion, loaderSel);
          log(`Installed: ${result.filename}`);
          refreshModsList();
        } catch (err) {
          log(`Install failed: ${err.message}`);
        }
      };
      row.appendChild(btn);
      resultsBox.appendChild(row);
    }
    if (!results.length) resultsBox.innerHTML = '<p class="hint">No results.</p>';
  } catch (err) {
    resultsBox.innerHTML = '';
    log(`Mod search failed: ${err.message}`);
  }
};

// ---------------- Modpacks: search / install ----------------
window.api.onModpackProgress((data) => {
  const wrap = document.getElementById('modpack-progress-wrap');
  wrap.hidden = false;
  if (typeof data.percent === 'number') {
    document.getElementById('modpack-progress-fill').style.width = `${data.percent}%`;
  }
  document.getElementById('modpack-progress-text').textContent = data.message || '';
  if (data.message) log(data.message);
});

document.getElementById('btn-modpack-search').onclick = async () => {
  const query = document.getElementById('modpack-search-input').value.trim();
  const resultsBox = document.getElementById('modpack-search-results');
  resultsBox.innerHTML = 'Searching...';
  try {
    const results = await window.api.searchModpacks(query);
    resultsBox.innerHTML = '';
    for (const pack of results) {
      const row = document.createElement('div');
      row.className = 'search-result-item';
      row.innerHTML = `<div class="info"><div class="title">${pack.title}</div><div class="desc">${pack.description || ''}</div></div>`;
      const btn = document.createElement('button');
      btn.className = 'accent-button';
      btn.textContent = 'Install';
      btn.onclick = async () => {
        try {
          const result = await window.api.installModpackById(pack.id);
          log(`Modpack installed: ${result.name} (MC ${result.mcVersion}${result.loader ? ', ' + result.loader.type : ''})`);
          document.getElementById('modpack-progress-wrap').hidden = true;
        } catch (err) {
          log(`Modpack install failed: ${err.message}`);
        }
      };
      row.appendChild(btn);
      resultsBox.appendChild(row);
    }
    if (!results.length) resultsBox.innerHTML = '<p class="hint">No results.</p>';
  } catch (err) {
    resultsBox.innerHTML = '';
    log(`Modpack search failed: ${err.message}`);
  }
};

document.getElementById('btn-import-modpack').onclick = async () => {
  try {
    const result = await window.api.installModpackFile();
    if (result) {
      log(`Modpack installed: ${result.name} (MC ${result.mcVersion}${result.loader ? ', ' + result.loader.type : ''})`);
    }
    document.getElementById('modpack-progress-wrap').hidden = true;
  } catch (err) {
    log(`Modpack import failed: ${err.message}`);
  }
};

// ---------------- PLAY ----------------
window.api.onDownloadProgress((data) => {
  const wrap = document.getElementById('progress-wrap');
  wrap.hidden = false;
  if (data.total) {
    const pct = Math.round((data.task / data.total) * 100);
    document.getElementById('progress-fill').style.width = `${pct}%`;
  }
  document.getElementById('progress-text').textContent = data.type ? `Downloading ${data.type}...` : 'Preparing...';
});

window.api.onGameLog((line) => log(line));

function setPlayEnabled(enabled) {
  const btn = document.getElementById('btn-play');
  btn.disabled = !enabled;
  btn.classList.toggle('play-button--disabled', !enabled);
}

window.api.onGameClosed((code) => {
  log(`Game exited with code ${code}`);
  document.getElementById('progress-wrap').hidden = true;
  setPlayEnabled(true);
});

document.getElementById('btn-play').onclick = async () => {
  if (document.getElementById('btn-play').disabled) return;
  if (!activeProfile) { log('Log in first (Profiles tab) before launching.'); return; }

  setPlayEnabled(false);

  const mcVersion = document.getElementById('select-version').value;
  const loaderType = document.getElementById('select-loader').value;
  const loaderVersionInput = document.getElementById('loader-version-input').value.trim() || null;

  const config = {
    profile: activeProfile,
    version: { number: mcVersion, type: 'release' },
    memory: {
      min: document.getElementById('mem-min').value || '2G',
      max: document.getElementById('mem-max').value || '4G',
    },
    javaPath: document.getElementById('java-path').value || 'auto',
    loader: null,
  };

  try {
    if (loaderType === 'forge') {
      log('Resolving Forge install...');
      const forgeResult = await window.api.installForge(mcVersion, loaderVersionInput || 'latest');
      config.loader = { type: 'forge', forge: forgeResult.installerPath };
    } else if (loaderType === 'fabric') {
      log('Resolving Fabric install...');
      const fabricResult = await window.api.installFabric(mcVersion, loaderVersionInput);
      config.loader = { type: 'fabric', versionId: fabricResult.versionId };
    }

    log(`Launching Minecraft ${mcVersion}${loaderType !== 'none' ? ' (' + loaderType + ')' : ''}...`);
    document.getElementById('progress-wrap').hidden = false;

    await window.api.launchGame(config);
    // NOTE: intentionally NOT re-enabling PLAY here -- it stays disabled
    // until the 'game:closed' event fires, since launchGame() resolving
    // just means the process spawned, not that it's done running.
  } catch (err) {
    log(`Launch failed: ${err.message}`);
    document.getElementById('progress-wrap').hidden = true;
    setPlayEnabled(true);
  }
};
