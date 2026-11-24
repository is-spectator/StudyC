import type { Hono } from "hono";
import type { StudyEnv } from "./auth.js";
import type { Db } from "../db/db.js";
import type { GenerationStore } from "../generation/store.js";
import type { SharedRateLimiter } from "../runtime/rate-limit.js";
import { uuid } from "../services/organization-common.js";
import { TrashService } from "../services/trash.js";
import { readJson } from "./study.js";
import { z } from "zod";
export function registerTrashRoutes(
  app: Hono<StudyEnv>,
  db: Db,
  limits: SharedRateLimiter,
  store?: GenerationStore,
) {
  const service = new TrashService(db, store),
    root = "/v1/study/trash";
  app.get(root, async (c) => {
    const query = z
      .object({ cursor: uuid.optional() })
      .strict()
      .parse(c.req.query());
    return c.json(await service.list(c.get("userId"), query.cursor));
  });
  app.get(root + "/:setId", async (c) =>
    c.json({
      item: await service.get(
        c.get("userId"),
        uuid.parse(c.req.param("setId")),
      ),
    }),
  );
  app.patch(root + "/:setId", async (c) => {
    const user = c.get("userId");
    await limits.consume("write", user, 120);
    return c.json(
      await service.change(
        user,
        uuid.parse(c.req.param("setId")),
        await readJson(c, 16384),
      ),
    );
  });
}
