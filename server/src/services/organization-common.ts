import {requireVisibleSet} from './set-visibility.js';
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Queryable } from "../db/db.js";
import { requireActiveUser } from "./identity.js";
import { GenerationError } from "../generation/types.js";
export const uuid = z.uuid().transform((v) => v.toLowerCase());
export const version = z.number().int().min(1).max(2147483646);
export const plainTitle = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v));
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !v.startsWith("0000") &&
      Number.isFinite(Date.parse(v + "T00:00:00Z")) &&
      new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v,
  );
export const missing = () =>
  new GenerationError("not_found", "没有找到这个学习对象。");
export const conflict = () =>
  new GenerationError(
    "version_conflict",
    "内容已在另一页面更新。你的输入仍保留，请读取最新内容后再决定。",
  );
export const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const iso = (v: Date | string | null) =>
  v === null ? null : typeof v === "string" ? v : new Date(v).toISOString();
export async function ownedSet(q: Queryable, user: string, set: string) { return requireVisibleSet(q,user,set); }
export function featureEnabled(name: string) {
  if (process.env[name] === "false")
    throw new GenerationError(
      "service_unavailable",
      "这项功能暂时只允许查看。",
    );
}
export const activityTables = {
  material: "study_materials",
  deck: "study_flashcard_decks",
  quiz: "study_quizzes",
  note: "study_notes",
} as const;
export type ActivityKind = keyof typeof activityTables;
export async function ownedActivity(
  q: Queryable,
  user: string,
  set: string,
  kind: ActivityKind,
  id: string,
) {
  const [r] = await q.query<{ id: string; title: string }>(
    `SELECT id,title FROM ${activityTables[kind]} WHERE id=$1 AND user_id=$2 AND study_set_id=$3`,
    [id, user, set],
  );
  if (!r) throw missing();
  return r;
}
