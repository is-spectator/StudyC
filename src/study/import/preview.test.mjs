import test from "node:test";
import assert from "node:assert/strict";
import { previewArchive } from "./preview.ts";
const user = "a1111111-1111-4111-8111-111111111111",
  archive = (entries) =>
    JSON.stringify({
      format: "studyc-local-data-export",
      version: 1,
      accountId: user,
      entries,
    });
test("supports actual legacy uploads, reports each broken item and preserves unsupported keys", () => {
  const p = previewArchive(
    archive({
      "sf-k12:uploads": [
        { title: "  旧笔记  ", text: "原文\n😀" },
        { title: "缺正文" },
        { title: "无效\u0000", text: "x" },
      ],
      "sf-k12:sets": ["旧主题"],
      "sf-k12:cloud-draft:x": { title: "未同步" },
    }),
    user,
  );
  assert.equal(p.rows.filter((r) => r.status === "supported").length, 1);
  assert.equal(p.rows.filter((r) => r.status === "invalid").length, 2);
  assert.equal(p.rows.filter((r) => r.status === "unsupported").length, 2);
  assert.equal(p.rows.find((r) => r.status === "supported").body, "原文\n😀");
});
test("never guesses another account or an unversioned archive", () => {
  assert.throws(() =>
    previewArchive(archive({}), "b2222222-2222-4222-8222-222222222222"),
  );
  assert.throws(() => previewArchive("{bad", user));
  assert.throws(() => previewArchive(JSON.stringify({ entries: {} }), user));
});
test("raw entries are checked without dropping corruption or silently overriding conflict", () => {
  const p = previewArchive(
    JSON.stringify({
      format: "studyc-local-data-export",
      version: 1,
      accountId: user,
      entries: { "sf-k12:uploads": [], "sf-k12:topic": "主题" },
      rawEntries: {
        "sf-k12:uploads": '[{"title":"新","text":"x"}]',
        "sf-k12:topic": "bad",
      },
    }),
    user,
  );
  assert.equal(p.rows.length, 2);
  assert.ok(p.rows.every((r) => r.status === "invalid"));
});
test("duplicates at distinct indices stay distinct and HTML stays plain text", () => {
  const p = previewArchive(
    archive({
      "sf-k12:uploads": [
        { title: "相同", text: "<img onerror=evil()>" },
        { title: "相同", text: "<img onerror=evil()>" },
      ],
    }),
    user,
  );
  assert.notEqual(p.rows[0].id, p.rows[1].id);
  assert.equal(p.rows[0].body, "<img onerror=evil()>");
});
test("rejects large archives before parsing and reports per-item text limits", () => {
  assert.throws(() => previewArchive("x".repeat(5 * 1024 * 1024 + 1), user));
  const p = previewArchive(
    archive({
      "sf-k12:uploads": [{ title: "大文本", text: "字".repeat(350000) }],
    }),
    user,
  );
  assert.equal(p.rows[0].status, "invalid");
});
