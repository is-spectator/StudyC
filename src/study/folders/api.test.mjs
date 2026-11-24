import test from "node:test";
import assert from "node:assert/strict";
import { createFolderApi, parseAssignment, parseFolder } from "./api.ts";
const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  folder = { id, title: "资料整理", version: 1, setCount: 0 },
  assignment = {
    studySetId: id,
    folderId: null,
    folderTitle: null,
    version: 0,
  };
test("folder and assignment responses validate IDs, counts and their expected parent set", () => {
  assert.equal(parseFolder(folder).id, id);
  assert.equal(parseAssignment(assignment, id).version, 0);
  for (const v of [
    { ...folder, setCount: -1 },
    { ...folder, version: 0 },
    { ...folder, id: "bad" },
  ])
    assert.throws(() => parseFolder(v));
  for (const v of [
    { ...assignment, studySetId: other },
    { ...assignment, version: -1 },
    { ...assignment, folderId: id, folderTitle: null },
  ])
    assert.throws(() => parseAssignment(v, id));
});
test("folder and move retries retain exact intent and independent assignment version", async () => {
  const seen = [],
    api = createFolderApi(async (path, options) => {
      seen.push([path, options.body]);
      return path.endsWith("/folder")
        ? {
            assignment: {
              ...assignment,
              folderId: other,
              folderTitle: "目标",
              version: 2,
            },
          }
        : { folder };
    });
  const input = { clientRequestId: other, title: "新名称", version: 1 };
  await api.save(id, input);
  await api.save(id, input);
  assert.deepEqual(seen[0], seen[1]);
  const move = { clientRequestId: other, version: 1, folderId: other };
  await api.move(id, move);
  await api.move(id, move);
  assert.deepEqual(seen[2], seen[3]);
  assert.equal(seen[2][1].version, 1);
});
test("detail and membership results cannot silently substitute another folder or classification", async () => {
  const api = createFolderApi(async () => ({
    folder: { ...folder, id: other },
    items: [
      {
        id,
        title: "学习集",
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        folderId: other,
        assignmentVersion: 1,
      },
    ],
    nextCursor: null,
  }));
  await assert.rejects(api.get(id), (e) => e.code === "invalid_response");
  await assert.rejects(api.sets(id), (e) => e.code === "invalid_response");
});
