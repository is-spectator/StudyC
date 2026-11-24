import type { Hono, Context } from "hono";
import { z } from "zod";
import type { Db } from "../db/db.js";
import type { StudyEnv } from "./auth.js";
import type { SharedRateLimiter } from "../runtime/rate-limit.js";
import { uuid } from "../services/organization-common.js";
import { FolderService } from "../services/folders.js";
import { GenerationError } from "../generation/types.js";
import { readJson } from "./study.js";
export function registerFolderRoutes(
  app: Hono<StudyEnv>,
  db: Db,
  limits: SharedRateLimiter,
) {
  const service = new FolderService(db),
    root = "/v1/study/folders",
    user = (c: Context<StudyEnv>) => c.get("userId"),
    id = (c: Context<StudyEnv>) => uuid.parse(c.req.param("folderId")),
    set = (c: Context<StudyEnv>) => uuid.parse(c.req.param("setId"));
  const cursor = (c: Context<StudyEnv>) => {
    if (Object.values(c.req.queries()).some((v) => v.length !== 1))
      throw new GenerationError("invalid_input", "分页参数不能重复。");
    return z.object({ cursor: uuid.optional() }).strict().parse(c.req.query())
      .cursor;
  };
  const input = async (c: Context<StudyEnv>) => {
    await limits.consume("write", user(c), 120);
    return readJson(c, 16384);
  };
  app.get(root, async (c) => c.json(await service.list(user(c), cursor(c))));
  app.post(root, async (c) => {
    const r = await service.create(user(c), await input(c));
    return c.json(r, r.replayed ? 200 : 201);
  });
  app.get(root + "/:folderId", async (c) =>
    c.json({ folder: await service.get(user(c), id(c)) }),
  );
  app.patch(root + "/:folderId", async (c) =>
    c.json(await service.rename(user(c), id(c), await input(c))),
  );
  app.post(root + "/:folderId/remove", async (c) =>
    c.json(await service.remove(user(c), id(c), await input(c))),
  );
  app.get(root + "/:folderId/sets", async (c) =>
    c.json(
      await service.sets(
        user(c),
        c.req.param("folderId") === "unfiled" ? "unfiled" : id(c),
        cursor(c),
      ),
    ),
  );
  const assignment = "/v1/study/sets/:setId/folder";
  app.get(assignment, async (c) =>
    c.json({ assignment: await service.getAssignment(user(c), set(c)) }),
  );
  app.patch(assignment, async (c) =>
    c.json(await service.move(user(c), set(c), await input(c))),
  );
}
