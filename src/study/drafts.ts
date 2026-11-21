import { appStorage, captureStorageSession } from '../lib/account-storage.ts';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_SOURCES = 32;
export type SaveAttempt = { title: string; body: string; version?: number; clientRequestId?: string };
export interface MaterialDraft {
  format: 1; studySetId: string; materialId: string; title: string; body: string;
  baseVersion: number | null; requestId: string; pending?: SaveAttempt; updatedAt: number;
}
type ReadResult = { draft: MaterialDraft | null; warning?: string; blocked?: boolean };
type Source = { key: string; revision: string };
type Parsed = { draft: MaterialDraft; revision?: string; sources: Source[]; writtenAt: number };
type Snapshot = { key: string; raw: string };
type Tracking = { ownRaw: string | null; origin?: Snapshot; sources: Source[]; blocked: boolean; writtenAt: number };

function key(setId: string, materialId: string): string {
  if (!uuid.test(setId) || (materialId !== 'new' && !uuid.test(materialId))) throw new Error('Invalid draft identity');
  return `sf-k12:cloud-draft:${setId.toLowerCase()}:${materialId.toLowerCase()}`;
}
const isWriterKey = (name: string, base: string) => name.startsWith(base + ':') && uuid.test(name.slice(base.length + 1));
const validVersion = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2147483646;
const blocked = (): ReadResult => ({ draft: null, blocked: true,
  warning: '本机草稿无法读取，已暂停编辑；原记录仍保留。请先到“本机旧数据”导出备份。' });

function parse(raw: string, setId: string, materialId: string): Parsed | null {
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || Array.isArray(d) || d.format !== 1
      || d.studySetId !== setId || d.materialId !== materialId || typeof d.requestId !== 'string' || !uuid.test(d.requestId)
      || typeof d.title !== 'string' || typeof d.body !== 'string' || d.body.length > 2 * 1024 * 1024
      || !(materialId === 'new' ? d.baseVersion === null : validVersion(d.baseVersion)) || !Number.isFinite(d.updatedAt)) return null;
    if (d.pending !== undefined && (!d.pending || typeof d.pending !== 'object' || Array.isArray(d.pending)
      || typeof d.pending.title !== 'string' || typeof d.pending.body !== 'string'
      || (materialId === 'new' ? d.pending.clientRequestId !== d.requestId : !validVersion(d.pending.version)))) return null;
    const sources: Source[] = d._draftSources ?? [];
    if ((d._draftRevision !== undefined && (typeof d._draftRevision !== 'string' || !uuid.test(d._draftRevision)))
      || (d._draftWrittenAt !== undefined && (!Number.isSafeInteger(d._draftWrittenAt) || d._draftWrittenAt < 0))
      || !Array.isArray(sources) || sources.length > MAX_SOURCES
      || sources.some(source => !source || typeof source.key !== 'string' || !isWriterKey(source.key, key(setId, materialId))
        || typeof source.revision !== 'string' || !uuid.test(source.revision))
      || new Set(sources.map(source => source.key)).size !== sources.length
      || (sources.length > 0 && !d._draftRevision)) return null;
    const draft: MaterialDraft = { format: 1, studySetId: d.studySetId, materialId: d.materialId,
      title: d.title, body: d.body, baseVersion: d.baseVersion, requestId: d.requestId, updatedAt: d.updatedAt,
      ...(d.pending ? { pending: { ...d.pending } } : {}) };
    return { draft, revision: d._draftRevision, sources: sources.map(source => ({ key: source.key, revision: source.revision })), writtenAt: d._draftWrittenAt ?? 0 };
  } catch { return null; }
}

/** Use one instance per editor. It is permanently bound to its opening account
 * epoch: a delayed cleanup cannot touch any subsequently signed-in account.
 * Every writer owns its key; recovery keeps originals until explicit clear. */
