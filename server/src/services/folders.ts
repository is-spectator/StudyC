import { z } from "zod";
import type { Db, Queryable } from "../db/db.js";
import { requireActiveUser } from "./identity.js";
import {
  uuid,
  plainTitle,
  version,
  missing,
  conflict,
  digest,
  iso,
  ownedSet,
  featureEnabled,
} from "./organization-common.js";
import { GenerationError } from "../generation/types.js";
type Row = Record<string, any>;
const title = plainTitle
  .max(80)
  .refine((v) => !/[\u0000-\u001f\u007f]/u.test(v));
export const folderCreate = z.object({ clientRequestId: uuid, title }).strict();
export const folderRename = z
  .object({ clientRequestId: uuid, version, title })
  .strict();
export const folderRemove = z
  .object({ clientRequestId: uuid, version })
  .strict();
export const folderMove = z
  .object({
    clientRequestId: uuid,
    version: z.number().int().min(0).max(2147483646),
    folderId: uuid.nullable(),
  })
  .strict();
const folderView = (r: Row) => ({
  id: r.id,
  title: r.title,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  setCount: r.set_count ?? 0,
});
const count = `(SELECT count(*)::integer FROM study_folder_assignments a JOIN study_sets s ON s.id=a.study_set_id AND s.user_id=a.user_id WHERE a.user_id=f.user_id AND a.folder_id=f.id AND NOT EXISTS(SELECT 1 FROM study_set_lifecycle l WHERE l.user_id=s.user_id AND l.study_set_id=s.id AND l.deleted_at IS NOT NULL)) AS set_count`;
export class FolderService {
  constructor(private db: Db) {}
  private async folder(q: Queryable, user: string, id: string) {
    const [r] = await q.query<Row>(
      `SELECT f.*,${count} FROM study_folders f WHERE f.user_id=$1 AND f.id=$2 AND f.deleted_at IS NULL FOR SHARE OF f`,
      [user, id],
    );
    if (!r) throw missing();
    return r;
  }
  private async assignment(q: Queryable, user: string, set: string) {
    const [r] = await q.query<Row>(
      "SELECT a.*,f.title AS folder_title FROM study_folder_assignments a LEFT JOIN study_folders f ON f.id=a.folder_id AND f.user_id=a.user_id AND f.deleted_at IS NULL WHERE a.user_id=$1 AND a.study_set_id=$2",
      [user, set],
    );
    return {
      studySetId: set,
      folderId: r?.folder_id ?? null,
      folderTitle: r?.folder_title ?? null,
      version: r?.version ?? 0,
    };
  }
  private async replay(
    q: Queryable,
    user: string,
    id: string,
    hash: string,
    kind: string,
  ) {
    const [r] = await q.query<Row>(
      "SELECT * FROM study_folder_requests WHERE user_id=$1 AND client_request_id=$2",
      [user, id],
    );
    if (r && (r.digest !== hash || r.entity_kind !== kind))
      throw new GenerationError(
        "idempotency_conflict",
        "这个请求ID已用于其他操作。",
      );
    return r;
  }
  private async receipt(
    q: Queryable,
    user: string,
    id: string,
    hash: string,
    kind: string,
    entity: string,
    outcome: unknown = null,
  ) {
    await q.query(
      "INSERT INTO study_folder_requests(user_id,client_request_id,digest,entity_kind,entity_id,outcome) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
      [user, id, hash, kind, entity, JSON.stringify(outcome)],
    );
  }
  private async uniqueTitle(
    q: Queryable,
    user: string,
    title: string,
    id?: string,
  ) {
    const rows = await q.query(
      "SELECT id FROM study_folders WHERE user_id=$1 AND lower(title)=lower($2) AND deleted_at IS NULL AND ($3::uuid IS NULL OR id<>$3)",
      [user, title, id ?? null],
    );
    if (rows.length)
      throw new GenerationError(
        "job_conflict",
        "这个名称的文件夹已存在，请使用其他名称。",
      );
  }
  async list(user: string, cursor?: string) {
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      if (cursor) await this.folder(q, user, cursor);
      const rows = await q.query<Row>(
        `SELECT f.*,${count} FROM study_folders f WHERE f.user_id=$1 AND f.deleted_at IS NULL ${cursor ? "AND f.id>$2" : ""} ORDER BY f.id LIMIT 21`,
        [user, ...(cursor ? [cursor] : [])],
      );
      return {
        enabled: process.env.STUDYC_FOLDERS_ENABLED !== "false",
        items: rows.slice(0, 20).map(folderView),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async get(user: string, id: string) {
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      return folderView(await this.folder(q, user, id));
    });
  }
  async create(user: string, raw: unknown) {
    featureEnabled("STUDYC_FOLDERS_ENABLED");
    const input = folderCreate.parse(raw),
      hash = digest(["create_folder", input.title]);
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      const old = await this.replay(
        q,
        user,
        input.clientRequestId,
        hash,
        "folder",
      );
      if (old) {
        const [r] = await q.query<Row>(
          "SELECT deleted_at FROM study_folders WHERE user_id=$1 AND id=$2",
          [user, old.entity_id],
        );
        if (r?.deleted_at)
          throw new GenerationError(
            "job_conflict",
            "原创建请求已处理，但文件夹后来被删除。请明确新建文件夹。",
          );
        return {
          folder: folderView(await this.folder(q, user, old.entity_id)),
          replayed: true,
        };
      }
      await this.uniqueTitle(q, user, input.title);
      const [r] = await q.query<Row>(
        "INSERT INTO study_folders(user_id,title) VALUES($1,$2) RETURNING *",
        [user, input.title],
      );
      await this.receipt(q, user, input.clientRequestId, hash, "folder", r!.id);
      return { folder: folderView(r!), replayed: false };
    }, `studyc:organization:${user}`);
  }
  async rename(user: string, id: string, raw: unknown) {
    featureEnabled("STUDYC_FOLDERS_ENABLED");
    const input = folderRename.parse(raw),
      hash = digest(["rename_folder", id, input.version, input.title]);
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      const current = await this.folder(q, user, id);
      if (await this.replay(q, user, input.clientRequestId, hash, "folder"))
        return { folder: folderView(current), replayed: true };
      if (current.version !== input.version) throw conflict();
      await this.uniqueTitle(q, user, input.title, id);
      await q.query(
        "UPDATE study_folders SET title=$3,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
        [user, id, input.title],
      );
      await this.receipt(q, user, input.clientRequestId, hash, "folder", id);
      return {
        folder: folderView(await this.folder(q, user, id)),
        replayed: false,
      };
    }, `studyc:organization:${user}`);
  }
  async remove(user: string, id: string, raw: unknown) {
    featureEnabled("STUDYC_FOLDERS_ENABLED");
    const input = folderRemove.parse(raw),
      hash = digest(["remove_folder", id, input.version]);
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      const old = await this.replay(
        q,
        user,
        input.clientRequestId,
        hash,
        "remove",
      );
      if (old) return { ...old.outcome, replayed: true };
      const f = await this.folder(q, user, id);
      if (f.version !== input.version) throw conflict();
      const moved = await q.query(
        "UPDATE study_folder_assignments SET folder_id=NULL,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND folder_id=$2 RETURNING study_set_id",
        [user, id],
      );
      await q.query(
        "UPDATE study_folders SET deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
        [user, id],
      );
      const outcome = { removed: true, id, movedSets: moved.length };
      await this.receipt(
        q,
        user,
        input.clientRequestId,
        hash,
        "remove",
        id,
        outcome,
      );
      return { ...outcome, replayed: false };
    }, `studyc:organization:${user}`);
  }
  async getAssignment(user: string, set: string) {
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      return this.assignment(q, user, set);
    });
  }
  async move(user: string, set: string, raw: unknown) {
    featureEnabled("STUDYC_FOLDERS_ENABLED");
    const input = folderMove.parse(raw),
      hash = digest(["assign_folder", set, input.version, input.folderId]);
    return this.db.tx(async (q) => {
      await ownedSet(q, user, set);
      const old = await this.replay(
        q,
        user,
        input.clientRequestId,
        hash,
        "assignment",
      );
      if (old)
        return {
          assignment: await this.assignment(q, user, set),
          replayed: true,
        };
      const a = await this.assignment(q, user, set);
      if (a.version !== input.version) throw conflict();
      if (input.folderId) await this.folder(q, user, input.folderId);
      await q.query(
        "INSERT INTO study_folder_assignments(user_id,study_set_id,folder_id,version) VALUES($1,$2,$3,1) ON CONFLICT(study_set_id,user_id) DO UPDATE SET folder_id=$3,version=study_folder_assignments.version+1,updated_at=clock_timestamp()",
        [user, set, input.folderId],
      );
      await this.receipt(
        q,
        user,
        input.clientRequestId,
        hash,
        "assignment",
        set,
      );
      return {
        assignment: await this.assignment(q, user, set),
        replayed: false,
      };
    }, `studyc:organization:${user}`);
  }
  async sets(user: string, folder: string, cursor?: string) {
    return this.db.tx(async (q) => {
      await requireActiveUser(q, user);
      if (folder !== "unfiled") await this.folder(q, user, folder);
      const filter =
        folder === "unfiled" ? "a.folder_id IS NULL" : "a.folder_id=$2::uuid";
      const parameters = [user, ...(folder === "unfiled" ? [] : [folder])],
        cursorIndex = parameters.length + 1;
      const base = `FROM study_sets s LEFT JOIN study_folder_assignments a ON a.study_set_id=s.id AND a.user_id=s.user_id WHERE s.user_id=$1 AND NOT EXISTS(SELECT 1 FROM study_set_lifecycle l WHERE l.user_id=s.user_id AND l.study_set_id=s.id AND l.deleted_at IS NOT NULL) AND ${filter}`;
      if (cursor) {
        const exists = await q.query(
          `SELECT s.id ${base} AND s.id=$${cursorIndex}`,
          [...parameters, cursor],
        );
        if (!exists.length)
          throw new GenerationError(
            "invalid_input",
            "学习集归类已变化，请重新读取。",
          );
      }
      const rows = await q.query<Row>(
        `SELECT s.*,a.folder_id,COALESCE(a.version,0) AS assignment_version ${base} ${cursor ? `AND s.id>$${cursorIndex}` : ""} ORDER BY s.id LIMIT 21`,
        [...parameters, ...(cursor ? [cursor] : [])],
      );
      return {
        items: rows
          .slice(0, 20)
          .map((r) => ({
            id: r.id,
            title: r.title,
            version: r.version,
            createdAt: iso(r.created_at),
            updatedAt: iso(r.updated_at),
            folderId: r.folder_id ?? null,
            assignmentVersion: r.assignment_version,
          })),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
}
