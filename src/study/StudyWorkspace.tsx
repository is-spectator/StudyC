import FoldersPanel from './folders/FoldersPanel';
import SearchPanel from './search/SearchPanel';
import CalendarPanel from './calendar/CalendarPanel';
import PlansPanel from './plans/PlansPanel';
import NotesPanel from './notes/NotesPanel';
import MistakesPanel from './mistakes/MistakesPanel';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Archive, ArrowLeft, ArrowRight, BookOpen, ChevronRight, ClipboardCheck, Cloud, Download, FileText, Folder, Layers, LoaderCircle, LogOut, Menu, MessageCircle, Pencil, Plus, RefreshCw, Route, Search, X } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { appStorage, captureStorageSession } from '../lib/account-storage';
import { createStudyApi, validateStudyTitle, type MaterialSummary, type StudySet, type TextMaterial } from './api';
import MaterialEditor from './MaterialEditor';
import PdfUpload from './PdfUpload';
import ChatPanel from './chat/ChatPanel';
import FlashcardsPanel from './flashcards/FlashcardsPanel';
import QuizzesPanel from './quizzes/QuizzesPanel';
import { confirmStudyLeave, useStudyNavigation } from './navigation';
import { materialPath, parseStudyRoute, studySetPath } from './routes';
import '../app.css';
import '../features/library.css';
import './workspace.css';

type Page<T> = { items: T[]; nextCursor: string | null };
type PageState<T> = Page<T> & { scope?: string; loading: boolean; loadingMore: boolean; error: string; loaded: boolean };
type Api = ReturnType<typeof createStudyApi>;
const message = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请重试。';
const cancelled = (error: unknown) => error instanceof Error && error.name === 'AbortError';

/** Lists are scoped by entity, with cancellation AND a generation fence for late responses. */
function usePaged<T extends { id: string }>(scope: string | undefined, load: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>) {
  const [state, setState] = useState<PageState<T>>({ scope, items: [], nextCursor: null, loading: !!scope, loadingMore: false, error: '', loaded: false });
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    pending.current = !!scope;
    setState({ scope, items: [], nextCursor: null, loading: !!scope, loadingMore: false, error: '', loaded: false });
    if (scope) void load(undefined, abort.signal).then(page => {
      if (current === generation.current && !abort.signal.aborted) setState({ ...page, scope, loading: false, loadingMore: false, error: '', loaded: true });
    }).catch(error => {
      if (current === generation.current && !abort.signal.aborted && !cancelled(error)) setState({ scope, items: [], nextCursor: null, loading: false, loadingMore: false, error: message(error), loaded: false });
    }).finally(() => { if (current === generation.current) pending.current = false; });
    return () => { abort.abort(); ++generation.current; pending.current = false; };
  }, [scope, load, revision]);
  const loadMore = useCallback(async () => {
    const currentState = stateRef.current;
    if (pending.current || !scope || currentState.scope !== scope || !currentState.nextCursor) return;
    const current = generation.current;
    const abort = controller.current;
    if (!abort || abort.signal.aborted) return;
    pending.current = true;
    setState(old => ({ ...old, loadingMore: true, error: '' }));
    try {
      const page = await load(currentState.nextCursor, abort.signal);
      if (current === generation.current && !abort.signal.aborted) setState(old => {
        if (old.scope !== scope) return old;
        const items = new Map(old.items.map(item => [item.id, item]));
        for (const item of page.items) items.set(item.id, item);
        return { ...old, items: [...items.values()], nextCursor: page.nextCursor, loadingMore: false, error: '', loaded: true };
      });
    } catch (error) {
      if (current === generation.current && !abort.signal.aborted && !cancelled(error)) setState(old => ({ ...old, loadingMore: false, error: message(error) }));
    } finally { if (current === generation.current) pending.current = false; }
  }, [scope, load]);
  const upsert = useCallback((item: T) => setState(old => {
    if (old.scope !== scope) return old;
    const found = old.items.some(value => value.id === item.id);
    return { ...old, items: found ? old.items.map(value => value.id === item.id ? item : value) : [item, ...old.items] };
  }), [scope]);
  const visible = state.scope === scope ? state : { scope, items: [], nextCursor: null, loading: !!scope, loadingMore: false, error: '', loaded: false };
  return { ...visible, loadMore, reload: () => setRevision(value => value + 1), upsert };
}

