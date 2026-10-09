# silk electron shell, build notes

## how it fits together
- tsc is typecheck only (`npm run typecheck`, `npx tsc --noEmit`).
  it typechecks electron/ and scripts/ against the real core sources.
- esbuild does the emit (`npm run bundle:electron`): bundles
  electron/main.ts into electron/dist/main.js with core inlined,
  and electron/preload.ts into electron/dist/preload.js.
  the electron import stays external, everything else is bundled.
- core is never compiled separately for the shell; the bundle
  inlines whatever core currently exports.

## dev
1. the ui agent serves the renderer on http://localhost:5173 (vite)
2. `npm run electron:dev` bundles electron/ then launches electron
3. `npm run dev` runs vite and electron together via concurrently

## windows packaging

the exact command:

```sh
npm run pack
```

this runs `electron-builder --win` (nsis target, x64, per
electron-builder.yml). requirements:

- run it on a windows 10/11 x64 machine, not cross-compiled
- node 20+ installed
- `npm install` already run in the repo root

output: a `release/` directory containing `Silk Setup <version>.exe`
(nsis installer) plus the win-unpacked folder. install by running the
exe; unsigned builds show a smartscreen warning on first install,
which is expected for local builds. code signing needs a certificate
later and is not required for testing.

### what was verified where

verified in the linux dev container:

- `npx tsc --noEmit` clean (electron, scripts, and core sources)
- `npm run bundle:electron` succeeds (esbuild, main + preload)
- `npm run build` in ui/ succeeds (vite production build)
- electron-builder.yml parses and the nsis config is present

not verified here, on purpose:

- the installer itself was never produced in this container.
  cross-building a windows nsis installer from linux needs wine,
  which is not installed here, so `npm run pack` was not run.
- first real installer build must happen on the windows pc.

## integration notes
- main.ts imports the real core api: Agent, providers, config,
  credentials, permissions, runtime. the agent is constructed per
  chat turn from silk.json settings plus the windows credential
  vault.
- renderer settings are sanitized in main: activeProvider is
  whitelisted, baseUrl must be http(s), and the renderer only ever
  receives keySet booleans, never key material.
- settings live in silk.json under the os user data dir
  (%APPDATA%/Silk on windows), via core loadConfig/saveConfig.
  api keys live in windows credential manager, migrated from any
  legacy plaintext silk.json on first run.
- chat validation errors (missing keys etc.) surface as a chat
  error event, so the ui can route the user to settings.
- approval flow: the agent's ToolRuntime calls back into main,
  main forwards an approval request to the renderer over ipc and
  awaits the user's decision (allow once / session / always / deny).

## paths the ui needs
- dev server must be http://localhost:5173 (main.ts loads it when
  the app is not packaged)
- prod ui must build to ui/dist/index.html
- the renderer talks to the shell only through window.silk, see
  electron/preload.ts for the exact api (chat with streaming
  events, getSettings, saveSettings, approval request/response,
  testProvider)
