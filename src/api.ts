export interface SessionInfo {
  configured: boolean;
  authenticated: boolean;
  csrf: string | null;
}

export interface Source {
  id: number;
  name: string;
  url: string;
  branch: string;
  publishedSha: string | null;
  syncStatus: 'queued' | 'running' | 'ready' | 'failed';
  lastError: string | null;
  lastSyncAt: string | null;
  enabled: number;
  syncEnabled: number;
  documentCount: number;
}

export interface DocumentSummary {
  id: number;
  path: string;
  title: string;
  currentSha: string;
}

export interface DocumentDetail extends DocumentSummary {
  sourceId: number;
  sourceName: string;
  publishedSha: string;
  markdown: string;
  plainText: string;
}

export interface SourceDocuments {
  source: { id: number; name: string; publishedSha: string | null; syncStatus: Source['syncStatus'] };
  documents: DocumentSummary[];
}

export interface RecentDocument {
  id: number;
  title: string;
  path: string;
  sourceName: string;
  state: 'unread' | 'reading' | 'completed';
  position: number;
  updatedAt: string;
}

export interface UpdateRun {
  id: number;
  sourceId: number;
  sourceName: string;
  fromSha: string | null;
  toSha: string;
  finishedAt: string;
  changes: Array<{ runId: number; documentId: number; oldPath: string | null; newPath: string | null; kind: string; title: string }>;
}

export interface DocumentDiff {
  runId: number;
  documentId: number;
  sourceId: number;
  sourceName: string;
  title: string;
  kind: string;
  oldPath: string | null;
  newPath: string | null;
  fromSha: string | null;
  toSha: string;
  before: string;
  after: string;
}

export interface AskStatus { configured: boolean; model: string | null }
export interface SyncSettings { intervalMinutes: number }

export interface AskAnswer {
  answer: string;
  citations: Array<{ number: number; documentId: number; title: string; path: string; sourceName: string; publishedSha: string; snippet: string }>;
}

export interface SearchResult {
  id: number;
  title: string;
  path: string;
  sourceId: number;
  sourceName: string;
  publishedSha: string;
  snippet: string;
}

export interface Annotation {
  id: number;
  documentId?: number;
  kind: string;
  note: string;
  color: 'yellow' | 'green' | 'pink' | 'blue';
  exact: string;
  prefix?: string;
  suffix?: string;
  startOffset?: number;
  endOffset?: number;
  anchorStatus: 'anchored' | 'relocated' | 'needs_review';
  createdAt: string;
  title?: string;
  path?: string;
  sourceName?: string;
  documentStatus?: string;
  sourceEnabled?: number;
}

export interface PersonalState {
  reading: { state: 'unread' | 'reading' | 'completed'; position: number; updatedAt: string | null };
  bookmarked: boolean;
  annotations: Annotation[];
}

export interface MarksState {
  annotations: Annotation[];
  bookmarks: Array<{ documentId: number; title: string; path: string; sourceName: string; documentStatus: string; sourceEnabled: number; createdAt: string }>;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function request<T>(path: string, options: RequestInit = {}, csrf?: string | null): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data.code ?? 'REQUEST_FAILED', data.message ?? '请求失败，请重试');
  }
  return response.json() as Promise<T>;
}

export function formatTime(value: string | null): string {
  if (!value) return '尚未同步';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
