import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { studySetPath, materialPath } from "../routes";
import { registerStudyLeaveGuard } from "../navigation";
import { useOrganization, uuidPattern } from "../organization/useOrganization";
import OrganizationStatus from "../organization/OrganizationStatus";
import {
  createPlanApi,
  type Plan,
  type Task,
  type Activity,
  type Evidence,
} from "./api";
import "../organization/organization.css";
type Props = { studySetId: string; onNavigate: (path: string) => boolean };
const labels = { material: "资料", deck: "闪卡", quiz: "测验", note: "笔记" };
export function activityPath(set: string, a: Activity) {
  const root = studySetPath(set);
  return a.kind === "material"
    ? materialPath(set, a.id)
    : a.kind === "deck"
      ? `${root}/flashcards?flashcardDeck=${a.id}`
      : a.kind === "quiz"
        ? `${root}/practice?quizId=${a.id}`
        : `${root}/notes?noteId=${a.id}`;
}
export default function PlansPanel({ studySetId, onNavigate }: Props) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    api = useMemo(
      () => createPlanApi(op.call, studySetId),
      [op.call, studySetId],
    );
  const [plans, setPlans] = useState<Plan[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [plan, setPlan] = useState<Plan | null>(null),
    [tasks, setTasks] = useState<Task[]>([]),
    [taskCursor, setTaskCursor] = useState<string | null>(null),
    [enabled, setEnabled] = useState(true),
    [editor, setEditor] = useState(false),
    [addTask, setAddTask] = useState(false);
  const params = new URLSearchParams(location.search),
    selected = params.get("planId"),
    base = `${studySetPath(studySetId)}/study-plan`;
  const load = async () => {
    if (
      params.getAll("planId").length > 1 ||
      (params.has("planId") && !uuidPattern.test(selected ?? ""))
    )
      throw new Error("计划地址无效。");
    const page = await api.list();
    setPlans(page.items);
    setCursor(page.nextCursor);
    setEnabled(page.enabled);
    if (selected) {
      const [p, t] = await Promise.all([
        api.get(selected),
        api.tasks(selected),
      ]);
      setPlan(p);
      setTasks(t.items);
      setTaskCursor(t.nextCursor);
    }
  };
  useEffect(() => {
    void op.run(load);
  }, [api]);
  const upsert = (task: Task) =>
    setTasks((old) =>
      old.some((t) => t.id === task.id)
        ? old.map((t) => (t.id === task.id ? task : t))
        : [task, ...old],
    );
  return (
    <section className="organization-panel">
      <header className="cloud-page-heading">
        <div>
          <h1>{plan?.title ?? "学习目标与计划"}</h1>
          <p>安排学习目标，逐步完成每天的任务。</p>
        </div>
        {plan ? (
          <button
            className="btn"
            disabled={op.busy}
            onClick={() => onNavigate(base)}
          >
            返回计划列表
          </button>
        ) : (
          <button
            className="btn btn-black"
            disabled={!enabled || op.busy}
            onClick={() => setEditor(true)}
          >
            新建计划
          </button>
        )}
      </header>
      {!enabled ? <p role="status">计划暂时只允许查看。</p> : null}
      <OrganizationStatus
        {...op}
        onRetry={() => void op.run(op.retry ?? load, !!op.retry)}
      />
      {editor ? (
        <PlanEditor
          key={plan?.id ?? "new"}
          plan={plan}
          api={api}
          onCancel={() => setEditor(false)}
          onSaved={(p) => {
            setEditor(false);
            if (plan) setPlan(p);
            else onNavigate(base + "?planId=" + p.id);
          }}
        />
      ) : null}
      {plan ? (
        <>
          <div className="org-box org-plan-goal">
            <h2>学习目标</h2>
            <p className="org-prose">{plan.goal || "还没有填写目标说明。"}</p>
            <p className="org-small">目标日期：{plan.dueDate ?? "未安排"}</p>
            <button
              className="btn"
              disabled={!enabled || op.busy}
              onClick={() => setEditor(true)}
            >
              编辑目标与日期
            </button>
          </div>
          <div className="org-heading">
            <h2>学习任务</h2>
            <button
              className="btn"
              disabled={!enabled || op.busy}
              onClick={() => setAddTask(!addTask)}
            >
              添加任务
            </button>
          </div>
          <p className="org-small">打开任务开始学习，或手动记录完成情况。</p>
          {addTask ? (
            <TaskCreator
              api={api}
              disabled={op.busy || !enabled || !!op.retry}
              onCancel={() => setAddTask(false)}
              onCreate={(body) => {
                const input = { ...body, clientRequestId: crypto.randomUUID() };
                void op.run(async () => {
                  upsert(await api.saveTask(plan.id, undefined, input));
                  setAddTask(false);
                }, true);
              }}
            />
          ) : null}
          {!tasks.length && !op.busy ? <p>尚未添加任务。</p> : null}
          {tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              enabled={enabled}
              api={api}
              onSaved={upsert}
              onNavigate={onNavigate}
            />
          ))}
          {taskCursor ? (
            <button
              className="btn"
              disabled={op.busy}
              onClick={() =>
                void op.run(async () => {
                  const page = await api.tasks(plan.id, taskCursor);
                  setTasks((old) => [
                    ...old,
                    ...page.items.filter(
                      (n) => !old.some((t) => t.id === n.id),
                    ),
                  ]);
                  setTaskCursor(page.nextCursor);
                })
              }
            >
              加载更多任务
            </button>
          ) : null}
        </>
      ) : (
        <>
          <div className="org-grid">
            {plans.map((p) => (
              <button
                className="org-box org-select"
                key={p.id}
                onClick={() => onNavigate(base + "?planId=" + p.id)}
              >
                <h2>{p.title}</h2>
                <p>{p.goal.slice(0, 140) || "打开计划安排任务"}</p>
                <small>目标日期：{p.dueDate ?? "未设定"}</small>
              </button>
            ))}
          </div>
          {cursor ? (
            <button
              className="btn"
              disabled={op.busy}
              onClick={() =>
                void op.run(async () => {
                  const page = await api.list(cursor);
                  setPlans((old) => [
                    ...old,
                    ...page.items.filter(
                      (n) => !old.some((t) => t.id === n.id),
                    ),
                  ]);
                  setCursor(page.nextCursor);
                })
              }
            >
              加载更多计划
            </button>
          ) : null}
          {!plans.length && !op.busy ? (
            <div className="org-box">
              <h2>从一个学习目标开始</h2>
              <p>例如：理解水循环，并通过一次测验检查掌握情况。</p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
function useDraftGuard(dirty: boolean) {
  const ref = useRef(dirty);
  ref.current = dirty;
  useEffect(() => {
    const clear = registerStudyLeaveGuard(
      () => !ref.current || confirm("有尚未保存的修改，确定离开吗？"),
    );
    const unload = (e: BeforeUnloadEvent) => {
      if (ref.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      clear();
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  return () => {
    ref.current = false;
  };
}
function PlanEditor({
  plan,
  api,
  onCancel,
  onSaved,
}: {
  plan: Plan | null;
  api: ReturnType<typeof createPlanApi>;
  onCancel: () => void;
  onSaved: (p: Plan) => void;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    [title, setTitle] = useState(plan?.title ?? ""),
    [goal, setGoal] = useState(plan?.goal ?? ""),
    [dueDate, setDate] = useState(plan?.dueDate ?? ""),
    [base, setBase] = useState(plan?.version),
    [latest, setLatest] = useState<Plan | null>(null),
    [dirty, setDirty] = useState(false);
  const clearGuard = useDraftGuard(dirty);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = {
      clientRequestId: crypto.randomUUID(),
      title,
      goal,
      dueDate: dueDate || null,
      ...(base ? { version: base } : {}),
    };
    void op.run(async () => {
      try {
        const p = await api.save(plan?.id, input);
        setDirty(false);
        clearGuard();
        onSaved(p);
      } catch (e) {
        if ((e as { status?: number }).status === 409 && plan)
          setLatest(await api.get(plan.id));
        throw e;
      }
    }, true);
  };
  return (
    <form className="org-box" onSubmit={submit}>
      <h2>{plan ? "编辑计划" : "新建计划"}</h2>
      <label>
        计划名称
        <input
          className="field"
          autoFocus
          required
          maxLength={160}
          value={title}
          disabled={op.busy || !!op.retry}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <label>
        目标说明
        <textarea
          className="field"
          rows={4}
          maxLength={2000}
          value={goal}
          disabled={op.busy || !!op.retry}
          onChange={(e) => {
            setGoal(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <label>
        目标日期
        <input
          className="field"
          type="date"
          value={dueDate}
          disabled={op.busy || !!op.retry}
          onChange={(e) => {
            setDate(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <OrganizationStatus
        {...op}
        onRetry={() => {
          if (op.retry) void op.run(op.retry, true);
          else if (plan)
            void op.run(async () => setLatest(await api.get(plan.id)));
        }}
      />
      {latest ? (
        <div className="org-conflict">
          <h3>云端计划已更新</h3>
          <p>
            你的输入已保留。云端名称：{latest.title}；日期：
            {latest.dueDate ?? "未设定"}
          </p>
          <pre>{latest.goal}</pre>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setBase(latest.version);
              setLatest(null);
              op.clearError();
            }}
          >
            保留我的输入继续编辑
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setTitle(latest.title);
              setGoal(latest.goal);
              setDate(latest.dueDate ?? "");
              setBase(latest.version);
              setLatest(null);
              setDirty(true);
              op.clearError();
            }}
          >
            采用云端内容
          </button>
        </div>
      ) : null}
      <div className="org-actions">
        <button
          className="btn btn-black"
          disabled={op.busy || !!latest || !!op.retry}
        >
          保存计划
        </button>
        <button
          type="button"
          className="btn"
          disabled={op.busy}
          onClick={() => {
            if (!dirty || confirm("放弃尚未保存的修改？")) onCancel();
          }}
        >
          取消
        </button>
      </div>
    </form>
  );
}
function TaskCreator({
  api,
  disabled,
  onCancel,
  onCreate,
}: {
  api: ReturnType<typeof createPlanApi>;
  disabled: boolean;
  onCancel: () => void;
  onCreate: (v: {
    title: string;
    dueDate: string | null;
    activity: { kind: string; id: string } | null;
  }) => void;
}) {
  const [title, setTitle] = useState(""),
    [date, setDate] = useState(""),
    [kind, setKind] = useState("manual"),
    [id, setId] = useState(""),
    [options, setOptions] = useState<{ id: string; title: string }[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useDraftGuard(!!title || !!date || !!id);
  const alive = useRef(true),
    optionEpoch = useRef(0);
  useEffect(() => {
    alive.current = true;
    ++optionEpoch.current;
    let current = true;
    setId("");
    setOptions([]);
    setCursor(null);
    setError("");
    setLoading(kind !== "manual");
    if (kind !== "manual") {
      void api
        .options(kind)
        .then((p) => {
          if (current) {
            setOptions(p.items);
            setCursor(p.nextCursor);
          }
        })
        .catch((e) => {
          if (current) setError(e.message);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }
    return () => {
      current = false;
      alive.current = false;
    };
  }, [api, kind]);
  return (
    <form
      className="org-box"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({
          title,
          dueDate: date || null,
          activity: kind === "manual" ? null : { kind, id },
        });
      }}
    >
      <h3>添加学习任务</h3>
      <fieldset disabled={disabled}>
        <label>
          任务名称
          <input
            className="field"
            required
            maxLength={160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          任务日期
          <input
            className="field"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          关联活动
          <select
            className="field"
            aria-label="关联活动"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="manual">手动任务</option>
            {Object.entries(labels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {kind !== "manual" ? (
          <>
            <label>
              选择{labels[kind as keyof typeof labels]}
              <select
                className="field"
                aria-label={`选择${labels[kind as keyof typeof labels]}`}
                required
                value={id}
                disabled={loading}
                onChange={(e) => setId(e.target.value)}
              >
                <option value="">请选择</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </select>
            </label>
            {loading ? <p role="status">正在读取活动…</p> : null}
            {error ? <p role="alert">{error}</p> : null}
            {cursor ? (
              <button
                type="button"
                className="btn"
                disabled={loading}
                onClick={() => {
                  const e = optionEpoch.current;
                  setLoading(true);
                  void api
                    .options(kind, cursor)
                    .then((p) => {
                      if (alive.current && e === optionEpoch.current) {
                        setOptions((old) => [...old, ...p.items]);
                        setCursor(p.nextCursor);
                      }
                    })
                    .catch((e) => {
                      if (alive.current && e === optionEpoch.current)
                        setError(e.message);
                    })
                    .finally(() => {
                      if (alive.current && e === optionEpoch.current)
                        setLoading(false);
                    });
                }}
              >
                加载更多活动
              </button>
            ) : null}
          </>
        ) : null}
        <p>
          关联对象创建后固定，旧任务不会随重新生成改绑。需要更换活动时可取消原任务并新建。
        </p>
        <div className="org-actions">
          <button
            className="btn btn-black"
            disabled={loading || !!error || (kind !== "manual" && !id)}
          >
            保存任务
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if ((!title && !date && !id) || confirm("放弃尚未保存的任务？"))
                onCancel();
            }}
          >
            取消
          </button>
        </div>
      </fieldset>
    </form>
  );
}
function TaskCard({
  task,
  enabled,
  api,
  onSaved,
  onNavigate,
}: {
  task: Task;
  enabled: boolean;
  api: ReturnType<typeof createPlanApi>;
  onSaved: (t: Task) => void;
  onNavigate: (path: string) => boolean;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    [editing, setEditing] = useState(false),
    [title, setTitle] = useState(task.title),
    [dueDate, setDate] = useState(task.dueDate ?? ""),
    [latest, setLatest] = useState<Task | null>(null),
    [version, setVersion] = useState(task.version),
    [choices, setChoices] = useState<Evidence[] | null>(null);
  useDraftGuard(
    (editing && (title !== task.title || dueDate !== (task.dueDate ?? ""))) ||
      !!op.retry,
  );
  useEffect(() => {
    setVersion(task.version);
    if (!editing) {
      setTitle(task.title);
      setDate(task.dueDate ?? "");
    }
  }, [task.version]);
  const refresh = async () => {
    let cursor: string | undefined;
    do {
      const page = await api.tasks(task.planId, cursor);
      const t = page.items.find((t) => t.id === task.id);
      if (t) {
        setLatest(t);
        return;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    throw new Error("这个任务已不可用。");
  };
  const mutate = (body: unknown) => {
    const input = {
      ...(body as object),
      version,
      clientRequestId: crypto.randomUUID(),
    };
    void op.run(async () => {
      try {
        const t = await api.saveTask(task.planId, task.id, input);
        onSaved(t);
        setEditing(false);
        setChoices(null);
      } catch (e) {
        if ((e as { status?: number }).status === 409) await refresh();
        throw e;
      }
    }, true);
  };
  return (
    <article
      className={`org-box org-task ${task.cancelledAt ? "is-cancelled" : ""}`}
    >
      <div className="org-task-summary">
        <div className="org-task-copy">
          <h3>{task.title}</h3>
          <div className="org-task-meta">
            <span
              className={`org-task-state ${task.cancelledAt ? "is-muted" : task.manualCompletedAt || task.evidence.length ? "is-complete" : ""}`}
            >
              {task.cancelledAt
                ? "已取消"
                : task.manualCompletedAt
                  ? "手动完成"
                  : task.evidence.length
                    ? "学习已完成"
                    : "待完成"}
            </span>
            <span>{task.dueDate ?? "未安排日期"}</span>
            <span>
              {task.activity ? labels[task.activity.kind] : "手动任务"}
            </span>
          </div>
        </div>
        {!task.cancelledAt && task.activity ? (
          <button
            className="btn btn-black"
            disabled={editing || op.busy || !!op.retry}
            onClick={() =>
              onNavigate(activityPath(task.studySetId, task.activity!))
            }
          >
            {task.manualCompletedAt || task.evidence.length
              ? "再次学习"
              : "开始学习"}
          </button>
        ) : !task.cancelledAt ? (
          <button
            className="btn"
            disabled={editing || !enabled || op.busy || !!latest || !!op.retry}
            onClick={() => mutate({ manualCompleted: !task.manualCompletedAt })}
          >
            {task.manualCompletedAt ? "撤销手动完成" : "手动标记完成"}
          </button>
        ) : null}
      </div>
      <OrganizationStatus
        {...op}
        onRetry={() => void op.run(op.retry ?? refresh, !!op.retry)}
      />
      {latest ? (
        <div className="org-conflict">
          <h4>任务已在另一页面更新</h4>
          <p>
            云端：{latest.title}，{latest.dueDate ?? "未设日期"}
            。本地输入已保留；请先比较，再重新发起操作。
          </p>
          <button
            className="btn"
            disabled={op.busy}
            onClick={() => {
              setVersion(latest.version);
              onSaved(latest);
              setLatest(null);
              op.clearError();
            }}
          >
            读取最新任务并保留编辑输入
          </button>
        </div>
      ) : null}
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutate({ title, dueDate: dueDate || null });
          }}
        >
          <label>
            任务名称
            <input
              className="field"
              required
              maxLength={160}
              value={title}
              disabled={op.busy || !!op.retry}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            任务日期
            <input
              className="field"
              type="date"
              value={dueDate}
              disabled={op.busy || !!op.retry}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <div className="org-actions">
            <button
              className="btn btn-black"
              disabled={op.busy || !!latest || !!op.retry}
            >
              保存任务修改
            </button>
            <button
              type="button"
              className="btn"
              disabled={op.busy}
              onClick={() => {
                if (
                  (title === task.title && dueDate === (task.dueDate ?? "")) ||
                  confirm("放弃尚未保存的任务修改？")
                ) {
                  setTitle(task.title);
                  setDate(task.dueDate ?? "");
                  setEditing(false);
                }
              }}
            >
              取消编辑
            </button>
          </div>
        </form>
      ) : null}
      <details className="org-disclosure org-task-details">
        <summary>完成记录与更多操作</summary>
        {task.activity ? (
          <p>
            关联{labels[task.activity.kind]}：
            <button
              className="org-text-link"
              onClick={() =>
                onNavigate(activityPath(task.studySetId, task.activity!))
              }
            >
              {task.activity.title}
            </button>
          </p>
        ) : (
          <p>手动任务</p>
        )}
        <p>
          手动完成情况：
          {task.manualCompletedAt
            ? "已完成（" +
              new Date(task.manualCompletedAt).toLocaleString("zh-CN") +
              "）"
            : "未完成"}
        </p>
        <p>
          关联的学习记录：
          {task.evidence.length
            ? `${task.evidence.length} 条实际完成记录`
            : "暂无已关联的完成记录"}
        </p>
        {task.evidence.map((e) => (
          <p key={e.sessionKind + e.sessionId} className="org-small">
            {e.sessionKind === "quiz_attempt"
              ? "已提交测验"
              : e.sessionKind === "spaced_review"
                ? "已完成间隔复习"
                : "已完成闪卡学习"}{" "}
            · {new Date(e.completedAt).toLocaleString("zh-CN")}
          </p>
        ))}
        <button
          className="btn"
          disabled={!!task.cancelledAt || op.busy}
          onClick={() =>
            onNavigate(
              "/platform/calendar?" +
                new URLSearchParams({
                  studySetId: task.studySetId,
                  planId: task.planId,
                  taskId: task.id,
                }),
            )
          }
        >
          安排到日历
        </button>
        {!editing ? (
          <div className="org-actions">
            <button
              className="btn"
              disabled={!enabled || op.busy || !!latest || !!op.retry}
              onClick={() => setEditing(true)}
            >
              改名或改期
            </button>
            {task.activity ? (
              <button
                className="btn"
                disabled={
                  !enabled ||
                  op.busy ||
                  !!latest ||
                  !!op.retry ||
                  !!task.cancelledAt
                }
                onClick={() =>
                  mutate({ manualCompleted: !task.manualCompletedAt })
                }
              >
                {task.manualCompletedAt ? "撤销手动完成" : "手动标记完成"}
              </button>
            ) : null}
            <button
              className="btn"
              disabled={!enabled || op.busy || !!latest || !!op.retry}
              onClick={() => mutate({ cancelled: !task.cancelledAt })}
            >
              {task.cancelledAt ? "恢复任务" : "取消任务"}
            </button>
            {task.activity && ["deck", "quiz"].includes(task.activity.kind) ? (
              <button
                className="btn"
                disabled={!enabled || op.busy || !!task.cancelledAt}
                onClick={() =>
                  void op.run(async () =>
                    setChoices(await api.evidence(task.planId, task.id)),
                  )
                }
              >
                关联已完成记录
              </button>
            ) : null}
          </div>
        ) : null}
      </details>
      {choices ? (
        <div className="org-evidence">
          <h4>选择实际完成记录</h4>
          <p>
            选择这项任务开始后完成的闪卡复习或已提交测验。阅读资料后可手动标记完成。
          </p>
          {!choices.length ? (
            <p>
              暂无符合条件的记录。请先打开关联活动，完成一轮学习或提交测验。
            </p>
          ) : (
            choices.map((e) => (
              <button
                className="btn"
                key={e.sessionKind + e.sessionId}
                disabled={op.busy || !enabled || !!latest || !!op.retry}
                onClick={() => {
                  const input = {
                    ...e,
                    version: task.version,
                    clientRequestId: crypto.randomUUID(),
                  };
                  const { completedAt, ...body } = input;
                  void op.run(async () => {
                    try {
                      onSaved(await api.link(task.planId, task.id, body));
                      setChoices(null);
                    } catch (e) {
                      if ((e as { status?: number }).status === 409)
                        await refresh();
                      throw e;
                    }
                  }, true);
                }}
              >
                {e.sessionKind === "quiz_attempt"
                  ? "测验提交"
                  : e.sessionKind === "spaced_review"
                    ? "间隔复习"
                    : "闪卡学习"}{" "}
                · {new Date(e.completedAt).toLocaleString("zh-CN")}
              </button>
            ))
          )}
        </div>
      ) : null}
    </article>
  );
}
