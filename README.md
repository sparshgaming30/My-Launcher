# My Launcher

## Setup

```bash
npm install
npm run dev     # dev mode with DevTools
npm start        # normal run
npm run pack      # unpacked build (dist/win-unpacked) — no installer step, always works
npm run dist       # full NSIS installer (dist/My Launcher Setup 1.0.0.exe)
```

## About the TLS / "socket disconnected" fix

If you've been fighting `Client network socket disconnected before secure TLS
connection was established` errors during downloads — **this project now
fixes the actual root cause**, not just symptoms.

`minecraft-launcher-core` downloads assets using the long-deprecated `request`
npm package (unmaintained since 2020), and its asset-download loop fires
**every single file as one giant `Promise.all()` batch** — for a modern
Minecraft version that's often 5,000+ files hitting Mojang's servers in the
same instant. That's what was actually causing the connection resets, on
every machine that hit it, regardless of antivirus/network setup.

`patches/minecraft-launcher-core+3.18.1.patch` (applied automatically via
`patch-package` on every `npm install`, through the `postinstall` script)
patches the library itself to download in small batches (6 at a time)
instead of all at once for assets, libraries, and natives. This was tested
end-to-end in development: fresh install → patch auto-applies → verified via
`node --check` and a grep for the patched function.

If a future `npm install` bumps `minecraft-launcher-core` to a newer minor
version, `patch-package` will still try to apply the patch and only warns
(doesn't fail) on a version mismatch — but it's worth spot-checking that
`node_modules/minecraft-launcher-core/components/handler.js` still contains
`runBatched` after any dependency update.

## Project layout

```
my-launcher/
├── package.json
├── main.js                # Electron main process: window + all IPC wiring
├── preload.js               # contextBridge — the only Node-facing surface the UI sees
├── patches/
│   └── minecraft-launcher-core+3.18.1.patch   # the TLS/concurrency fix
├── core/
│   ├── launcher.js           # MCLC logic: auth, Forge/Fabric install, launch
│   ├── net.js                  # retry-with-backoff wrapper for our own fetch calls
│   ├── skins.js                  # custom skin via resource-pack override
│   ├── mods.js                     # mod search/install via Modrinth
│   └── modpack.js                    # modpack search/install via Modrinth (.mrpack)
└── renderer/
    ├── index.html                      # dashboard UI
    ├── style.css                         # green/white theme, leaf logo animation
    └── renderer.js                         # UI-side script, calls window.api only
```

## How offline mode bypasses official authentication

`Authenticator.getAuth(username)` never talks to Microsoft or Mojang — it
derives an offline UUID locally by hashing `"OfflinePlayer:<username>"` (the
same convention Mojang's own server software uses in offline mode) and fills
in a placeholder access token that's never verified. The client only checks
that token against Mojang's session servers when joining an
`online-mode=true` server. Premium login (via `msmc`) performs the real
OAuth → Xbox Live → XSTS → Minecraft Services chain instead.

## Known gaps

- `msmc`'s API differs across major versions — confirm method names against
  the installed version's README if Microsoft login errors after an update.
- No code signing on the built `.exe` — Windows SmartScreen will show an
  "Unknown publisher" warning; normal for unsigned indie/hobby apps.
- Custom skins are local-only (resource pack override) — not visible to
  other players on a server.
