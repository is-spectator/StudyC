import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { appStorage, captureStorageSession } from "../../lib/account-storage";
import { createStudyApi, type StudySet } from "../api";
import { useOrganization, uuidPattern } from "../organization/useOrganization";
import { useDraftGuard } from "../organization/useDraftGuard";
import OrganizationStatus from "../organization/OrganizationStatus";
import { previewArchive, type ImportRow } from "./preview";
import "../organization/organization.css";
type Result = {
  sourceKey: string;
  sourceIndex: number;
  materialId: string;
  status: "imported" | "already_imported";
};
export default function ImportPanel({
  onNavigate,
  onChanged,
}: {
  onNavigate: (p: string) => boolean;
  onChanged: () => void;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    study = useMemo(() => createStudyApi(op.call), [op.call]);
  const [archive, setArchive] = useState<{
      raw: string;
      rows: ImportRow[];
    } | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [ack, setAck] = useState(false),
    [target, setTarget] = useState(""),
    [targets, setTargets] = useState<StudySet[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [enabled, setEnabled] = useState(true),
    [result, setResult] = useState<{
      targetSetId: string;
      items: Result[];
    } | null>(null);
  const clean = useDraftGuard(
    !result && !!archive && (selected.length > 0 || !!op.retry),
  );
  const load = async () => {
    const [page, status] = await Promise.all([
      study.listSets(),
      op.call<{ enabled: boolean }>("/v1/study/imports/status"),
    ]);
    if (typeof status.enabled !== "boolean")
      throw new Error("导入状态无法读取。");
    setTargets(page.items);
    setCursor(page.nextCursor);
    setEnabled(status.enabled);
  };
  useEffect(() => {
    void op.run(load);
  }, [study]);
  const preview = (raw: string) => {
    setArchive(null);
    setSelected([]);
    setAck(false);
    const p = previewArchive(raw, auth.user!.id);
    setArchive({ raw, rows: p.rows });
    setSelected(
      p.rows
        .filter((r) => r.status === "supported")
        .slice(0, 100)
        .map((r) => r.id),
    );
    setAck(false);
    setResult(null);
  };
  const current = () =>
    void op.run(async () => {
      const valid = captureStorageSession(),
        keys = appStorage.keys().sort(),
        entries: Record<string, unknown> = {},
        rawEntries: Record<string, string> = {};
      for (const key of keys) {
        const raw = appStorage.getItem(key);
        if (raw === null) continue;
        rawEntries[key] = raw;
        try {
          entries[key] = JSON.parse(raw);
        } catch {
          entries[key] = raw;
        }
      }
      if (!valid()) return;
      preview(
        JSON.stringify(
          {
            format: "studyc-local-data-export",
            version: 1,
            accountId: auth.user!.id,
            exportedAt: new Date().toISOString(),
            entries,
            rawEntries,
          },
          null,
          2,
        ),
      );
    });
  const file = (f: File) => {
    setArchive(null);
    setSelected([]);
    setAck(false);
    void op.run(async () => {
      const valid = captureStorageSession();
      if (f.size > 5 * 1024 * 1024)
        throw new Error("导出文件最多5 MiB，未上传任何记录。");
      const raw = await f.text();
      if (valid()) preview(raw);
    });
  };
  const backup = () => {
    if (!archive) return;
    const url = URL.createObjectURL(
        new Blob([archive.raw], { type: "application/json;charset=utf-8" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = "StudyC-导入原始备份.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const submit = () => {
    if (!archive) return;
    const items = archive.rows
        .filter((r) => selected.includes(r.id) && r.status === "supported")
        .map((r) => ({
          sourceKey: r.sourceKey,
          sourceIndex: r.sourceIndex,
          title: r.title,
          body: r.body!,
        })),
      body = {
        clientRequestId: crypto.randomUUID(),
        sourceAccountId: auth.user!.id,
        targetSetId: target,
        items,
      };
    void op.run(async () => {
      if (
        new TextEncoder().encode(JSON.stringify(body)).byteLength >
        2 * 1024 * 1024
      )
        throw Object.assign(
          new Error("本次上传合计超过2 MiB，请减少勾选项后重试。"),
          { status: 413 },
        );
      const r = await op.call<{ targetSetId: string; items: Result[] }>(
        "/v1/study/imports",
        { method: "POST", body },
      );
      if (
        r.targetSetId !== target ||
        !Array.isArray(r.items) ||
        r.items.length !== items.length ||
        r.items.some(
          (i, n) =>
            !uuidPattern.test(i.materialId) ||
            !["imported", "already_imported"].includes(i.status) ||
            i.sourceKey !== items[n].sourceKey ||
            i.sourceIndex !== items[n].sourceIndex,
        )
      )
        throw new Error("导入结果无法确认，请重试同一次请求。");
      clean();
      setResult(r);
      onChanged();
    }, true);
  };
  return (
    <section className="organization-panel">
      <header className="cloud-page-heading">
        <div>
          <h1>导入旧文本资料</h1>
          <p>预览旧笔记，选择要导入的内容和学习集。原始记录会保留。</p>
        </div>
      </header>
      <details className="org-disclosure org-help">
        <summary>支持哪些旧数据？</summary>
        <p>
          支持当前账户旧版「上传资料」中的文本笔记。其他记录和草稿保留在原始备份中；导入不会恢复旧成绩或学习历史。
        </p>
      </details>
      <OrganizationStatus
        {...op}
        onRetry={op.retry ? () => void op.run(op.retry!, true) : undefined}
      />
      {result ? (
        <div className="org-box" role="status">
          <h2>导入已确认</h2>
          <p>
            新导入 {result.items.filter((i) => i.status === "imported").length}{" "}
            项，已存在{" "}
            {result.items.filter((i) => i.status === "already_imported").length}{" "}
            项；本机原记录未删除。
          </p>
          <ul>
            {result.items.map((i) => (
              <li key={i.sourceKey + ":" + i.sourceIndex}>
                第 {i.sourceIndex + 1} 项：
                {i.status === "imported"
                  ? "新导入"
                  : "此前已导入，保留云端编辑"}
              </li>
            ))}
          </ul>
          <button
            className="btn btn-black"
            onClick={() =>
              onNavigate("/platform/studyset/" + result.targetSetId)
            }
          >
            打开导入的学习集
          </button>
          <button
            className="btn"
            onClick={() => {
              setResult(null);
              setAck(false);
              op.clearError();
            }}
          >
            再次核对同一份旧数据
          </button>
        </div>
      ) : (
        <>
          <div className="org-box">
            <button
              className="btn"
              disabled={op.busy || !!op.retry}
              onClick={current}
            >
              预览当前账户本机旧数据
            </button>
            <label>
              或选择当前账户导出的 JSON
              <input
                className="field"
                type="file"
                accept=".json,application/json"
                disabled={op.busy || !!op.retry}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) file(f);
                }}
              />
            </label>
            <p>只选择文件或预览不会发送正文。</p>
          </div>
          {archive ? (
            <form
              className="org-box"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <h2>逐项预览</h2>
              <p>
                可导入{" "}
                {archive.rows.filter((r) => r.status === "supported").length}{" "}
                项；损坏{" "}
                {archive.rows.filter((r) => r.status === "invalid").length}{" "}
                项；不支持{" "}
                {archive.rows.filter((r) => r.status === "unsupported").length}{" "}
                项。每批最多100项。
              </p>
              <button
                className="btn"
                type="button"
                disabled={op.busy || !!op.retry}
                onClick={backup}
              >
                下载原始备份 JSON
              </button>
              <fieldset disabled={op.busy || !!op.retry || !enabled}>
                <legend>核对并选择资料</legend>
                {archive.rows.map((r) => (
                  <article key={r.id} className="org-box">
                    <label>
                      {r.status === "supported" ? (
                        <input
                          type="checkbox"
                          checked={selected.includes(r.id)}
                          onChange={(e) =>
                            setSelected((old) =>
                              e.target.checked
                                ? [...old, r.id]
                                : old.filter((id) => id !== r.id),
                            )
                          }
                        />
                      ) : null}
                      {r.title} ·{" "}
                      {r.status === "supported"
                        ? "可导入"
                        : r.status === "invalid"
                          ? "损坏"
                          : "不支持"}
                    </label>
                    <p>
                      {r.sourceIndex >= 0
                        ? `上传资料第 ${r.sourceIndex + 1} 项：`
                        : ""}
                      {r.reason}
                    </p>
                    {r.body !== undefined ? (
                      <details>
                        <summary>查看原文</summary>
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {r.body.slice(0, 2000)}
                        </pre>
                        {r.body.length > 2000 ? (
                          <p>预览截取前2000字；导入保留完整文本。</p>
                        ) : null}
                      </details>
                    ) : null}
                  </article>
                ))}
                <label>
                  目标学习集
                  <select
                    className="field"
                    aria-label="导入目标学习集"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">明确选择归属</option>
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
                        const page = await study.listSets(cursor);
                        setTargets((old) => [
                          ...old,
                          ...page.items.filter(
                            (i) => !old.some((o) => o.id === i.id),
                          ),
                        ]);
                        setCursor(page.nextCursor);
                      })
                    }
                  >
                    加载更多目标学习集
                  </button>
                ) : null}
                <label className="org-row">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  我已保留原始备份，同意将勾选的文本上传到所选学习集
                </label>
                <p>
                  勾选 {selected.length}{" "}
                  项。相同旧记录再次导入同一学习集会返回已有资料，不覆盖云端编辑。
                </p>
                <button
                  className="btn btn-black"
                  disabled={
                    !ack ||
                    !target ||
                    selected.length < 1 ||
                    selected.length > 100
                  }
                >
                  确认导入选中资料
                </button>
              </fieldset>
              {!enabled ? <p>导入功能当前只允许本地预览和备份。</p> : null}
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}
