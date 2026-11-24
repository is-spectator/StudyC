import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { createStudyApi } from "../api";
import { studySetPath } from "../routes";
import { useOrganization, uuidPattern } from "../organization/useOrganization";
import { useDraftGuard } from "../organization/useDraftGuard";
import OrganizationStatus from "../organization/OrganizationStatus";
import {
  createFolderApi,
  type Folder,
  type FolderSet,
  type Assignment,
} from "./api";
import "../organization/organization.css";
type Api = ReturnType<typeof createFolderApi>;
export default function FoldersPanel({
  onNavigate,
}: {
  onNavigate: (p: string) => boolean;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    api = useMemo(() => createFolderApi(op.call), [op.call]),
    study = useMemo(() => createStudyApi(op.call), [op.call]);
  const [folders, setFolders] = useState<Folder[]>([]),
    [folderCursor, setFolderCursor] = useState<string | null>(null),
    [folder, setFolder] = useState<Folder | null>(null),
    [sets, setSets] = useState<FolderSet[]>([]),
    [setsCursor, setSetsCursor] = useState<string | null>(null),
    [enabled, setEnabled] = useState(true),
    [showForm, setShowForm] = useState(false),
    [moving, setMoving] = useState<{
      set: FolderSet;
      assignment: Assignment;
    } | null>(null);
  const params = new URLSearchParams(location.search),
    selected = params.get("folderId"),
    moveId = params.get("moveSetId");
  useDraftGuard(!!op.retry);
  const base = "/platform/folders",
    path = (id: string) => base + "?folderId=" + id;
  const load = async () => {
    if (
      [...params.keys()].some((k) => params.getAll(k).length > 1) ||
      (params.has("folderId") &&
        selected !== "unfiled" &&
        !uuidPattern.test(selected ?? "")) ||
      (params.has("moveSetId") && !uuidPattern.test(moveId ?? "")) ||
      (selected && moveId)
    )
      throw new Error("文件夹地址无效。");
    const [page, current, children, preset, assignment] = await Promise.all([
      api.list(),
      selected && selected !== "unfiled" ? api.get(selected) : null,
      selected ? api.sets(selected) : null,
      moveId ? study.getSet(moveId) : null,
      moveId ? api.assignment(moveId) : null,
    ]);
    let options =
      current && !page.items.some((f) => f.id === current.id)
        ? [current, ...page.items]
        : page.items;
    if (
      assignment?.folderId &&
      !options.some((f) => f.id === assignment.folderId)
    )
      options = [await api.get(assignment.folderId), ...options];
    setFolders(options);
    setFolderCursor(page.nextCursor);
    setFolder(current);
    setSets(children?.items ?? []);
    setSetsCursor(children?.nextCursor ?? null);
    setEnabled(page.enabled);
    if (preset && assignment)
      setMoving({
        set: {
          ...preset,
          folderId: assignment.folderId,
          assignmentVersion: assignment.version,
        },
        assignment,
      });
  };
  useEffect(() => {
    void op.run(load);
  }, [api, study]);
  const moreFolders = async () => {
    if (!folderCursor) return;
    const page = await api.list(folderCursor);
    setFolders((old) => [
      ...old,
      ...page.items.filter((f) => !old.some((o) => o.id === f.id)),
    ]);
    setFolderCursor(page.nextCursor);
  };
  const remove = () => {
    if (
      !folder ||
      !confirm("删除文件夹会将其中学习集移到未分类，资料和学习记录保留。继续？")
    )
      return;
    const input = {
      clientRequestId: crypto.randomUUID(),
      version: folder.version,
    };
    void op.run(async () => {
      await api.remove(folder.id, input);
      onNavigate(path("unfiled"));
    }, true);
  };
  return (
    <section className="organization-panel">
      <header className="cloud-page-heading">
        <div>
          <span className="cloud-eyebrow">ORGANIZE YOUR LEARNING</span>
          <h1>
            {folder?.title ??
              (selected === "unfiled" ? "未分类学习集" : "文件夹")}
          </h1>
          <p>按自己的主题归类学习集，资料与学习记录留在原处。</p>
        </div>
        <div className="org-actions">
          {selected || moveId ? (
            <button
              className="btn"
              disabled={op.busy}
              onClick={() => onNavigate(base)}
            >
              全部文件夹
            </button>
          ) : null}
          <button
            className="btn btn-black"
            disabled={!enabled || op.busy || !!op.retry || showForm || !!moving}
            onClick={() => setShowForm(true)}
          >
            {folder ? "重命名文件夹" : "新建文件夹"}
          </button>
          {folder ? (
            <button
              className="btn"
              disabled={
                !enabled || op.busy || !!op.retry || showForm || !!moving
              }
              onClick={remove}
            >
              删除文件夹
            </button>
          ) : null}
        </div>
      </header>
      {!enabled ? <p role="status">文件夹暂时只允许查看。</p> : null}
      <OrganizationStatus
        {...op}
        onRetry={() => void op.run(op.retry ?? load, !!op.retry)}
      />
      {showForm ? (
        <FolderEditor
          key={folder?.id ?? "new"}
          folder={folder}
          api={api}
          enabled={enabled}
          onCancel={() => setShowForm(false)}
          onSaved={(f) => {
            setShowForm(false);
            if (folder) {
              setFolder(f);
              setFolders((old) => old.map((o) => (o.id === f.id ? f : o)));
            } else onNavigate(path(f.id));
          }}
        />
      ) : null}
      {moving ? (
        <MoveEditor
          key={moving.set.id}
          set={moving.set}
          assignment={moving.assignment}
          api={api}
          enabled={enabled}
          folders={folders}
          hasMore={!!folderCursor}
          onMore={moreFolders}
          onFolder={(f) => setFolders(old => old.some(o => o.id === f.id) ? old : [f, ...old])}
          onCancel={() => {
            setMoving(null);
            if (moveId) onNavigate(base);
          }}
          onSaved={(a) => {
            setMoving(null);
            const target = path(a.folderId ?? "unfiled");
            if (location.pathname + location.search === target)
              void op.run(load);
            else onNavigate(target);
          }}
        />
      ) : null}
      {!selected && !moveId ? (
        <>
          <div className="org-grid">
            <button
              className="org-box org-select"
              disabled={op.busy}
              onClick={() => onNavigate(path("unfiled"))}
            >
              <h2>未分类</h2>
              <p>尚未放入文件夹的学习集</p>
            </button>
            {folders.map((f) => (
              <button
                className="org-box org-select"
                key={f.id}
                disabled={op.busy}
                onClick={() => onNavigate(path(f.id))}
              >
                <h2>{f.title}</h2>
                <p>{f.setCount} 个学习集</p>
              </button>
            ))}
          </div>
          {folderCursor ? (
            <button
              className="btn"
              disabled={op.busy}
              onClick={() => void op.run(moreFolders)}
            >
              加载更多文件夹
            </button>
          ) : null}
          <p className="org-small">
            每个学习集归入一个一级文件夹。移动归类不改变对象ID，不复制或删除学习内容。
          </p>
        </>
      ) : null}
      {selected ? (
        <>
          <h2>文件夹内的学习集</h2>
          {!sets.length && !op.busy ? (
            <div className="org-box">
              <h3>这里还没有学习集</h3>
              <p>从未分类或其他文件夹中选择学习集，移动到这里。</p>
              <button
                className="btn"
                onClick={() => onNavigate(path("unfiled"))}
              >
                查看未分类
              </button>
            </div>
          ) : null}
          {sets.map((s) => (
            <article className="org-box" key={s.id}>
              <h3>{s.title}</h3>
              <p className="org-small">
                更新于 {new Date(s.updatedAt).toLocaleString("zh-CN")}
              </p>
              <div className="org-actions">
                <button
                  className="btn"
                  disabled={op.busy || !!moving}
                  onClick={() => onNavigate(studySetPath(s.id))}
                >
                  打开学习集
                </button>
                <button
                  className="btn"
                  disabled={
                    !enabled || op.busy || !!op.retry || showForm || !!moving
                  }
                  onClick={() =>
                    setMoving({
                      set: s,
                      assignment: {
                        studySetId: s.id,
                        folderId: s.folderId,
                        folderTitle: folder?.title ?? null,
                        version: s.assignmentVersion,
                      },
                    })
                  }
                >
                  移动或归类
                </button>
              </div>
            </article>
          ))}
          {setsCursor ? (
            <button
              className="btn"
              disabled={op.busy || !!moving}
              onClick={() =>
                void op.run(async () => {
                  const page = await api.sets(selected, setsCursor);
                  setSets((old) => [
                    ...old,
                    ...page.items.filter(
                      (n) => !old.some((s) => s.id === n.id),
                    ),
                  ]);
                  setSetsCursor(page.nextCursor);
                })
              }
            >
              加载更多学习集
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
function FolderEditor({
  folder,
  api,
  enabled,
  onCancel,
  onSaved,
}: {
  folder: Folder | null;
  api: Api;
  enabled: boolean;
  onCancel: () => void;
  onSaved: (f: Folder) => void;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    [title, setTitle] = useState(folder?.title ?? ""),
    [version, setVersion] = useState(folder?.version),
    [latest, setLatest] = useState<Folder | null>(null),
    [dirty, setDirty] = useState(false),
    clean = useDraftGuard(dirty || !!op.retry);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = {
      clientRequestId: crypto.randomUUID(),
      title,
      ...(version ? { version } : {}),
    };
    void op.run(async () => {
      try {
        const f = await api.save(folder?.id, input);
        clean();
        onSaved(f);
      } catch (e) {
        if ((e as { code?: string }).code === "version_conflict" && folder)
          setLatest(await api.get(folder.id));
        throw e;
      }
    }, true);
  };
  return (
    <form className="org-box" onSubmit={submit}>
      <h2>{folder ? "编辑文件夹名称" : "创建文件夹"}</h2>
      <label>
        文件夹名称
        <input
          className="field"
          autoFocus
          required
          maxLength={80}
          value={title}
          disabled={!enabled || op.busy || !!op.retry}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <p>同一账户中有效文件夹名称不能重复，不区分普通字母大小写。</p>
      <OrganizationStatus
        {...op}
        onRetry={op.retry ? () => void op.run(op.retry!, true) : undefined}
      />
      {latest ? (
        <div className="org-conflict">
          <h3>文件夹已在另一页面更新</h3>
          <p>云端名称：{latest.title}。你的输入已保留。</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setVersion(latest.version);
              setLatest(null);
              op.clearError();
            }}
          >
            保留我的名称继续编辑
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setTitle(latest.title);
              setVersion(latest.version);
              setLatest(null);
              op.clearError();
            }}
          >
            采用云端名称
          </button>
        </div>
      ) : null}
      <div className="org-actions">
        <button
          className="btn btn-black"
          disabled={
            !enabled || op.busy || !!op.retry || !!latest || !title.trim()
          }
        >
          保存文件夹
        </button>
        <button
          className="btn"
          type="button"
          disabled={op.busy}
          onClick={() => {
            if (
              (!dirty && !op.retry) ||
              confirm(
                op.retry
                  ? "保存结果尚未确认，确定离开本次核对？"
                  : "放弃尚未保存的文件夹名称？",
              )
            ) {
              clean();
              onCancel();
            }
          }}
        >
          取消编辑文件夹
        </button>
      </div>
    </form>
  );
}
function MoveEditor({
  set,
  assignment,
  api,
  enabled,
  folders,
  hasMore,
  onMore,
  onFolder,
  onCancel,
  onSaved,
}: {
  set: FolderSet;
  assignment: Assignment;
  api: Api;
  enabled: boolean;
  folders: Folder[];
  hasMore: boolean;
  onMore: () => Promise<void>;
  onFolder: (f: Folder) => void;
  onCancel: () => void;
  onSaved: (a: Assignment) => void;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    [destination, setDestination] = useState(assignment.folderId ?? ""),
    [version, setVersion] = useState(assignment.version),
    [latest, setLatest] = useState<Assignment | null>(null),
    dirty = destination !== (assignment.folderId ?? ""),
    clean = useDraftGuard(dirty || !!op.retry);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = {
      clientRequestId: crypto.randomUUID(),
      version,
      folderId: destination || null,
    };
    void op.run(async () => {
      try {
        const a = await api.move(set.id, input);
        clean();
        onSaved(a);
      } catch (e) {
        if ((e as { code?: string }).code === "version_conflict")
          setLatest(await api.assignment(set.id));
        throw e;
      }
    }, true);
  };
  return (
    <form className="org-box" onSubmit={submit}>
      <h2>移动学习集：{set.title}</h2>
      <p>
        当前：{assignment.folderTitle ?? "未分类"}。内容、ID和学习历史会保留。
      </p>
      <label>
        目标文件夹
        <select
          className="field"
          aria-label="目标文件夹"
          value={destination}
          disabled={!enabled || op.busy || !!op.retry}
          onChange={(e) => setDestination(e.target.value)}
        >
          <option value="">未分类</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title}
            </option>
          ))}
        </select>
      </label>
      {hasMore ? (
        <button
          type="button"
          className="btn"
          disabled={op.busy || !!op.retry}
          onClick={() => void op.run(onMore)}
        >
          加载更多目标文件夹
        </button>
      ) : null}
      <OrganizationStatus
        {...op}
        onRetry={
          op.retry
            ? () => void op.run(op.retry!, true)
            : () =>
                void op.run(async () => setLatest(await api.assignment(set.id)))
        }
      />
      {latest ? (
        <div className="org-conflict">
          <h3>学习集的归类已更新</h3>
          <p>
            云端：{latest.folderTitle ?? "未分类"}
            。你选中的目标保留，请比较后再明确保存。
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setVersion(latest.version);
              setLatest(null);
              op.clearError();
            }}
          >
            读取最新版本并保留目标
          </button>
          <button
            type="button"
            className="btn"
            disabled={op.busy}
            onClick={() => void op.run(async () => {
              if (latest.folderId && !folders.some(f => f.id === latest.folderId))
                onFolder(await api.get(latest.folderId));
              setDestination(latest.folderId ?? "");
              setVersion(latest.version);
              setLatest(null);
            })}
          >
            采用云端归类
          </button>
        </div>
      ) : null}
      <div className="org-actions">
        <button
          className="btn btn-black"
          disabled={
            !enabled ||
            op.busy ||
            !!op.retry ||
            !!latest ||
            (!!destination && !folders.some((f) => f.id === destination))
          }
        >
          保存归类
        </button>
        <button
          className="btn"
          type="button"
          disabled={op.busy}
          onClick={() => {
            if (
              (!dirty && !op.retry) ||
              confirm(
                op.retry
                  ? "归类结果尚未确认，确定离开本次核对？"
                  : "放弃尚未保存的归类选择？",
              )
            ) {
              clean();
              onCancel();
            }
          }}
        >
          取消归类
        </button>
      </div>
    </form>
  );
}
