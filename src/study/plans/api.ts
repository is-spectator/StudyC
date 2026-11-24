import { AuthApiError, type RequestOptions } from "../../auth/api.ts";
export type Plan = {
  id: string;
  studySetId: string;
  title: string;
  goal: string;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type Activity = {
  kind: "material" | "deck" | "quiz" | "note";
  id: string;
  title: string;
};
export type Evidence = {
  sessionKind: "flashcard_session" | "spaced_review" | "quiz_attempt";
  sessionId: string;
  completedAt: string;
};
export type Task = {
  id: string;
  planId: string;
  studySetId: string;
  title: string;
  dueDate: string | null;
  version: number;
  activity: Activity | null;
  manualCompletedAt: string | null;
  manualCompletedBy: string | null;
  cancelledAt: string | null;
  evidence: Evidence[];
  createdAt: string;
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const fail = (): never => {
  throw new AuthApiError("invalid_response", "计划数据暂时无法读取，请重试。");
};
const date = (v: unknown) =>
  v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
export function parsePlan(v: any, set: string): Plan {
  if (
    !v ||
    !uuid(v.id) ||
    v.studySetId !== set ||
    typeof v.title !== "string" ||
    typeof v.goal !== "string" ||
    !date(v.dueDate) ||
    !Number.isInteger(v.version) ||
    v.version < 1
  )
    fail();
  return v;
}
export function parseTask(v: any, set: string, plan: string): Task {
  if (
    !v ||
    !uuid(v.id) ||
    v.studySetId !== set ||
    v.planId !== plan ||
    typeof v.title !== "string" ||
    !date(v.dueDate) ||
    !Number.isInteger(v.version) ||
    v.version < 1 ||
    !Array.isArray(v.evidence) ||
    !(
      v.activity === null ||
      (v.activity &&
        ["material", "deck", "quiz", "note"].includes(v.activity.kind) &&
        uuid(v.activity.id) &&
        typeof v.activity.title === "string")
    ) ||
    ![v.manualCompletedAt, v.cancelledAt].every(
      (x) =>
        x === null || (typeof x === "string" && Number.isFinite(Date.parse(x))),
    )
  )
    fail();
  for (const e of v.evidence)
    if (
      !uuid(e.sessionId) ||
      !["flashcard_session", "spaced_review", "quiz_attempt"].includes(
        e.sessionKind,
      ) ||
      !Number.isFinite(Date.parse(e.completedAt))
    )
      fail();
  return v;
}
export function createPlanApi(
  request: <T>(path: string, options?: RequestOptions) => Promise<T>,
  set: string,
) {
  if (!uuid(set)) throw new TypeError("Invalid study set");
  const root = `/v1/study/sets/${set}/plans`;
  const page = <T>(v: any, parse: (v: any) => T) => {
    if (
      !v ||
      !Array.isArray(v.items) ||
      (v.nextCursor !== null && !uuid(v.nextCursor))
    )
      fail();
    return {
      items: v.items.map(parse) as T[],
      nextCursor: v.nextCursor as string | null,
    };
  };
  return {
    list: async (cursor?: string) => {
      const v = await request<any>(root + (cursor ? "?cursor=" + cursor : ""));
      if (typeof v.enabled !== "boolean") fail();
      return {
        ...page(v, (n) => parsePlan(n, set)),
        enabled: v.enabled as boolean,
      };
    },
    get: async (id: string) => {
      const v = await request<{ plan: Plan }>(root + "/" + id);
      if (v.plan?.id !== id) fail();
      return parsePlan(v.plan, set);
    },
    save: async (id: string | undefined, body: unknown) => {
      const v = await request<{ plan: Plan }>(root + (id ? "/" + id : ""), {
        method: id ? "PATCH" : "POST",
        body,
      });
      if (id && v.plan?.id !== id) fail();
      return parsePlan(v.plan, set);
    },
    tasks: async (plan: string, cursor?: string) =>
      page(
        await request(
          root + "/" + plan + "/tasks" + (cursor ? "?cursor=" + cursor : ""),
        ),
        (v) => parseTask(v, set, plan),
      ),
    saveTask: async (plan: string, id: string | undefined, body: unknown) => {
      const v = await request<{ task: Task }>(
        root + "/" + plan + "/tasks" + (id ? "/" + id : ""),
        { method: id ? "PATCH" : "POST", body },
      );
      if (id && v.task?.id !== id) fail();
      return parseTask(v.task, set, plan);
    },
    evidence: async (plan: string, task: string) => {
      const v = await request<{ items: Evidence[] }>(
        root + "/" + plan + "/tasks/" + task + "/evidence",
      );
      if (!Array.isArray(v.items)) fail();
      for (const e of v.items)
        if (
          !uuid(e.sessionId) ||
          !["flashcard_session", "spaced_review", "quiz_attempt"].includes(
            e.sessionKind,
          ) ||
          !Number.isFinite(Date.parse(e.completedAt))
        )
          fail();
      return v.items;
    },
    link: async (plan: string, task: string, body: unknown) => {
      const v = await request<{ task: Task }>(
        root + "/" + plan + "/tasks/" + task + "/evidence",
        { method: "POST", body },
      );
      if (v.task?.id !== task) fail();
      return parseTask(v.task, set, plan);
    },
    options: async (kind: string, cursor?: string) =>
      page(
        await request(
          `/v1/study/sets/${set}/planning-options?type=${encodeURIComponent(kind)}${cursor ? "&cursor=" + cursor : ""}`,
        ),
        (v) => {
          if (!v || !uuid(v.id) || typeof v.title !== "string") fail();
          return v as { id: string; title: string };
        },
      ),
  };
}
