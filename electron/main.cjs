const { app, BrowserWindow, session, shell, Menu, protocol, net, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

// ─── Native offline transcription (whisper.cpp) ───────────────────────────
// A self-contained whisper.cpp binary + ggml model are bundled as extra
// resources. This runs Whisper natively (all CPU cores) — far faster and more
// reliable than the in-browser WASM engine, fully offline and free.
function nativeDir() {
  if (process.env.AUTOCAPCUT_NATIVE_DIR) return process.env.AUTOCAPCUT_NATIVE_DIR;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(__dirname, '..', 'native');
}
function nativeBinPath() {
  return path.join(nativeDir(), process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
}
function nativeModelPath() {
  return path.join(nativeDir(), 'ggml-tiny.en.bin');
}

// ─── Video export folder ─────────────────────────────────────────
// The renderer triggers a normal browser download for the finished MP4; we
// intercept it here and save it into the user's chosen folder (remembered
// across projects), then reveal it in the file manager so it's never "lost".
let exportDir = null;

function defaultExportDir() {
  try { return app.getPath('videos'); } catch { /* fall through */ }
  try { return app.getPath('downloads'); } catch { return app.getPath('home'); }
}

ipcMain.handle('get-export-dir', () => exportDir || defaultExportDir());
ipcMain.handle('set-export-dir', (_e, dir) => { if (typeof dir === 'string' && dir) exportDir = dir; return exportDir; });
ipcMain.handle('pick-export-dir', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose where to save exported videos',
    defaultPath: exportDir || defaultExportDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  exportDir = res.filePaths[0];
  return exportDir;
});
ipcMain.handle('reveal-path', (_e, p) => { if (p) shell.showItemInFolder(p); });

// ─── Streaming export to disk (memory-safe for long videos) ──────
let exportFd = null;
let exportSavePath = null;

function closeExportFd() {
  if (exportFd !== null) { try { fs.closeSync(exportFd); } catch { /* ignore */ } exportFd = null; }
}

ipcMain.handle('export-stream-open', (_e, { filename }) => {
  closeExportFd();
  const dir = exportDir || defaultExportDir();
  fs.mkdirSync(dir, { recursive: true });
  exportSavePath = path.join(dir, filename);
  exportFd = fs.openSync(exportSavePath, 'w');
  return exportSavePath;
});
ipcMain.handle('export-stream-write', (_e, { chunk, position }) => {
  if (exportFd === null) throw new Error('No export file is open');
  const buf = Buffer.from(chunk); // chunk arrives as a Uint8Array/ArrayBuffer
  // Explicit position makes writes order-independent; throws ENOSPC if full.
  fs.writeSync(exportFd, buf, 0, buf.length, position);
  return true;
});
ipcMain.handle('export-stream-close', () => {
  closeExportFd();
  const p = exportSavePath;
  if (p) shell.showItemInFolder(p);
  return p;
});
ipcMain.handle('export-stream-abort', () => {
  closeExportFd();
  try { if (exportSavePath) fs.unlinkSync(exportSavePath); } catch { /* ignore */ }
  exportSavePath = null;
  return true;
});

ipcMain.handle('native-available', () => {
  try {
    return fs.existsSync(nativeBinPath()) && fs.existsSync(nativeModelPath());
  } catch {
    return false;
  }
});

ipcMain.handle('native-transcribe', async (_event, { wavBuffer }) => {
  const bin = nativeBinPath();
  const model = nativeModelPath();
  if (!fs.existsSync(bin) || !fs.existsSync(model)) {
    return { ok: false, error: 'Bundled transcription engine not found.' };
  }
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const wavPath = path.join(os.tmpdir(), `autocapcut-${stamp}.wav`);
  const outBase = path.join(os.tmpdir(), `autocapcut-${stamp}-out`);
  const jsonPath = `${outBase}.json`;
  try {
    fs.writeFileSync(wavPath, Buffer.from(wavBuffer));
    const threads = Math.max(2, Math.min(os.cpus().length || 4, 8));
    await new Promise((resolve, reject) => {
      execFile(
        bin,
        ['-m', model, '-f', wavPath, '-oj', '-of', outBase, '-ml', '1', '-np', '-t', String(threads)],
        { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err) => (err ? reject(err) : resolve(undefined)),
      );
    });
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const words = (parsed.transcription || []).map((s) => ({
      word: (s.text || '').trim(),
      start: (s.offsets?.from ?? 0) / 1000,
      end: (s.offsets?.to ?? 0) / 1000,
    })).filter((w) => w.word.length > 0);
    return { ok: true, words };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    for (const f of [wavPath, jsonPath]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

// Online transcription via Groq's Whisper API. Runs in the main process so the
// request isn't subject to renderer CORS and the key stays out of any web origin.
ipcMain.handle('groq-transcribe', async (_event, { apiKey, wavBuffer, model }) => {
  try {
    if (!apiKey) return { ok: false, error: 'No Groq API key set.' };
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(wavBuffer)], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', model || 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: json?.error?.message || `Groq HTTP ${res.status}` };
    }
    return { ok: true, words: json.words || [], segments: json.segments || [], text: json.text || '' };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

const DIST = path.join(__dirname, '..', 'dist');

// Serve the built app from a custom "app://" origin instead of file://.
// A standard, secure scheme gives the page a real same-origin context, so ES
// modules and WASM load correctly — file:// blocks module scripts as
// cross-origin. Relative asset paths (vite base './') resolve against
// app://local/ automatically.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function resolveWithinDist(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.join(DIST, rel || 'index.html');
  // Prevent path traversal outside dist.
  if (!target.startsWith(DIST)) return path.join(DIST, 'index.html');
  return target;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    title: 'AutoCapcut',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // Keep timers/rendering running at full speed when the window is
      // minimized or in the background, so a video export never stalls.
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.loadURL('app://local/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const filePath = resolveWithinDist(pathname);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Allow the File System Access API (folder/file pickers) inside the app.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  // Save exported videos into the chosen folder and reveal them afterwards.
  session.defaultSession.on('will-download', (_event, item) => {
    const dir = exportDir || defaultExportDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const savePath = path.join(dir, item.getFilename());
    item.setSavePath(savePath);
    item.once('done', (_e, state) => {
      const wc = BrowserWindow.getAllWindows()[0]?.webContents;
      if (state === 'completed') {
        if (wc) wc.send('export-saved', savePath);
        shell.showItemInFolder(savePath);
      } else if (wc) {
        wc.send('export-save-failed', String(state));
      }
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
