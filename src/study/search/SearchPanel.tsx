import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { useAuth } from "../../auth/AuthProvider";
import { createStudyApi, type StudySet } from "../api";
import { useOrganization, uuidPattern } from "../organization/useOrganization";
import OrganizationStatus from "../organization/OrganizationStatus";
import { createSearchApi, searchTypes, type Query, type Hit } from "./api";
import "../organization/organization.css";
import "./search.css";
export default function SearchPanel({
  onNavigate,
}: {
  onNavigate: (p: string) => boolean;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    api = useMemo(() => createSearchApi(op.call), [op.call]),
    study = useMemo(() => createStudyApi(op.call), [op.call]);
  const params = new URLSearchParams(location.search);
  const submitted = {
    q: params.get("q") ?? "",
    type: (params.get("type") ?? "all") as Query["type"],
    studySetId: params.get("studySetId") ?? undefined,
  };
  const [q, setQ] = useState(submitted.q),
    [type, setType] = useState<Query["type"]>(submitted.type),
    [setId, setSet] = useState(submitted.studySetId ?? ""),
    [sets, setSets] = useState<StudySet[]>([]),
    [setPageCursor, setSetPageCursor] = useState<string | null>(null),
    [items, setItems] = useState<Hit[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [searched, setSearched] = useState(false);
  const load = async () => {
    if (
      [...params.keys()].some((k) => params.getAll(k).length > 1) ||
      !Object.hasOwn(searchTypes, submitted.type) ||
      (submitted.studySetId && !uuidPattern.test(submitted.studySetId))
    )
      throw new Error("搜索地址或筛选条件无效。");
    setItems([]);
    setCursor(null);
    setSearched(false);
    const [page, selected, result] = await Promise.all([
      study.listSets(),
      submitted.studySetId ? study.getSet(submitted.studySetId) : null,
      submitted.q.trim() ? api.search(submitted) : null,
    ]);
    setSets(
      selected && !page.items.some((s) => s.id === selected.id)
        ? [selected, ...page.items]
        : page.items,
    );
    setSetPageCursor(page.nextCursor);
    if (result) {
      setItems(result.items);
      setCursor(result.nextCursor);
      setSearched(true);
    }
  };
  useEffect(() => {
    void op.run(load);
  }, [api, study]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const target =
      "/platform/search?" +
      new URLSearchParams({
        q: q.trim(),
        type,
        ...(setId ? { studySetId: setId } : {}),
      });
    if (location.pathname + location.search === target) void op.run(load);
    else onNavigate(target);
  };
  const follow = (e: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      onNavigate(path);
    }
  };
  return (
    <section className="organization-panel">
      <header className="cloud-page-heading">
        <div>
          <span className="cloud-eyebrow">SEARCH YOUR LEARNING</span>
          <h1>搜索学习内容</h1>
          <p>找回已保存的学习集、资料、笔记、闪卡和测验。</p>
        </div>
      </header>
      <form className="org-box search-form" onSubmit={submit}>
        <label>
          关键词
          <input
            className="field"
            type="search"
            autoFocus
            required
            maxLength={120}
            placeholder="例如：水循环、项目管理"
            value={q}
            disabled={op.busy}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <div className="search-filters">
          <label>
            内容类型
            <select
              className="field"
              aria-label="内容类型"
              value={type}
              disabled={op.busy}
              onChange={(e) => setType(e.target.value as Query["type"])}
            >
              {Object.entries(searchTypes).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            学习集范围
            <select
              className="field"
              aria-label="学习集范围"
              value={setId}
              disabled={op.busy}
              onChange={(e) => setSet(e.target.value)}
            >
              <option value="">全部学习集</option>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-black" disabled={op.busy || !q.trim()}>
            搜索
          </button>
        </div>
        {setPageCursor ? (
          <button
            type="button"
            className="btn"
            disabled={op.busy}
            onClick={() =>
              void op.run(async () => {
                const page = await study.listSets(setPageCursor);
                setSets((old) => [
                  ...old,
                  ...page.items.filter((n) => !old.some((s) => s.id === n.id)),
                ]);
                setSetPageCursor(page.nextCursor);
              })
            }
          >
            加载更多学习集选项
          </button>
        ) : null}
        <p className="org-small">
          修改筛选后点击搜索。按关键词字面匹配；测验只搜名称和题干。
        </p>
      </form>
      <OrganizationStatus {...op} onRetry={() => void op.run(load)} />
      {searched ? (
        <>
          <h2>“{submitted.q.trim()}” 的结果</h2>
          <p className="org-small">
            {searchTypes[submitted.type]} · 当前显示 {items.length} 条
            {cursor ? "，还有更多" : ""}
          </p>
          {items.length ? (
            <div className="search-results">
              {items.map((hit) => (
                <article
                  className="org-box search-result"
                  key={hit.type + ":" + hit.id}
                >
                  <span className="search-kind">{searchTypes[hit.type]}</span>
                  <a href={hit.href} onClick={(e) => follow(e, hit.href)}>
                    <h3>{hit.title}</h3>
                  </a>
                  <p className="org-small">所属学习集：{hit.studySetTitle}</p>
                  <p className="search-excerpt">{hit.excerpt}</p>
                </article>
              ))}
            </div>
          ) : (
            <div className="org-box">
              <h3>没有找到匹配的已保存内容</h3>
              <p>试试更短的关键词或扩大筛选范围。</p>
            </div>
          )}
          {cursor ? (
            <button
              className="btn"
              disabled={op.busy}
              onClick={() =>
                void op.run(async () => {
                  const page = await api.search(submitted, cursor);
                  setItems((old) => [
                    ...old,
                    ...page.items.filter(
                      (n) =>
                        !old.some((h) => h.type === n.type && h.id === n.id),
                    ),
                  ]);
                  setCursor(page.nextCursor);
                })
              }
            >
              加载更多结果
            </button>
          ) : null}
        </>
      ) : !op.busy && !op.error ? (
        <div className="org-box">
          <h2>输入关键词开始查找</h2>
          <p>
            搜索只读取当前账户的已保存对象，不查询生成草稿、原稿历史或作答记录。
          </p>
        </div>
      ) : null}
    </section>
  );
}
