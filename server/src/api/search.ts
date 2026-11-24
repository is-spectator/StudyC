import type { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/db.js";
import type { StudyEnv } from "./auth.js";
import { SearchService } from "../services/search.js";
import { GenerationError } from "../generation/types.js";
export function registerSearchRoutes(app: Hono<StudyEnv>, db: Db) {
  const service = new SearchService(db);
  app.get("/v1/study/search", async (c) => {
    if (Object.values(c.req.queries()).some((v) => v.length !== 1))
      throw new GenerationError("invalid_input", "搜索参数不能重复。");
    const q = z
      .object({
        q: z.string(),
        type: z.string().optional(),
        studySetId: z.string().optional(),
        cursor: z.string().optional(),
        limit: z
          .string()
          .regex(/^[1-9]\d?$/)
          .transform(Number)
          .optional(),
      })
      .strict()
      .parse(c.req.query());
    return c.json(await service.search(c.get("userId"), q));
  });
}
