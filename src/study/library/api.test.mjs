import test from "node:test";
import assert from "node:assert/strict";
import { createLibraryApi, parseLibrarySet } from "./api.ts";
const id = "11111111-1111-4111-8111-111111111111",
  deck = "22222222-2222-4222-8222-222222222222",
  set = {
    id,
    title: "学习集",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      materialCount: 1,
      deckCount: 1,
      quizCount: 0,
      noteCount: 0,
      dueCardCount: 2,
      pendingTaskCount: 0,
      lastStudiedAt: null,
      continue: null,
    },
  };
test("library summaries reject fabricated counters, dates and cross-parent resume links", () => {
  assert.equal(parseLibrarySet(set).summary.lastStudiedAt, null);
  for (const summary of [
    { ...set.summary, materialCount: -1 },
    { ...set.summary, dueCardCount: 2.3 },
    { ...set.summary, lastStudiedAt: "invalid" },
    { ...set.summary, continue: { label: "继续", href: "https://evil.test" } },
    {
      ...set.summary,
      continue: {
        label: "继续",
        href: `/platform/studyset/${deck}/flashcards?flashcardDeck=${deck}`,
      },
    },
    {
      ...set.summary,
      continue: {
        label: "继续",
        href: `/platform/studyset/${id}/flashcards?flashcardDeck=${deck}&unsafe=x`,
      },
    },
    {
      ...set.summary,
      continue: {
        label: "继续",
        href: `/platform/studyset/${id}/flashcards?flashcardDeck=${deck}&flashcardDeck=${deck}`,
      },
    },
  ])
    assert.throws(() => parseLibrarySet({ ...set, summary }));
  assert.ok(
    parseLibrarySet({
      ...set,
      summary: {
        ...set.summary,
        continue: {
          label: "继续学习",
          href: `/platform/studyset/${id}/flashcards?flashcardDeck=${deck}`,
        },
      },
    }),
  );
});
test("query input is encoded, parent detail is validated and transport cancellation is retained", async () => {
  const seen = [],
    api = createLibraryApi(async (path, options) => {
      seen.push([path, options]);
      return path.includes("?view=library&q=")
        ? { items: [set], nextCursor: null }
        : { studySet: set };
    });
  const controller = new AbortController();
  assert.equal(
    (await api.list({ q: "中文 & %", sort: "title" }, controller.signal)).items
      .length,
    1,
  );
  assert.equal(
    new URL(seen[0][0], "http://local").searchParams.get("q"),
    "中文 & %",
  );
  assert.equal(seen[0][1].signal, controller.signal);
  assert.equal((await api.get(id)).id, id);
  await assert.rejects(api.get(deck));
  controller.abort();
  await assert.rejects(
    api.list({}, controller.signal),
    (e) => e.name === "AbortError",
  );
});
