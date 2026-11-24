import AccountMenu from "./library/AccountMenu";
import LibraryPage from "./library/LibraryPage";
import SetOverview from "./library/SetOverview";
import ImportPanel from "./import/ImportPanel";
import CopyPanel from "./copy/CopyPanel";
import TrashPanel from "./trash/TrashPanel";
import FoldersPanel from "./folders/FoldersPanel";
import SearchPanel from "./search/SearchPanel";
import CalendarPanel from "./calendar/CalendarPanel";
import PlansPanel from "./plans/PlansPanel";
import NotesPanel from "./notes/NotesPanel";
import MistakesPanel from "./mistakes/MistakesPanel";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  Archive,
  ArrowLeft,
  BookOpen,
  ChevronRight,
  ClipboardCheck,
  Cloud,
  Download,
  FileText,
  Folder,
  Layers,
  LoaderCircle,
  Menu,
  MessageCircle,
  Plus,
  RefreshCw,
  Route,
  Search,
  X,
  CalendarDays,
  FolderOpen,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { appStorage, captureStorageSession } from "../lib/account-storage";
import {
  createStudyApi,
  validateStudyTitle,
  type MaterialSummary,
  type StudySet,
  type TextMaterial,
} from "./api";
import MaterialEditor from "./MaterialEditor";
import ChatPanel from "./chat/ChatPanel";
import FlashcardsPanel from "./flashcards/FlashcardsPanel";
import QuizzesPanel from "./quizzes/QuizzesPanel";
import { confirmStudyLeave, useStudyNavigation } from "./navigation";
import { materialPath, parseStudyRoute, studySetPath } from "./routes";
import "../app.css";
import "../features/library.css";
import "./workspace.css";
import "./library/library.css";

type Page<T> = { items: T[]; nextCursor: string | null };
type PageState<T> = Page<T> & {
  scope?: string;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  loaded: boolean;
};
type Api = ReturnType<typeof createStudyApi>;
const message = (error: unknown) =>
  error instanceof Error ? error.message : "请求未完成，请重试。";
const cancelled = (error: unknown) =>
  error instanceof Error && error.name === "AbortError";

/** Lists are scoped by entity, with cancellation AND a generation fence for late responses. */
function usePaged<T extends { id: string }>(
  scope: string | undefined,
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
) {
  const [state, setState] = useState<PageState<T>>({
    scope,
    items: [],
    nextCursor: null,
    loading: !!scope,
    loadingMore: false,
    error: "",
    loaded: false,
  });
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
    setState({
      scope,
      items: [],
      nextCursor: null,
      loading: !!scope,
      loadingMore: false,
      error: "",
      loaded: false,
    });
    if (scope)
      void load(undefined, abort.signal)
        .then((page) => {
          if (current === generation.current && !abort.signal.aborted)
            setState({
              ...page,
              scope,
              loading: false,
              loadingMore: false,
              error: "",
              loaded: true,
            });
        })
        .catch((error) => {
          if (
            current === generation.current &&
            !abort.signal.aborted &&
            !cancelled(error)
          )
            setState({
              scope,
              items: [],
              nextCursor: null,
              loading: false,
              loadingMore: false,
              error: message(error),
              loaded: false,
            });
        })
        .finally(() => {
          if (current === generation.current) pending.current = false;
        });
    return () => {
      abort.abort();
      ++generation.current;
      pending.current = false;
    };
  }, [scope, load, revision]);
  const loadMore = useCallback(async () => {
    const currentState = stateRef.current;
    if (
      pending.current ||
      !scope ||
      currentState.scope !== scope ||
      !currentState.nextCursor
    )
      return;
    const current = generation.current;
    const abort = controller.current;
    if (!abort || abort.signal.aborted) return;
    pending.current = true;
    setState((old) => ({ ...old, loadingMore: true, error: "" }));
    try {
      const page = await load(currentState.nextCursor, abort.signal);
      if (current === generation.current && !abort.signal.aborted)
        setState((old) => {
          if (old.scope !== scope) return old;
          const items = new Map(old.items.map((item) => [item.id, item]));
          for (const item of page.items) items.set(item.id, item);
          return {
            ...old,
            items: [...items.values()],
            nextCursor: page.nextCursor,
            loadingMore: false,
            error: "",
            loaded: true,
          };
        });
    } catch (error) {
      if (
        current === generation.current &&
        !abort.signal.aborted &&
        !cancelled(error)
      )
        setState((old) => ({
          ...old,
          loadingMore: false,
          error: message(error),
        }));
    } finally {
      if (current === generation.current) pending.current = false;
    }
  }, [scope, load]);
  const upsert = useCallback(
    (item: T) =>
      setState((old) => {
        if (old.scope !== scope) return old;
        const found = old.items.some((value) => value.id === item.id);
        return {
          ...old,
          items: found
            ? old.items.map((value) => (value.id === item.id ? item : value))
            : [item, ...old.items],
        };
      }),
    [scope],
  );
  const visible =
    state.scope === scope
      ? state
      : {
          scope,
          items: [],
          nextCursor: null,
          loading: !!scope,
          loadingMore: false,
          error: "",
          loaded: false,
        };
  return {
    ...visible,
    loadMore,
    reload: () => setRevision((value) => value + 1),
    upsert,
  };
}