function followLink(event: MouseEvent<HTMLAnchorElement>, navigate: (path: string) => boolean, path: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}

export default function StudyWorkspace() {
  const auth = useAuth();
  const api = useMemo(() => createStudyApi(auth.request), [auth.request]);
  const { path, navigate } = useStudyNavigation();
  const route = parseStudyRoute(path);
  const setId = 'studySetId' in route ? route.studySetId : undefined;
  const [selected, setSelected] = useState<{ id?: string; data?: StudySet; loading: boolean; error: string }>({ loading: false, error: '' });
  const selectedEpoch = useRef(0);
  const [setRevision, setSetRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [mobile, setMobile] = useState(false);
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'rename'; studySet: StudySet } | null>(null);
  const [notice, setNotice] = useState('');
  const listSets = useCallback((cursor: string | undefined, signal: AbortSignal) => api.listSets(cursor, signal), [api]);
  const listMaterials = useCallback((cursor: string | undefined, signal: AbortSignal) => api.listMaterials(setId!, cursor, signal), [api, setId]);
  const sets = usePaged<StudySet>('sets', listSets);
  const materials = usePaged<MaterialSummary>(setId, listMaterials);
  const currentSet = selected.id === setId ? selected : { id: setId, loading: !!setId, error: '' };

  useEffect(() => {
    const epoch = ++selectedEpoch.current;
    const abort = new AbortController();
    setSelected({ id: setId, loading: !!setId, error: '' });
    if (setId) void api.getSet(setId, abort.signal).then(data => {
      if (epoch === selectedEpoch.current && !abort.signal.aborted) setSelected({ id: setId, data, loading: false, error: '' });
    }).catch(error => {
      if (epoch === selectedEpoch.current && !abort.signal.aborted && !cancelled(error)) setSelected({ id: setId, loading: false, error: message(error) });
    });
    return () => { abort.abort(); ++selectedEpoch.current; };
  }, [api, setId, setRevision]);
  useEffect(() => { setDialog(null); setMobile(false); document.querySelector('.cloud-main-scroll')?.scrollTo(0, 0); }, [path]);
  useEffect(() => {
    const title = route.kind === 'folders' ? '文件夹' : route.kind === 'search' ? '搜索学习内容' : route.kind === 'calendar' ? '学习日历' : route.kind === 'local-data' ? '本机旧数据' : currentSet.data?.title ?? '我的学习集';
    document.title = `${title} | StudyC`;
  }, [route.kind, currentSet.data?.title]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);

  const go = useCallback((target: string) => {
    const accepted = navigate(target);
    if (accepted) setMobile(false);
    return accepted;
  }, [navigate]);
  const updateSet = (studySet: StudySet) => {
    sets.upsert(studySet);
    setSelected(old => old.id === studySet.id ? { ...old, data: studySet, error: '', loading: false } : old);
  };
  const savedMaterial = (material: TextMaterial) => {
    if (material.studySetId !== setId) return;
    const { body: _body, ...summary } = material;
    materials.upsert(summary);
  };
  const logout = async () => {
    if (!confirmStudyLeave()) return;
    try { await auth.logout(); } catch (error) { setNotice(message(error)); }
  };
  const filtered = sets.items.filter(item => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const createButton = <button className="btn btn-black" onClick={() => setDialog({ mode: 'create' })}><Plus size={17} />创建学习集</button>;

  return <div className="app cloud-app">
    <nav className="rail cloud-rail" aria-label="主导航">
      <a className="rail-button" href="/platform/studysets" aria-label="StudyC 首页" onClick={event => followLink(event, go, '/platform/studysets')}><img src="/assets/studyc/xiaoc-avatar.svg" alt="" /></a>
      <a className={`rail-button ${route.kind === 'sets' ? 'active' : ''}`} href="/platform/studysets" aria-label="我的学习集" onClick={event => followLink(event, go, '/platform/studysets')}><Folder /></a>
      <a className={`rail-button ${route.kind === 'local-data' ? 'active' : ''}`} href="/platform/local-data" aria-label="本机旧数据" onClick={event => followLink(event, go, '/platform/local-data')}><Archive /></a>
      <div className="rail-bottom"><button className="rail-button" aria-label="退出登录" title="退出登录" onClick={() => void logout()}><LogOut /></button><span className="cloud-account-dot" title="已登录账户">C</span></div>
    </nav>
    {mobile && <button className="cloud-nav-scrim" aria-label="关闭导航" onClick={() => setMobile(false)} />}
    <aside className={`set-sidebar cloud-sidebar ${mobile ? 'is-open' : ''}`} aria-label="学习空间导航">
      <div className="cloud-sidebar-brand"><span>StudyC</span><small>你的学习空间</small><button className="icon-button cloud-close-nav" aria-label="关闭导航" onClick={() => setMobile(false)}><X /></button></div>
      <button className="side-link cloud-all-sets" onClick={() => go('/platform/studysets')}><Folder size={16} /><span>我的学习集</span></button>
      <div className="cloud-sidebar-label">学习集<button className="icon-button" aria-label="创建学习集" onClick={() => setDialog({ mode: 'create' })}><Plus size={16} /></button></div>
      <div className="cloud-sidebar-sets">
        {sets.loading ? <p className="cloud-sidebar-note" role="status">正在读取学习集…</p> : null}
        {sets.items.map(item => <a key={item.id} href={studySetPath(item.id)} className={`side-link ${setId === item.id ? 'active' : ''}`} onClick={event => followLink(event, go, studySetPath(item.id))}><BookOpen size={16} /><span>{item.title}</span></a>)}
        {sets.loaded && !sets.items.length ? <p className="cloud-sidebar-note">创建一个学习集，开始整理资料。</p> : null}
        {sets.error ? <div className="cloud-sidebar-error"><p>学习集列表读取失败</p><button onClick={sets.loaded ? () => void sets.loadMore() : sets.reload}>重试</button></div> : null}
        {sets.nextCursor ? <button className="cloud-side-more" disabled={sets.loadingMore} onClick={() => void sets.loadMore()}>{sets.loadingMore ? '正在加载…' : '加载更多学习集'}</button> : null}
      </div>
      <button className="side-link" onClick={()=>go('/platform/folders')}><Folder size={16}/><span>文件夹</span></button>
      <button className="side-link" onClick={()=>go('/platform/search')}><Search size={16}/><span>搜索学习内容</span></button>
      <button className="side-link" onClick={()=>go('/platform/calendar')}><Route size={16}/><span>学习日历</span></button>
      <div className="cloud-sidebar-tools"><span>学习工具</span>{[
        { suffix: 'chat/new', title: '资料问答', Icon: MessageCircle },
        { suffix: 'flashcards', title: '闪卡', Icon: Layers },
        { suffix: 'practice', title: '测验与考试', Icon: ClipboardCheck },
        { suffix: 'mistakes', title: '错题', Icon: BookOpen },
        { suffix: 'notes', title: '笔记', Icon: FileText },
        { suffix: 'study-plan', title: '学习计划', Icon: Route },
      ].map(({ suffix, title, Icon }) => <button key={title} className="side-link" onClick={() => setId ? go(`${studySetPath(setId)}/${suffix}`) : setNotice('请先选择一个学习集。')}><Icon size={16} /><span>{title}</span></button>)}</div>
      <a className="cloud-local-link" href="/platform/local-data" onClick={event => followLink(event, go, '/platform/local-data')}><Archive size={15} />本机旧数据</a>
    </aside>
    <div className="main-area cloud-main">
      <header className="topbar cloud-topbar"><div className="breadcrumb"><button className="icon-button cloud-mobile-menu" aria-label="打开导航" onClick={() => setMobile(true)}><Menu /></button><a href="/platform/studysets" onClick={event => followLink(event, go, '/platform/studysets')}>我的学习集</a>{setId ? <><ChevronRight size={14} /><a href={studySetPath(setId)} onClick={event => followLink(event, go, studySetPath(setId))}>{currentSet.data?.title ?? '学习集'}</a></> : null}{route.kind === 'material' ? <><ChevronRight size={14} /><span>文本资料</span></> : null}</div><span className="cloud-space-label"><Cloud size={15} />{import.meta.env.DEV && import.meta.env.VITE_LOCAL_ACCEPTANCE === '1' ? '本地验收空间' : '云端学习空间'}</span></header>
      <main className="main-scroll cloud-main-scroll">
        {route.kind === 'sets' ? <div className="cloud-page">
          <div className="cloud-page-heading"><div><span className="cloud-eyebrow">YOUR STUDY SPACE</span><h1>我的学习集</h1><p>把资料收在一起，慢慢积累自己的知识。</p></div>{createButton}</div>
          <div className="cloud-list-toolbar"><label className="cloud-search"><Search size={17} /><input aria-label="搜索已加载的学习集" placeholder="搜索已加载的学习集" value={search} onChange={event => setSearch(event.target.value)} /></label><button className="icon-button" aria-label="刷新学习集列表" disabled={sets.loading} onClick={sets.reload}><RefreshCw size={17} /></button></div>
          {sets.loading ? <Loading text="正在读取学习集…" /> : null}
          {sets.error ? <ErrorState text={sets.error} onRetry={sets.loaded ? () => void sets.loadMore() : sets.reload} /> : null}
          {sets.loaded && !sets.items.length ? <div className="cloud-empty"><div className="cloud-empty-mark"><Folder size={32} /></div><h2>从一个学习集开始</h2><p>为课程、考试或感兴趣的主题留一个位置。<br />创建后，就可以添加并保存文本资料。</p>{createButton}</div> : null}
          {sets.loaded && sets.items.length > 0 && !filtered.length ? <p className="cloud-no-results">已加载的学习集中没有匹配结果。{sets.nextCursor ? '可以继续加载更多。' : ''}</p> : null}
          <div className="cloud-set-grid">{filtered.map(item => <article className="cloud-set-card" key={item.id} data-study-set-id={item.id}><a className="cloud-card-link" aria-label={item.title} href={studySetPath(item.id)} onClick={event => followLink(event, go, studySetPath(item.id))}><div className="cloud-card-cover"><img src="/assets/studyc/studyset-cover.png" alt="" /><ArrowRight size={18} /></div><h2>{item.title}</h2><p>创建于 {formatDate(item.createdAt)}</p></a><button className="icon-button cloud-card-rename" aria-label={`重命名学习集 ${item.title}`} onClick={() => setDialog({ mode: 'rename', studySet: item })}><Pencil size={15} /></button></article>)}</div>
          {sets.nextCursor ? <div className="cloud-load-more"><button className="btn" disabled={sets.loadingMore} onClick={() => void sets.loadMore()}>{sets.loadingMore ? '正在加载…' : '加载更多学习集'}</button></div> : null}
        </div> : null}
        {setId && currentSet.loading ? <Loading text="正在打开学习集…" /> : null}
        {setId && currentSet.error ? <div className="cloud-page"><ErrorState text={currentSet.error} onRetry={() => setSetRevision(value => value + 1)} /><button className="btn" onClick={() => go('/platform/studysets')}><ArrowLeft size={16} />返回学习集列表</button></div> : null}
        {route.kind === 'set' && currentSet.data ? <div className="cloud-page">
          <div className="cloud-study-heading"><div className="set-cover"><img src="/assets/studyc/studyset-cover.png" alt="" /></div><div><span className="cloud-eyebrow">学习集</span><h1>{currentSet.data.title}</h1><p>资料会保存在当前学习集，登录后可继续查看和编辑。</p></div><button className="icon-button" aria-label={`重命名学习集 ${currentSet.data.title}`} onClick={() => setDialog({ mode: 'rename', studySet: currentSet.data! })}><Pencil size={17} /></button></div>
          <section className="cloud-material-section"><div className="section-heading"><h2><FileText size={20} />我的资料</h2><button className="btn btn-black" onClick={() => go(materialPath(route.studySetId))}><Plus size={17} />新建文本资料</button></div>
            {materials.loading ? <Loading text="正在读取资料…" /> : null}
            {materials.error ? <ErrorState text={materials.error} onRetry={materials.loaded ? () => void materials.loadMore() : materials.reload} /> : null}
            {materials.loaded && !materials.items.length ? <div className="cloud-material-empty"><FileText size={29} /><h3>这里还没有资料</h3><p>写下笔记，或粘贴一段想学习的内容。</p><button className="btn" onClick={() => go(materialPath(route.studySetId))}>添加第一份文本资料<ArrowRight size={16} /></button></div> : null}
            <div className="cloud-material-list">{materials.items.map(item => <a key={item.id} data-material-id={item.id} href={materialPath(route.studySetId, item.id)} onClick={event => followLink(event, go, materialPath(route.studySetId, item.id))}><span className="cloud-material-icon"><FileText size={21} /></span><span><strong>{item.title}</strong><small>纯文本 · 更新于 {formatDate(item.updatedAt)}</small></span><ChevronRight size={17} /></a>)}</div>
            {materials.nextCursor ? <div className="cloud-load-more"><button className="btn" disabled={materials.loadingMore} onClick={() => void materials.loadMore()}>{materials.loadingMore ? '正在加载…' : '加载更多资料'}</button></div> : null}
            <PdfUpload api={api} studySetId={route.studySetId} onExtracted={materials.reload} />
          </section>
          <section className="cloud-tools-preview"><button className="btn" onClick={() => go(`${studySetPath(route.studySetId)}/chat/new`)}><MessageCircle /><span>资料问答<small>依据资料，与小C对话</small></span></button><button className="btn" onClick={() => go(`${studySetPath(route.studySetId)}/flashcards`)}><Layers /><span>闪卡<small>翻开答案，记录自己的熟悉程度</small></span></button><button className="btn" onClick={() => go(`${studySetPath(route.studySetId)}/practice`)}><ClipboardCheck /><span>测验与考试<small>即时练习反馈，独立考试成绩</small></span></button><button className="btn" onClick={() => go(`${studySetPath(route.studySetId)}/study-plan`)}><Route /><span>学习计划<small>目标、任务与完成记录</small></span></button></section>
        </div> : null}
        {route.kind === 'material' && currentSet.data ? <MaterialEditor key={`${auth.user?.id}:${route.studySetId}:${route.materialId ?? 'new'}`} studySetId={route.studySetId} materialId={route.materialId} onNavigate={go} onSaved={savedMaterial} /> : null}
        {(route.kind === 'chat' || route.kind === 'flashcards' || route.kind === 'quizzes' || route.kind === 'notes') && currentSet.data && (materials.loading || materials.error || materials.nextCursor) ? <div className="cloud-page cloud-source-status">{materials.loading ? <Loading text="正在读取可选资料…" /> : null}{materials.error ? <ErrorState text={materials.error} onRetry={materials.reload} /> : null}{materials.nextCursor ? <button className="btn" disabled={materials.loadingMore} onClick={() => void materials.loadMore()}>{materials.loadingMore ? '正在加载…' : '加载更多可选资料'}</button> : null}</div> : null}
        {route.kind === 'chat' && currentSet.data ? <ChatPanel key={`${auth.user?.id}:${route.studySetId}`} studySetId={route.studySetId} threadId={route.threadId} materials={materials.items} onNavigate={go} /> : null}
        {route.kind === 'flashcards' && currentSet.data ? <FlashcardsPanel key={`${auth.user?.id}:${route.studySetId}:${path}`} studySetId={route.studySetId} materials={materials.items} /> : null}
        {route.kind === 'quizzes' && currentSet.data ? <div className="cloud-page"><QuizzesPanel key={`${auth.user?.id}:${route.studySetId}:${path}`} studySetId={route.studySetId} materials={materials.items} /></div> : null}
        {route.kind === 'mistakes' && currentSet.data ? <div className="cloud-page"><MistakesPanel key={`${auth.user?.id}:${route.studySetId}:${path}`} studySetId={route.studySetId} onNavigate={go}/></div> : null}
        {route.kind === 'notes' && currentSet.data ? <div className="cloud-page"><NotesPanel key={`${auth.user?.id}:${route.studySetId}:${path}`} studySetId={route.studySetId} materials={materials.items} onNavigate={go}/></div> : null}
        {route.kind === 'plans' && currentSet.data ? <div className="cloud-page"><PlansPanel key={`${auth.user?.id}:${route.studySetId}:${path}`} studySetId={route.studySetId} onNavigate={go}/></div> : null}
        {route.kind === 'folders' ? <div className="cloud-page"><FoldersPanel key={`${auth.user?.id}:${path}`} onNavigate={go}/></div> : null}
        {route.kind === 'search' ? <div className="cloud-page"><SearchPanel key={`${auth.user?.id}:${path}`} onNavigate={go}/></div> : null}
        {route.kind === 'calendar' ? <div className="cloud-page"><CalendarPanel key={`${auth.user?.id}:${path}`} onNavigate={go}/></div> : null}
        {route.kind === 'local-data' ? <LocalData accountId={auth.user?.id ?? ''} /> : null}
        {route.kind === 'unavailable' && (!setId || currentSet.data) ? <div className="cloud-page cloud-unavailable"><span className="cloud-empty-mark"><BookOpen size={30} /></span><h1>{route.title}尚未开放</h1><p>现在可以创建学习集、整理和编辑文本资料。<br />这项学习工具还在准备中。</p><button className="btn btn-black" onClick={() => go(setId ? studySetPath(setId) : '/platform/studysets')}>返回我的资料<ArrowRight size={16} /></button></div> : null}
        {route.kind === 'not-found' ? <div className="cloud-page cloud-unavailable"><h1>没有找到这个页面</h1><p>请从学习集列表重新打开资料。</p><button className="btn btn-black" onClick={() => go('/platform/studysets')}>返回学习集列表</button></div> : null}
      </main>
    </div>
    {dialog ? <SetDialog key={dialog.mode === 'create' ? 'create' : dialog.studySet.id} api={api} {...dialog} onClose={() => setDialog(null)} onSaved={item => {
      updateSet(item);
      if (dialog.mode === 'create' && !go(studySetPath(item.id))) return false;
      setDialog(null);
      if (dialog.mode === 'rename') setNotice('学习集名称已保存');
      return true;
    }} /> : null}
    {notice ? <div role="status" className="toast">{notice}</div> : null}
  </div>;
}

function Loading({ text }: { text: string }) {
  return <div className="cloud-loading" role="status"><LoaderCircle size={20} /><span>{text}</span></div>;
}
function ErrorState({ text, onRetry }: { text: string; onRetry: () => void }) {
  return <div className="cloud-error" role="alert"><div><strong>暂时无法读取</strong><p>{text}</p></div><button className="btn" onClick={onRetry}><RefreshCw size={15} />重试</button></div>;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
}

type SetDialogProps = ({ mode: 'create' } | { mode: 'rename'; studySet: StudySet }) & { api: Api; onClose: () => void; onSaved: (item: StudySet) => boolean };
type SetCreationAttempt = { clientRequestId: string; title: string };
const setCreationKey = 'sf-k12:cloud-set-create';
function pendingSetCreation(): SetCreationAttempt | null {
  try {
    const stored = JSON.parse(appStorage.getItem(setCreationKey) ?? 'null');
    if (!stored || stored.format !== 1 || typeof stored.clientRequestId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored.clientRequestId)) return null;
    return { clientRequestId: stored.clientRequestId, title: validateStudyTitle(stored.title, 60) };
  } catch { return null; }
}
function persistSetCreation(attempt: SetCreationAttempt, isCurrentAccount: () => boolean) {
  if (!isCurrentAccount()) throw new DOMException('Account changed', 'AbortError');
  const pending = pendingSetCreation();
  if (appStorage.getItem(setCreationKey) !== null && !pending) throw new Error('本机保存的创建请求暂时无法读取。请先到“本机旧数据”导出原始记录，避免覆盖可能尚未确认的创建。');
  if (pending && pending.clientRequestId !== attempt.clientRequestId) throw new Error('另一条创建请求尚待确认，请关闭后重新打开，先核对上一次创建。');
  const encoded = JSON.stringify({ format: 1, ...attempt });
  try {
    appStorage.setItem(setCreationKey, encoded);
    if (appStorage.getItem(setCreationKey) === encoded) return;
  } catch { /* Refuse a write whose retry identity could not be retained. */ }
  throw new Error('当前浏览器无法保留创建请求，请允许本机存储后重试。');
}
function clearSetCreation(attempt: SetCreationAttempt | null, isCurrentAccount: () => boolean) {
  if (!isCurrentAccount()) return;
  try { if (attempt && pendingSetCreation()?.clientRequestId === attempt.clientRequestId) appStorage.removeItem(setCreationKey); } catch { /* A retained intent will safely replay the existing resource. */ }
}
function SetDialog(props: SetDialogProps) {
  const [isCurrentAccount] = useState(() => captureStorageSession());
  const [pending] = useState(() => props.mode === 'create' ? pendingSetCreation() : null);
  const [title, setTitle] = useState(props.mode === 'rename' ? props.studySet.title : pending?.title ?? '');
  const [base, setBase] = useState(props.mode === 'rename' ? props.studySet : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latestTitle, setLatestTitle] = useState<string | undefined>();
  const [uncertain, setUncertain] = useState(!!pending);
  const [created, setCreated] = useState<StudySet | null>(null);
  const attempt = useRef<SetCreationAttempt | null>(pending);
  const controller = useRef(new AbortController());
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const abort = new AbortController();
    controller.current = abort;
    return () => { abort.abort(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isCurrentAccount() || busy || conflict) return;
    if (created) { props.onSaved(created); return; }
    setError('');
    try {
      const normalized = validateStudyTitle(title, 60);
      setBusy(true);
      let result: StudySet;
      if (props.mode === 'create') {
        if (!attempt.current || !uncertain && attempt.current.title !== normalized) attempt.current = { clientRequestId: crypto.randomUUID(), title: normalized };
        persistSetCreation(attempt.current, isCurrentAccount);
        result = await props.api.createSet(attempt.current, controller.current.signal);
      } else result = await props.api.renameSet(base!.id, { version: base!.version, title: normalized }, controller.current.signal);
      if (isCurrentAccount() && !controller.current.signal.aborted) {
        if (props.mode === 'create') clearSetCreation(attempt.current, isCurrentAccount);
        setUncertain(false);
        if (!props.onSaved(result)) setCreated(result);
      }
    } catch (cause) {
      if (!isCurrentAccount() || controller.current.signal.aborted || cancelled(cause)) return;
      const detail = cause as { code?: string; status?: number };
      setError(message(cause));
      if (detail.code === 'version_conflict') setConflict(true);
      if (props.mode === 'create' && (detail.code === 'connection_lost' || detail.code === 'invalid_response' || detail.code === 'idempotency_conflict' || (detail.status ?? 0) >= 500)) setUncertain(true);
      else if (props.mode === 'create' && (detail.status ?? 0) >= 400 && (detail.status ?? 0) < 500 && detail.code !== 'idempotency_conflict') {
        clearSetCreation(attempt.current, isCurrentAccount); setUncertain(false);
      }
    } finally { if (isCurrentAccount() && !controller.current.signal.aborted) setBusy(false); }
  };
  const readLatest = async () => {
    if (!isCurrentAccount() || !base || busy) return;
    setBusy(true);
    try {
      const latest = await props.api.getSet(base.id, controller.current.signal);
      if (isCurrentAccount() && !controller.current.signal.aborted) { setBase(latest); setLatestTitle(latest.title); setConflict(false); setError(''); }
    } catch (cause) { if (isCurrentAccount() && !controller.current.signal.aborted && !cancelled(cause)) setError(message(cause)); }
    finally { if (isCurrentAccount() && !controller.current.signal.aborted) setBusy(false); }
  };
  return <div className="modal-backdrop cloud-dialog-backdrop"><section ref={dialogRef} className="modal cloud-set-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-set-dialog-title" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); props.onClose(); }
    if (event.key === 'Tab') {
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><div className="modal-head"><h2 id="cloud-set-dialog-title">{props.mode === 'create' ? '创建学习集' : '重命名学习集'}</h2><button className="icon-button" disabled={busy} aria-label="关闭" onClick={props.onClose}><X /></button></div>
    <form onSubmit={event => void submit(event)}><label>学习集名称<input className="field" autoFocus required value={title} disabled={busy || uncertain || !!created} onChange={event => { setTitle(event.target.value); setError(''); }} placeholder="例如：英语学习笔记" /></label><p className="cloud-field-hint">{Array.from(title.trim()).length}/60 个字符 · 同名学习集会分别保存</p>
      {latestTitle !== undefined ? <p className="cloud-dialog-note">服务器当前名称：<strong>{latestTitle}</strong>。你的输入已保留，确认后可再次保存。</p> : null}
      {uncertain ? <p className="cloud-dialog-note">创建结果暂时无法确认。重试会核对同一次创建。</p> : null}
      {created ? <p className="cloud-dialog-note">学习集已创建。处理当前资料后，可以继续打开它。</p> : null}
      {error ? <p className="cloud-form-error" role="alert">{error}</p> : null}
      {conflict ? <button type="button" className="btn" disabled={busy} onClick={() => void readLatest()}>读取最新名称</button> : null}
      <div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={props.onClose}>取消</button><button className="btn btn-black" disabled={busy || conflict}>{busy ? '正在保存…' : created ? '打开学习集' : props.mode === 'create' ? uncertain ? '重试创建' : '创建' : '保存名称'}</button></div>
    </form>
  </section></div>;
}

