export type ProjectMode = 'native' | 'fallback';

export interface AudioPart {
  id: string;
  name: string;
  /** native mode: handle stored in db handles store */
  handleId?: string;
  /** fallback mode: blob stored in db blobs store */
  blobId?: string;
  size: number;
}

export interface FolderRefs {
  imagesHandleId?: string;
  imagesBlobIds?: string[];
  videosHandleId?: string;
  videosBlobIds?: string[];
  audioParts: AudioPart[];
  mode: ProjectMode;
}

export interface MediaItem {
  id: string;
  kind: 'image' | 'video' | 'audio';
  name: string;
  /** segment number this belongs to (1-based), 0 = audio */
  segment: number;
  /** sub-index for multiple media per segment */
  subIndex: number;
  /** native: relative path from folder root; fallback: blob id */
  handlePath?: string;
  blobId?: string;
  size: number;
  /** video duration in seconds */
  duration?: number;
  width?: number;
  height?: number;
  /** cached object URL for preview */
  objectUrl?: string;
}

export interface Segment {
  id: string;
  index: number;
  text: string;
  startTime: number;
  endTime: number;
  /** confidence of alignment 0-1 */
  confidence: number;
  lowConfidence: boolean;
  matchedMedia: MediaItem[];
  hasVideo: boolean;
  hasImages: boolean;
  hasMedia: boolean;
}

export interface Clip {
  id: string;
  segmentIndex: number;
  media: MediaItem;
  /** timeline position in seconds */
  start: number;
  duration: number;
  /** source trim start for videos (seconds) */
  sourceTrimStart: number;
  isImage: boolean;
  /** true if this clip is extending to cover a missing-media segment */
  coveringMissing: boolean;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface PipelineStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  progress: number;
  message?: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  folders: FolderRefs;
  segments: Segment[];
  clips: Clip[];
  audioDuration: number;
  /** duration of each audio part in order (seconds) */
  audioPartDurations: number[];
  transcript: TranscriptWord[];
  pipelineSteps: PipelineStep[];
  processed: boolean;
  /** CapCut export settings */
  capcutUsername?: string;
  capcutDraftsPath?: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  audioDuration: number;
  segmentCount: number;
  hasWarnings: boolean;
  size: number;
}

export interface CapCutTemplate {
  id: string;
  name: string;
  importedAt: number;
  /** raw draft_content.json object */
  draftContent: any;
  /** raw draft_meta_info.json object */
  draftMeta: any;
  /** additional cloned files (draft_settings, draft_virtual_store.json, etc.) */
  extraFiles: { name: string; content: string }[];
  /** Full folder tree of the imported template (relative paths), so modern
   *  CapCut drafts (Timelines/<UUID>/…) can be replicated exactly on export. */
  templateFiles?: { path: string; content: string; base64?: boolean }[];
  /** detected drafts root path from the template's draft_meta_info.json */
  detectedDraftsRoot: string;
  /** path style: '/' or '\\' */
  pathSeparator: string;
}

export interface AppSettings {
  draftsRootPath: string;
  username: string;
  /** 'online' uses Groq's cloud Whisper (fast, needs a free API key); 'offline' runs on-device. */
  transcriptionMode?: 'online' | 'offline';
  /** Groq API key for online transcription (stored locally only). */
  groqApiKey?: string;
  /** Shift all image/segment start times earlier by this many seconds. Increase
   *  if images change too late; negative moves them later. Default 0. */
  imageOffsetSec?: number;
}
