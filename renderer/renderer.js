// renderer/renderer.js
// Runs inside the sandboxed webContents. Has NO Node/fs/mclc access — it can
// only call the whitelisted methods preload.js exposed on window.api, which
// forward to core/*.js in the main process over IPC.

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

// ---------------- Active profile state ----------------
let activeProfile = null;

function setProfileUI(profile) {
  activeProfile = profile;
  document.getElementById('account-avatar').textContent = profile.name?.[0]?.toUpperCase() || '?';
  document.getElementById('account-name').textContent = profile.name || 'Unknown';
  document.getElementById('account-type').textContent =
    profile.type === 'microsoft' ? 'Premium (Microsoft)' : 'Offline';
}

// restore last session, if any
window.api.getSavedProfile().then((p) => { if (p) setProfileUI(p); });

// ---------------- Offline login ----------------
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

// ---------------- Microsoft login ----------------
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

// =============================================================================
// VERSION MANIFEST — fetched once, used to populate every version dropdown
// =============================================================================

let versionManifest = null; // { latest, versions: [{id, type, releaseTime}, ...] }

async function loadVersionManifest() {
  try {
    versionManifest = await window.api.listVersions();
    populateVersionSelect(document.getElementById('select-mc-version'), releasesOnly());
    populateVersionSelect(document.getElementById('skin-target-version'), releasesOnly());
    populateVersionSelect(document.getElementById('mod-search-version'), releasesOnly(), true);
  } catch (err) {
    log(`Failed to load version list: ${err.message}`);
  }
}

function releasesOnly() {
  return versionManifest.versions.filter((v) => v.type === 'release');
}

function populateVersionSelect(selectEl, versions, includeAnyOption = false) {
  selectEl.innerHTML = '';
  if (includeAnyOption) {
    const anyOpt = document.createElement('option');
    anyOpt.value = '';
    anyOpt.textContent = 'Any version';
    selectEl.appendChild(anyOpt);
  }
  for (const v of versions) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.type === 'release' ? v.id : `${v.id} (${v.type})`;
    selectEl.appendChild(opt);
  }
}

document.getElementById('chk-show-all-versions').addEventListener('change', (e) => {
  const versions = e.target.checked ? versionManifest.versions : releasesOnly();
  populateVersionSelect(document.getElementById('select-mc-version'), versions);
});

loadVersionManifest();

// =============================================================================
// DASHBOARD — source toggle (pick a version+loader vs. an installed modpack)
// =============================================================================

document.querySelectorAll('#source-version, #source-modpack').forEach((el) => {}); // no-op, ids used directly below

document.getElementById('src-version-btn').addEventListener('click', () => setPlaySource('version'));
document.getElementById('src-modpack-btn').addEventListener('click', () => setPlaySource('modpack'));

function setPlaySource(source) {
  document.getElementById('src-version-btn').classList.toggle('active', source === 'version');
  document.getElementById('src-modpack-btn').classList.toggle('active', source === 'modpack');
  document.getElementById('source-version').classList.toggle('active', source === 'version');
  document.getElementById('source-modpack').classList.toggle('active', source === 'modpack');
}

async function refreshInstalledModpacks() {
  const instances = await window.api.listInstances(); // [{id, meta}]
  const modpacks = instances.filter((i) => i.id.startsWith('modpack-') && i.meta);

  const dashSelect = document.getElementById('select-modpack-instance');
  const listPanel = document.getElementById('installed-modpacks-list');

  if (!modpacks.length) {
    dashSelect.innerHTML = '<option value="">No modpacks installed yet</option>';
    listPanel.innerHTML = '<p class="hint">None installed yet.</p>';
    return;
  }

  dashSelect.innerHTML = modpacks
    .map((m) => `<option value="${m.id}">${m.meta.name} (${m.meta.mcVersion}${m.meta.loaderType ? ' / ' + m.meta.loaderType : ''})</option>`)
    .join('');

  listPanel.innerHTML = modpacks
    .map((m) => `<div class="installed-item"><strong>${m.meta.name}</strong> — ${m.meta.mcVersion}${m.meta.loaderType ? ' (' + m.meta.loaderType + ' ' + m.meta.loaderVersion + ')' : ''}</div>`)
    .join('');
}

refreshInstalledModpacks();

// ---------------- Forge / Fabric manual installers ----------------
document.getElementById('btn-install-forge').onclick = async () => {
  const mcVersion = document.getElementById('forge-mc-version').value.trim();
  const forgeVersion = document.getElementById('forge-loader-version').value.trim() || undefined;
  if (!mcVersion) return log('Enter a Minecraft version.');
  log(`Installing Forge for ${mcVersion}${forgeVersion ? ' (' + forgeVersion + ')' : ' (recommended)'}...`);
  try {
    const result = await window.api.installForge(mcVersion, forgeVersion);
    log(`Forge ready: ${result.versionId}`);
  } catch (err) {
    log(`Forge install failed: ${err.message}`);
  }
};

