import { GenerationError, type GenerationConfig, type GenerationKind, type GenerationSnapshot } from './types.js';
export const PROMPTS: Record<GenerationKind, GenerationSnapshot['promptVersion']> = {
  study_outline: 'study-outline-v1', chat_answer: 'chat-answer-v1', flashcards: 'flashcards-v1', quiz: 'quiz-v1', study_note: 'study-note-v1',
};
export const snapshotKind = (snapshot: GenerationSnapshot): GenerationKind | undefined =>
  (Object.keys(PROMPTS) as GenerationKind[]).find(kind => PROMPTS[kind] === snapshot.promptVersion);
export function normalizeConfig(kind: GenerationKind, value: GenerationConfig): GenerationConfig {
  const invalid = () => new GenerationError('invalid_input', '生成配置无效。');
  if (!value || typeof value !== 'object' || !['zh-CN', 'en'].includes(value.language)) throw invalid();
  const int = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
  const keys = (...expected: string[]) => Object.keys(value).sort().join(',') === ['language', ...expected].sort().join(',');
  if (kind === 'study_outline' && 'pointCount' in value && keys('pointCount') && int(value.pointCount, 1, 8)) return { language: value.language, pointCount: value.pointCount };
  if (kind === 'study_note' && 'sectionCount' in value && keys('sectionCount') && int(value.sectionCount,1,8)) return {language:value.language,sectionCount:value.sectionCount};
  if (kind === 'flashcards' && 'cardCount' in value && keys('cardCount') && int(value.cardCount, 1, 20)) return { language: value.language, cardCount: value.cardCount };
  if (kind === 'quiz' && 'singleChoiceCount' in value && keys('singleChoiceCount', 'trueFalseCount')
    && int(value.singleChoiceCount, 0, 10) && int(value.trueFalseCount, 0, 10) && value.singleChoiceCount + value.trueFalseCount >= 1) {
    return { language: value.language, singleChoiceCount: value.singleChoiceCount, trueFalseCount: value.trueFalseCount };
  }
  if (kind === 'chat_answer' && 'question' in value && keys('question', 'history')
    && typeof value.question === 'string' && value.question.trim() && value.question.length <= 2000 && !/[\u0000\uD800-\uDFFF]/u.test(value.question)
    && Array.isArray(value.history) && value.history.length <= 4 && Buffer.byteLength(JSON.stringify(value.history)) <= 8192
    && value.history.every(turn => turn && Object.keys(turn).sort().join(',') === 'answer,question'
      && typeof turn.question === 'string' && typeof turn.answer === 'string' && turn.question.length <= 2000 && turn.answer.length <= 4000
      && !/[\u0000\uD800-\uDFFF]/u.test(turn.question + turn.answer))) {
    return { language: value.language, question: value.question, history: value.history.map(turn => ({ ...turn })) };
  }
  throw invalid();
}
