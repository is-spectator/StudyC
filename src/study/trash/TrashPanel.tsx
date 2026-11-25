import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { useOrganization, uuidPattern } from "../organization/useOrganization";
import { useDraftGuard } from "../organization/useDraftGuard";
import OrganizationStatus from "../organization/OrganizationStatus";
import { AuthApiError } from "../../auth/api";
import "../organization/organization.css";
type Item = {
  id: string;
  title: string;
  version: number;
  deletedAt: string | null;
};
const parse = (v: Item): Item => {
  if (
    !v ||
    !uuidPattern.test(v.id) ||
    typeof v.title !== "string" ||
    !Number.isInteger(v.version) ||
    v.version < 0 ||
    !(v.deletedAt === null || Number.isFinite(Date.parse(v.deletedAt)))
  )
    throw new AuthApiError("invalid_response", "回收站数据暂时无法读取。");
  return v;
};
export default function TrashPanel({
  onNavigate,
  onChanged,
}: {
  onNavigate: (p: string) => boolean;
  onChanged: () => void;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    params = new URLSearchParams(location.search),
    set = params.get("setId");
  const [items, setItems] = useState<Item[]>([]),
    [current, setCurrent] = useState<Item | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [enabled, setEnabled] = useState(true),
    [latest, setLatest] = useState<Item | null>(null);
  const api = useMemo(
    () => ({
      get: async (id: string) =>
        parse((await op.call<{ item: Item }>("/v1/study/trash/" + id)).item),
      list: async (cursor?: string) => {
        const p = await op.call<{
          items: Item[];
          nextCursor: string | null;
          enabled: boolean;
        }>("/v1/study/trash" + (cursor ? "?cursor=" + cursor : ""));
        if (
          !Array.isArray(p.items) ||
          typeof p.enabled !== "boolean" ||
          !(p.nextCursor === null || uuidPattern.test(p.nextCursor))
        )
          throw new Error("回收站列表无效。");
        return { ...p, items: p.items.map(parse) };
      },
    }),
    [op.call],
  );
  useDraftGuard(!!op.retry);
  const load = async () => {
    if (set && (!uuidPattern.test(set) || params.getAll("setId").length !== 1))
      throw new Error("学习集地址无效。");
    const page = await api.list();
    setItems(page.items);
    setCursor(page.nextCursor);
    setEnabled(page.enabled);
    setCurrent(set ? await api.get(set) : null);
    setLatest(null);
  };
  useEffect(() => {
    void op.run(load);
  }, [api]);
  const change = (item: Item, deleted: boolean) => {
    if (
      !confirm(
        deleted
          ? "将整个学习集移入回收站？资料与学习记录保留；进行中的生成任务会取消，恢复后需手动重试。"
          : "恢复这个学习集及其原有资料和学习记录？",
      )
    )
      return;
    const body = {
      clientRequestId: crypto.randomUUID(),
      version: item.version,
      deleted,
    };
    void op.run(async () => {
      try {
        const r = await op.call<{ item: Item }>("/v1/study/trash/" + item.id, {
          method: "PATCH",
          body,
        });
        const result = parse(r.item);
        onChanged();
        if (result.deletedAt) {
          setCurrent(null);
          if (set) onNavigate("/platform/trash");
          else await load();
        } else onNavigate("/platform/studyset/" + result.id);
      } catch (e) {
        if ((e as { code?: string }).code === "version_conflict") {
          setCurrent(item);
          setLatest(await api.get(item.id));
        }
        throw e;
      }
    }, true);
  };
  return (
    <section className="organization-panel">
      <header className="cloud-page-heading">
        <div>
          <h1>{current ? "管理学习集" : "回收站"}</h1>
          <p>暂时收起不再学习的内容，需要时可以完整恢复。</p>
        </div>
      </header>
      <details className="org-disclosure org-help">
        <summary>了解回收站与恢复</summary>
        <p>
          移入回收站后，学习集会从列表、搜索与关联日程中隐藏。恢复后，资料、归类和学习记录都会保留。回收站目前不会永久删除或自动清理内容。
        </p>
      </details>
      {!enabled ? <p role="status">回收站当前只允许查看。</p> : null}
      <OrganizationStatus
        {...op}
        onRetry={
          op.retry
            ? () => void op.run(op.retry!, true)
            : () => void op.run(load)
        }
      />
      {latest ? (
        <div className="org-conflict">
          <h2>学习集状态已更新</h2>
          <p>
            云端：{latest.deletedAt ? "已在回收站" : "正常学习集"}
            。本次操作没有覆盖云端状态。
          </p>
          <button
            className="btn"
            disabled={op.busy}
            onClick={() => {
              setCurrent(latest);
              setLatest(null);
              op.clearError();
            }}
          >
            读取最新状态后重新决定
          </button>
        </div>
      ) : null}
      {current ? (
        <article className="org-box">
          <h2>{current.title}</h2>
          <p>{current.deletedAt ? "已移入回收站" : "正常学习集"}</p>
          <button
            className="btn"
            disabled={!enabled || op.busy || !!op.retry || !!latest}
            onClick={() => change(current, !current.deletedAt)}
          >
            {current.deletedAt ? "恢复学习集" : "移入回收站"}
          </button>
        </article>
      ) : null}
      {!current && !op.busy && !items.length ? <p>回收站为空。</p> : null}
      {!current
        ? items.map((item) => (
            <article className="org-box" key={item.id}>
              <h2>{item.title}</h2>
              <p>移入时间：{new Date(item.deletedAt!).toLocaleString()}</p>
              <button
                className="btn"
                disabled={!enabled || op.busy || !!op.retry || !!latest}
                onClick={() => change(item, false)}
              >
                恢复学习集
              </button>
            </article>
          ))
        : null}
      {cursor && !current ? (
        <button
          className="btn"
          disabled={op.busy || !!op.retry}
          onClick={() =>
            void op.run(async () => {
              const p = await api.list(cursor);
              setItems((old) => [
                ...old,
                ...p.items.filter((i) => !old.some((o) => o.id === i.id)),
              ]);
              setCursor(p.nextCursor);
            })
          }
        >
          加载更多回收站记录
        </button>
      ) : null}
    </section>
  );
}
