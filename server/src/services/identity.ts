import type { Queryable } from '../db/db.js';
import { DomainError } from './errors.js';

/** Shared identity is owned by Clyna. StudyC never creates or changes an account. */
export async function requireActiveUser(q: Queryable, userId: string): Promise<void> {
  const [user] = await q.query('SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL FOR SHARE', [userId]);
  if (!user) throw new DomainError('unauthorized', '账户已失效，请重新登录。');
}
