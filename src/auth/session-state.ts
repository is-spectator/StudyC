import type { AccountUser } from './api';

export type AuthStatus = 'checking' | 'verifying' | 'authenticated' | 'anonymous' | 'unavailable' | 'preview';
export type AuthState = { status: AuthStatus; user: AccountUser | null; message: string };

/** This is the actual gate decision: pending/offline keeps the previous keyed
 * subtree mounted but never visible. Only verified identity unlocks it. */
export function accountGateView(state: Pick<AuthState, 'status' | 'user'>, allowPreview: boolean) {
  const preview = allowPreview && state.status === 'preview';
  const canRetainAccount = ['authenticated', 'verifying', 'unavailable'].includes(state.status);
  const accountId = preview ? 'preview' : canRetainAccount ? state.user?.id ?? null : null;
  return {
    accountId,
    hidden: accountId !== null && !preview && state.status !== 'authenticated',
    verifying: state.status === 'verifying',
  };
}
