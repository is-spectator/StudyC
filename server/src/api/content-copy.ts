import type { Hono } from "hono";
import type { Db } from "../db/db.js";
import type { StudyEnv } from "./auth.js";
import type { SharedRateLimiter } from "../runtime/rate-limit.js";
import { z } from "zod";
import { uuid } from "../services/organization-common.js";
import { ContentCopyService } from "../services/content-copy.js";
import { readJson } from "./study.js";
import { GenerationError } from "../generation/types.js";
export function registerCopyRoutes(
  app: Hono<StudyEnv>,
  db: Db,
  limits: SharedRateLimiter,
) {
  const s = new ContentCopyService(db);
  app.get("/v1/study/sets/:setId/copy-preview", async (c) => {
    if (Object.values(c.req.queries()).some((v) => v.length !== 1))
      throw new GenerationError("invalid_input", "参数不能重复。");
    const input = z
      .object({ materialId: uuid.optional() })
      .strict()
      .parse(c.req.query());
    return c.json(
      await s.preview(
        c.get("userId"),
        uuid.parse(c.req.param("setId")),
        input.materialId,
      ),
    );
  });
  app.post("/v1/study/copies", async (c) => {
    await limits.consume("write", c.get("userId"), 30);
    const r = await s.copy(c.get("userId"), await readJson(c, 32768));
    return c.json(r, r.replayed ? 200 : 201);
  });
}
