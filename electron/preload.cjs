const { contextBridge, ipcRenderer } = require('electron');

// Bridge for online (Groq) transcription. The actual HTTPS request runs in the
// main process (no browser CORS restrictions, and the API key never touches a
// web origin). The renderer sends WAV bytes + the user's key and gets words back.
contextBridge.exposeInMainWorld('autocapcut', {
  groqTranscribe: (apiKey, wavBuffer, model) =>
    ipcRenderer.invoke('groq-transcribe', { apiKey, wavBuffer, model }),
  // Native offline transcription (whisper.cpp) — fast, local, free.
  nativeAvailable: () => ipcRenderer.invoke('native-available'),
  nativeTranscribe: (wavBuffer) => ipcRenderer.invoke('native-transcribe', { wavBuffer }),
  // Video export folder (remembered across projects) + reveal in file manager.
  getExportDir: () => ipcRenderer.invoke('get-export-dir'),
  setExportDir: (dir) => ipcRenderer.invoke('set-export-dir', dir),
  pickExportDir: () => ipcRenderer.invoke('pick-export-dir'),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  onExportSaved: (cb) => ipcRenderer.on('export-saved', (_e, p) => cb(p)),
});
