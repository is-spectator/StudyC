import { useCallback, useEffect, useRef, useState } from 'react';

const guards = new Set<() => boolean>();
export function registerStudyLeaveGuard(next: () => boolean): () => void {
  guards.add(next);
  return () => { guards.delete(next); };
}
export function confirmStudyLeave(): boolean { return [...guards].every(guard => guard()); }
const currentPath = () => location.pathname + location.search;

export function useStudyNavigation() {
  const [path, setPath] = useState(currentPath);
  const current = useRef(path);
  const position = useRef(0);
  const restoring = useRef(false);
  useEffect(() => {
    const existing = history.state?.studyPosition;
    position.current = Number.isSafeInteger(existing) ? existing : 0;
    history.replaceState({ ...history.state, studyPosition: position.current }, '', currentPath());
    const pop = () => {
      if (restoring.current) { restoring.current = false; return; }
      const nextPosition = history.state?.studyPosition;
      if (!confirmStudyLeave()) {
        if (Number.isSafeInteger(nextPosition) && nextPosition !== position.current) {
          restoring.current = true; history.go(position.current - nextPosition);
        } else history.pushState({ studyPosition: position.current }, '', current.current);
        return;
      }
      position.current = Number.isSafeInteger(nextPosition) ? nextPosition : position.current;
      current.current = currentPath(); setPath(current.current);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const navigate = useCallback((next: string, options?: { replace?: boolean }): boolean => {
    if (!next.startsWith('/platform') || next.startsWith('//') || /[\\\r\n]/.test(next)) return false;
    if (next === current.current && !options?.replace) return true;
    if (!confirmStudyLeave()) return false;
    if (!options?.replace) position.current += 1;
    const state = { studyPosition: position.current };
    if (options?.replace) history.replaceState(state, '', next);
    else history.pushState(state, '', next);
    current.current = next; setPath(next);
    document.querySelector('.main-scroll')?.scrollTo(0, 0);
    return true;
  }, []);
  return { path, navigate };
}
