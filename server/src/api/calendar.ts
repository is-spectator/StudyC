import type { Hono, Context } from "hono";
import { z } from "zod";
import type { Db } from "../db/db.js";
import type { StudyEnv } from "./auth.js";
import type { SharedRateLimiter } from "../runtime/rate-limit.js";
import { CalendarService } from "../services/calendar.js";
import { uuid } from "../services/organization-common.js";
import { GenerationError } from "../generation/types.js";
import { readJson } from "./study.js";
export function registerCalendarRoutes(
  app: Hono<StudyEnv>,
  db: Db,
  limits: SharedRateLimiter,
) {
  const service = new CalendarService(db),
    root = "/v1/study/calendar",
    user = (c: Context<StudyEnv>) => c.get("userId");
  const query = (c: Context<StudyEnv>) => {
    if (Object.values(c.req.queries()).some((v) => v.length !== 1))
      throw new GenerationError("invalid_input", "查询参数无效。");
    return c.req.query();
  };
  const input = async (c: Context<StudyEnv>) => {
    await limits.consume("write", user(c), 120);
    return readJson(c, 16384);
  };
  app.get(root + "/settings", async (c) =>
    c.json(await service.getSettings(user(c))),
  );
  app.patch(root + "/settings", async (c) =>
    c.json(await service.setSettings(user(c), await input(c))),
  );
  app.get(root + "/time-options", async (c) => {
    const q = z
      .object({
        local: z.string().max(16),
        timeZone: z.string().min(1).max(80),
      })
      .strict()
      .parse(query(c));
    return c.json(await service.options(user(c), q.local, q.timeZone));
  });
  app.get(root + "/task-event", async (c) =>
    c.json(await service.taskEvent(user(c), query(c))),
  );
  app.get(root + "/events", async (c) =>
    c.json(await service.list(user(c), query(c))),
  );
  app.post(root + "/events", async (c) => {
    const r = await service.create(user(c), await input(c));
    return c.json(r, r.replayed ? 200 : 201);
  });
  app.get(root + "/events/:eventId", async (c) =>
    c.json({
      event: await service.get(user(c), uuid.parse(c.req.param("eventId"))),
    }),
  );
  app.patch(root + "/events/:eventId", async (c) =>
    c.json(
      await service.edit(
        user(c),
        uuid.parse(c.req.param("eventId")),
        await input(c),
      ),
    ),
  );
  app.post(root + "/conflicts", async (c) =>
    c.json(await service.preview(user(c), await input(c))),
  );
}