export function createDraftStore(writerId = crypto.randomUUID()) {
  if (!uuid.test(writerId)) throw new Error('Invalid draft writer');
  const active = captureStorageSession();
  const tracked = new Map<string, Tracking>();
  const ownKey = (base: string) => `${base}:${writerId.toLowerCase()}`;

  function readDraft(setId: string, materialId: string): ReadResult {
    if (!active()) return { draft: null };
    const base = key(setId, materialId), own = ownKey(base), ownRaw = appStorage.getItem(own);
    let chosen: Snapshot | undefined;
    let parsed: Parsed | null = null;
    if (ownRaw !== null) {
      chosen = { key: own, raw: ownRaw };
      parsed = parse(ownRaw, setId, materialId);
    } else {
      const candidates = new Set([base, ...appStorage.keys().filter(name => isWriterKey(name, base))]);
      for (const name of candidates) {
        const raw = appStorage.getItem(name);
        if (raw === null) continue;
        const candidate = parse(raw, setId, materialId);
        // Unreadable originals require explicit export/discard, not replacement.
        if (!candidate) { chosen = { key: name, raw }; parsed = null; break; }
        if (!parsed || candidate.draft.updatedAt > parsed.draft.updatedAt
          || (candidate.draft.updatedAt === parsed.draft.updatedAt && candidate.writtenAt > parsed.writtenAt)) {
          chosen = { key: name, raw }; parsed = candidate;
        }
      }
    }
    const previous = tracked.get(base);
    const origin = chosen?.key === own ? previous?.origin : chosen;
    const lineage = new Map((parsed?.sources ?? []).map(source => [source.key, source]));
    if (chosen && chosen.key !== own && parsed?.revision) lineage.set(chosen.key, { key: chosen.key, revision: parsed.revision });
    lineage.delete(own);
    tracked.set(base, { ownRaw, origin, sources: [...lineage.values()], blocked: !!chosen && !parsed, writtenAt: parsed?.writtenAt ?? 0 });
    if (chosen && !parsed) return blocked();
    return { draft: parsed?.draft ?? null };
  }

  function writeDraft(draft: MaterialDraft): boolean {
    if (!active()) return false;
    try {
      const base = key(draft.studySetId, draft.materialId), own = ownKey(base);
      if (!tracked.has(base)) readDraft(draft.studySetId, draft.materialId);
      const state = tracked.get(base);
      const current = appStorage.getItem(own);
      // Another recovering editor may have acknowledged and removed this old
      // snapshot. Recreating our absent unique key cannot overwrite its work.
      if (!state || state.blocked || state.sources.length > MAX_SOURCES || (current !== null && current !== state.ownRaw)) return false;
      // A pending save can change without another text edit. Its persisted
      // successor must win a recovery tie even within the same millisecond.
      const writtenAt = Math.max(Date.now(), state.writtenAt + 1);
      const value = JSON.stringify({ ...draft, _draftRevision: crypto.randomUUID(), _draftSources: state.sources, _draftWrittenAt: writtenAt });
      if (!parse(value, draft.studySetId, draft.materialId)) return false;
      appStorage.setItem(own, value);
      if (!active() || appStorage.getItem(own) !== value) return false;
      state.ownRaw = value;
      state.writtenAt = writtenAt;
      return true;
    } catch { return false; }
  }

  /** Called only after cloud acknowledgement or explicit user discard. Direct
   * snapshots compare exact bytes. Inherited writer revisions change on every
   * write, so a later edit from another tab survives cleanup. */
  function clearDraft(setId: string, materialId: string): boolean {
    if (!active()) return false;
    const base = key(setId, materialId), own = ownKey(base), state = tracked.get(base);
    if (!state) return true; // Never delete a draft that this editor did not read.
    let cleared = true;
    const removeSnapshot = ({ key: name, raw }: Snapshot) => {
      const current = appStorage.getItem(name);
      if (current === null) return true;
      if (current !== raw) { cleared = false; return false; }
      appStorage.removeItem(name);
      if (appStorage.getItem(name) !== null) { cleared = false; return false; }
      return true;
    };
    try {
      if (state.ownRaw !== null && removeSnapshot({ key: own, raw: state.ownRaw })) state.ownRaw = null;
      if (state.origin) removeSnapshot(state.origin);
      for (const source of state.sources) {
        if (source.key === own || source.key === state.origin?.key) continue;
        const raw = appStorage.getItem(source.key);
        if (raw === null) continue;
        const stored = parse(raw, setId, materialId);
        if (stored?.revision !== source.revision) { cleared = false; continue; }
        removeSnapshot({ key: source.key, raw });
      }
      if (cleared) tracked.set(base, { ownRaw: null, sources: [], blocked: false, writtenAt: 0 });
      return cleared;
    } catch { return false; }
  }
  return { readDraft, writeDraft, clearDraft };
}

// Compatibility callers without asynchronous editor lifetimes may use these.
// Editors use a factory instance so old-account callbacks retain their fence.
let defaultStore: ReturnType<typeof createDraftStore> | undefined;
let defaultActive: (() => boolean) | undefined;
export function readDraft(setId: string, materialId: string): ReadResult {
  if (!defaultActive?.()) { defaultStore = createDraftStore(); defaultActive = captureStorageSession(); }
  return defaultStore!.readDraft(setId, materialId);
}
export function writeDraft(draft: MaterialDraft): boolean {
  if (!defaultStore) readDraft(draft.studySetId, draft.materialId);
  return defaultStore!.writeDraft(draft);
}
export function clearDraft(setId: string, materialId: string): boolean { return defaultStore?.clearDraft(setId, materialId) ?? true; }

export function sameText(a: { title: string; body: string }, b: { title: string; body: string }): boolean {
  return a.title.trim() === b.title && a.body === b.body;
}
/** A lost PATCH response can be reconciled only against the exact acknowledged next version. */
export function acknowledgesAttempt(remote: { title: string; body: string; version: number }, pending?: SaveAttempt): boolean {
  return !!pending && pending.version !== undefined && remote.version === pending.version + 1 && sameText(pending, remote);
}
