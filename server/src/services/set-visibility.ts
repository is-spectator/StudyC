import type { Queryable } from "../db/db.js";
import { requireActiveUser } from "./identity.js";
import { GenerationError } from "../generation/types.js";
/** Call within the operation's transaction: deletion obtains the matching UPDATE lock.
 * The second statement sees a marker committed while the first waited for its lock. */
export async function requireVisibleSet(
  q: Queryable,
  user: string,
  set: string,
) {
  await requireActiveUser(q, user);
  const [row] = await q.query<{ id: string; title: string }>(
    "SELECT id,title FROM study_sets WHERE user_id=$1 AND id=$2 FOR SHARE",
    [user, set],
  );
  if (
    !row ||
    (
      await q.query(
        "SELECT 1 FROM study_set_lifecycle WHERE user_id=$1 AND study_set_id=$2 AND deleted_at IS NOT NULL",
        [user, set],
      )
    ).length
  )
    throw new GenerationError(
      "not_found",
      "没有找到这个学习集；如已移入回收站，请先恢复。",
    );
  return row;
}
