import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { createReadStream, existsSync, statSync, mkdirSync, copyFileSync, cpSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const nodeModule = (m: string) => fileURLToPath(new URL(`./node_modules/${m}`, import.meta.url));

// App version, shown in the UI so users can confirm which build they're running.
const pkgVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
).version as string;

// Location of the bundled Whisper model. Populated locally by
// tests/fetch-model.sh (and in CI by the same script). If present at build
// time it is copied into dist/models so the packaged app runs transcription
// fully offline; if absent, the app falls back to downloading it at runtime.
const MODEL_SRC = fileURLToPath(new URL('./tests/local-assets/models', import.meta.url));

// The ONNX-runtime WASM binaries (used by Whisper transcription). They ship
// with the onnxruntime-web dependency, so we copy them out of node_modules into
// dist/ort at build time and serve them from /ort in dev — the app loads them
// from a bundled path instead of a CDN, so transcription works offline in the
// packaged desktop app. numThreads=1 in audio.ts means only these two
// (non-threaded) variants are ever requested.
const ORT_WASM = ['ort-wasm.wasm', 'ort-wasm-simd.wasm'];
const ortDist = nodeModule('onnxruntime-web/dist');

function ortWasm(): Plugin {
  return {
    name: 'ort-wasm',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith('/ort/')) return next();
        const file = join(ortDist, url.slice('/ort/'.length));
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'application/wasm');
        createReadStream(file).pipe(res);
      });
    },
  };
}

function ortWasmBuild(): Plugin {
  return {
    name: 'ort-wasm-build',
    apply: 'build',
    writeBundle(outputOptions) {
      const outDir = outputOptions.dir || 'dist';
      const dest = join(outDir, 'ort');
      mkdirSync(dest, { recursive: true });
      for (const f of ORT_WASM) copyFileSync(join(ortDist, f), join(dest, f));
    },
  };
}

// Copy the bundled Whisper model into dist/models at build time (if present),
// so the packaged app can transcribe offline with no model download.
function modelBuild(): Plugin {
  return {
    name: 'model-build',
    apply: 'build',
    writeBundle(outputOptions) {
      if (!existsSync(MODEL_SRC)) {
        this.warn('tests/local-assets/models not found — the app will download the model at runtime. Run tests/fetch-model.sh to bundle it offline.');
        return;
      }
      const outDir = outputOptions.dir || 'dist';
      cpSync(MODEL_SRC, join(outDir, 'models'), { recursive: true });
    },
  };
}

// Dev-only: serve the local Whisper model (tests/local-assets) so the opt-in
// `?whisper=1` test can run inference offline. These files are NOT shipped or
// bundled — they only exist to make the test suite runnable without network.
function localTestAssets(): Plugin {
  const root = fileURLToPath(new URL('./tests/local-assets', import.meta.url));
  const mime: Record<string, string> = {
    '.json': 'application/json', '.onnx': 'application/octet-stream',
    '.wasm': 'application/wasm', '.txt': 'text/plain',
  };
  return {
    name: 'local-test-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith('/models/')) return next();
        const file = join(root, url);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the built app also loads from file:// (Electron).
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [react(), ortWasm(), ortWasmBuild(), modelBuild(), localTestAssets()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    // Pre-bundle transformers together with onnxruntime-web and
    // onnxruntime-common. Excluding it (the previous setting) left ort-web as a
    // raw webpack UMD bundle whose internal module registry Vite's CJS interop
    // broke, so onnxruntime-common resolved to undefined and the Whisper
    // backend failed to register ("registerBackend" crash).
    include: ['@xenova/transformers', 'onnxruntime-web'],
    exclude: ['lucide-react'],
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          transformers: ['@xenova/transformers'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
