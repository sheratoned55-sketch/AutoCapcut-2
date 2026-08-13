import { useState, useEffect } from 'react';
import { Plus, Trash2, Film, Clock, AlertTriangle, HardDrive, FolderOpen } from 'lucide-react';
import { useStore } from '../store';
import { NewProjectModal } from './NewProjectModal';

function formatDuration(seconds: number): string {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function HomeScreen() {
  const { projects, openProject, removeProject, storageInfo, loading } = useStore();
  const [showNew, setShowNew] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center">
              <Film size={22} className="text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold">CapCut Auto-Editor <span className="align-middle text-xs font-normal text-neutral-500 border border-neutral-700 rounded px-1.5 py-0.5">v{__APP_VERSION__}</span></h1>
              <p className="text-sm text-neutral-400">Match media to script segments, export to CapCut</p>
            </div>
          </div>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-4 py-2.5 font-medium transition-colors"
          >
            <Plus size={18} />
            New Project
          </button>
        </div>

        {/* Storage info */}
        <div className="flex items-center gap-2 text-sm text-neutral-400 mb-6">
          <HardDrive size={16} />
          <span>Browser storage: {formatBytes(storageInfo.usage)} used</span>
          {storageInfo.quota > 0 && (
            <span className="text-neutral-600">/ {formatBytes(storageInfo.quota)}</span>
          )}
        </div>

        {/* Project list */}
        {loading ? (
          <div className="text-center py-20 text-neutral-500">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="text-center py-20">
            <div className="inline-flex w-16 h-16 rounded-2xl bg-neutral-800 items-center justify-center mb-4">
              <FolderOpen size={28} className="text-neutral-500" />
            </div>
            <h2 className="text-lg font-medium text-neutral-300 mb-2">No projects yet</h2>
            <p className="text-sm text-neutral-500 mb-6">Create a new project to get started</p>
            <button
              onClick={() => setShowNew(true)}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-5 py-2.5 font-medium transition-colors"
            >
              <Plus size={18} />
              New Project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p) => (
              <div
                key={p.id}
                onClick={() => openProject(p.id)}
                className="group bg-neutral-900 border border-neutral-800 hover:border-neutral-600 rounded-xl p-5 cursor-pointer transition-all hover:shadow-lg"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-lg bg-neutral-800 flex items-center justify-center">
                      <Film size={16} className="text-blue-400" />
                    </div>
                    <h3 className="font-medium text-white truncate max-w-[160px]">{p.name}</h3>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteId(p.id); }}
                    className="text-neutral-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <div className="flex items-center gap-4 text-xs text-neutral-400">
                  <span className="flex items-center gap-1">
                    <Clock size={12} />
                    {formatDuration(p.audioDuration)}
                  </span>
                  <span>{p.segments.length} segments</span>
                  <span>{p.clips.length} clips</span>
                </div>
                {p.segments.some(s => !s.hasMedia) && (
                  <div className="flex items-center gap-1 mt-2 text-xs text-yellow-500">
                    <AlertTriangle size={12} />
                    Missing media
                  </div>
                )}
                <div className="text-xs text-neutral-600 mt-2">
                  {new Date(p.updatedAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setDeleteId(null)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-2xl p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-950 flex items-center justify-center">
                <Trash2 size={18} className="text-red-400" />
              </div>
              <h3 className="text-lg font-semibold">Delete project?</h3>
            </div>
            <p className="text-sm text-neutral-400 mb-5">This will permanently delete the project and all its stored media from your browser. This cannot be undone.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleteId(null)} className="px-4 py-2 text-neutral-400 hover:text-white transition-colors">Cancel</button>
              <button
                onClick={() => { removeProject(deleteId); setDeleteId(null); }}
                className="bg-red-600 hover:bg-red-500 text-white rounded-lg px-4 py-2 font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
    </div>
  );
}
