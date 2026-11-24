import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { studySetPath } from "../routes";
import { useOrganization, uuidPattern } from "../organization/useOrganization";
import { useDraftGuard } from "../organization/useDraftGuard";
import OrganizationStatus from "../organization/OrganizationStatus";
import {
  createCalendarApi,
  formatCalendarTime,
  dateInZone,
  addDays,
  viewRange,
  type Event,
  type Time,
  type Settings,
  type SourceTask,
  type Option,
  type Conflict,
  type Candidate,
} from "./api";
import "../organization/organization.css";
import "./calendar.css";
type Api = ReturnType<typeof createCalendarApi>;
const kinds = { study: "学习时段", exam: "考试安排", personal: "手动事件" };
const commonZones = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Kathmandu",
  "Australia/Lord_Howe",
];
const inactive = (e: Event) => !!e.cancelledAt || !!e.taskCancelledAt;
export default function CalendarPanel({
  onNavigate,
}: {
  onNavigate: (path: string) => boolean;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    api = useMemo(() => createCalendarApi(op.call), [op.call]);
  const [settings, setSettings] = useState<Settings | null>(null),
    [events, setEvents] = useState<Event[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [anchor, setAnchor] = useState(""),
    [view, setView] = useState<"day" | "week">("week"),
    [detail, setDetail] = useState<Event | null>(null),
    [creating, setCreating] = useState(false),
    [showZone, setShowZone] = useState(false),
    [context, setContext] = useState<Awaited<ReturnType<Api["task"]>> | null>(
      null,
    );
  const params = new URLSearchParams(location.search),
    eventId = params.get("eventId"),
    source =
      params.has("taskId") || params.has("studySetId") || params.has("planId")
        ? {
            studySetId: params.get("studySetId") ?? "",
            planId: params.get("planId") ?? "",
            taskId: params.get("taskId") ?? "",
          }
        : null;
  const path = (event?: string, date = anchor, mode = view) =>
    "/platform/calendar?" +
    new URLSearchParams({
      date,
      view: mode,
      ...(event ? { eventId: event } : {}),
    });
  const load = async () => {
    if (
      [...params.keys()].some((k) => params.getAll(k).length > 1) ||
      (params.has("eventId") && !uuidPattern.test(eventId ?? "")) ||
      (source && !Object.values(source).every((v) => uuidPattern.test(v))) ||
      (eventId && source)
    )
      throw new Error("日历地址无效。");
    const mode = params.get("view") ?? "week";
    if (mode !== "day" && mode !== "week") throw new Error("日历视图无效。");
    const [s, e, t] = await Promise.all([
      api.settings(),
      eventId ? api.get(eventId) : null,
      source ? api.task(source) : null,
    ]);
    const date =
      params.get("date") ??
      t?.task.dueDate ??
      (e
        ? e.time.kind === "all_day"
          ? e.time.date
          : dateInZone(e.time.startsAt, s.timeZone)
        : dateInZone(new Date(), s.timeZone));
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date + "T00:00:00Z")) ||
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date
    )
      throw new Error("日历日期无效。");
    const range = viewRange(date, mode),
      page = await api.list(range.from, range.to);
    setSettings(s);
    setEvents(page.items);
    setCursor(page.nextCursor);
    setAnchor(date);
    setView(mode);
    setDetail(e);
    setContext(t);
    setCreating(!!t && !t.event);
  };
  useEffect(() => {
    void op.run(load);
  }, [api]);
  const range = anchor ? viewRange(anchor, view) : null,
    editing = creating || !!detail;
  return (
    <section className="organization-panel calendar-panel">
      <header className="cloud-page-heading">
        <div>
          <span className="cloud-eyebrow">LEARNING CALENDAR</span>
          <h1>学习日历</h1>
          <p>把学习安排到具体日期，保留自己的时间节奏。</p>
        </div>
        <div className="org-actions">
          <button
            className="btn"
            disabled={op.busy || editing || showZone || !settings}
            onClick={() => setShowZone(true)}
          >
            显示时区：{settings?.timeZone ?? "正在读取"}
          </button>
          <button
            className="btn btn-black"
            disabled={op.busy || editing || showZone || !settings?.enabled}
            onClick={() => setCreating(true)}
          >
            新建日程
          </button>
        </div>
      </header>
      <OrganizationStatus
        {...op}
        onRetry={() => void op.run(op.retry ?? load, !!op.retry)}
      />
      {settings && !settings.enabled ? (
        <p role="status">日历暂时只允许查看。</p>
      ) : null}
      {showZone && settings ? (
        <ZoneEditor
          settings={settings}
          api={api}
          onCancel={() => setShowZone(false)}
          onSaved={() => {
            setShowZone(false);
            void op.run(load);
          }}
        />
      ) : null}
      {context?.event && !detail ? (
        <div className="org-box">
          <h2>这个任务已有安排</h2>
          <p>
            {context.task.title}：{context.event.title}
          </p>
          <button
            className="btn"
            onClick={() => onNavigate(path(context.event!.id))}
          >
            打开已有日程
          </button>
          <button className="btn" onClick={() => onNavigate(path())}>
            查看日历
          </button>
        </div>
      ) : null}
      {editing && settings ? (
        <EventEditor
          key={detail?.id ?? context?.task.taskId ?? "new"}
          event={detail}
          api={api}
          settings={settings}
          date={anchor}
          source={context?.task ?? null}
          onCancel={() => {
            if (detail || context) onNavigate(path());
            else setCreating(false);
          }}
          onSaved={(e) => {
            setCreating(false);
            setDetail(null);
            const target = path(
              undefined,
              e.time.kind === "all_day"
                ? e.time.date
                : dateInZone(e.time.startsAt, settings.timeZone),
            );
            if (location.pathname + location.search === target)
              void op.run(load);
            else onNavigate(target);
          }}
          onNavigate={onNavigate}
        />
      ) : null}
      {range && settings ? (
        <>
          <div className="calendar-window">
            <div className="org-actions">
              <button
                className="btn"
                disabled={op.busy}
                aria-label="上一时段"
                onClick={() =>
                  onNavigate(
                    path(undefined, addDays(anchor, view === "day" ? -1 : -7)),
                  )
                }
              >
                ←
              </button>
              <label>
                查看日期
                <input
                  className="field"
                  type="date"
                  value={anchor}
                  disabled={op.busy}
                  onChange={(e) => {
                    if (e.target.value)
                      onNavigate(path(undefined, e.target.value));
                  }}
                />
              </label>
              <button
                className="btn"
                disabled={op.busy}
                aria-label="下一时段"
                onClick={() =>
                  onNavigate(
                    path(undefined, addDays(anchor, view === "day" ? 1 : 7)),
                  )
                }
              >
                →
              </button>
              <button
                className="btn"
                disabled={op.busy}
                onClick={() =>
                  onNavigate(
                    path(undefined, dateInZone(new Date(), settings.timeZone)),
                  )
                }
              >
                今天
              </button>
            </div>
            <div className="org-actions">
              <button
                className={`btn ${view === "day" ? "btn-black" : ""}`}
                disabled={op.busy}
                onClick={() => onNavigate(path(undefined, anchor, "day"))}
              >
                日视图
              </button>
              <button
                className={`btn ${view === "week" ? "btn-black" : ""}`}
                disabled={op.busy}
                onClick={() => onNavigate(path(undefined, anchor, "week"))}
              >
                周视图
              </button>
            </div>
          </div>
          <p>
            {range.from}
            {range.from !== range.to ? " 至 " + range.to : ""} · 时间按{" "}
            {settings.timeZone} 显示，全天事件保留原日期。
          </p>
          <div className={`calendar-days ${view === "day" ? "is-day" : ""}`}>
            {Array.from({ length: view === "day" ? 1 : 7 }, (_, i) => {
              const day = addDays(range.from, i),
                items = events.filter((e) =>
                  e.time.kind === "all_day"
                    ? e.time.date === day
                    : dateInZone(e.time.startsAt, settings.timeZone) <= day &&
                      dateInZone(
                        new Date(Date.parse(e.time.endsAt) - 1),
                        settings.timeZone,
                      ) >= day,
                );
              return (
                <Day
                  key={day}
                  day={day}
                  events={items}
                  zone={settings.timeZone}
                  disabled={op.busy || showZone}
                  onSelect={(e) => onNavigate(path(e.id))}
                />
              );
            })}
          </div>
          {cursor ? (
            <button
              className="btn"
              disabled={op.busy}
              onClick={() =>
                void op.run(async () => {
                  const page = await api.list(range.from, range.to, cursor);
                  setEvents((old) => [
                    ...old,
                    ...page.items.filter(
                      (n) => !old.some((e) => e.id === n.id),
                    ),
                  ]);
                  setCursor(page.nextCursor);
                })
              }
            >
              加载更多日程
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
function Day({
  day,
  events,
  zone,
  disabled,
  onSelect,
}: {
  day: string;
  events: Event[];
  zone: string;
  disabled: boolean;
  onSelect: (e: Event) => void;
}) {
  const active = events.filter((e) => !inactive(e));
  const overlaps = active.some((a, i) =>
    active
      .slice(i + 1)
      .some(
        (b) =>
          a.time.kind === "all_day" ||
          b.time.kind === "all_day" ||
          (Date.parse(a.time.startsAt) < Date.parse(b.time.endsAt) &&
            Date.parse(a.time.endsAt) > Date.parse(b.time.startsAt)),
      ),
  );
  return (
    <section className="calendar-day">
      <h2>
        {day.slice(5)}{" "}
        <small>
          {new Intl.DateTimeFormat("zh-CN", {
            weekday: "short",
            timeZone: "UTC",
          }).format(new Date(day + "T12:00:00Z"))}
        </small>
      </h2>
      {overlaps ? (
        <p className="calendar-overlap" role="status">
          当前显示的安排有时间重叠
        </p>
      ) : null}
      {!events.length ? <p className="org-small">暂无安排</p> : null}
      {[...events]
        .sort(
          (a, b) =>
            (a.time.kind === "all_day" ? -1 : 0) -
              (b.time.kind === "all_day" ? -1 : 0) ||
            (a.time.kind === "timed" && b.time.kind === "timed"
              ? Date.parse(a.time.startsAt) - Date.parse(b.time.startsAt)
              : 0) ||
            a.id.localeCompare(b.id),
        )
        .map((e) => (
          <button
            className={`calendar-event ${inactive(e) ? "is-inactive" : ""}`}
            key={e.id}
            disabled={disabled}
            onClick={() => onSelect(e)}
          >
            <strong>{e.title}</strong>
            <span>
              {kinds[e.kind]} · {formatCalendarTime(e, zone)}
            </span>
            {e.cancelledAt ? (
              <small>已取消</small>
            ) : e.taskCancelledAt ? (
              <small>关联任务已取消，安排暂停</small>
            ) : null}
          </button>
        ))}
    </section>
  );
}
function ZoneEditor({
  settings,
  api,
  onSaved,
  onCancel,
}: {
  settings: Settings;
  api: Api;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    [zone, setZone] = useState(settings.timeZone),
    [version, setVersion] = useState(settings.version),
    [latest, setLatest] = useState<Settings | null>(null),
    [dirty, setDirty] = useState(false),
    clean = useDraftGuard(dirty);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = {
      clientRequestId: crypto.randomUUID(),
      version,
      timeZone: zone,
    };
    void op.run(async () => {
      try {
        await api.setZone(input);
        clean();
        onSaved();
      } catch (e) {
        if ((e as { status?: number }).status === 409)
          setLatest(await api.settings());
        throw e;
      }
    }, true);
  };
  return (
    <form className="org-box" onSubmit={submit}>
      <h2>日历显示时区</h2>
      <p>
        修改显示时区会转换定时安排的显示时间，全天日期不变。创建时区仍保存在日程中。
      </p>
      <ZoneField
        value={zone}
        disabled={op.busy || !!op.retry || !settings.enabled}
        onChange={(v) => {
          setZone(v);
          setDirty(true);
        }}
      />
      <OrganizationStatus
        {...op}
        onRetry={() => {
          if (op.retry) void op.run(op.retry, true);
          else void op.run(async () => setLatest(await api.settings()));
        }}
      />
      {latest ? (
        <div className="org-conflict">
          <p>云端时区已改为 {latest.timeZone}，你的输入仍保留。</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setVersion(latest.version);
              setLatest(null);
              op.clearError();
            }}
          >
            保留我的时区继续编辑
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setZone(latest.timeZone);
              setVersion(latest.version);
              setLatest(null);
              op.clearError();
            }}
          >
            采用云端时区
          </button>
        </div>
      ) : null}
      <div className="org-actions">
        <button
          className="btn btn-black"
          disabled={!settings.enabled || op.busy || !!op.retry || !!latest}
        >
          保存显示时区
        </button>
        <button
          type="button"
          className="btn"
          disabled={op.busy}
          onClick={() => {
            if (!dirty || confirm("放弃尚未保存的时区修改？")) onCancel();
          }}
        >
          取消时区修改
        </button>
      </div>
    </form>
  );
}
function ZoneField({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label>
      时区
      <input
        className="field"
        list="calendar-timezones"
        required
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="例如 Asia/Shanghai"
      />
      <datalist id="calendar-timezones">
        {commonZones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </label>
  );
}
function EventEditor({
  event,
  api,
  settings,
  date,
  source,
  onCancel,
  onSaved,
  onNavigate,
}: {
  event: Event | null;
  api: Api;
  settings: Settings;
  date: string;
  source:
    | (SourceTask & {
        title: string;
        dueDate: string | null;
        cancelledAt: string | null;
      })
    | null;
  onCancel: () => void;
  onSaved: (e: Event) => void;
  onNavigate: (p: string) => boolean;
}) {
  const auth = useAuth(),
    op = useOrganization(auth.request),
    [title, setTitle] = useState(event?.title ?? source?.title ?? ""),
    [description, setDescription] = useState(event?.description ?? ""),
    [kind, setKind] = useState(event?.kind ?? "study"),
    [timeKind, setTimeKind] = useState<"all_day" | "timed">(
      event?.time.kind ?? "all_day",
    ),
    [day, setDay] = useState(
      event?.time.kind === "all_day" ? event.time.date : date,
    ),
    [zone, setZone] = useState(
      event?.time.kind === "timed" ? event.time.timeZone : settings.timeZone,
    ),
    [start, setStart] = useState(
      event?.time.kind === "timed" ? event.time.startLocal : date + "T09:00",
    ),
    [end, setEnd] = useState(
      event?.time.kind === "timed" ? event.time.endLocal : date + "T10:00",
    ),
    [startValue, setStartValue] = useState(
      event?.time.kind === "timed" ? event.time.start : "",
    ),
    [endValue, setEndValue] = useState(
      event?.time.kind === "timed" ? event.time.end : "",
    ),
    [startOptions, setStartOptions] = useState<Option[] | null>(null),
    [endOptions, setEndOptions] = useState<Option[] | null>(null),
    [version, setVersion] = useState(event?.version),
    [cancelled, setCancelled] = useState(!!event?.cancelledAt),
    [conflicts, setConflicts] = useState<Conflict[]>([]),
    [token, setToken] = useState<string | null>(null),
    [ack, setAck] = useState(false),
    [latest, setLatest] = useState<Event | null>(null),
    [dirty, setDirty] = useState(false),
    clean = useDraftGuard(dirty || !!op.retry);
  const invalidatesTime = () => {
    setStartValue("");
    setEndValue("");
    setStartOptions(null);
    setEndOptions(null);
    setConflicts([]);
    setToken(null);
    setAck(false);
    setDirty(true);
  };
  const candidate = (): Candidate => ({
    title,
    description,
    kind,
    time:
      timeKind === "all_day"
        ? { kind: "all_day", date: day }
        : { kind: "timed", start: startValue, end: endValue, timeZone: zone },
  });
  const check = async () => {
    const p = await api.preview({
      ...candidate(),
      ...(event ? { eventId: event.id } : {}),
      sourceTask:
        event?.sourceTask ??
        (source
          ? {
              studySetId: source.studySetId,
              planId: source.planId,
              taskId: source.taskId,
            }
          : null),
    });
    setConflicts(p.conflicts);
    setToken(p.conflictToken);
    setAck(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = {
      ...candidate(),
      clientRequestId: crypto.randomUUID(),
      acknowledgeConflicts: !cancelled && ack ? token : null,
      ...(event
        ? { version, cancelled }
        : {
            sourceTask: source
              ? {
                  studySetId: source.studySetId,
                  planId: source.planId,
                  taskId: source.taskId,
                }
              : null,
          }),
    };
    void op.run(async () => {
      try {
        const saved = await api.save(event?.id, input);
        clean();
        onSaved(saved);
      } catch (e) {
        const err = e as { code?: string; status?: number };
        if (err.code === "version_conflict" && event)
          setLatest(await api.get(event.id));
        else if (err.code === "job_conflict") await check();
        throw e;
      }
    }, true);
  };
  const disabled = op.busy || !!op.retry || !settings.enabled,
    ready = timeKind === "all_day" ? !!day : !!startValue && !!endValue;
  return (
    <form className="org-box calendar-editor" onSubmit={submit}>
      <h2>{event ? "编辑日程" : "新建日程"}</h2>
      {source || event?.sourceTask ? (
        <div className="calendar-source">
          <p>
            来自计划任务：{source?.title ?? "已关联的学习任务"}
            。日程取消不取消任务；任务取消会暂停安排，恢复任务后原安排重新生效。修改任务日期不会自动改动日程。
          </p>
          <button
            type="button"
            className="org-text-link"
            onClick={() => {
              const s = event?.sourceTask ?? source!;
              onNavigate(
                studySetPath(s.studySetId) + "/study-plan?planId=" + s.planId,
              );
            }}
          >
            打开来源计划
          </button>
        </div>
      ) : null}
      {source?.cancelledAt || event?.taskCancelledAt ? (
        <p role="status">关联任务已取消；请在计划中恢复后再启用安排。</p>
      ) : null}
      <fieldset disabled={disabled}>
        <label>
          日程名称
          <input
            className="field"
            required
            maxLength={160}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label>
          日程说明
          <textarea
            className="field"
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label>
          事件类型
          <select
            className="field"
            aria-label="事件类型"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Event["kind"]);
              setDirty(true);
            }}
          >
            {Object.entries(kinds).map(([k, v]) => (
              <option value={k} key={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          时间方式
          <select
            className="field"
            aria-label="时间方式"
            value={timeKind}
            onChange={(e) => {
              setTimeKind(e.target.value as "all_day" | "timed");
              invalidatesTime();
            }}
          >
            <option value="all_day">全天日期</option>
            <option value="timed">具体时段</option>
          </select>
        </label>
        {timeKind === "all_day" ? (
          <label>
            安排日期
            <input
              className="field"
              type="date"
              required
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                setDirty(true);
                setConflicts([]);
                setAck(false);
                setToken(null);
              }}
            />
          </label>
        ) : (
          <>
            <ZoneField
              value={zone}
              disabled={disabled}
              onChange={(v) => {
                setZone(v);
                invalidatesTime();
              }}
            />
            <label>
              开始时间
              <input
                className="field"
                type="datetime-local"
                step={60}
                required
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  invalidatesTime();
                }}
              />
            </label>
            <label>
              结束时间
              <input
                className="field"
                type="datetime-local"
                step={60}
                required
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value);
                  invalidatesTime();
                }}
              />
            </label>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void op.run(async () => {
                  const [a, b] = await Promise.all([
                    api.options(start, zone),
                    api.options(end, zone),
                  ]);
                  setStartOptions(a);
                  setEndOptions(b);
                  setStartValue(a.length === 1 ? a[0]!.value : "");
                  setEndValue(b.length === 1 ? b[0]!.value : "");
                })
              }
            >
              检查本地时间
            </button>
            {startOptions !== null ? (
              <TimeChoices
                label="开始时间选择"
                options={startOptions}
                value={startValue}
                onChange={(v) => {
                  setStartValue(v);
                  setAck(false);
                  setDirty(true);
                }}
              />
            ) : null}
            {endOptions !== null ? (
              <TimeChoices
                label="结束时间选择"
                options={endOptions}
                value={endValue}
                onChange={(v) => {
                  setEndValue(v);
                  setAck(false);
                  setDirty(true);
                }}
              />
            ) : null}
            <p className="org-small">
              时间不存在时需另选；夏令时重复的时刻须明确选择较早或较晚一次。单次时段最长7天。
            </p>
          </>
        )}
        {event ? (
          <label className="calendar-check">
            <input
              type="checkbox"
              checked={cancelled}
              onChange={(e) => {
                setCancelled(e.target.checked);
                setDirty(true);
              }}
            />
            取消此日程（保存后生效）
          </label>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={!ready}
          onClick={() => void op.run(check)}
        >
          检查时间冲突
        </button>
        {conflicts.length ? (
          <div className="org-conflict">
            <h3>时间有重叠</h3>
            {conflicts.map((c) => (
              <p key={c.id}>{c.title}</p>
            ))}
            <label className="calendar-check">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              我已知晓这些冲突，仍保存安排
            </label>
            <p>不会自动移动或取消其他日程。</p>
          </div>
        ) : null}
      </fieldset>
      <OrganizationStatus
        {...op}
        onRetry={() => {
          if (op.retry) void op.run(op.retry, true);
          else if (event)
            void op.run(async () => setLatest(await api.get(event.id)));
          else void op.run(check);
        }}
      />
      {latest ? (
        <div className="org-conflict">
          <h3>云端日程已更新</h3>
          <p>
            你的输入仍保留。云端版本 {latest.version}：{latest.title}
          </p>
          <pre>{latest.description}</pre>
          <p>
            {latest.time.kind === "all_day"
              ? latest.time.date
              : latest.time.start + " 至 " + latest.time.end}{" "}
            · {latest.cancelledAt ? "已取消" : "有效"}
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setVersion(latest.version);
              setLatest(null);
              setConflicts([]);
              setAck(false);
              setToken(null);
              op.clearError();
            }}
          >
            保留我的输入继续编辑
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const t = latest.time;
              setTitle(latest.title);
              setDescription(latest.description);
              setKind(latest.kind);
              setTimeKind(t.kind);
              if (t.kind === "all_day") setDay(t.date);
              else {
                setZone(t.timeZone);
                setStart(t.startLocal);
                setEnd(t.endLocal);
                setStartValue(t.start);
                setEndValue(t.end);
              }
              setVersion(latest.version);
              setCancelled(!!latest.cancelledAt);
              setLatest(null);
              setStartOptions(null);
              setEndOptions(null);
              setConflicts([]);
              setAck(false);
              setToken(null);
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
          disabled={
            disabled ||
            !settings.enabled ||
            !!latest ||
            !ready ||
            !!source?.cancelledAt ||
            (conflicts.length > 0 && !ack && !cancelled)
          }
        >
          保存日程
        </button>
        <button
          type="button"
          className="btn"
          disabled={op.busy}
          onClick={() => {
            if (
              !dirty ||
              confirm(
                op.retry
                  ? "保存结果尚未确认。可以先重试同一次请求；确定离开并放弃本次核对吗？"
                  : "放弃尚未保存的日程修改？",
              )
            ) {
              clean();
              onCancel();
            }
          }}
        >
          返回日历
        </button>
      </div>
    </form>
  );
}
function TimeChoices({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option[];
  value: string;
  onChange: (v: string) => void;
}) {
  return options.length ? (
    <label>
      {label}
      <select
        className="field"
        aria-label={label}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">请选择明确时刻</option>
        {options.map((o, i) => (
          <option key={o.value} value={o.value}>
            {o.value.slice(0, 16).replace("T", " ")} UTC{o.offset}
            {options.length > 1
              ? i === 0
                ? "（较早一次）"
                : "（较晚一次）"
              : ""}
          </option>
        ))}
      </select>
    </label>
  ) : (
    <p role="alert">{label}：这个本地时刻不存在，请更换时间。</p>
  );
}
