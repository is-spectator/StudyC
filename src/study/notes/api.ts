import {
  AuthApiError,
  throwIfAborted,
  type RequestOptions,
} from "../../auth/api.ts";
export type Citation = {
  sourceId: string;
  materialId: string;
  version: number;
  quote: string;
  start: number;
  end: number;
  page: number | null;
};
export type Result = {
  schemaVersion: 1;
  title: string;
  sections: {
    heading: string;
    body: string;
    citations: Citation[];
  }[];
};
export type Source = {
  sourceId: string;
  materialId: string;
  title: string;
  body: string;
  version: number;
};
export type Note = {
  id: string;
  studySetId: string;
  title: string;
  body: string;
  version: number;
  manuallyEdited: boolean;
  createdAt: string;
  updatedAt: string;
};
export type Detail = {
  note: Note;
  origin: {
    jobId: string;
    result: Result;
    sourceSnapshots: Source[];
  };
};
export type Job = {
  id: string;
  studySetId: string;
  kind: string;
  status: string;
  result: Result | null;
  errorCode: string | null;
  attempts: {
    status: string;
  }[];
  inputSnapshot: {
    sources: Source[];
  };
};
type Request = <T>(path: string, options?: RequestOptions) => Promise<T>;
const id = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const fail = (): never => {
  throw new AuthApiError("invalid_response", "笔记数据暂时无法读取，请重试。");
};
export function parseResult(v: any): Result {
  if (
    !v ||
    v.schemaVersion !== 1 ||
    typeof v.title !== "string" ||
    !Array.isArray(v.sections) ||
    !v.sections.length ||
    v.sections.length > 8
  )
    fail();
  for (const s of v.sections) {
    if (
      typeof s.heading !== "string" ||
      typeof s.body !== "string" ||
      !Array.isArray(s.citations) ||
      !s.citations.length
    )
      fail();
    for (const c of s.citations)
      if (
        !id(c.materialId) ||
        typeof c.sourceId !== "string" ||
        !Number.isInteger(c.version) ||
        c.version < 1 ||
        typeof c.quote !== "string" ||
        !Number.isInteger(c.start) ||
        c.start < 0 ||
        !Number.isInteger(c.end) ||
        c.end <= c.start ||
        !(c.page === null || (Number.isInteger(c.page) && c.page > 0))
      )
        fail();
  }
  return v;
}
export function parseNote(v: any, set: string, full = true): Note {
  if (
    !v ||
    !id(v.id) ||
    v.studySetId !== set ||
    typeof v.title !== "string" ||
    (full && typeof v.body !== "string") ||
    !Number.isInteger(v.version) ||
    v.version < 1 ||
    typeof v.manuallyEdited !== "boolean" ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    !Number.isFinite(Date.parse(v.updatedAt))
  )
    fail();
  return v;
}
export function createNotesApi(
  request: Request,
  set: string,
  signal: () => AbortSignal,
) {
  if (!id(set)) throw new TypeError("Invalid study set");
  const root = `/v1/study/sets/${set}`;
  const call = async <T>(path: string, options: RequestOptions = {}) => {
    const s = signal();
    throwIfAborted(s);
    const v = await request<T>(path, { ...options, signal: s });
    throwIfAborted(s);
    return v;
  };
  const parseJob = (v: Job) => {
    if (
      !v ||
      !id(v.id) ||
      v.studySetId !== set ||
      v.kind !== "study_note" ||
      !Array.isArray(v.attempts)
    )
      fail();
    if (v.result) parseResult(v.result);
    return v;
  };
  return {
    list: async (cursor?: string) => {
      const v = await call<any>(
        `${root}/notes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (
        !v ||
        typeof v.enabled !== "boolean" ||
        !Array.isArray(v.items) ||
        (v.nextCursor !== null && !id(v.nextCursor))
      )
        fail();
      return {
        ...v,
        items: v.items.map((n: unknown) => parseNote(n, set, false)),
      } as {
        enabled: boolean;
        items: Note[];
        nextCursor: string | null;
      };
    },
    get: async (noteId: string) => {
      if (!id(noteId)) fail();
      const v = await call<Detail>(`${root}/notes/${noteId}`);
      parseNote(v.note, set);
      if (
        v.note.id !== noteId ||
        !id(v.origin?.jobId) ||
        !Array.isArray(v.origin.sourceSnapshots) ||
        !v.origin.sourceSnapshots.length
      )
        fail();
      parseResult(v.origin.result);
      for (const s of v.origin.sourceSnapshots)
        if (
          !id(s.materialId) ||
          typeof s.body !== "string" ||
          typeof s.title !== "string" ||
          !Number.isInteger(s.version)
        )
          fail();
      return v;
    },
    save: async (body: { clientRequestId: string; jobId: string }) => {
      const v = await call<{
        note: Note;
      }>(`${root}/notes`, { method: "POST", body });
      return parseNote(v.note, set);
    },
    edit: async (
      noteId: string,
      body: {
        version: number;
        title: string;
        body: string;
      },
    ) => {
      const v = await call<{
        note: Note;
      }>(`${root}/notes/${noteId}`, { method: "PATCH", body });
      const n = parseNote(v.note, set);
      if (n.id !== noteId) fail();
      return n;
    },
    jobs: async () => {
      const v = await call<{
        items: Job[];
      }>(`${root}/generations?limit=50`);
      if (!Array.isArray(v.items)) fail();
      return v.items.filter((j) => j.kind === "study_note").map(parseJob);
    },
    job: async (jobId: string) => {
      if (!id(jobId)) fail();
      const v = await call<{
        job: Job;
      }>(`${root}/generations/${jobId}`);
      const j = parseJob(v.job);
      if (j.id !== jobId) fail();
      return j;
    },
    generate: async (body: unknown) => {
      const v = await call<{
        job: Job;
      }>(`${root}/generations`, { method: "POST", body });
      return parseJob(v.job);
    },
    cancel: async (jobId: string) =>
      call(`${root}/generations/${jobId}/cancel`, { method: "POST", body: {} }),
    retry: async (jobId: string, clientRequestId: string) =>
      call(`${root}/generations/${jobId}/retry`, {
        method: "POST",
        body: { clientRequestId },
      }),
  };
}
