import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle2, Download, RefreshCw, Save } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { AuthApiError } from '../auth/api';
import { captureStorageSession } from '../lib/account-storage';
import { createStudyApi, type TextMaterial } from './api';
import { acknowledgesAttempt, createDraftStore, sameText, type MaterialDraft, type SaveAttempt } from './drafts';
import { registerStudyLeaveGuard } from './navigation';
import './editor.css';

type Props = { studySetId: string; materialId?: string; onNavigate: (path: string) => void; onSaved: (material: TextMaterial) => void };
const message = (reason: unknown) => reason instanceof Error ? reason.message : '保存未完成，请保留草稿后重试。';
const cancelled = (reason: unknown) => reason instanceof Error && reason.name === 'AbortError';
const byteLength = (value: string) => new TextEncoder().encode(value).length;

export default function MaterialEditor({ studySetId, materialId, onNavigate, onSaved }: Props) {
  const auth = useAuth();
  const api = useMemo(() => createStudyApi(auth.request), [auth.request]);
  const id = materialId ?? 'new';
  const [draftStore] = useState(() => createDraftStore());
  const { readDraft, writeDraft, clearDraft } = draftStore;
  const [initial] = useState(() => readDraft(studySetId, id));
  const [draft, setDraft] = useState<MaterialDraft>(() => initial.draft ?? {
    format: 1, studySetId, materialId: id, title: '', body: '', baseVersion: null,
    requestId: crypto.randomUUID(), updatedAt: Date.now(),
  });
  const latest = useRef(draft);
  const server = useRef<TextMaterial | null>(null);
  const alive = useRef(true);
  const leavingAfterCreate = useRef(false);
  const canStore = useRef(captureStorageSession());
  const saveController = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(!!materialId);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [draftBlocked, setDraftBlocked] = useState(!!initial.blocked);
  const blockedRef = useRef(!!initial.blocked);
  const [localWarning, setLocalWarning] = useState(initial.warning ?? '');
  const [conflict, setConflict] = useState<TextMaterial | null>(null);
  const [status, setStatus] = useState(initial.draft ? '已恢复本机草稿，尚未同步' : '');
  const isDirty = () => !!latest.current.pending || (server.current ? !sameText(latest.current, server.current) : !!(latest.current.title || latest.current.body));

  function persist(value: MaterialDraft) {
    if (blockedRef.current || !canStore.current() || leavingAfterCreate.current) return false;
    const stored = writeDraft(value);
    if (!stored && alive.current) setLocalWarning('本机草稿未能存储。离开前请保存到云端或下载草稿。');
    return stored;
  }
  function flush() {
    if (isDirty()) persist(latest.current);
  }
  function update(next: MaterialDraft, _immediate = false) {
    latest.current = next; setDraft(next);
    // Persist in the editing event before an account boundary can unmount us.
    return persist(next);
  }
  function edit(field: 'title' | 'body', value: string) {
    update({ ...latest.current, [field]: value, updatedAt: Date.now() });
    setStatus('未保存更改'); setError('');
  }

  useEffect(() => {
    alive.current = true;
    const unregister = registerStudyLeaveGuard(() => {
      if (leavingAfterCreate.current) return true;
      flush();
      const accepted = !isDirty() || window.confirm('资料尚未同步到云端。请确认草稿已保留或下载，确定离开吗？');
      if (accepted) saveController.current?.abort();
      return accepted;
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (isDirty() && !leavingAfterCreate.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      flush(); alive.current = false; saveController.current?.abort(); unregister();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  useEffect(() => {
    if (!materialId) return;
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    void api.getMaterial(studySetId, materialId, controller.signal).then(remote => {
      if (controller.signal.aborted) return;
      server.current = remote;
      const local = latest.current;
      if (local.baseVersion === null || sameText(local, remote)) {
        const next = { ...local, title: remote.title, body: remote.body, baseVersion: remote.version, pending: undefined };
        
        latest.current = next; setDraft(next); if (!blockedRef.current) clearDraft(studySetId, id); setStatus('已保存到云端');
      } else if (acknowledgesAttempt(remote, local.pending)) {
        update({ ...local, baseVersion: remote.version, pending: undefined }, true);
        setStatus('上次保存已确认；当前草稿尚未同步');
      } else if (local.baseVersion !== remote.version) {
        setConflict(remote); setStatus('发现版本冲突，草稿已保留');
      } else setStatus('已恢复本机草稿，尚未同步');
    }).catch(reason => { if (!controller.signal.aborted && !cancelled(reason)) setLoadError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, studySetId, materialId, id, loadAttempt]);

  function download() {
    const content = `${latest.current.title}\n\n${latest.current.body}`;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'StudyC-未同步草稿.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function acknowledge(remote: TextMaterial, attempt: SaveAttempt) {
    const local = latest.current;
    server.current = remote;
    const untouched = local.title.trim() === attempt.title && local.body === attempt.body;
    const next = { ...local, title: untouched ? remote.title : local.title, body: untouched ? remote.body : local.body,
      baseVersion: remote.version, pending: undefined, updatedAt: Date.now() };
    
    latest.current = next; setDraft(next); setConflict(null); setError('');
    if (sameText(next, remote)) { clearDraft(studySetId, id); setStatus('已保存到云端'); }
    else { persist(next); setStatus('上次保存已确认；当前草稿尚未同步'); }
    onSaved(remote);
  }
  async function save() {
    if (blockedRef.current || busyRef.current || loading || loadError || conflict) return;
    const local = latest.current;
    const title = local.title.trim();
    if (!local.pending && (Array.from(title).length < 1 || Array.from(title).length > 120)) {
      setError('资料名称请填写 1–120 个字符。'); return;
    }
    if (!local.pending && (byteLength(local.body) > 1048576 || /[\u0000\uD800-\uDFFF]/u.test(title + local.body))) {
      setError('正文最多 1 MiB UTF-8 文本，且不能包含无效字符。'); return;
    }
    const attempt: SaveAttempt = local.pending ?? (materialId
      ? { version: local.baseVersion!, title, body: local.body }
      : { clientRequestId: local.requestId, title, body: local.body });
    if (byteLength(JSON.stringify(attempt)) > 2097152) { setError('文本转义后的请求超过 2 MiB，请缩短后保存。'); return; }
    busyRef.current = true; setBusy(true); setError(''); setStatus('正在保存…');
    const durable = update({ ...local, pending: attempt }, true);
    if (!materialId && !durable) {
      busyRef.current = false; setBusy(false); setStatus('尚未保存');
      setError('无法保留创建记录，暂未发送请求。请先下载草稿并允许本机存储，再重试保存。'); return;
    }
    const controller = new AbortController(); saveController.current = controller;
    try {
      const remote = materialId
        ? await api.updateMaterial(studySetId, materialId, { version: attempt.version!, title: attempt.title, body: attempt.body }, controller.signal)
        : await api.createMaterial(studySetId, { clientRequestId: attempt.clientRequestId!, title: attempt.title, body: attempt.body }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (materialId) acknowledge(remote, attempt);
      else {
        const current = latest.current;
        // A retried create uses its original immutable intent, then carries any
        // subsequent edits to the real resource as an explicitly unsaved draft.
        if (!sameText(current, remote)) {
          // Replayed POST returns the current row. A later remote edit must
          // remain a conflict against creation version 1, never a silent rebase.
          const moved = { ...current, materialId: remote.id, baseVersion: sameText(attempt, remote) ? remote.version : 1, pending: undefined };
          if (!writeDraft(moved)) { setLocalWarning('后续修改未能存储，请下载当前草稿后继续。'); setError('资料已建立，但当前修改还未同步；请先下载草稿。'); return; }
        }
        clearDraft(studySetId, 'new'); leavingAfterCreate.current = true;
        
        server.current = remote; latest.current = { ...current, pending: undefined };
        setStatus('已保存到云端'); onSaved(remote);
        onNavigate(`/platform/studyset/${studySetId}/material/${remote.id}`);
      }
    } catch (reason) {
      if (!alive.current || controller.signal.aborted || cancelled(reason)) return;
      if (reason instanceof AuthApiError && reason.code === 'version_conflict' && materialId) {
        try {
          const remote = await api.getMaterial(studySetId, materialId, controller.signal);
          if (!alive.current || controller.signal.aborted) return;
          if (acknowledgesAttempt(remote, attempt)) { acknowledge(remote, attempt); return; }
          setConflict(remote); setStatus('发现版本冲突，草稿已保留');
          setError('云端资料已更新。请比较两个版本，再决定如何继续。');
        } catch (readError) {
          if (!controller.signal.aborted) { setError(`无法读取冲突版本：${message(readError)}`); setStatus('未保存更改'); }
        }
      } else {
        if (reason instanceof AuthApiError && [400, 413, 429].includes(reason.status)) {
          update({ ...latest.current, pending: undefined }, true);
        }
        setError(message(reason)); setStatus('保存未确认，草稿已保留');
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function useRemote() {
    if (!conflict) return;
    server.current = conflict;
    const next = { ...latest.current, title: conflict.title, body: conflict.body, baseVersion: conflict.version, pending: undefined };
    
    latest.current = next; setDraft(next); clearDraft(studySetId, id);
    setConflict(null); setError(''); setStatus('已采用云端版本');
  }
  function keepDraft() {
    if (!conflict) return;
    server.current = conflict;
    update({ ...latest.current, baseVersion: conflict.version, pending: undefined }, true);
    setConflict(null); setError(''); setStatus('保留了我的草稿，请核对后保存');
  }

  return <section className="study-editor" aria-label="文本资料编辑器">
    <div className="study-editor-toolbar"><button className="btn" onClick={() => onNavigate(`/platform/studyset/${studySetId}`)}><ArrowLeft size={16}/>返回资料</button>
      <div className="study-editor-save"><span role="status" className={isDirty() ? 'is-unsaved' : 'is-saved'}>{!isDirty() && server.current && <CheckCircle2 size={15}/>} {status || '新建文本资料'}</span><button className="btn btn-black" disabled={draftBlocked || busy || loading || !!loadError || !!conflict || (!!materialId && !isDirty())} onClick={() => void save()}><Save size={16}/>{busy ? '正在保存…' : materialId ? '保存更改' : '保存资料'}</button></div>
    </div>
    {loading ? <p role="status">正在加载资料…</p> : loadError ? <div className="study-editor-alert" role="alert"><AlertCircle/><div><p>{loadError}</p><button className="btn" onClick={() => setLoadAttempt(v => v + 1)}><RefreshCw size={15}/>重新加载</button>{initial.draft && <button className="btn" onClick={download}>下载本机草稿</button>}</div></div> : <>
      <div className="study-editor-label"><span>纯文本资料</span><span>仅你可见 · {materialId ? `云端版本 ${draft.baseVersion}` : '保存后可跨设备继续'}</span></div>
      {localWarning && <div className="study-editor-warning" role="alert">{localWarning} {draftBlocked ? <><button onClick={() => onNavigate('/platform/local-data')}>查看并导出原记录</button><button onClick={() => { if (!window.confirm('确认已备份损坏的本机草稿？继续将清除该草稿记录。')) return; if (!clearDraft(studySetId, id)) { setLocalWarning('原记录已变更或清理失败，请重新导出备份后再处理。'); return; } blockedRef.current = false; setDraftBlocked(false); setLocalWarning(''); }}>已备份，重新编辑</button></> : <button onClick={download}>下载草稿</button>}</div>}
      {error && <div className="study-editor-alert" role="alert"><AlertCircle size={18}/><div><p>{error}</p>{!conflict && <button className="btn" disabled={busy} onClick={() => void save()}>重试保存</button>}<button className="btn" onClick={download}><Download size={15}/>下载草稿</button></div></div>}
      {draft.pending && !busy && !conflict && <p className="study-editor-warning">上次保存结果尚未确认，重试会先核对原请求，避免重复创建或覆盖资料。</p>}
      <label className="study-editor-title">资料名称<input aria-label="资料名称" value={draft.title} onChange={event => edit('title', event.target.value)} placeholder="给这份资料起个名字" disabled={busy || draftBlocked}/></label>
      <label className="study-editor-body">资料正文<textarea aria-label="资料正文" value={draft.body} onChange={event => edit('body', event.target.value)} placeholder="粘贴学习资料，或从一段新的笔记开始…" spellCheck={false} disabled={busy || draftBlocked}/></label>
      <div className="study-editor-footer"><span>{byteLength(draft.body).toLocaleString()} / 1,048,576 字节</span><span>未同步草稿只保留在本机，不会替代云端保存。</span></div>
      {conflict && <section className="study-editor-conflict" aria-label="解决版本冲突"><h2>资料已在另一处修改</h2><p>两个版本都在这里。选择云端版本会替换当前草稿；保留草稿后，需要再次点击保存才会更新云端。</p><div className="study-editor-versions"><label>我的草稿<input aria-label="我的草稿名称" readOnly value={draft.title}/><textarea aria-label="我的草稿" readOnly value={draft.body}/></label><label>云端版本 · {conflict.version}<input aria-label="云端资料名称" readOnly value={conflict.title}/><textarea aria-label="云端版本" readOnly value={conflict.body}/></label></div><div className="study-editor-conflict-actions"><button className="btn" onClick={useRemote}>使用云端版本</button><button className="btn btn-black" onClick={keepDraft}>保留我的草稿继续编辑</button><button className="btn" onClick={download}>下载我的草稿</button></div></section>}
    </>}
  </section>;
}
