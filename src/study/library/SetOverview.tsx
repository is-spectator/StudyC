import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  ClipboardCheck,
  FileText,
  Layers,
  MessageCircle,
  Plus,
  Route,
  Download,
  Upload,
} from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import type { StudySet, MaterialSummary, SourceFile, StudyApi } from "../api";
import { studySetPath, materialPath } from "../routes";
import PdfUpload, { type PdfFileListState } from "../PdfUpload";
import { createLibraryApi, type LibrarySet } from "./api";
import SetActions, { setTone } from "./SetActions";
type Materials = {
  items: MaterialSummary[];
  loading: boolean;
  loadingMore: boolean;
  error: string;
  nextCursor: string | null;
  reload: () => void;
  loadMore: () => Promise<void>;
};
export default function SetOverview({
  set,
  api,
  materials,
  onNavigate,
  onRename,
}: {
  set: StudySet;
  api: StudyApi;
  materials: Materials;
  onNavigate: (p: string) => boolean;
  onRename: (s: StudySet) => void;
}) {
  const auth = useAuth(),
    library = useMemo(() => createLibraryApi(auth.request), [auth.request]),
    [detail, setDetail] = useState<LibrarySet | null>(null),
    [detailError, setDetailError] = useState(""),
    [fileList, setFileList] = useState<PdfFileListState>({ studySetId: set.id, files: [], loading: true, loaded: false, error: "" }),
    [filesRevision, setFilesRevision] = useState(0),
    [adding, setAdding] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setDetail(null);
    setDetailError("");
    void library
      .get(set.id, c.signal)
      .then((r) => {
        if (!c.signal.aborted) setDetail(r);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setDetailError(
            e instanceof Error ? e.message : "学习进度暂时无法读取。",
          );
      });
    return () => c.abort();
  }, [library, set.id, revision]);
  const currentFiles = fileList.studySetId === set.id ? fileList : { studySetId: set.id, files: [], loading: true, loaded: false, error: "" },
    files = currentFiles.files,
    root = studySetPath(set.id),
    summary = detail?.summary,
    download = async (file: SourceFile) => {
      setError("");
      try {
        const blob = await api.downloadPdf(set.id, file.id),
          url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = file.displayName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        setError(e instanceof Error ? e.message : "原文件暂时无法下载。");
      }
    };
  const tools = [
    {
      path: "chat/new",
      title: "问问小C",
      description: "带着问题理解资料",
      Icon: MessageCircle,
      tone: "lilac",
    },
    {
      path: "flashcards",
      title: "闪卡复习",
      description: summary?.dueCardCount
        ? `${summary.dueCardCount} 张闪卡到期`
        : "把知识点牢牢记住",
      Icon: Layers,
      tone: "sage",
    },
    {
      path: "practice",
      title: "测验与考试",
      description: "用练习检查理解",
      Icon: ClipboardCheck,
      tone: "sky",
    },
    {
      path: "study-plan",
      title: "学习计划",
      description: summary?.pendingTaskCount
        ? `${summary.pendingTaskCount} 项任务待完成`
        : "安排下一步的学习",
      Icon: Route,
      tone: "sand",
    },
  ];
  return (
    <div className="cloud-page overview-page">
      <header className="overview-heading">
        <span className={`overview-cover tone-${setTone(set.id)}`}>
          <BookOpen size={34} />
        </span>
        <div>
          <h1>{set.title}</h1>
          {summary ? (
            <p>
              {summary.materialCount} 份资料 · {summary.deckCount} 套闪卡 ·{" "}
              {summary.quizCount} 份测验
              {summary.noteCount ? ` · ${summary.noteCount} 篇笔记` : ""}
            </p>
          ) : (
            <p>你的资料、笔记与学习进度</p>
          )}
        </div>
        <SetActions set={set} onRename={onRename} onNavigate={onNavigate} />
        <button
          className="btn btn-black"
          onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}
        >
          <Plus size={16} />
          {adding ? "收起添加资料" : "添加资料"}
        </button>
      </header>
      {detailError ? (
        <div className="overview-load-error" role="alert">
          {detailError}
          <button
            className="org-text-link"
            onClick={() => setRevision((v) => v + 1)}
          >
            重新读取进度
          </button>
        </div>
      ) : null}
      {summary?.continue ? (
        <section className="overview-next">
          <div>
            <small>继续你的学习</small>
            <h2>{summary.continue.label}</h2>
            <p>
              {summary.pendingTaskCount
                ? `还有 ${summary.pendingTaskCount} 项学习任务，按自己的节奏完成。`
                : "按自己的节奏，完成下一步。"}
            </p>
          </div>
          <button
            className="btn btn-black"
            onClick={() => onNavigate(summary.continue!.href)}
          >
            继续学习
            <ArrowRight size={16} />
          </button>
        </section>
      ) : summary && summary.materialCount === 0 ? (
        <section className="overview-next">
          <div>
            <h2>先放入一份想学的资料</h2>
            <p>添加笔记或 PDF 后，就能开始问答、闪卡和测验。</p>
          </div>
          <button className="btn" onClick={() => setAdding(true)}>
            添加第一份资料
            <Plus size={16} />
          </button>
        </section>
      ) : null}
      <section className="overview-tools" aria-label="学习工具">
        {tools.map(({ path, title, description, Icon, tone }) => (
          <a
            key={path}
            className={`overview-tool tone-${tone}`}
            href={root + "/" + path}
            onClick={(e) => {
              if (!e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                onNavigate(root + "/" + path);
              }
            }}
          >
            <span>
              <Icon size={29} />
            </span>
            <strong>{title}</strong>
            <small>{description}</small>
            <ArrowRight size={16} />
          </a>
        ))}
      </section>
      <div className="overview-add" hidden={!adding}>
        <div className="overview-add-text">
          <div>
            <h2>写下笔记，或上传资料</h2>
            <p>学习内容只保存在当前学习集中。</p>
          </div>
          <button
            className="btn"
            onClick={() => onNavigate(materialPath(set.id))}
          >
            <FileText size={16} />
            新建文本资料
          </button>
        </div>
        <PdfUpload
          api={api}
          studySetId={set.id}
          hideRecords
          filesRevision={filesRevision}
          onFileListChange={setFileList}
          onExtracted={() => {
            materials.reload();
            setRevision((v) => v + 1);
          }}
        />
      </div>
      <section className="overview-materials">
        <header className="section-heading">
          <h2>学习资料</h2>
          <button className="btn" onClick={() => setAdding((v) => !v)}>
            <Upload size={15} />
            添加资料
          </button>
        </header>
        {materials.loading ? <p role="status">正在读取资料…</p> : null}
        {currentFiles.loading ? <p role="status">正在读取上传记录…</p> : null}
        {currentFiles.error ? (
          <div className="cloud-error" role="alert">
            <p>上传记录读取失败：{currentFiles.error}</p>
            <button className="btn" onClick={() => setFilesRevision(value => value + 1)}>
              重新读取上传记录
            </button>
          </div>
        ) : null}
        {materials.error ? (
          <div className="cloud-error" role="alert">
            <p>{materials.error}</p>
            <button className="btn" onClick={materials.reload}>
              重试
            </button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="cloud-form-error">
            {error}
          </p>
        ) : null}
        {!materials.loading &&
        !materials.error &&
        currentFiles.loaded &&
        !materials.items.length &&
        !files.length ? (
          <div className="overview-material-empty">
            <FileText size={26} />
            <p>这里还没有资料。添加一份笔记或 PDF，开始学习。</p>
            <button className="btn" onClick={() => setAdding(true)}>
              添加资料
            </button>
          </div>
        ) : null}
        <div className="overview-material-list">
          {materials.items.map((m) => {
            const source = files.find((f) => f.materialId === m.id);
            return (
              <article key={m.id} data-material-id={m.id}>
                <span className={`material-kind ${source ? "is-pdf" : ""}`}>
                  <FileText size={20} />
                </span>
                <a
                  href={materialPath(set.id, m.id)}
                  onClick={(e) => {
                    if (!e.metaKey && !e.ctrlKey) {
                      e.preventDefault();
                      onNavigate(materialPath(set.id, m.id));
                    }
                  }}
                >
                  <strong>{m.title}</strong>
                  <small>
                    {source
                      ? `PDF · ${source.pageCount} 页 · 文字已提取`
                      : currentFiles.loaded ? "文本笔记" : "资料来源待确认"}{" "}
                    · {new Date(m.updatedAt).toLocaleDateString("zh-CN")} 更新
                  </small>
                </a>
                {source ? (
                  <button
                    className="btn material-download"
                    onClick={() => void download(source)}
                  >
                    <Download size={14} />
                    原文件
                  </button>
                ) : null}
                <ArrowRight size={15} />
              </article>
            );
          })}
          {files
            .filter((f) => !f.materialId)
            .map((f) => (
              <article
                key={f.id}
                className="material-unparsed"
                data-source-file-id={f.id}
              >
                <span className="material-kind is-pdf">
                  <FileText size={20} />
                </span>
                <div>
                  <strong>{f.displayName}</strong>
                  <small>
                    {
                      (
                        {
                          no_extractable_text: "未提取到文字，扫描件暂不支持",
                          encrypted_pdf: "文件已加密，无法提取文字",
                          invalid_pdf: "文件无法读取，请重新选择",
                          text_too_large: "文字过多，请拆分文件",
                          too_many_pages: "超过30页，请拆分文件",
                          ready: "已上传",
                        } as const
                      )[f.status]
                    }
                  </small>
                </div>
              </article>
            ))}
        </div>
        {materials.nextCursor ? (
          <div className="cloud-load-more">
            <button
              className="btn"
              disabled={materials.loadingMore}
              onClick={() => void materials.loadMore()}
            >
              {materials.loadingMore ? "正在加载…" : "加载更多资料"}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
