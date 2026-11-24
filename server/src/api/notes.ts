import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/db.js";
import type { StudyEnv } from "./auth.js";
import type { SharedRateLimiter } from "../runtime/rate-limit.js";
import { NoteService } from "../services/notes.js";
import { GenerationError } from "../generation/types.js";
import { readJson } from "./study.js";
const uuid = z.uuid().transform((v) => v.toLowerCase());
export function registerNoteRoutes(
  app: Hono<StudyEnv>,
  db: Db,
  limits: SharedRateLimiter,
) {
  const service = new NoteService(db),
    root = "/v1/study/sets/:setId/notes";
  const ids = (c: Context<StudyEnv>) =>
    [c.get("userId"), uuid.parse(c.req.param("setId"))] as const;
  const input = async (c: Context<StudyEnv>) => {
    await limits.consume("write", c.get("userId"), 120);
    return readJson(c, 262144);
  };
  app.get(root, async (c) => {
    if (Object.values(c.req.queries()).some((v) => v.length !== 1))
      throw new GenerationError("invalid_input", "分页参数无效。");
    const { cursor } = z
      .object({ cursor: uuid.optional() })
      .strict()
      .parse(c.req.query());
    return c.json(await service.list(...ids(c), cursor));
  });
  app.post(root, async (c) => {
    const r = await service.save(...ids(c), await input(c));
    return c.json(r, r.replayed ? 200 : 201);
  });
  app.get(`${root}/:noteId`, async (c) =>
    c.json(await service.get(...ids(c), uuid.parse(c.req.param("noteId")))),
  );
  app.patch(`${root}/:noteId`, async (c) =>
    c.json({
      note: await service.edit(
        ...ids(c),
        uuid.parse(c.req.param("noteId")),
        await input(c),
      ),
    }),
  );
}
