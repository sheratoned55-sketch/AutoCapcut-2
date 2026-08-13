import { useState, useCallback } from 'react';
import { X, Folder, FileAudio, Film, Plus, Trash2, ChevronUp, ChevronDown, Info } from 'lucide-react';
import { useStore } from '../store';
import { pickAudioFiles, pickFolder, persistAudioPart, persistFolder, genId, isInIframe, isAudioFile } from '../lib/fs';
import { FolderRefs, AudioPart, ProjectMode } from '../types';

interface SelectedAudioFile {
  name: string;
  handle?: FileSystemFileHandle;
  blob?: File;
}

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { createProject, addLog } = useStore();
  const [name, setName] = useState('');
  const [audioFiles, setAudioFiles] = useState<SelectedAudioFile[]>([]);
  const [imagesResult, setImagesResult] = useState<{ mode: ProjectMode; handle?: FileSystemDirectoryHandle; files?: File[] } | null>(null);
  const [videosResult, setVideosResult] = useState<{ mode: ProjectMode; handle?: FileSystemDirectoryHandle; files?: File[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const inIframe = isInIframe();

  const handlePickAudio = useCallback(async () => {
    try {
      const result = await pickAudioFiles();
      const newFiles = result.files.map((f) => ({ name: f.name, handle: f.handle, blob: f.blob }));
      setAudioFiles((prev) => [...prev, ...newFiles]);
      setError('');
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setError(e.message);
        addLog(`Audio pick error: ${e.message}`, 'error');
      }
    }
  }, [addLog]);

  const handlePickImages = useCallback(async () => {
    try {
      const result = await pickFolder();
      setImagesResult(result);
      setError('');
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setError(e.message);
        addLog(`Images folder pick error: ${e.message}`, 'error');
      }
    }
  }, [addLog]);

  const handlePickVideos = useCallback(async () => {
    try {
      const result = await pickFolder();
      setVideosResult(result);
      setError('');
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setError(e.message);
      addLog(`Videos folder pick error: ${e.message}`, 'error');
      }
    }
  }, [addLog]);

  const moveAudio = (idx: number, dir: -1 | 1) => {
    setAudioFiles((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const removeAudio = (idx: number) => {
    setAudioFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCreate = async () => {
    if (!name.trim()) { setError('Please enter a project name'); return; }
    if (audioFiles.length === 0) { setError('Please select at least one audio file'); return; }
    if (!imagesResult && !videosResult) { setError('Please select at least an images or videos folder'); return; }

    setCreating(true);
    setError('');
    try {
      const mode: ProjectMode = (audioFiles[0].handle || imagesResult?.handle) ? 'native' : 'fallback';

      // Persist audio parts
      const audioParts: AudioPart[] = [];
      for (const f of audioFiles) {
        const id = genId();
        const stored = await persistAudioPart({ name: f.name, handle: f.handle, blob: f.blob }, id);
        audioParts.push({ id, name: f.name, handleId: stored.handleId, blobId: stored.blobId, size: stored.size });
      }

      // Persist folders
      let folders: FolderRefs = { audioParts, mode };

      if (imagesResult) {
        const stored = await persistFolder(imagesResult, 'img_' + genId());
        folders.imagesHandleId = stored.handleId;
        folders.imagesBlobIds = stored.blobIds;
      }

      if (videosResult) {
        const stored = await persistFolder(videosResult, 'vid_' + genId());
        folders.videosHandleId = stored.handleId;
        folders.videosBlobIds = stored.blobIds;
      }

      await createProject(name.trim(), folders);
      addLog(`Created project: ${name.trim()} (${mode} mode)`);
      onClose();
    } catch (e: any) {
      setError(e.message);
      addLog(`Create project error: ${e.message}`, 'error');
    } finally {
      setCreating(false);
    }
  };

  const imagesCount = imagesResult?.files?.filter(f => !isAudioFile(f.name)).length || (imagesResult?.handle ? 'folder' : 0);
  const videosCount = videosResult?.files?.filter(f => !isAudioFile(f.name)).length || (videosResult?.handle ? 'folder' : 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-neutral-900 border border-neutral-700 rounded-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-700">
          <h2 className="text-lg font-semibold text-white">New Project</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {inIframe && (
            <div className="flex items-start gap-2 bg-blue-950/50 border border-blue-800 rounded-lg px-4 py-3 text-sm text-blue-200">
              <Info size={16} className="mt-0.5 shrink-0" />
              <span>Running in sandboxed mode — files are stored in your browser storage and persist across reloads. For live folder access, open this app in a new tab.</span>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Video Project"
              className="w-full bg-neutral-800 border border-neutral-600 rounded-lg px-4 py-2.5 text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          {/* Audio files */}
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">Audio File(s) — Voiceover</label>
            <p className="text-xs text-neutral-500 mb-2">Select one or more audio files (mp3, wav, m4a, aac, ogg). Multiple files are concatenated in order.</p>
            <button
              onClick={handlePickAudio}
              className="w-full flex items-center gap-3 bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 rounded-lg px-4 py-3 text-white transition-colors"
            >
              <FileAudio size={20} className="text-blue-400" />
              <span>{audioFiles.length === 0 ? 'Select audio file(s)' : 'Add more audio parts'}</span>
            </button>
            {audioFiles.length > 0 && (
              <div className="mt-2 space-y-1">
                {audioFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 bg-neutral-800/50 border border-neutral-700 rounded-lg px-3 py-2">
                    <span className="text-xs text-neutral-400 font-mono w-6">{i + 1}.</span>
                    <span className="text-sm text-neutral-200 flex-1 truncate">{f.name}</span>
                    <button onClick={() => moveAudio(i, -1)} disabled={i === 0} className="text-neutral-400 hover:text-white disabled:opacity-30 transition-colors">
                      <ChevronUp size={16} />
                    </button>
                    <button onClick={() => moveAudio(i, 1)} disabled={i === audioFiles.length - 1} className="text-neutral-400 hover:text-white disabled:opacity-30 transition-colors">
                      <ChevronDown size={16} />
                    </button>
                    <button onClick={() => removeAudio(i)} className="text-red-400 hover:text-red-300 transition-colors">
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Images folder */}
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">Images Folder</label>
            <p className="text-xs text-neutral-500 mb-2">Contains images named by segment number: 1.jpg, 01.png, 001.jpg, 1-1.jpg, 1_2.jpg</p>
            <button
              onClick={handlePickImages}
              className="w-full flex items-center gap-3 bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 rounded-lg px-4 py-3 text-white transition-colors"
            >
              <Folder size={20} className="text-green-400" />
              <span>{imagesResult ? (typeof imagesCount === 'number' ? `${imagesCount} files selected` : 'Folder selected') : 'Select images folder'}</span>
            </button>
          </div>

          {/* Videos folder */}
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">Videos Folder (optional)</label>
            <p className="text-xs text-neutral-500 mb-2">Contains videos named the same way: 1.mp4, 01.mp4, 001.mp4</p>
            <button
              onClick={handlePickVideos}
              className="w-full flex items-center gap-3 bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 rounded-lg px-4 py-3 text-white transition-colors"
            >
              <Film size={20} className="text-purple-400" />
              <span>{videosResult ? (typeof videosCount === 'number' ? `${videosCount} files selected` : 'Folder selected') : 'Select videos folder'}</span>
            </button>
          </div>

          {error && (
            <div className="bg-red-950/50 border border-red-800 rounded-lg px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-neutral-700">
          <button onClick={onClose} className="px-4 py-2 text-neutral-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !name.trim() || audioFiles.length === 0}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white rounded-lg px-5 py-2.5 font-medium transition-colors"
          >
            <Plus size={18} />
            {creating ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
