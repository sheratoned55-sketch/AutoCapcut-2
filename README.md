# AutoCapcut

CapCut Auto-Editor — a Windows desktop app. Drop in your audio and media, and it automatically builds an edit you can export.

## Download & install (no coding needed)

1. Go to the [**Releases**](../../releases/latest) page of this repository.
2. Download **AutoCapcut-Setup-1.6.0.exe**.
3. Double-click the downloaded file. Windows may show a "Windows protected your PC" screen — click **More info → Run anyway** (the app is unsigned, which is normal for personal apps).
4. The app installs itself in seconds, opens automatically, and adds an **AutoCapcut** shortcut to your desktop and Start menu.

Prefer not to install anything? Download **AutoCapcut-Portable-1.6.0.exe** instead — it runs directly when you double-click it.

## How the installer is built

Every push to the `main` branch automatically builds the Windows app with GitHub Actions and updates the **latest** release. You never need to run any code yourself.

## For developers

```bash
npm install        # install dependencies
npm run dev        # run in the browser (Vite dev server)
npm run app        # build and run as a desktop app (Electron)
npm run dist:win   # build the Windows installer (on Windows)
```

The web app lives in `src/` (React + Vite + Tailwind); the desktop shell is `electron/main.cjs`; packaging is configured in the `build` section of `package.json`.
