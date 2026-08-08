# My Launcher (boilerplate)

## Setup

```bash
# 1. Scaffold / unzip the project, then install deps
cd mc-launcher
npm install

# 2. Run in dev mode (opens DevTools)
npm run dev

# 3. Run normally
npm start

# 4. Build a distributable (Windows/Mac/Linux via electron-builder)
npm run dist
```

## Project layout

```
mc-launcher/
├── package.json
├── main.js               # Electron main process: window + all IPC wiring
├── preload.js              # contextBridge — the only Node-facing surface the UI sees
├── core/
│   ├── launcher.js          # MCLC logic: auth, Forge/Fabric install, launch
│   ├── instances.js         # Per-version+loader (and per-modpack) folder isolation
│   ├── skins.js              # Custom skin support (resource-pack based)
│   └── modrinth.js            # Mod/modpack search + install via Modrinth's API
└── renderer/
    ├── index.html            # dashboard UI (sidebar + PLAY button + all panels)
    ├── style.css              # dark theme, purple accent
    └── renderer.js             # UI-side script, calls window.api only
```

## Why the MCLC logic lives in `core/` and not the renderer

`minecraft-launcher-core` needs `fs`, `child_process`, etc. With
`contextIsolation: true` + `sandbox: true` (the secure config `main.js`
uses), the renderer has **zero** Node access — that's the point of the
sandbox. So the "renderer backend" logic is written in `core/*.js`,
required by `main.js`, and invoked over `ipcMain.handle(...)` /
`ipcRenderer.invoke(...)`. The renderer's `renderer.js` only ever calls
`window.api.xxx()`, which is the whitelisted bridge `preload.js` sets up.

## How offline mode bypasses official authentication

`Authenticator.getAuth(username)` never talks to Microsoft or Mojang. It:

1. Derives an **offline UUID** locally by hashing `"OfflinePlayer:<username>"`
   — the same convention Mojang's own server software uses in offline mode.
2. Fills in a placeholder `access_token` that is never actually verified
   against Mojang's session servers.

The Minecraft client only checks that token when joining a server running
in **online mode** (`online-mode=true` in `server.properties`). For
singleplayer worlds and any server explicitly running `online-mode=false`,
the client accepts the local, unverified identity. Premium/Microsoft login
(via `msmc`) is different: it performs the real OAuth → Xbox Live → XSTS →
Minecraft Services chain and returns a token that **does** pass the
session-server check, so it works on online-mode servers.

## Forge / Fabric injection, in short

- **Forge**: `core/launcher.js`'s `resolveForgeVersion()` resolves
  "recommended"/"latest"/undefined into a real build number via Forge's
  `promotions_slim.json` feed, downloads the matching installer jar from
  Forge's Maven, then passes its path as `opts.forge` in MCLC's launch
  options — MCLC runs Forge's install routine and patches the classpath.
- **Fabric**: no installer jar — fetch a loader "profile" JSON from
  `meta.fabricmc.net`, write it to `versions/<id>/<id>.json` in the shared
  root, then launch that version id like a normal vanilla version (via
  `custom:` in the version object — `number` stays the real vanilla MC
  version, only `custom` points at the Fabric id).

## Instances (`core/instances.js`)

Each (Minecraft version + loader) combo — or each installed modpack — gets
its own folder under `%APPDATA%/CustomMCLauncher/instances/<id>/` holding
`mods/`, `resourcepacks/`, `saves/`, `config/`. The big shared stuff
(vanilla libraries, assets, version jars) lives once in the shared root and
is reused across every instance, so switching between a plain Fabric 1.20.4
install and a modpack doesn't require re-downloading vanilla assets, but
their mods also never mix in one shared folder.

## Custom skins (`core/skins.js`)

Builds a small resource pack that overrides the vanilla Steve/Alex player
texture (`assets/minecraft/textures/entity/player/{wide,slim}/...`) and
auto-enables it in that instance's `options.txt`. This works fully offline
and needs no account/session verification, but it's a local-only override —
other players on a server won't see it unless the server has its own skin
system. Targets the modern 1.13+ texture layout; pre-1.13 versions use a
different, flatter path and aren't covered by this module as written.

## Mods & modpacks (`core/modrinth.js`)

Searches and installs directly from Modrinth's public API (no key required,
unlike CurseForge's third-party API). `installMod()` drops a single mod jar
into an instance's `mods/`; `installModpack()` downloads every file listed
in a `.mrpack`'s `modrinth.index.json`, applies its `overrides/` folder,
and records the pack's required MC version + loader so the Dashboard's
"Installed Modpack" launch source can use it without re-asking.

## Minecraft version list

Pulled live from Mojang's own `version_manifest_v2.json` — no hardcoded
version list to keep updated. This automatically includes both the legacy
`1.x` scheme and the new `YY.D.H` scheme Mojang switched to starting with
`26.1` ("Tiny Takeover", March 2026), since the manifest itself lists both.
Note that `26.1`+ requires **Java 25** — if launches on newer versions fail
with a Java version error, that's the cause; either update your system
Java or point Settings → Java Path at a Java 25+ install.

## Known gaps to fill in for a production build

- `msmc`'s API differs across major versions — pin a version and confirm the
  `Auth().launch(...)` / `.getMinecraft()` method names against its current
  README before shipping.
- Add real error UI (toasts) instead of just the log box.
- Add a Java runtime bundler/downloader if you don't want to depend on the
  user having a compatible Java installed (especially now that different
  MC versions require different Java majors).
- Add code signing / auto-update (`electron-updater`) for distribution.
- No manual "browse for a local mod .jar" flow yet — mods currently come
  from Modrinth search, not from files already on disk.

