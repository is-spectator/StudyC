import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, LoaderCircle, MessageCircle, Plus, RefreshCw, Send, Square, X } from 'lucide-react';
import { useAuth } from '../../auth/AuthProvider';
import { AuthApiError } from '../../auth/api';
import type { MaterialSummary } from '../api';
import './chat.css';

type Citation = { sourceId: string; materialId: string; version: number; quote: string; start: number; end: number; page: number | null };
type SnapshotSource = { sourceId: string; materialId: string; version: number; title: string; body: string };
type Job = {
  id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; errorCode: string | null;
  result: { answer: string; citations: Citation[]; insufficientEvidence: boolean } | null;
  inputSnapshot?: { sources: SnapshotSource[] };
  sources: { sourceId: string; materialId: string; version: number; title: string }[];
  attemptCount: number; attempts: { id: string; status: string }[];
};
type Thread = { id: string; studySetId: string; title: string; createdAt: string; updatedAt: string };
type Turn = { id: string; threadId: string; sequence: number; question: string; jobId: string; createdAt: string; job: Job };
const active = (job: Job) => job.status === 'queued' || job.status === 'running'
  || job.attempts.some(attempt => attempt.status === 'queued' || attempt.status === 'running');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请重试。';
const rejectedWrite = (error: unknown) => error instanceof AuthApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(error.status);
const failures: Record<string, string> = {
  provider_rate_limited: '模型服务暂时限流，请稍后再试。', provider_timeout: '模型响应超时，可以重新生成。',
  invalid_citation: '这次回答的来源无法核验，未保存为有效回答。', invalid_output: '模型未返回有效回答，可以重试。',
  insufficient_evidence: '选中的资料不足以回答这个问题。', quota_exceeded: '今天的生成额度已用完。',
  config_changed: '模型配置已变化，请开启新一轮提问。', service_unavailable: '生成服务暂时不可用。',
};
function checked<T>(value: T): T { if (!value || typeof value !== 'object') throw new Error('服务返回了无效的数据。'); return value; }