document.getElementById('btn-install-fabric').onclick = async () => {
  const mcVersion = document.getElementById('fabric-mc-version').value.trim();
  const loaderVersion = document.getElementById('fabric-loader-version').value.trim() || null;
  if (!mcVersion) return log('Enter a Minecraft version.');
  log(`Installing Fabric for ${mcVersion}...`);
  try {
    const result = await window.api.installFabric(mcVersion, loaderVersion);
    log(`Fabric ready: ${result.versionId}`);
  } catch (err) {
    log(`Fabric install failed: ${err.message}`);
  }
};

window.api.onInstallProgress((data) => {
  if (data.message) log(data.message);
});

// =============================================================================
// SKINS
// =============================================================================

let pickedSkinPath = null;

document.getElementById('btn-pick-skin').onclick = async () => {
  const picked = await window.api.pickSkinFile();
  if (!picked) return;
  pickedSkinPath = picked.path;

  const preview = document.getElementById('skin-preview');
  preview.innerHTML = '';
  const img = document.createElement('img');
  img.src = picked.dataUrl;
  img.alt = 'Skin preview';
  preview.appendChild(img);

  document.getElementById('btn-apply-skin').disabled = false;
};

document.getElementById('btn-apply-skin').onclick = async () => {
  if (!pickedSkinPath) return;
  const model = document.querySelector('input[name="skin-model"]:checked').value;
  const mcVersion = document.getElementById('skin-target-version').value;
  const loaderType = document.getElementById('skin-target-loader').value || null;

  const btn = document.getElementById('btn-apply-skin');
  btn.disabled = true;
  log(`Applying skin to ${mcVersion}${loaderType ? ' (' + loaderType + ')' : ''}...`);
  try {
    await window.api.applySkin(pickedSkinPath, mcVersion, loaderType, null, model);
    log('Skin applied. It will show next time that instance launches.');
  } catch (err) {
    log(`Skin apply failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
};

// =============================================================================
// MODS & MODPACKS (Modrinth search)
// =============================================================================

let searchType = 'mod';

document.getElementById('search-type-mod').addEventListener('click', () => setSearchType('mod'));
document.getElementById('search-type-modpack').addEventListener('click', () => setSearchType('modpack'));

function setSearchType(type) {
  searchType = type;
  document.getElementById('search-type-mod').classList.toggle('active', type === 'mod');
  document.getElementById('search-type-modpack').classList.toggle('active', type === 'modpack');
}

document.getElementById('btn-mod-search').onclick = async () => {
  const query = document.getElementById('mod-search-input').value.trim();
  const mcVersion = document.getElementById('mod-search-version').value || undefined;
  const loader = document.getElementById('mod-search-loader').value || undefined;
  const resultsEl = document.getElementById('mod-results');

  resultsEl.innerHTML = '<p class="hint">Searching...</p>';
  try {
    const results = await window.api.searchMods(query, mcVersion, loader, searchType);
    renderModResults(results, { mcVersion, loader });
  } catch (err) {
    resultsEl.innerHTML = `<p class="hint">Search failed: ${err.message}</p>`;
  }
};

function renderModResults(results, filters) {
  const resultsEl = document.getElementById('mod-results');
  if (!results.length) {
    resultsEl.innerHTML = '<p class="hint">No results.</p>';
    return;
  }

  resultsEl.innerHTML = '';
  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'mod-card';
    card.innerHTML = `
      <img class="mod-icon" src="${r.iconUrl || ''}" onerror="this.style.visibility='hidden'" />
      <div class="mod-info">
        <div class="mod-title">${escapeHtml(r.title)}</div>
        <div class="mod-desc">${escapeHtml(r.description || '')}</div>
        <div class="mod-meta">by ${escapeHtml(r.author || 'unknown')} · ${r.downloads?.toLocaleString?.() || 0} downloads</div>
      </div>
      <button class="accent-button mod-install-btn">Install</button>
    `;
    card.querySelector('.mod-install-btn').onclick = (e) => installSearchResult(r, filters, e.target);
    resultsEl.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function installSearchResult(result, filters, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = 'Installing...';

  try {
    if (result.type === 'mod') {
      if (!filters.mcVersion) {
        log('Pick a Minecraft version filter before installing a mod (so it goes in the right instance).');
        return;
      }
      const installed = await window.api.installMod(result.id, filters.mcVersion, filters.loader || null, null);
      log(`Installed mod: ${installed.filename}`);
      btnEl.textContent = 'Installed';
    } else {
      log(`Resolving download for modpack "${result.title}"...`);
      const versions = await window.api.getModVersions(result.id, filters.mcVersion, filters.loader);
      if (!versions.length) throw new Error('No compatible modpack version found for that filter.');
      const file = versions[0].files.find((f) => f.primary) || versions[0].files[0];

      log(`Installing modpack "${result.title}"...`);
      document.getElementById('progress-wrap').hidden = false;
      await window.api.installModpack(file.url, result.title);
      document.getElementById('progress-wrap').hidden = true;

      log(`Modpack "${result.title}" installed.`);
      btnEl.textContent = 'Installed';
      await refreshInstalledModpacks();
    }
  } catch (err) {
    log(`Install failed: ${err.message}`);
    btnEl.textContent = 'Install';
    btnEl.disabled = false;
  }
}

window.api.onModpackProgress((data) => {
  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  if (data.percent != null) fill.style.width = `${data.percent}%`;
  if (data.message) text.textContent = data.message;
});

// =============================================================================
// PLAY
// =============================================================================

window.api.onDownloadProgress((data) => {
  const wrap = document.getElementById('progress-wrap');
  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  wrap.hidden = false;
  if (data.total) {
    const pct = Math.round((data.task / data.total) * 100);
    fill.style.width = `${pct}%`;
  }
  text.textContent = data.type ? `Downloading ${data.type}...` : 'Preparing...';
});

window.api.onGameLog((line) => log(line));

function setPlayButtonEnabled(enabled) {
  const playBtn = document.getElementById('btn-play');
  playBtn.disabled = !enabled;
  playBtn.classList.toggle('play-button--disabled', !enabled);
}

window.api.onGameClosed((code) => {
  log(`Game exited with code ${code}`);
  document.getElementById('progress-wrap').hidden = true;
  setPlayButtonEnabled(true);
});

document.getElementById('btn-play').onclick = async () => {
  const playBtn = document.getElementById('btn-play');
  if (playBtn.disabled) return; // guards rapid double-fire before the async work below even starts

  if (!activeProfile) {
    log('Log in first (Profiles tab) before launching.');
    return;
  }

  setPlayButtonEnabled(false);

  const source = document.getElementById('src-modpack-btn').classList.contains('active') ? 'modpack' : 'version';

  const config = {
    profile: activeProfile,
    memory: {
      min: document.getElementById('mem-min')?.value || '2G',
      max: document.getElementById('mem-max')?.value || '4G',
    },
    javaPath: document.getElementById('java-path')?.value || 'auto',
    loader: null,
  };

  try {
    if (source === 'modpack') {
      const instId = document.getElementById('select-modpack-instance').value;
      if (!instId) {
        log('No modpack selected. Install one from the Modpack Downloader tab first.');
        return;
      }
      const instances = await window.api.listInstances();
      const inst = instances.find((i) => i.id === instId);
      if (!inst?.meta) throw new Error('Could not read modpack metadata.');

      config.instanceId = instId;
      config.version = { number: inst.meta.mcVersion, type: 'release' };

      if (inst.meta.loaderType === 'forge') {
        log('Preparing Forge for this modpack...');
        const forgeResult = await window.api.installForge(inst.meta.mcVersion, inst.meta.loaderVersion);
        config.loader = { type: 'forge', forge: forgeResult.installerPath };
      } else if (inst.meta.loaderType === 'fabric') {
        log('Preparing Fabric for this modpack...');
        const fabricResult = await window.api.installFabric(inst.meta.mcVersion, inst.meta.loaderVersion);
        config.loader = { type: 'fabric', versionId: fabricResult.versionId };
      }

      log(`Launching modpack "${inst.meta.name}"...`);
    } else {
      const mcVersion = document.getElementById('select-mc-version').value;
      const loaderType = document.getElementById('select-loader').value;

      config.version = { number: mcVersion, type: 'release' };

      if (loaderType === 'forge') {
        log('Resolving Forge install...');
        const forgeResult = await window.api.installForge(mcVersion, undefined); // undefined -> auto "recommended"
        config.loader = { type: 'forge', forge: forgeResult.installerPath };
      } else if (loaderType === 'fabric') {
        log('Resolving Fabric install...');
        const fabricResult = await window.api.installFabric(mcVersion, null);
        config.loader = { type: 'fabric', versionId: fabricResult.versionId };
      }

      log(`Launching Minecraft ${mcVersion}${loaderType ? ' (' + loaderType + ')' : ''}...`);
    }

    document.getElementById('progress-wrap').hidden = false;
    await window.api.launchGame(config);
  } catch (err) {
    log(`Launch failed: ${err.message}`);
    document.getElementById('progress-wrap').hidden = true;
    setPlayButtonEnabled(true);
  }
  // Note: on success we deliberately do NOT re-enable here — the button
  // stays disabled until game:closed fires (see onGameClosed above), since
  // launchGame() resolving just means the process *started*, not exited.
};
