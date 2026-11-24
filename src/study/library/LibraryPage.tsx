import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  Clock3,
  FileText,
  Folder,
  FolderPlus,
  Layers,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import type { StudySet } from "../api";
import { studySetPath } from "../routes";
import { createLibraryApi, type LibrarySet, type LibrarySort } from "./api";
import SetActions, { setTone, studyDate } from "./SetActions";
export default function LibraryPage({
  path,
  revision,
  onNavigate,
  onCreate,
  onRename,
}: {
  path: string;
  revision: number;
  onNavigate: (path: string) => boolean;
  onCreate: () => void;
  onRename: (s: StudySet) => void;
}) {
  const auth = useAuth(),
    api = useMemo(() => createLibraryApi(auth.request), [auth.request]),
    params = new URLSearchParams(path.split("?")[1] ?? ""),
    query = params.get("q") ?? "",
    sort = (params.get("sort") ?? "recent") as LibrarySort;
  const [draft, setDraft] = useState(query),
    [items, setItems] = useState<LibrarySet[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [more, setMore] = useState(false),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0),
    epoch = useRef(0),
    pending = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => setDraft(query), [query]);
  useEffect(() => {
    const current = ++epoch.current,
      c = new AbortController();
    controller.current = c;
    pending.current = false;
    setLoading(true);
    setMore(false);
    setError("");
    setItems([]);
    setCursor(null);
    if (
      !["recent", "created", "title"].includes(sort) ||
      params.getAll("q").length > 1 ||
      params.getAll("sort").length > 1
    ) {
      setError("筛选地址无效，请重新选择排序或搜索。");
      setLoading(false);
      return () => c.abort();
    }
    void api
      .list({ q: query, sort }, c.signal)
      .then((p) => {
        if (current === epoch.current && !c.signal.aborted) {
          setItems(p.items);
          setCursor(p.nextCursor);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted && current === epoch.current)
          setError(e instanceof Error ? e.message : "学习集暂时无法读取。");
      })
      .finally(() => {
        if (!c.signal.aborted && current === epoch.current) setLoading(false);
      });
    return () => {
      c.abort();
      ++epoch.current;
    };
  }, [api, query, sort, revision, reload]);
  const filter = (q: string, nextSort = sort) => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (nextSort !== "recent") p.set("sort", nextSort);
    onNavigate("/platform/studysets" + (p.size ? "?" + p : ""));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    filter(draft);
  };
  const loadMore = async () => {
    if (!cursor || pending.current || loading || !controller.current) return;
    pending.current = true;
    setMore(true);
    const c = controller.current,
      current = epoch.current;
    setError("");
    try {
      const p = await api.list({ q: query, sort, cursor }, c.signal);
      if (current === epoch.current && !c.signal.aborted) {
        setItems((old) => [
          ...old,
          ...p.items.filter((i) => !old.some((o) => o.id === i.id)),
        ]);
        setCursor(p.nextCursor);
      }
    } catch (e) {
      if (current === epoch.current && !c.signal.aborted) {
        setError(e instanceof Error ? e.message : "读取失败，请重试。");
        const status = (e as {status?:number}).status ?? 0;
        // Stale/removed cursor entities need a new first page; transport failures
        // can safely retry the same page without discarding the loaded results.
        if (status >= 400 && status < 500) setCursor(null);
      }
    } finally {
      if (current === epoch.current && !c.signal.aborted) {
        pending.current = false;
        setMore(false);
      }
    }
  };
  const resume = !query ? items.find((s) => s.summary.continue) : undefined;
  return (
    <div className="cloud-page library-page">
      <header className="library-heading">
        <div>
          <h1>我的学习集</h1>
          <p>找到上次的进度，继续今天的学习。</p>
        </div>
        <button className="btn" onClick={() => onNavigate("/platform/folders")}>
          <Folder size={16} />
          文件夹
        </button>
      </header>
      <form className="library-toolbar" onSubmit={submit}>
        <label className="library-search">
          <Search size={18} />
          <input
            aria-label="搜索全部学习集"
            placeholder="搜索学习集…"
            maxLength={120}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" aria-label="搜索学习集">
            <ArrowRight size={17} />
          </button>
        </label>
        <label className="library-sort">
          <Clock3 size={15} />
          <select
            aria-label="学习集排序"
            value={sort}
            onChange={(e) => filter(draft, e.target.value as LibrarySort)}
          >
            <option value="recent">最近活动</option>
            <option value="created">最近创建</option>
            <option value="title">名称排序</option>
          </select>
        </label>
        <button
          className="icon-button"
          type="button"
          title="刷新学习集"
          aria-label="刷新学习集列表"
          disabled={loading}
          onClick={() => setReload((v) => v + 1)}
        >
          <RefreshCw size={17} />
        </button>
        <button type="button" className="btn btn-black" onClick={onCreate}>
          <Plus size={16} />
          创建学习集
        </button>
      </form>
      {loading ? (
        <div className="cloud-loading" role="status">
          正在读取学习集…
        </div>
      ) : null}
      {error ? (
        <div className="cloud-error" role="alert">
          <p>{error}</p>
          <button
            className="btn"
            onClick={() => (cursor ? void loadMore() : setReload((v) => v + 1))}
          >
            重试
          </button>
        </div>
      ) : null}
      {resume ? (
        <section className="library-resume">
          <span className="resume-mark">
            <BookOpen size={24} />
          </span>
          <div>
            <small>继续学习 · {resume.title}</small>
            <h2>{resume.summary.continue!.label}</h2>
            <p>
              {resume.summary.dueCardCount
                ? `${resume.summary.dueCardCount} 张闪卡待复习`
                : "沿着自己的节奏，完成下一步。"}
              {resume.summary.pendingTaskCount
                ? ` · ${resume.summary.pendingTaskCount} 项任务待完成`
                : ""}
            </p>
          </div>
          <a
            className="btn btn-black"
            href={resume.summary.continue!.href}
            onClick={(e) => {
              if (!e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                onNavigate(resume.summary.continue!.href);
              }
            }}
          >
            继续学习
            <ArrowRight size={16} />
          </a>
        </section>
      ) : null}
      {!loading && !error && !items.length ? (
        <section className="cloud-empty">
          <FolderPlus size={32} />
          <h2>{query ? "没有找到匹配的学习集" : "从你的第一份资料开始"}</h2>
          <p>
            {query
              ? "试试更短的名称，或清除关键词查看全部学习集。"
              : "为课程、考试或感兴趣的主题创建一个学习集。"}
          </p>
          <button
            className="btn btn-black"
            onClick={() => (query ? filter("") : onCreate())}
          >
            {query ? "查看全部学习集" : "创建学习集"}
          </button>
        </section>
      ) : null}
      <div className="library-grid">
        {!query && !loading && !error ? (
          <button className="library-new" onClick={onCreate}>
            <span>
              <Plus size={25} />
            </span>
            <strong>创建学习集</strong>
            <small>把资料、笔记和练习放在一起</small>
          </button>
        ) : null}
        {items.map((item) => (
          <article
            className={`library-card tone-${setTone(item.id)}`}
            key={item.id}
            data-study-set-id={item.id}
          >
            <SetActions
              set={item}
              onRename={onRename}
              onNavigate={onNavigate}
            />
            <a
              className="library-card-title"
              href={studySetPath(item.id)}
              onClick={(e) => {
                if (!e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  onNavigate(studySetPath(item.id));
                }
              }}
            >
              <span className="library-icon">
                <BookOpen size={23} />
              </span>
              <h2>{item.title}</h2>
            </a>
            <div className="library-counts">
              <span>
                <FileText size={13} />
                {item.summary.materialCount} 份资料
              </span>
              <span>
                <Layers size={13} />
                {item.summary.deckCount} 套闪卡
              </span>
              <span>{item.summary.quizCount} 份测验</span>
              {item.summary.noteCount ? (
                <span>{item.summary.noteCount} 篇笔记</span>
              ) : null}
            </div>
            <div className="library-status">
              {item.summary.dueCardCount ? (
                <span className="due-pill">
                  待复习 {item.summary.dueCardCount}
                </span>
              ) : null}
              {item.summary.pendingTaskCount ? (
                <span>
                  <CalendarDays size={13} />
                  {item.summary.pendingTaskCount} 项任务
                </span>
              ) : null}
            </div>
            <footer>
              <small>
                {item.summary.lastStudiedAt
                  ? "上次学习 " + studyDate(item.summary.lastStudiedAt)
                  : "尚未开始学习"}
              </small>
              <a
                href={item.summary.continue?.href ?? studySetPath(item.id)}
                onClick={(e) => {
                  if (!e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    onNavigate(
                      item.summary.continue?.href ?? studySetPath(item.id),
                    );
                  }
                }}
              >
                {item.summary.continue ? "继续学习" : "打开学习集"}
                <ArrowRight size={14} />
              </a>
            </footer>
          </article>
        ))}
      </div>
      {cursor ? (
        <div className="cloud-load-more">
          <button
            className="btn"
            disabled={more || loading}
            onClick={() => void loadMore()}
          >
            {more ? "正在加载…" : "加载更多学习集"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
