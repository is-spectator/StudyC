import type { Hono } from "hono";
import type { Db } from "../db/db.js";
import type { StudyEnv } from "./auth.js";
import type { SharedRateLimiter } from "../runtime/rate-limit.js";
import { LocalImportService } from "../services/local-import.js";
import { readJson } from "./study.js";
export function registerImportRoutes(
  app: Hono<StudyEnv>,
  db: Db,
  limits: SharedRateLimiter,
) {
  const s = new LocalImportService(db);
  app.get("/v1/study/imports/status", (c) =>
    c.json({ enabled: process.env.STUDYC_IMPORT_ENABLED !== "false" }),
  );
  app.post("/v1/study/imports", async (c) => {
    await limits.consume("write", c.get("userId"), 30);
    const r = await s.import(
      c.get("userId"),
      await readJson(c, 2 * 1024 * 1024),
    );
    return c.json(r, r.replayed ? 200 : 201);
  });
}