function readLocalEntries() {
  return appStorage.keys().sort().flatMap(key => {
    const raw = appStorage.getItem(key);
    if (raw === null) return [];
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; }
    return [{ key, value, raw }];
  });
}
function LocalData({ accountId }: { accountId: string }) {
  const [entries, setEntries] = useState(readLocalEntries);
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => setEntries(readLocalEntries());
    refresh();
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);
  const names: Record<string, string> = { sets: '学习集名称', materials: '本机资料', uploads: '导入资料', topic: '学习主题', profile: '个人设置', stage: '学习阶段', 'created-deck': '闪卡记录', 'plan-completed': '学习计划记录' };
  const legacy = entries.filter(entry => !entry.key.startsWith('sf-k12:cloud-'));
  const drafts = entries.filter(entry => entry.key.startsWith('sf-k12:cloud-'));
  const exportData = () => {
    try {
      const current = readLocalEntries();
      const payload = { format: 'studyc-local-data-export', version: 1, accountId, exportedAt: new Date().toISOString(),
        entries: Object.fromEntries(current.map(entry => [entry.key, entry.value])),
        rawEntries: Object.fromEntries(current.map(entry => [entry.key, entry.raw])) };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `StudyC-本机数据-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
      setError('');
    } catch { setError('暂时无法导出，请允许浏览器下载后重试。'); }
  };
  const rows = (items: typeof entries, isDraft: boolean) => <div className="cloud-archive-list">{items.map((entry, index) => {
      const content = opened === entry.key ? JSON.stringify(entry.value, null, 2) : '';
      const key = entry.key.replace(/^[^:]+:/, '');
      const title = isDraft
        ? key.startsWith('cloud-draft:') ? `文本资料草稿 ${index + 1}` : key === 'cloud-set-create' ? '待确认的学习集创建' : `其他本机草稿 ${index + 1}`
        : Object.hasOwn(names, key) ? names[key] : `其他本机记录 ${index + 1}`;
      return <section key={entry.key}><button className="cloud-archive-row" aria-expanded={opened === entry.key} onClick={() => setOpened(opened === entry.key ? null : entry.key)}><FileText size={18} /><span>{title}</span><small>{Array.isArray(entry.value) ? `${entry.value.length} 条记录` : '查看内容'}</small><ChevronRight size={16} /></button>{opened === entry.key ? <><pre>{content.slice(0, 20_000)}</pre>{content.length > 20_000 ? <p className="cloud-field-hint">预览已截断，导出可保存全部内容。</p> : null}</> : null}</section>;
    })}</div>;
  return <div className="cloud-page"><div className="cloud-page-heading"><div><span className="cloud-eyebrow">LOCAL ARCHIVE</span><h1>本机旧数据</h1><p>查看当前账户保存在本机的旧记录与未同步草稿。</p></div><button className="btn btn-black" onClick={exportData} disabled={!entries.length}><Download size={17} />导出 JSON</button></div><div className="cloud-archive-note"><Archive size={20} /><p>这里的记录只供查看和导出，不会自动上传到云端。导出包含旧记录、未同步草稿和待确认的请求，并保留原始内容；本机草稿不代表云端已经保存。</p></div>{error ? <p role="alert" className="cloud-form-error">{error}</p> : null}{!entries.length ? <div className="cloud-empty"><h2>未读取到本机数据</h2><p>这里只显示当前账户的记录。</p></div> : <>
      <section className="cloud-archive-group"><h2>旧版本机记录</h2><p>旧版资料没有明确的学习集归属，后续导入时需要重新选择。</p>{legacy.length ? rows(legacy, false) : <p className="cloud-field-hint">没有读取到旧版本机记录。</p>}</section>
      <section className="cloud-archive-group"><h2>未同步草稿与待确认请求</h2><p>包括正常草稿和暂时无法读取的原始记录。导出可保留它们供后续恢复。</p>{drafts.length ? rows(drafts, true) : <p className="cloud-field-hint">没有读取到本机草稿。</p>}</section>
    </>}</div>;
}
