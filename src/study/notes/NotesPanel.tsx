import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import type { MaterialSummary } from "../api";
import { registerStudyLeaveGuard } from "../navigation";
import { materialPath, studySetPath } from "../routes";
import {
  createNotesApi,
  type Detail,
  type Job,
  type Note,
  type Result,
  type Source,
} from "./api";
import SafeMarkdown from "./SafeMarkdown";
import "./notes.css";
type Props = {
  studySetId: string;
  materials: MaterialSummary[];
  onNavigate: (path: string) => boolean;
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : "请求未完成，请重试。";
const active = (j: Job) =>
  ["queued", "running"].includes(j.status) ||
  j.attempts.some((a) => ["queued", "running"].includes(a.status));
export default function NotesPanel({
  studySetId,
  materials,
  onNavigate,
}: Props) {
  const auth = useAuth(),
    scope = useRef(new AbortController()),
    epoch = useRef(0);
  const api = useMemo(
    () => createNotesApi(auth.request, studySetId, () => scope.current.signal),
    [auth.request, studySetId],
  );
  const [items, setItems] = useState<Note[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [enabled, setEnabled] = useState(true),
    [detail, setDetail] = useState<Detail | null>(null),
    [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState<null | (() => Promise<void>)>(null),
    [form, setForm] = useState(false),
    [editing, setEditing] = useState(false);
  const params = new URLSearchParams(location.search),
    noteId = params.get("noteId"),
    jobId = params.get("generationId"),
    base = `${studySetPath(studySetId)}/notes`;
  const uuid = (value: string | null) =>
    !!value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  const valid = !(
    (params.has("noteId") && !uuid(noteId)) ||
    (params.has("generationId") && !uuid(jobId)) ||
    (params.has("noteId") && params.has("generationId")) ||
    params.getAll("noteId").length > 1 ||
    params.getAll("generationId").length > 1
  );
  async function run(fn: () => Promise<void>, retain = false) {
    if (busy) return;
    const e = epoch.current;
    setBusy(true);
    setError("");
    setRetry(null);
    try {
      await fn();
    } catch (cause) {
      if (e === epoch.current && !scope.current.signal.aborted) {
        setError(message(cause));
        const s =
          (
            cause as {
              status?: number;
            }
          ).status ?? 0;
        if (retain && (s === 0 || s >= 500)) setRetry(() => fn);
      }
    } finally {
      if (e === epoch.current && !scope.current.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    const e = ++epoch.current;
    void run(async () => {
      if (!valid) throw new Error("笔记地址无效。");
      const [page, records, selected, candidate] = await Promise.all([
        api.list(),
        api.jobs(),
        noteId ? api.get(noteId) : null,
        jobId ? api.job(jobId) : null,
      ]);
      if (e !== epoch.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setEnabled(page.enabled);
      setJobs(records);
      setDetail(selected);
      setJob(candidate);
    });
    return () => {
      controller.abort();
      ++epoch.current;
    };
  }, [api]);
  useEffect(() => {
    if (!job || !active(job)) return;
    let live = true;
    const timer = setTimeout(() => {
      void api
        .job(job.id)
        .then((j) => {
          if (live) setJob(j);
        })
        .catch((e) => {
          if (live) setError(message(e));
        });
    }, 1500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, job]);
  const open = (n: Note) => onNavigate(`${base}?noteId=${n.id}`),
    candidate = (j: Job) => onNavigate(`${base}?generationId=${j.id}`);
  return (
    <section className="notes-panel">
      <div className="cloud-page-heading">
        <div>
          <span className="cloud-eyebrow">STUDY NOTES</span>
          <h1>{detail ? detail.note.title : "学习笔记"}</h1>
          <p>从资料整理要点，确认后保存为自己的笔记。</p>
        </div>
        <button
          className="btn"
          disabled={busy || (!enabled && !detail && !job)}
          onClick={() => {
            if (detail || job) onNavigate(base);
            else setForm(!form);
          }}
        >
          {detail || job ? "返回笔记列表" : form ? "收起" : "生成笔记"}
        </button>
      </div>
      {!enabled ? (
        <p role="status">笔记生成和编辑暂时关闭，已保存内容仍可查看。</p>
      ) : null}
      {error ? (
        <div role="alert" className="cloud-form-error">
          <p>{error}</p>
          {retry ? (
            <button
              className="btn"
              disabled={busy}
              onClick={() => void run(retry, true)}
            >
              重试同一次请求
            </button>
          ) : (
            <button
              className="btn"
              disabled={busy}
              onClick={() => location.reload()}
            >
              重新读取
            </button>
          )}
        </div>
      ) : null}
      {busy ? <p role="status">正在处理…</p> : null}
      {form && !detail && !job && enabled ? (
        <Generator
          materials={materials}
          disabled={busy || !!retry}
          onGenerate={(body) => {
            const request = {
              ...body,
              clientRequestId: crypto.randomUUID(),
              kind: "study_note",
            };
            void run(async () => {
              candidate(await api.generate(request));
            }, true);
          }}
        />
      ) : null}
      {job ? (
        <article className="note-box">
          <h2>{job.result?.title ?? "笔记候选"}</h2>
          <p role="status">
            {active(job)
              ? "正在依据资料生成笔记…"
              : job.status === "succeeded"
                ? "候选已生成，尚未保存为笔记。"
                : job.status === "cancelled"
                  ? "生成已停止。"
                  : job.errorCode === "provider_rate_limited"
                    ? "模型服务限流，请稍后明确重试。"
                    : "这次生成没有完成，可以稍后重试。"}
          </p>
          {job.result ? (
            <>
              <Sections
                result={job.result}
                sources={job.inputSnapshot.sources}
                materials={materials}
                setId={studySetId}
              />
              <button
                className="btn btn-black"
                disabled={busy || !enabled}
                onClick={() => {
                  const input = {
                    jobId: job.id,
                    clientRequestId: crypto.randomUUID(),
                  };
                  void run(async () => {
                    open(await api.save(input));
                  }, true);
                }}
              >
                保存为笔记
              </button>
            </>
          ) : null}
          {active(job) ? (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.cancel(job.id);
                  setJob(await api.job(job.id));
                }, true)
              }
            >
              停止生成笔记
            </button>
          ) : ["failed", "cancelled", "interrupted"].includes(job.status) &&
            job.attempts.length < 3 ? (
            <button
              className="btn"
              disabled={busy || !enabled}
              onClick={() => {
                const id = crypto.randomUUID();
                void run(async () => {
                  await api.retry(job.id, id);
                  setJob(await api.job(job.id));
                }, true);
              }}
            >
              明确重试原候选
            </button>
          ) : null}
        </article>
      ) : null}
      {detail ? (
        <article className="note-box">
          {editing ? (
            <Editor
              key={detail.note.id}
              detail={detail}
              api={api}
              onSaved={(note) => {
                setDetail({ ...detail, note });
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <p>
                版本 {detail.note.version} ·{" "}
                {new Date(detail.note.updatedAt).toLocaleString("zh-CN")}
              </p>
              {detail.note.manuallyEdited ? (
                <p className="note-warning">
                  正文已手动编辑。下方保留原始生成引用，尚未对编辑后的内容重新验证。
                </p>
              ) : null}
              <SafeMarkdown body={detail.note.body} />
              <button
                className="btn"
                disabled={!enabled}
                onClick={() => setEditing(true)}
              >
                编辑笔记
              </button>
              <p>需要重新生成时，返回列表创建新候选；当前笔记会保留。</p>
            </>
          )}
          <details className="note-origin">
            <summary>查看原始生成稿与引用</summary>
            <h2>{detail.origin.result.title}</h2>
            <Sections
              result={detail.origin.result}
              sources={detail.origin.sourceSnapshots}
              materials={materials}
              setId={studySetId}
            />
          </details>
        </article>
      ) : null}
      {!detail && !job ? (
        <>
          <h2>已保存笔记</h2>
          {!items.length && !busy ? (
            <p>还没有保存笔记。选择资料生成一份候选吧。</p>
          ) : null}
          <div className="note-list">
            {items.map((n) => (
              <button className="note-box" key={n.id} onClick={() => open(n)}>
                <strong>{n.title}</strong>
                <span>
                  版本 {n.version} ·{" "}
                  {n.manuallyEdited ? "已编辑" : "原始生成稿"}
                </span>
              </button>
            ))}
          </div>
          {cursor ? (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const page = await api.list(cursor);
                  setItems((old) => [
                    ...old,
                    ...page.items.filter(
                      (n) => !old.some((o) => o.id === n.id),
                    ),
                  ]);
                  setCursor(page.nextCursor);
                })
              }
            >
              加载更多笔记
            </button>
          ) : null}
          <h2>最近生成记录</h2>
          {jobs.map((j) => (
            <button
              key={j.id}
              className="note-record"
              onClick={() => candidate(j)}
            >
              {j.result?.title ?? "笔记候选"} ·{" "}
              {j.status === "succeeded"
                ? "已生成"
                : active(j)
                  ? "生成中"
                  : "未完成"}
            </button>
          ))}
        </>
      ) : null}
    </section>
  );
}
function Generator({
  materials,
  disabled,
  onGenerate,
}: {
  materials: MaterialSummary[];
  disabled: boolean;
  onGenerate: (
    body: unknown & {
      sources: {
        materialId: string;
        version: number;
      }[];
      config: {
        language: string;
        sectionCount: number;
      };
    },
  ) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [count, setCount] = useState(3),
    [language, setLanguage] = useState("zh-CN");
  return (
    <form
      className="note-box"
      onSubmit={(e) => {
        e.preventDefault();
        onGenerate({
          sources: materials
            .filter((m) => selected.includes(m.id))
            .map((m) => ({ materialId: m.id, version: m.version })),
          config: { language, sectionCount: count },
        });
      }}
    >
      <h2>选择资料</h2>
      <fieldset disabled={disabled}>
        {materials.map((m) => (
          <label className="note-source-choice" key={m.id}>
            <input
              type="checkbox"
              checked={selected.includes(m.id)}
              disabled={!selected.includes(m.id) && selected.length >= 5}
              onChange={(e) =>
                setSelected((old) =>
                  e.target.checked
                    ? [...old, m.id]
                    : old.filter((id) => id !== m.id),
                )
              }
            />
            {m.title} · v{m.version}
          </label>
        ))}
        <p>选择 1–5 份资料，生成内容仅依据这些资料。</p>
        <label>
          章节数
          <input
            aria-label="章节数"
            type="number"
            min={1}
            max={8}
            required
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </label>
        <label>
          语言
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <button className="btn btn-black" disabled={!selected.length}>
          开始生成笔记
        </button>
      </fieldset>
    </form>
  );
}
function Sections({
  result,
  sources,
  materials,
  setId,
}: {
  result: Result;
  sources: Source[];
  materials: MaterialSummary[];
  setId: string;
}) {
  return (
    <>
      {result.sections.map((s, i) => (
        <section key={i}>
          <h3>{s.heading}</h3>
          <SafeMarkdown body={s.body} />
          {s.citations.map((c, j) => {
            const source = sources.find((s) => s.sourceId === c.sourceId),
              current = materials.find((m) => m.id === c.materialId);
            return (
              <details className="note-citation" key={j}>
                <summary>
                  {source?.title ?? "原资料"} · 原始 v{c.version}
                  {c.page ? ` · 第 ${c.page} 页` : ""}
                  {current && current.version !== c.version
                    ? `（当前 v${current.version}）`
                    : ""}
                </summary>
                <blockquote>{c.quote}</blockquote>
                <details>
                  <summary>查看原始资料快照</summary>
                  <pre>{source?.body ?? "快照暂时无法读取"}</pre>
                </details>
                <a href={materialPath(setId, c.materialId)}>查看当前资料</a>
              </details>
            );
          })}
        </section>
      ))}
    </>
  );
}
function Editor({
  detail,
  api,
  onSaved,
  onCancel,
}: {
  detail: Detail;
  api: ReturnType<typeof createNotesApi>;
  onSaved: (n: Note) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(detail.note.title),
    [body, setBody] = useState(detail.note.body),
    [version, setVersion] = useState(detail.note.version),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [latest, setLatest] = useState<Note | null>(null);
  const live = useRef(true),
    dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    live.current = true;
    const leave = () =>
      !dirtyRef.current || confirm("笔记有尚未保存的修改，确定离开吗？");
    const cleanup = registerStudyLeaveGuard(leave);
    const unload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      live.current = false;
      cleanup();
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy || latest) return;
    setBusy(true);
    setError("");
    try {
      const n = await api.edit(detail.note.id, { title, body, version });
      if (live.current) {
        dirtyRef.current = false;
        onSaved(n);
      }
    } catch (e) {
      if (!live.current) return;
      setError(message(e));
      if (
        (
          e as {
            status?: number;
          }
        ).status === 409
      ) {
        try {
          const n = await api.get(detail.note.id);
          if (live.current) setLatest(n.note);
        } catch (c) {
          if (live.current) setError(message(c));
        }
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => void save(e)}>
      <label>
        笔记标题
        <input
          className="field"
          required
          maxLength={160}
          disabled={busy}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <label>
        笔记正文
        <textarea
          className="field note-editor"
          required
          disabled={busy}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <p>支持标题、段落、列表和引用。HTML、图片和脚本会作为普通文字显示。</p>
      {error ? <p role="alert">{error}</p> : null}
      {latest ? (
        <section className="note-conflict">
          <h3>发现另一页面的更新</h3>
          <p>
            你的输入保留在编辑框中。请比较云端版本 {latest.version}{" "}
            后选择，再明确保存。
          </p>
          <h4>{latest.title}</h4>
          <pre>{latest.body}</pre>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setVersion(latest.version);
              setLatest(null);
              setError("");
            }}
          >
            保留我的内容继续编辑
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setTitle(latest.title);
              setBody(latest.body);
              setVersion(latest.version);
              setLatest(null);
              setDirty(true);
              setError("");
            }}
          >
            使用云端内容
          </button>
        </section>
      ) : null}
      <div className="note-actions">
        <button
          className="btn btn-black"
          disabled={
            busy ||
            !!latest ||
            !title.trim() ||
            !body.trim() ||
            new TextEncoder().encode(body).length > 65536
          }
        >
          {busy ? "正在保存…" : "保存修改"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            if (!dirty || confirm("放弃尚未保存的修改？")) onCancel();
          }}
        >
          取消编辑
        </button>
      </div>
    </form>
  );
}
