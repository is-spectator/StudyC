import test from "node:test";
import assert from "node:assert/strict";
import { parseHit, createSearchApi, hitPath } from "./api.ts";
const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  query = { q: "水循环", type: "all" },
  hit = {
    type: "material",
    id,
    studySetId: other,
    title: "资料",
    studySetTitle: "学习集",
    excerpt: "水循环",
    href: `/platform/studyset/${other}/material/${id}`,
  };
test("result links must target exactly their owned object kind and identifiers", () => {
  assert.equal(parseHit(hit, query).id, id);
  for (const v of [
    { ...hit, href: "https://evil.test/x" },
    { ...hit, href: "/platform/studysets" },
    { ...hit, type: "attempt" },
    { ...hit, id: "bad" },
  ])
    assert.throws(
      () => parseHit(v, query),
      (e) => e.code === "invalid_response",
    );
  assert.throws(() => parseHit(hit, { ...query, type: "quiz" }));
  assert.throws(() => parseHit(hit, { ...query, studySetId: id }));
  assert.equal(
    hitPath({ ...hit, type: "deck" }),
    `/platform/studyset/${other}/flashcards?flashcardDeck=${id}`,
  );
});
test("search binds the returned query and filter to the requested result set", async () => {
  const api = createSearchApi(async () => ({
    query: { q: "旧搜索", type: "all", studySetId: null },
    items: [hit],
    nextCursor: null,
  }));
  await assert.rejects(api.search(query), (e) => e.code === "invalid_response");
});
test("Chinese and literal wildcard characters are URL encoded rather than interpreted as URL syntax", async () => {
  let seen;
  const q = { q: "水 %_&?/#", type: "material", studySetId: other };
  const api = createSearchApi(async (path) => {
    seen = new URL("https://test" + path);
    return { query: { ...q, studySetId: other }, items: [], nextCursor: null };
  });
  await api.search(q, "cursorToken");
  assert.equal(seen.searchParams.get("q"), q.q);
  assert.equal(seen.searchParams.get("studySetId"), other);
  assert.equal(seen.searchParams.get("cursor"), "cursorToken");
});