function followLink(
  event: MouseEvent<HTMLAnchorElement>,
  navigate: (path: string) => boolean,
  path: string,
) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(path);
}

export default function StudyWorkspace() {
  const auth = useAuth();
  const api = useMemo(() => createStudyApi(auth.request), [auth.request]);
  const { path, navigate } = useStudyNavigation();
  const route = parseStudyRoute(path);
  const setId = "studySetId" in route ? route.studySetId : undefined;
  const [selected, setSelected] = useState<{
    id?: string;
    data?: StudySet;
    loading: boolean;
    error: string;
  }>({ loading: false, error: "" });
  const selectedEpoch = useRef(0);
  const [setRevision, setSetRevision] = useState(0);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "rename"; studySet: StudySet } | null
  >(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!mobile) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobile(false);
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLButtonElement>(".cloud-mobile-menu")
            ?.focus(),
        );
      }
    };
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(".cloud-close-nav")?.focus(),
    );
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [mobile]);
  const listSets = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      api.listSets(cursor, signal),
    [api],
  );
  const listMaterials = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      api.listMaterials(setId!, cursor, signal),
    [api, setId],
  );
  const sets = usePaged<StudySet>(setId ? "sets" : undefined, listSets);
  const materials = usePaged<MaterialSummary>(setId, listMaterials);
  const currentSet =
    selected.id === setId
      ? selected
      : { id: setId, loading: !!setId, error: "" };

  useEffect(() => {
    const epoch = ++selectedEpoch.current;
    const abort = new AbortController();
    setSelected({ id: setId, loading: !!setId, error: "" });
    if (setId)
      void api
        .getSet(setId, abort.signal)
        .then((data) => {
          if (epoch === selectedEpoch.current && !abort.signal.aborted)
            setSelected({ id: setId, data, loading: false, error: "" });
        })
        .catch((error) => {
          if (
            epoch === selectedEpoch.current &&
            !abort.signal.aborted &&
            !cancelled(error)
          )
            setSelected({ id: setId, loading: false, error: message(error) });
        });
    return () => {
      abort.abort();
      ++selectedEpoch.current;
    };
  }, [api, setId, setRevision]);
  useEffect(() => {
    setDialog(null);
    setMobile(false);
    document.querySelector(".cloud-main-scroll")?.scrollTo(0, 0);
  }, [path]);
  useEffect(() => {
    const title =
      route.kind === "import"
        ? "导入旧文本资料"
        : route.kind === "copy"
          ? "复制学习内容"
          : route.kind === "trash"
            ? "回收站"
            : route.kind === "folders"
              ? "文件夹"
              : route.kind === "search"
                ? "搜索学习内容"
                : route.kind === "calendar"
                  ? "学习日历"
                  : route.kind === "local-data"
                    ? "本机旧数据"
                    : (currentSet.data?.title ?? "我的学习集");
    document.title = `${title} | StudyC`;
  }, [route.kind, currentSet.data?.title]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const go = useCallback(
    (target: string) => {
      const accepted = navigate(target);
      if (accepted) setMobile(false);
      return accepted;
    },
    [navigate],
  );
  const updateSet = (studySet: StudySet) => {
    sets.upsert(studySet);
    setLibraryRevision((v) => v + 1);
    setSelected((old) =>
      old.id === studySet.id
        ? { ...old, data: studySet, error: "", loading: false }
        : old,
    );
  };
  const savedMaterial = (material: TextMaterial) => {
    if (material.studySetId !== setId) return;
    const { body: _body, ...summary } = material;
    materials.upsert(summary);
  };
  const logout = async () => {
    if (!confirmStudyLeave()) return;
    try {
      await auth.logout();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const globalLinks = [
    {
      path: "/platform/studysets",
      title: "我的学习集",
      kind: "sets",
      Icon: Folder,
    },
    {
      path: "/platform/search",
      title: "搜索学习内容",
      kind: "search",
      Icon: Search,
    },
    {
      path: "/platform/calendar",
      title: "学习日历",
      kind: "calendar",
      Icon: CalendarDays,
    },
    {
      path: "/platform/folders",
      title: "文件夹",
      kind: "folders",
      Icon: FolderOpen,
    },
  ];
  const tools = [
    { suffix: "", title: "学习集概览", kind: "set", Icon: BookOpen },
    { suffix: "study-plan", title: "学习计划", kind: "plans", Icon: Route },
    { suffix: "chat/new", title: "问问小C", kind: "chat", Icon: MessageCircle },
    { suffix: "flashcards", title: "闪卡", kind: "flashcards", Icon: Layers },
    {
      suffix: "practice",
      title: "测验与考试",
      kind: "quizzes",
      Icon: ClipboardCheck,
    },
    { suffix: "mistakes", title: "错题", kind: "mistakes", Icon: BookOpen },
    { suffix: "notes", title: "笔记", kind: "notes", Icon: FileText },
  ];
  const sectionTitle =
    tools.find((t) => t.kind === route.kind)?.title ??
    (
      {
        calendar: "学习日历",
        search: "搜索学习内容",
        folders: "文件夹",
        trash: "回收站",
        copy: "复制文本资料",
        import: "导入旧文本资料",
        "local-data": "导入与本机数据",
        material: "文本资料",
      } as Record<string, string>
    )[route.kind];
  const changed = () => {
    sets.reload();
    setLibraryRevision((v) => v + 1);
  };

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
function LocalData({ accountId,onNavigate }: { accountId: string;onNavigate:(p:string)=>boolean }) {
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
  return <div className="cloud-page"><div className="cloud-page-heading"><div><span className="cloud-eyebrow">LOCAL ARCHIVE</span><h1>本机旧数据</h1><button className="btn" onClick={()=>onNavigate('/platform/import')}>导入旧文本资料</button><p>查看当前账户保存在本机的旧记录与未同步草稿。</p></div><button className="btn btn-black" onClick={exportData} disabled={!entries.length}><Download size={17} />导出 JSON</button></div><div className="cloud-archive-note"><Archive size={20} /><p>这里的记录可以查看、导出，并从导入入口明确选择文本资料上传，不会自动同步。导出包含旧记录、未同步草稿和待确认的请求，并保留原始内容；本机草稿不代表云端已经保存。</p></div>{error ? <p role="alert" className="cloud-form-error">{error}</p> : null}{!entries.length ? <div className="cloud-empty"><h2>未读取到本机数据</h2><p>这里只显示当前账户的记录。</p></div> : <>
      <section className="cloud-archive-group"><h2>旧版本机记录</h2><p>旧版资料没有明确的学习集归属，后续导入时需要重新选择。</p>{legacy.length ? rows(legacy, false) : <p className="cloud-field-hint">没有读取到旧版本机记录。</p>}</section>
      <section className="cloud-archive-group"><h2>未同步草稿与待确认请求</h2><p>包括正常草稿和暂时无法读取的原始记录。导出可保留它们供后续恢复。</p>{drafts.length ? rows(drafts, true) : <p className="cloud-field-hint">没有读取到本机草稿。</p>}</section>
    </>}</div>;
}
