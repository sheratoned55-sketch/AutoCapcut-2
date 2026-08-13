# AutoCapcut

A standalone auto-editor — a Windows desktop app. Drop in your audio and media, and it automatically builds an edit, lets you add animations, and **exports a finished MP4 with no CapCut required**.

## What it does

- **Auto-timing:** aligns your script to the audio word-by-word, so every image lasts exactly as long as its part is spoken. (Untouched — this is the core that already works.)
- **Built-in animations (56):** an **Animation** tab with professional In / Out / Combo animations (Zoom, Fade, Slide, Rotate, Ken-Burns pans, cinematic drifts, Float, Pulse, Shake, and more), organised by category and tags. **Star favorites**, set a duration (combos included), and apply to all images, the ones you select, or as a **sequence** that spreads different animations across your images in order. Images whose animation is longer than the image are highlighted so you can adjust them manually.
- **Transitions (10):** dissolve, fade to black/white, slides, zoom in/out and whip — applied between images with an adjustable duration.
- **Live preview:** the Preview tab plays your slideshow with animations and transitions, synced to the audio, in your chosen aspect ratio.
- **Standalone MP4 export:** render straight to an MP4 (**480p, 720p, 1080p, or 2K at 30 or 60 fps**, aspect ratio **16:9 / 9:16 / 1:1 / 4:3**, image fit cover/contain/stretch) — images, audio, animations and transitions baked in, no external editor needed. Uses the browser/Electron WebCodecs H.264 encoder.
- **CapCut draft export (optional):** still available if you'd rather finish in CapCut.
- **Projects:** create, open, edit and delete projects; everything is stored locally.

## Download & install (no coding needed)

1. Go to the [**Releases**](../../releases/latest) page of this repository.
2. Download **AutoCapcut-Setup-1.7.0.exe**.
3. Double-click the downloaded file. Windows may show a "Windows protected your PC" screen — click **More info → Run anyway** (the app is unsigned, which is normal for personal apps).
4. The app installs itself in seconds, opens automatically, and adds an **AutoCapcut** shortcut to your desktop and Start menu.

Prefer not to install anything? Download **AutoCapcut-Portable-1.7.0.exe** instead — it runs directly when you double-click it.

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
