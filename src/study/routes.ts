export type StudyRoute =
  | { kind: 'sets' }
  | { kind: 'set'; studySetId: string }
  | { kind: 'material'; studySetId: string; materialId?: string }
  | { kind: 'chat'; studySetId: string; threadId?: string }
  | { kind: 'flashcards'; studySetId: string }
  | { kind: 'quizzes'; studySetId: string }
  | { kind: 'mistakes'; studySetId: string }
  | { kind: 'notes'; studySetId: string }
  | { kind: 'plans'; studySetId: string }
  | { kind: 'calendar' }
  | { kind: 'search' }
  | { kind: 'folders' }
  | { kind: 'local-data' }
  | { kind: 'unavailable'; title: string; studySetId?: string }
  | { kind: 'not-found' };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tools: Record<string, string> = {
  'study-plan': '学习计划', chat: '资料问答', flashcards: '闪卡', practice: '测验与考试',
  'tutor-me': '小C辅导', 'live-lecture': '学习录音', 'audio-recap-v2': '音频复习',
  'assignment-grader': '作业批改', explainers: '视频讲解', arcade: '互动练习', read: '阅读',
};

export function parseStudyRoute(value: string): StudyRoute {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return { kind: 'not-found' };
  const path = value.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/platform' || path === '/platform/studysets'
    || path === '/platform/onboarding' || path.startsWith('/platform/onboarding/')
    || path === '/platform/studyset/main' || path.startsWith('/platform/studyset/main/')) return { kind: 'sets' };
  if (path === '/platform/folders') return {kind:'folders'};
  if (path === '/platform/search') return {kind:'search'};
  if (path === '/platform/calendar') return {kind:'calendar'};
  if (path === '/platform/local-data') return { kind: 'local-data' };
  const global = ({ '/platform/calendar': '日历', '/platform/qbank': '题库', '/platform/apps': '学习工具', '/platform/settings': '账户设置' } as Record<string, string>)[path];
  if (global) return { kind: 'unavailable', title: global };
  const parts = path.split('/');
  if (parts[1] !== 'platform' || parts[2] !== 'studyset' || !uuid.test(parts[3] ?? '')) return { kind: 'not-found' };
  const studySetId = parts[3].toLowerCase();
  if (parts.length === 4 || parts.length === 5 && parts[4] === 'materials') return { kind: 'set', studySetId };
  if (parts.length === 6 && parts[4] === 'material') {
    if (parts[5] === 'new') return { kind: 'material', studySetId };
    if (uuid.test(parts[5])) return { kind: 'material', studySetId, materialId: parts[5].toLowerCase() };
  }
  if (parts[4] === 'chat') {
    if (parts.length === 5 || parts.length === 6 && parts[5] === 'new') return { kind: 'chat', studySetId };
    if (parts.length === 6 && uuid.test(parts[5])) return { kind: 'chat', studySetId, threadId: parts[5].toLowerCase() };
    return { kind: 'not-found' };
  }
  if (parts[4] === 'flashcards') return parts.length === 5 ? { kind: 'flashcards', studySetId } : { kind: 'not-found' };
  if (parts[4] === 'study-plan') return parts.length === 5 ? { kind: 'plans', studySetId } : { kind: 'not-found' };
  if (parts[4] === 'notes') return parts.length === 5 ? { kind: 'notes', studySetId } : { kind: 'not-found' };
  if (parts[4] === 'mistakes') return parts.length === 5 ? { kind: 'mistakes', studySetId } : { kind: 'not-found' };
  if (parts[4] === 'practice') return parts.length === 5 ? { kind: 'quizzes', studySetId } : { kind: 'not-found' };
  if (Object.hasOwn(tools, parts[4])) return { kind: 'unavailable', title: tools[parts[4]], studySetId };
  return { kind: 'not-found' };
}

function resourceId(value: string): string {
  if (!uuid.test(value)) throw new TypeError('Study resource ID must be a UUID');
  return value.toLowerCase();
}

export const studySetPath = (id: string) => `/platform/studyset/${resourceId(id)}`;
export const materialPath = (setId: string, materialId?: string) => `${studySetPath(setId)}/material/${materialId === undefined ? 'new' : resourceId(materialId)}`;
