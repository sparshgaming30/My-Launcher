# My Launcher

## Setup

```bash
npm install
npm run dev     # dev mode with DevTools
npm start        # normal run
npm run pack      # unpacked build (dist/win-unpacked) — no installer step, always works
npm run dist       # full NSIS installer (dist/My Launcher Setup 1.0.0.exe)
```

## About the "Electron failed to install correctly" fix

If `npm install` finishes with no errors, but then `npm start` throws:
```
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
```
— that's not actually Electron's fault, and deleting/reinstalling alone won't
fix it. Here's what's really going on and how this project fixes it.

**The cause:** npm 11.16+ (and npm 12, current as of mid-2026) gates every
dependency's install/postinstall script behind an explicit approval list
(`allowScripts`). By default, an unapproved script doesn't fail the install —
it's **silently skipped**, with just a warning buried in the output. Electron
ships its actual binary via its own `postinstall` script (`node install.js`)
— when npm skips that unapproved, `npm install` reports success, but
`electron.exe` was simply never downloaded. The real failure only shows up
later, when you run `npm start` and Electron looks for a binary that doesn't
exist.

**The fix — a project-level `.npmrc` file** (already included in this repo,
at the project root next to `package.json`):
```
dangerously-allow-all-scripts=true
```
This pre-authorizes every dependency's install script, so a plain
`npm install` always runs them — no manual `npm approve-scripts` step, ever,
for you or for anyone who clones this repo.

**If you're hitting this on an existing broken install** (from before this
`.npmrc` existed, or from an interrupted install), the fix is to wipe and
reinstall clean once the file is in place:
```bash
rmdir /s /q node_modules
del package-lock.json
npm install
npm start
```
(On macOS/Linux, use `rm -rf node_modules package-lock.json` instead of the
two Windows commands above.)

**Trade-off, stated plainly:** `dangerously-allow-all-scripts` runs every
dependency's install script unreviewed, which is the exact supply-chain risk
this npm feature exists to prevent. Reasonable for a small personal/hobby
project with a known, short dependency list — not something to blanket-apply
to something handling sensitive data without actually reviewing what's in
`node_modules`.

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


## Known gaps

- `msmc`'s API differs across major versions — confirm method names against
  the installed version's README if Microsoft login errors after an update.
- No code signing on the built `.exe` — Windows SmartScreen will show an
  "Unknown publisher" warning; normal for unsigned indie/hobby apps.
- Custom skins are local-only (resource pack override) — not visible to
  other players on a server.