export default function ChatPanel({ studySetId, threadId, materials, onNavigate }: {
  studySetId: string; threadId?: string; materials: MaterialSummary[]; onNavigate: (path: string) => boolean;
}) {
  const auth = useAuth();
  const base = `/v1/study/sets/${studySetId}/chat/threads`;
  const route = `/platform/studyset/${studySetId}/chat`;
  const [threads, setThreads] = useState<Thread[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [streamRevision, setStreamRevision] = useState(0);
  const [draft, setDraft] = useState<{ turnId: string; attemptId: string; text: string } | null>(null);
  const [source, setSource] = useState<{ citation: Citation; snapshot?: SnapshotSource; title: string } | null>(null);
  const epoch = useRef(0);
  const pending = useRef<{ clientRequestId: string; question: string; sources: { materialId: string; version: number }[]; language: 'zh-CN' } | null>(null);
  const creation = useRef<string | null>(null);
  const retryRequest = useRef<{ turnId: string; clientRequestId: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const sourceDialog = useRef<HTMLElement>(null);
  const scope = `${auth.user?.id}:${studySetId}:${threadId ?? 'new'}`;

  useEffect(() => {
    ++epoch.current; setError(''); setSource(null); setDraft(null); setQuestion(''); pending.current = null;
    setSelected([]); setTurns([]); setBusy(false); retryRequest.current = null; creation.current = null;
    return () => { ++epoch.current; };
  }, [scope]);
  useEffect(() => {
    if (!source) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = sourceDialog.current;
    dialog?.querySelector<HTMLElement>('button')?.focus();
    dialog?.querySelector('mark')?.scrollIntoView({ block: 'center' });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setSource(null); }
      if (event.key === 'Tab' && dialog) {
        const elements = Array.from(dialog.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]'));
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, [source]);
  useEffect(() => {
    const abort = new AbortController(), started = epoch.current;
    setLoading(true); setError('');
    void Promise.all([
      auth.request<{ items: Thread[] }>(base, { signal: abort.signal }),
      threadId ? auth.request<{ thread: Thread; turns: Turn[] }>(`${base}/${threadId}`, { signal: abort.signal }) : Promise.resolve(null),
    ]).then(([list, detail]) => {
      if (abort.signal.aborted || started !== epoch.current) return;
      if (!Array.isArray(list.items) || detail && !Array.isArray(detail.turns)) throw new Error('对话记录格式不正确。');
      setThreads(list.items); setTurns(detail?.turns ?? []);
    }).catch(reason => { if (!abort.signal.aborted && started === epoch.current) setError(errorMessage(reason)); })
      .finally(() => { if (!abort.signal.aborted && started === epoch.current) setLoading(false); });
    return () => abort.abort();
  }, [auth.request, base, threadId, revision]);

  const running = turns.find(turn => active(turn.job));
  useEffect(() => {
    if (loading || !running || !threadId) return;
    const abort = new AbortController(), started = epoch.current, turnId = running.id;
    setDraft(null);
    void auth.request<void>(`${base}/${threadId}/messages/${turnId}/events?after=0`, {
      signal: abort.signal,
      onEvent: event => {
        if (started !== epoch.current || abort.signal.aborted) return;
        const data = checked(event.data) as Record<string, unknown>;
        if (event.event === 'progress' && typeof data.text === 'string' && data.text.length <= 32_768 && typeof data.attemptId === 'string') {
          setDraft({ turnId, attemptId: data.attemptId, text: data.text });
        } else if (event.event === 'job' && data.job && typeof data.job === 'object') {
          const job = data.job as Job;
          if (job.id !== running.jobId || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status)) throw new Error('任务状态无法确认。');
          setTurns(old => old.map(turn => turn.id === turnId ? { ...turn, job } : turn));
          if (!active(job)) setDraft(null);
        } else if (event.event === 'error') throw new Error('回答连接暂时中断，请重新连接查看。');
      },
    }).catch(reason => {
      if (!abort.signal.aborted && started === epoch.current) setError(errorMessage(reason));
    });
    return () => abort.abort();
  }, [auth.request, base, threadId, running?.id, streamRevision, loading]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [turns.length, draft?.text]);
  const updateTurn = useCallback((turn: Turn) => setTurns(old => old.some(item => item.id === turn.id) ? old.map(item => item.id === turn.id ? turn : item) : [...old, turn]), []);
  const startThread = async () => {
    if (busy) return;
    const started = epoch.current; setBusy(true); setError('');
    creation.current ??= crypto.randomUUID();
    try {
      const data = await auth.request<{ thread: Thread }>(base, { method: 'POST', body: { clientRequestId: creation.current } });
      if (started !== epoch.current) return;
      creation.current = null; onNavigate(`${route}/${data.thread.id}`);
    } catch (reason) { if (started === epoch.current) { if (rejectedWrite(reason)) creation.current = null; setError(errorMessage(reason)); } }
    finally { if (started === epoch.current) setBusy(false); }
  };
  const send = async () => {
    if (busy || running || !threadId || !question.trim() || !selected.length) return;
    const sources = materials.filter(item => selected.includes(item.id)).map(item => ({ materialId: item.id, version: item.version }));
    if (sources.length !== selected.length) { setError('资料列表已变化，请重新选择。'); return; }
    const next = { question: question.trim(), sources, language: 'zh-CN' as const };
    if (pending.current && JSON.stringify({ ...pending.current, clientRequestId: undefined }) !== JSON.stringify(next)) {
      setError('上一条提问的结果尚未确认，请先刷新对话，核对是否已经提交。'); return;
    }
    pending.current ??= { clientRequestId: crypto.randomUUID(), ...next };
    const started = epoch.current; setBusy(true); setError('');
    try {
      const data = await auth.request<{ turn: Turn }>(`${base}/${threadId}/messages`, { method: 'POST', body: pending.current });
      if (started !== epoch.current) return;
      updateTurn(data.turn); pending.current = null; setQuestion(''); setStreamRevision(value => value + 1);
    } catch (reason) { if (started === epoch.current) { if (rejectedWrite(reason)) pending.current = null; setError(errorMessage(reason)); } }
    finally { if (started === epoch.current) setBusy(false); }
  };
  const confirmPending = async () => {
    if (busy || !pending.current || !threadId) return;
    const intent = pending.current, started = epoch.current; setBusy(true); setError('');
    try {
      const data = await auth.request<{ turn: Turn }>(`${base}/${threadId}/messages`, { method: 'POST', body: intent });
      if (started !== epoch.current) return;
      updateTurn(data.turn); pending.current = null;
      setQuestion(value => value.trim() === intent.question ? '' : value); setStreamRevision(value => value + 1);
    } catch (reason) { if (started === epoch.current) { if (rejectedWrite(reason)) pending.current = null; setError(errorMessage(reason)); } }
    finally { if (started === epoch.current) setBusy(false); }
  };
  const act = async (turn: Turn, action: 'stop' | 'retry') => {
    if (busy) return;
    const started = epoch.current; setBusy(true); setError('');
    if (action === 'retry' && retryRequest.current?.turnId !== turn.id) retryRequest.current = { turnId: turn.id, clientRequestId: crypto.randomUUID() };
    try {
      const data = await auth.request<{ turn: Turn }>(`${base}/${threadId}/messages/${turn.id}/${action}`, { method: 'POST', body: action === 'retry' ? { clientRequestId: retryRequest.current!.clientRequestId } : {} });
      if (started === epoch.current) { updateTurn(data.turn); retryRequest.current = null; setStreamRevision(value => value + 1); }
    } catch (reason) { if (started === epoch.current) setError(errorMessage(reason)); }
    finally { if (started === epoch.current) setBusy(false); }
  };

  return <div className="cloud-page chat-page">
    <div className="cloud-page-heading"><div><span className="cloud-eyebrow">ASK YOUR MATERIALS</span><h1>和小C一起读懂资料</h1><p>选择资料再提问。回答会保留引用，以及生成时使用的资料版本。</p></div><button className="btn" disabled={busy} onClick={() => void startThread()}><Plus size={16} />新对话</button></div>
    <div className="chat-layout">
      <aside className="chat-history" aria-label="对话历史"><h2>对话历史</h2>{threads.map(item => <button key={item.id} className={item.id === threadId ? 'selected' : ''} onClick={() => onNavigate(`${route}/${item.id}`)}><MessageCircle size={15} /><span>{item.title}<small>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.createdAt))}</small></span></button>)}{!loading && !threads.length ? <p>新的问题，从这里开始。</p> : null}</aside>
      <section className="chat-conversation" aria-label="资料问答">
        {error ? <div className="cloud-error" role="alert"><p>{error}</p>{pending.current ? <button className="btn" disabled={busy} onClick={() => void confirmPending()}>核对上次提问</button> : <button className="btn" onClick={() => { setRevision(value => value + 1); setStreamRevision(value => value + 1); }}>重新连接</button>}</div> : null}
        {loading ? <div className="cloud-loading" role="status"><LoaderCircle size={18} />正在读取对话…</div> : null}
        {!loading && !threadId ? <div className="chat-welcome"><img src="/assets/studyc/xiaoc-avatar.svg" alt="小C" /><h2>你的资料里，有哪些值得追问？</h2><p>小C会依据你选中的内容回答，资料不够时也会告诉你。</p><button className="btn btn-black" disabled={busy} onClick={() => void startThread()}>开始一个对话</button></div> : null}
        {threadId ? <>
          <div className="chat-turns" aria-live="polite">
            {!loading && !turns.length ? <div className="chat-welcome compact"><BookOpen size={30} /><p>可以问一个概念、比较两段内容，或让小C解释重点。</p></div> : null}
            {turns.map(turn => <article key={turn.id} className="chat-turn">
              <div className="chat-question"><span>你</span><p>{turn.question}</p></div>
              <div className="chat-answer"><img src="/assets/studyc/xiaoc-avatar.svg" alt="小C" /><div>
                {turn.job.status === 'succeeded' && turn.job.result ? <><p className="chat-answer-text">{turn.job.result.answer}</p>{turn.job.result.insufficientEvidence ? <small>资料不足 · 可以补充内容后再问</small> : null}<div className="chat-citations">{turn.job.result.citations.map((citation, index) => {
                  const snapshot = turn.job.inputSnapshot?.sources.find(item => item.sourceId === citation.sourceId);
                  const title = snapshot?.title ?? turn.job.sources.find(item => item.sourceId === citation.sourceId)?.title ?? '引用资料';
                  return <button key={`${citation.sourceId}:${citation.start}`} onClick={() => setSource({ citation, snapshot, title })}><FileText size={12} />{index + 1}. {title}{citation.page ? ` · 第 ${citation.page} 页` : ''} · v{citation.version}</button>;
                })}</div></> : active(turn.job) ? turn.job.status === 'cancelled' ? <p role="status">正在停止生成，完成后可以重新生成…</p> : <><p className="chat-answer-text">{draft?.turnId === turn.id && draft.text ? draft.text : turn.job.status === 'queued' ? '正在排队…' : '正在阅读资料…'}</p><small>生成中 · 引用核验完成后保存回答</small><button className="chat-text-button" disabled={busy} onClick={() => void act(turn, 'stop')}><Square size={12} />停止生成</button></> : <><p>{turn.job.status === 'cancelled' ? '这次生成已停止。' : turn.job.status === 'interrupted' ? '上一次生成中断，可以明确重试。' : failures[turn.job.errorCode ?? ''] ?? '这次回答未能完成，请稍后重试。'}</p>{turn.job.attemptCount < 3 && turns.at(-1)?.id === turn.id ? <button className="chat-text-button" disabled={busy || !!running} onClick={() => void act(turn, 'retry')}><RefreshCw size={13} />重新生成</button> : <small>{turn.job.attemptCount >= 3 ? '已达到重试次数，请重新提问。' : '可在下方继续提问。'}</small>}</>}
                <small className="chat-source-meta">使用 {turn.job.sources.map(item => `${item.title} v${item.version}`).join('、')}</small>
              </div></div>
            </article>)}<div ref={bottom} />
          </div>
          <div className="chat-compose">
            <fieldset disabled={busy || !!running}><legend>选择本轮资料（最多 5 份）</legend><div className="chat-source-list">{materials.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id) && selected.length >= 5} onChange={event => setSelected(old => event.target.checked ? [...old, item.id] : old.filter(id => id !== item.id))} /><span>{item.title}<small>v{item.version}</small></span></label>)}</div>{!materials.length ? <p>请先回到学习集添加文本或 PDF 资料。</p> : null}</fieldset>
            <form onSubmit={event => { event.preventDefault(); void send(); }}><label className="sr-only" htmlFor="chat-question">向小C提问</label><textarea id="chat-question" placeholder="关于这些资料，你想了解什么？" maxLength={2000} value={question} disabled={busy || !!running} onChange={event => setQuestion(event.target.value)} /><button className="btn btn-black" aria-label="发送问题" disabled={busy || !!running || !question.trim() || !selected.length}><Send size={17} />发送</button></form>
          </div>
        </> : null}
      </section>
    </div>
    {source ? <div className="chat-source-backdrop" onClick={() => setSource(null)}><section ref={sourceDialog} role="dialog" aria-modal="true" aria-labelledby="chat-source-title" className="chat-source-dialog" onClick={event => event.stopPropagation()}><header><div><small>生成时的资料快照 · v{source.citation.version}{source.citation.page ? ` · 第 ${source.citation.page} 页` : ''}</small><h2 id="chat-source-title">{source.title}</h2></div><button className="icon-button" aria-label="关闭引用" onClick={() => setSource(null)}><X /></button></header><blockquote>{source.citation.quote}</blockquote>{source.snapshot ? <pre>{source.snapshot.body.slice(0, source.citation.start)}<mark>{source.snapshot.body.slice(source.citation.start, source.citation.end)}</mark>{source.snapshot.body.slice(source.citation.end)}</pre> : null}<a className="btn" href={`/platform/studyset/${studySetId}/material/${source.citation.materialId}`}>查看当前资料</a></section></div> : null}
  </div>;
}
