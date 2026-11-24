import test from "node:test";
import assert from "node:assert/strict";
import { createNotesApi, parseNote, parseResult } from "./api.ts";
const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const note = {
  id,
  studySetId: id,
  title: "笔记",
  body: "正文",
  version: 1,
  manuallyEdited: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const result = {
  schemaVersion: 1,
  title: "笔记",
  sections: [
    {
      heading: "章节",
      body: "正文",
      citations: [
        {
          sourceId: "s1",
          materialId: id,
          version: 1,
          quote: "原文",
          start: 0,
          end: 2,
          page: null,
        },
      ],
    },
  ],
};
test("notes reject foreign set, invalid versions and malformed section citations", () => {
  assert.equal(parseNote(note, id).id, id);
  for (const changes of [
    { studySetId: other },
    { version: 0 },
    { body: undefined },
    { manuallyEdited: undefined },
  ])
    assert.throws(
      () => parseNote({ ...note, ...changes }, id),
      (e) => e.code === "invalid_response",
    );
  assert.equal(parseResult(result).title, "笔记");
  for (const changes of [
    { sections: [] },
    { sections: [{ ...result.sections[0], citations: [] }] },
    {
      sections: [
        {
          ...result.sections[0],
          citations: [{ ...result.sections[0].citations[0], start: -1 }],
        },
      ],
    },
  ])
    assert.throws(() => parseResult({ ...result, ...changes }));
});
test("a save replay uses exactly the same job and intent, rather than client-authored content", async () => {
  const seen = [];
  const api = createNotesApi(
    async (path, options) => {
      seen.push([path, options.body]);
      return { note };
    },
    id,
    () => new AbortController().signal,
  );
  const input = { clientRequestId: other, jobId: id };
  await api.save(input);
  await api.save(input);
  assert.deepEqual(seen[0], seen[1]);
  assert.deepEqual(Object.keys(seen[0][1]).sort(), [
    "clientRequestId",
    "jobId",
  ]);
});
test("late responses after account scope cancellation are rejected", async () => {
  const controller = new AbortController();
  let release;
  const api = createNotesApi(
    () => new Promise((resolve) => (release = resolve)),
    id,
    () => controller.signal,
  );
  const pending = api.list();
  controller.abort();
  release({ enabled: true, items: [], nextCursor: null });
  await assert.rejects(pending, (e) => e.name === "AbortError");
});
test("detail response must match requested note and edit preserves expected version", async () => {
  const controller = new AbortController();
  const api = createNotesApi(
    async () => ({
      note: { ...note, id: other },
      origin: {
        jobId: id,
        result,
        sourceSnapshots: [
          {
            sourceId: "s1",
            materialId: id,
            version: 1,
            title: "原文",
            body: "原文",
          },
        ],
      },
    }),
    id,
    () => controller.signal,
  );
  await assert.rejects(api.get(id), (e) => e.code === "invalid_response");
  let body;
  const editing = createNotesApi(
    async (_, options) => {
      body = options.body;
      return { note: { ...note, version: 2 } };
    },
    id,
    () => controller.signal,
  );
  await editing.edit(id, { title: "本地", body: "草稿", version: 1 });
  assert.equal(body.version, 1);
});
