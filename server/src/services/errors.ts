export type ErrorCode = 'invalid_input' | 'not_found' | 'version_conflict' | 'unauthorized' | 'rate_limited' | 'internal';

export class DomainError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
