import test from "node:test";
import assert from "node:assert/strict";
import { createPlanApi, parsePlan, parseTask } from "./api.ts";
const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const plan = {
  id,
  studySetId: id,
  title: "计划",
  goal: "学习",
  dueDate: "2026-12-01",
  version: 1,
};
const task = {
  ...plan,
  planId: id,
  activity: null,
  evidence: [],
  manualCompletedAt: null,
  cancelledAt: null,
};
test("plans reject foreign identities, invalid versions and fabricated completion evidence", () => {
  assert.equal(parsePlan(plan, id).id, id);
  for (const v of [
    { ...plan, studySetId: other },
    { ...plan, version: 0 },
  ])
    assert.throws(() => parsePlan(v, id));
  assert.equal(parseTask(task, id, id).id, id);
  for (const v of [
    { ...task, planId: other },
    { ...task, activity: { kind: "manual", id } },
    {
      ...task,
      evidence: [
        {
          sessionId: id,
          sessionKind: "opened",
          completedAt: new Date().toISOString(),
        },
      ],
    },
  ])
    assert.throws(() => parseTask(v, id, id));
});
test("saving a plan or task retry retains exact intent and expected version", async () => {
  const seen = [],
    api = createPlanApi(async (p, o) => {
      seen.push([p, o.body]);
      return p.endsWith("/tasks/" + id) ? { task } : { plan };
    }, id);
  const input = {
    clientRequestId: other,
    version: 1,
    title: "保留草稿",
    goal: "目标",
    dueDate: null,
  };
  await api.save(id, input);
  await api.save(id, input);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[0][1].version, 1);
  await api.saveTask(id, id, {
    clientRequestId: other,
    version: 1,
    manualCompleted: true,
  });
  assert.equal(seen.at(-1)[1].manualCompleted, true);
});
test("detail response must belong to the requested plan rather than any owned plan", async () => {
  const api = createPlanApi(async () => ({ plan: { ...plan, id: other } }), id);
  await assert.rejects(api.get(id), (e) => e.code === "invalid_response");
});
