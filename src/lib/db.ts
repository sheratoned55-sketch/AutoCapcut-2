import { openDB, IDBPDatabase } from 'idb';

const DB_NAME = 'capcut-auto-editor';
const DB_VERSION = 1;

interface DBSchema {
  projects: { key: string; value: any };
  handles: { key: string; value: FileSystemHandle };
  blobs: { key: string; value: Blob };
  templates: { key: string; value: any };
  settings: { key: string; value: any };
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('handles')) {
          db.createObjectStore('handles');
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs');
        }
        if (!db.objectStoreNames.contains('templates')) {
          db.createObjectStore('templates', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
      },
    });
  }
  return dbPromise;
}

export async function saveProject(project: any) {
  const db = await getDB();
  await db.put('projects', project);
}

export async function getProject(id: string) {
  const db = await getDB();
  return db.get('projects', id);
}

export async function getAllProjects() {
  const db = await getDB();
  return db.getAll('projects');
}

export async function deleteProject(id: string) {
  const db = await getDB();
  const project = await db.get('projects', id);
  if (project) {
    // delete associated blobs (the bulk of the disk usage)
    for (const bid of collectBlobIds(project)) {
      try { await db.delete('blobs', bid); } catch { /* ignore */ }
    }
    // delete associated handles
    for (const hid of collectHandleIds(project)) {
      try { await db.delete('handles', hid); } catch { /* ignore */ }
    }
  }
  await db.delete('projects', id);
  // Sweep up anything left behind by crashes or older buggy versions.
  await purgeOrphans();
}

/**
 * Delete every blob/handle that is not referenced by any remaining project.
 * This reclaims disk from leaked data (e.g. a crash between saving media and
 * saving the project, or projects deleted by an older version that didn't
 * clean up). Safe: collectBlobIds/collectHandleIds cover every reference a
 * well-formed project holds, so nothing in use is removed.
 */
export async function purgeOrphans(): Promise<{ blobsDeleted: number; handlesDeleted: number }> {
  const db = await getDB();
  const projects = await db.getAll('projects');
  const usedBlobs = new Set<string>();
  const usedHandles = new Set<string>();
  for (const p of projects) {
    for (const id of collectBlobIds(p)) usedBlobs.add(id);
    for (const id of collectHandleIds(p)) usedHandles.add(id);
  }
  let blobsDeleted = 0;
  let handlesDeleted = 0;
  for (const key of await db.getAllKeys('blobs')) {
    if (!usedBlobs.has(key as string)) {
      try { await db.delete('blobs', key); blobsDeleted++; } catch { /* ignore */ }
    }
  }
  for (const key of await db.getAllKeys('handles')) {
    if (!usedHandles.has(key as string)) {
      try { await db.delete('handles', key); handlesDeleted++; } catch { /* ignore */ }
    }
  }
  return { blobsDeleted, handlesDeleted };
}

function collectBlobIds(project: any): string[] {
  const ids: string[] = [];
  if (project.folders) {
    project.folders.audioParts?.forEach((p: any) => p.blobId && ids.push(p.blobId));
    ids.push(...(project.folders.imagesBlobIds || []));
    ids.push(...(project.folders.videosBlobIds || []));
  }
  if (project.segments) {
    project.segments.forEach((s: any) => {
      s.matchedMedia?.forEach((m: any) => m.blobId && ids.push(m.blobId));
    });
  }
  if (project.clips) {
    project.clips.forEach((c: any) => c.media?.blobId && ids.push(c.media.blobId));
  }
  return ids;
}

function collectHandleIds(project: any): string[] {
  const ids: string[] = [];
  if (project.folders) {
    project.folders.audioParts?.forEach((p: any) => p.handleId && ids.push(p.handleId));
    if (project.folders.imagesHandleId) ids.push(project.folders.imagesHandleId);
    if (project.folders.videosHandleId) ids.push(project.folders.videosHandleId);
  }
  return ids;
}

export async function saveHandle(id: string, handle: FileSystemHandle) {
  const db = await getDB();
  await db.put('handles', handle, id);
}

export async function getHandle(id: string): Promise<FileSystemHandle | undefined> {
  const db = await getDB();
  return db.get('handles', id);
}

export async function saveBlob(id: string, blob: Blob) {
  const db = await getDB();
  await db.put('blobs', blob, id);
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  const db = await getDB();
  return db.get('blobs', id);
}

export async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  }
  return { usage: 0, quota: 0 };
}

// ─── Template storage ─────────────────────────────────────────

export async function saveTemplate(template: any) {
  const db = await getDB();
  await db.put('templates', template);
}

export async function getTemplate(id: string) {
  const db = await getDB();
  return db.get('templates', id);
}

export async function getAllTemplates() {
  const db = await getDB();
  return db.getAll('templates');
}

export async function deleteTemplate(id: string) {
  const db = await getDB();
  await db.delete('templates', id);
}

// ─── Settings storage ──────────────────────────────────────────

export async function getSetting(key: string) {
  const db = await getDB();
  return db.get('settings', key);
}

export async function setSetting(key: string, value: any) {
  const db = await getDB();
  await db.put('settings', value, key);
}
