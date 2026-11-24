import type { Hono, Context } from "hono";
import { z } from "zod";
import type { Db } from "../db/db.js";
import type { StudyEnv } from "./auth.js";
import type { SharedRateLimiter } from "../runtime/rate-limit.js";
import { PlanService } from "../services/plans.js";
import { uuid } from "../services/organization-common.js";
import { GenerationError } from "../generation/types.js";
import { readJson } from "./study.js";
export function registerPlanRoutes(
  app: Hono<StudyEnv>,
  db: Db,
  limits: SharedRateLimiter,
) {
  const service = new PlanService(db),
    root = "/v1/study/sets/:setId/plans";
  const ids = (c: Context<StudyEnv>) =>
    [c.get("userId"), uuid.parse(c.req.param("setId"))] as const;
  const plan = (c: Context<StudyEnv>) => uuid.parse(c.req.param("planId")),
    task = (c: Context<StudyEnv>) => uuid.parse(c.req.param("taskId"));
  const input = async (c: Context<StudyEnv>) => {
    await limits.consume("write", c.get("userId"), 120);
    return readJson(c, 16384);
  };
  const query = (c: Context<StudyEnv>) => {
    if (Object.values(c.req.queries()).some((v) => v.length !== 1))
      throw new GenerationError("invalid_input", "查询参数无效。");
    return c.req.query();
  };
  const cursor = (c: Context<StudyEnv>) =>
    z.object({ cursor: uuid.optional() }).strict().parse(query(c)).cursor;
  app.get(root, async (c) => c.json(await service.list(...ids(c), cursor(c))));
  app.post(root, async (c) => {
    const r = await service.create(...ids(c), await input(c));
    return c.json(r, r.replayed ? 200 : 201);
  });
  app.get(root + "/:planId", async (c) =>
    c.json({ plan: await service.get(...ids(c), plan(c)) }),
  );
  app.patch(root + "/:planId", async (c) =>
    c.json(await service.edit(...ids(c), plan(c), await input(c))),
  );
  app.get(root + "/:planId/tasks", async (c) =>
    c.json(await service.tasks(...ids(c), plan(c), cursor(c))),
  );
  app.post(root + "/:planId/tasks", async (c) => {
    const r = await service.createTask(...ids(c), plan(c), await input(c));
    return c.json(r, r.replayed ? 200 : 201);
  });
  app.patch(root + "/:planId/tasks/:taskId", async (c) =>
    c.json(await service.editTask(...ids(c), plan(c), task(c), await input(c))),
  );
  app.get(root + "/:planId/tasks/:taskId/evidence", async (c) =>
    c.json(await service.evidence(...ids(c), plan(c), task(c))),
  );
  app.post(root + "/:planId/tasks/:taskId/evidence", async (c) =>
    c.json(
      await service.linkEvidence(...ids(c), plan(c), task(c), await input(c)),
    ),
  );
  app.get("/v1/study/sets/:setId/planning-options", async (c) => {
    const { type, cursor } = z
      .object({
        type: z.enum(["material", "deck", "quiz", "note"]),
        cursor: uuid.optional(),
      })
      .strict()
      .parse(query(c));
    return c.json(await service.options(...ids(c), type, cursor));
  });
}
