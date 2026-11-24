import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { createStudyApi, type StudySet } from "../api";
import { useOrganization, uuidPattern } from "../organization/useOrganization";
import { useDraftGuard } from "../organization/useDraftGuard";
import OrganizationStatus from "../organization/OrganizationStatus";
import "../organization/organization.css";
type Preview = {
  enabled: boolean;
  source: { id: string; title: string; version: number };
  items: { id: string; title: string; version: number; bytes: number }[];
  hasMore: boolean;
};
export default function CopyPanel({
  onNavigate,
  onChanged,
}: {
  onNavigate: (p: string) => boolean;
  onChanged: () => void;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    study = useMemo(() => createStudyApi(op.call), [op.call]),
    params = new URLSearchParams(location.search),
    set = params.get("setId"),
    material = params.get("materialId");
  const [preview, setPreview] = useState<Preview | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [mode, setMode] = useState<"new_set" | "existing_set">("new_set"),
    [title, setTitle] = useState(""),
    [targets, setTargets] = useState<StudySet[]>([]),
    [target, setTarget] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [saved, setSaved] = useState<{
      targetSetId: string;
      mappings: unknown[];
    } | null>(null),
    [stale, setStale] = useState(false);
  const clean = useDraftGuard(
    !saved && !!preview && (!!op.retry || selected.length > 0),
  );
  const load = async () => {
    if (
      !set ||
      !uuidPattern.test(set) ||
      (material && !uuidPattern.test(material)) ||
      [...params.keys()].some((k) => params.getAll(k).length !== 1)
    )
      throw new Error("复制来源地址无效。");
    const [p, page] = await Promise.all([
      op.call<Preview>(
        `/v1/study/sets/${set}/copy-preview` +
          (material ? "?materialId=" + material : ""),
      ),
      study.listSets(),
    ]);
    if (
      p.source?.id !== set ||
      !Array.isArray(p.items) ||
      !Number.isInteger(p.source.version) ||
      typeof p.enabled !== "boolean" ||
      p.items.some(
        (m) =>
          !uuidPattern.test(m.id) ||
          typeof m.title !== "string" ||
          !Number.isInteger(m.version) ||
          !Number.isInteger(m.bytes),
      )
    )
      throw new Error("来源预览暂时无法读取。");
    setPreview(p);
    setSelected(p.items.map((i) => i.id));
    setTitle(Array.from(p.source.title).slice(0, 55).join("") + " 副本");
    setTargets(page.items);
    setCursor(page.nextCursor);
    setStale(false);
    setSaved(null);
  };
  useEffect(() => {
    void op.run(load);
  }, [study]);
  const submit = () => {
    if (!preview || !set) return;
    const body = {
      clientRequestId: crypto.randomUUID(),
      sourceSetId: set,
      sourceVersion: preview.source.version,
      materials: preview.items
        .filter((i) => selected.includes(i.id))
        .map((i) => ({ id: i.id, version: i.version })),
      target:
        mode === "new_set" ? { kind: mode, title } : { kind: mode, id: target },
    };
    void op.run(async () => {
      try {
        const r = await op.call<{ targetSetId: string; mappings: unknown[] }>(
          "/v1/study/copies",
          { method: "POST", body },
        );
        if (
          !uuidPattern.test(r.targetSetId) ||
          !Array.isArray(r.mappings) ||
          r.mappings.length !== body.materials.length
        )
          throw new Error("复制结果无效，请核对同一次请求。");
        clean();
        setSaved(r);
        onChanged();
      } catch (e) {
        if ((e as { code?: string }).code === "version_conflict")
          setStale(true);
        throw e;
      }
    }, true);
  };
  return (
    <section className="organization-panel">
      <header className="cloud-page-heading">
        <div>
          <span className="cloud-eyebrow">A FRESH COPY</span>
          <h1>复制学习内容</h1>
          <p>
            选择当前纯文本资料，复制到新学习集或已有学习集。副本拥有新
            ID，保留来源映射。
          </p>
          <p>
            原 PDF
            文件、笔记、闪卡、测验、成绩、学习记录、计划和日程不在本次复制范围。
          </p>
        </div>
      </header>
      <OrganizationStatus
        {...op}
        onRetry={op.retry ? () => void op.run(op.retry!, true) : undefined}
      />
      {saved ? (
        <div className="org-box" role="status">
          <h2>复制完成</h2>
          <p>已创建 {saved.mappings.length} 份文本资料，原资料未更改。</p>
          <button
            className="btn btn-black"
            onClick={() =>
              onNavigate("/platform/studyset/" + saved.targetSetId)
            }
          >
            打开副本所在学习集
          </button>
        </div>
      ) : preview ? (
        <form
          className="org-box"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <h2>来源：{preview.source.title}</h2>
          {!preview.enabled ? <p>复制功能当前只允许预览。</p> : null}
          {preview.hasMore ? (
            <p>
              仅列出前100份资料。本次只复制勾选项；可从具体资料页单独复制其他资料。
            </p>
          ) : null}
          <fieldset
            disabled={!preview.enabled || op.busy || !!op.retry || stale}
          >
            <legend>选择要复制的文本资料</legend>
            {preview.items.length ? (
              preview.items.map((m) => (
                <label key={m.id} className="org-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked
                          ? [...old, m.id]
                          : old.filter((id) => id !== m.id),
                      )
                    }
                  />
                  {m.title} · v{m.version} · {m.bytes} 字节
                </label>
              ))
            ) : (
              <p>没有文本资料；可以创建空学习集副本。</p>
            )}
            <label>
              复制位置
              <select
                className="field"
                aria-label="复制位置"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="new_set">新建学习集</option>
                <option value="existing_set">已有学习集</option>
              </select>
            </label>
            {mode === "new_set" ? (
              <label>
                新学习集名称
                <input
                  className="field"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            ) : (
              <>
                <label>
                  目标学习集
                  <select
                    className="field"
                    aria-label="目标学习集"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">请选择</option>
                    {targets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </label>
                {cursor ? (
                  <button
                    className="btn"
                    type="button"
                    onClick={() =>
                      void op.run(async () => {
                        const p = await study.listSets(cursor);
                        setTargets((old) => [
                          ...old,
                          ...p.items.filter(
                            (i) => !old.some((o) => o.id === i.id),
                          ),
                        ]);
                        setCursor(p.nextCursor);
                      })
                    }
                  >
                    加载更多目标学习集
                  </button>
                ) : null}
              </>
            )}
            <p>本次复制 {selected.length} 份资料。请核对来源和位置后提交。</p>
            <button
              className="btn btn-black"
              disabled={
                mode === "new_set"
                  ? !title.trim() || Array.from(title.trim()).length > 60
                  : !target || !selected.length
              }
            >
              确认创建副本
            </button>
          </fieldset>
          {stale ? (
            <div role="alert">
              <p>来源版本已变化，尚未创建副本。重新读取后请重新核对选择。</p>
              <button
                type="button"
                className="btn"
                onClick={() => void op.run(load)}
              >
                重新读取来源预览
              </button>
            </div>
          ) : null}
        </form>
      ) : (
        <button
          className="btn"
          disabled={op.busy}
          onClick={() => void op.run(load)}
        >
          读取来源预览
        </button>
      )}
    </section>
  );
}
