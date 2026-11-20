/** Study data is local to one verified account; legacy anonymous keys are never imported. */
const ACCOUNT_PREFIX = 'clyna-study:account:';
const APP_KEY_PREFIXES = ['sf-k12:', 'studyfetch:k12:', 'studyfetch-k12:'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let accountPrefix: string | null = null;
let accountRevision = 0;

/** Call before mounting account UI, and clear before logout/unmount. Preview is explicit. */
export function setStorageAccount(userId: string | null): void {
  let nextPrefix: string | null = null;
  if (userId !== null) {
    if (typeof userId !== 'string' || (userId !== 'preview' && !UUID.test(userId))) {
      accountPrefix = null;
      accountRevision += 1;
      throw new TypeError('Study storage requires an authenticated UUID or the explicit preview account.');
    }
    nextPrefix = `${ACCOUNT_PREFIX}${userId.toLowerCase()}:`;
  }
  if (nextPrefix !== accountPrefix) accountRevision += 1;
  accountPrefix = nextPrefix;
}

/** Prevent an in-flight upload from saving into a subsequently selected account. */
export function captureStorageSession(): () => boolean {
  const revision = accountRevision;
  return () => accountPrefix !== null && revision === accountRevision;
}

function backend(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function isAppKey(key: string): boolean {
  return APP_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

function scopedKey(key: string): string | null {
  return accountPrefix !== null && isAppKey(key) ? accountPrefix + key : null;
}

export const appStorage = {
  getItem(key: string): string | null {
    const scoped = scopedKey(key);
    if (!scoped) return null;
    try { return backend()?.getItem(scoped) ?? null; } catch { return null; }
  },
  setItem(key: string, value: string): void {
    const scoped = scopedKey(key);
    if (scoped) backend()?.setItem(scoped, value);
  },
  removeItem(key: string): void {
    const scoped = scopedKey(key);
    if (scoped) backend()?.removeItem(scoped);
  },
  /** Logical app keys for this account only, used by the user's data export. */
  keys(): string[] {
    const prefix = accountPrefix;
    if (!prefix) return [];
    const storage = backend();
    if (!storage) return [];
    try {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) {
          const logical = key.slice(prefix.length);
          if (isAppKey(logical)) keys.push(logical);
        }
      }
      return keys;
    } catch { return []; }
  },
};
