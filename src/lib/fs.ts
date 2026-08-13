import { saveHandle, saveBlob } from './db';

export function isInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function hasFileSystemAccess(): boolean {
  return !isInIframe() &&
    typeof window !== 'undefined' &&
    'showDirectoryPicker' in window &&
    'showOpenFilePicker' in window;
}

export function isAudioFile(name: string): boolean {
  return /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(name);
}

export function isImageFile(name: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(name);
}

export function isVideoFile(name: string): boolean {
  return /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(name);
}

export function genId(): string {
  return crypto.randomUUID();
}

// ─── Native pickers ───────────────────────────────────────────

export async function pickAudioFilesNative(): Promise<{ handle: FileSystemFileHandle; name: string }[]> {
  const handles = await (window as any).showOpenFilePicker({
    multiple: true,
    types: [{ description: 'Audio', accept: { 'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'] } }],
  });
  return handles.map((h: FileSystemFileHandle) => ({ handle: h, name: h.name }));
}

export async function pickFolderNative(): Promise<FileSystemDirectoryHandle> {
  return await (window as any).showDirectoryPicker();
}

// ─── Fallback pickers (standard file inputs — work in any iframe) ────

export function pickAudioFilesInput(): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac';
    input.onchange = () => {
      const files = Array.from(input.files || []);
      if (files.length === 0) reject(new Error('No files selected'));
      else resolve(files);
    };
    input.onerror = () => reject(new Error('File picker error'));
    input.click();
  });
}

export function pickFolderInput(): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as any).webkitdirectory = true;
    input.onchange = () => {
      const files = Array.from(input.files || []);
      if (files.length === 0) reject(new Error('No files selected'));
      else resolve(files);
    };
    input.onerror = () => reject(new Error('Folder picker error'));
    input.click();
  });
}

// ─── Combined pickers (try native, fall back to input) ────────

export async function pickAudioFiles(): Promise<{ mode: 'native' | 'fallback'; files: { name: string; handle?: FileSystemFileHandle; blob?: File }[] }> {
  if (hasFileSystemAccess()) {
    try {
      const results = await pickAudioFilesNative();
      return { mode: 'native', files: results.map(r => ({ name: r.name, handle: r.handle })) };
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      // fall through to fallback
    }
  }
  const files = await pickAudioFilesInput();
  return { mode: 'fallback', files: files.map(f => ({ name: f.name, blob: f })) };
}

export async function pickFolder(): Promise<{ mode: 'native' | 'fallback'; handle?: FileSystemDirectoryHandle; files?: File[] }> {
  if (hasFileSystemAccess()) {
    try {
      const handle = await pickFolderNative();
      return { mode: 'native', handle };
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
    }
  }
  const files = await pickFolderInput();
  return { mode: 'fallback', files };
}

// ─── Persist picked items ─────────────────────────────────────

export async function persistAudioPart(
  part: { name: string; handle?: FileSystemFileHandle; blob?: File },
  id: string,
): Promise<{ handleId?: string; blobId?: string; size: number }> {
  if (part.handle) {
    await saveHandle(id, part.handle);
    const file = await part.handle.getFile();
    return { handleId: id, size: file.size };
  } else if (part.blob) {
    await saveBlob(id, part.blob);
    return { blobId: id, size: part.blob.size };
  }
  return { size: 0 };
}

export async function persistFolder(
  result: { mode: 'native' | 'fallback'; handle?: FileSystemDirectoryHandle; files?: File[] },
  idPrefix: string,
): Promise<{ handleId?: string; blobIds?: string[]; mode: 'native' | 'fallback' }> {
  if (result.mode === 'native' && result.handle) {
    await saveHandle(idPrefix, result.handle);
    return { handleId: idPrefix, mode: 'native' };
  }
  const blobIds: string[] = [];
  if (result.files) {
    for (const file of result.files) {
      const id = genId();
      await saveBlob(id, file);
      blobIds.push(id);
    }
  }
  return { blobIds, mode: 'fallback' };
}

// ─── Read files from storage ──────────────────────────────────

export async function readFileFromHandle(handle: FileSystemFileHandle): Promise<File> {
  return await handle.getFile();
}

export async function verifyPermission(handle: FileSystemHandle, readWrite = false): Promise<boolean> {
  const opts: any = { mode: readWrite ? 'readwrite' : 'read' };
  try {
    if ((await (handle as any).queryPermission(opts)) === 'granted') return true;
    // requestPermission needs a fresh user gesture; if we're mid-pipeline it
    // throws "User activation is required". Treat that as "not granted" instead
    // of crashing — permissions are requested up front on the Process click.
    if ((await (handle as any).requestPermission(opts)) === 'granted') return true;
  } catch {
    /* no activation available — fall through */
  }
  return false;
}

/**
 * Request read permission for a batch of handles. Call this synchronously from
 * a user gesture (e.g. the Process click) so the browser's transient
 * activation is still valid — all requests are initiated within the one gesture.
 */
export async function requestReadPermissions(handles: FileSystemHandle[]): Promise<void> {
  await Promise.all(
    handles.map(async (h) => {
      try {
        if ((await (h as any).queryPermission({ mode: 'read' })) === 'granted') return;
        await (h as any).requestPermission({ mode: 'read' });
      } catch {
        /* ignore — will be handled gracefully during scan */
      }
    }),
  );
}
