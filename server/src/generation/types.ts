export type GenerationKind = 'study_outline' | 'chat_answer' | 'flashcards' | 'quiz';
export type Language = 'zh-CN' | 'en';
export interface OutlineConfig { language: Language; pointCount: number }
export interface ChatConfig { language: Language; question: string; history: { question: string; answer: string }[] }
export interface FlashcardConfig { language: Language; cardCount: number }
export interface QuizConfig { language: Language; singleChoiceCount: number; trueFalseCount: number }
export type GenerationConfig = OutlineConfig | ChatConfig | FlashcardConfig | QuizConfig;
export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface GenerationInput {
  clientRequestId: string;
  kind: GenerationKind;
  sources: { materialId: string; version: number }[];
  config: GenerationConfig;
}
export interface SourceSnapshot {
  sourceId: string;
  materialId: string;
  version: number;
  title: string;
  body: string;
  bodySha256: string;
  sourceFileId: string | null;
  pages: { page: number; start: number; end: number }[];
  pageProvenance: 'original_pdf' | 'edited_material' | 'plain_text';
}
export interface GenerationSnapshot {
  schemaVersion: 1;
  promptVersion: 'study-outline-v1' | 'chat-answer-v1' | 'flashcards-v1' | 'quiz-v1';
  sources: SourceSnapshot[];
  config: GenerationInput['config'];
}
/** Persisted routing identity, never credentials. Retry uses the original config. */
export interface GenerationProviderConfig {
  provider: 'openrouter';
  baseUrl: 'https://openrouter.ai/api/v1';
  model: string;
  outputMode: 'compact' | 'strict';
  maxOutputTokens: number;
  timeoutMs: number;
  providerOnly: string[];
}
export interface GenerationPolicy {
  userDailyRequests: number;
  globalDailyRequests: number;
  userDailyTokens: number;
  globalDailyTokens: number;
  userActiveJobs: number;
  globalActiveJobs: number;
  userConcurrency: number;
  globalConcurrency: number;
  maxAttempts: number;
}
export const DEFAULT_GENERATION_POLICY: GenerationPolicy = {
  userDailyRequests: 20, globalDailyRequests: 200,
  userDailyTokens: 100_000, globalDailyTokens: 1_000_000,
  userActiveJobs: 3, globalActiveJobs: 100,
  userConcurrency: 1, globalConcurrency: 2, maxAttempts: 3,
};
export const MAX_SOURCE_BYTES = 32 * 1024;
export const MAX_SOURCES = 5;
export interface GenerationCitation {
  sourceId: string; materialId: string; version: number; quote: string;
  start: number; end: number; page: number | null;
}
export interface OutlineResult {
  schemaVersion: 1;
  title: string;
  points: { text: string; citations: GenerationCitation[] }[];
}
export interface ChatResult { schemaVersion: 1; answer: string; citations: GenerationCitation[]; insufficientEvidence: boolean }
export interface FlashcardResult { schemaVersion: 1; title: string; cards: { front: string; back: string; citations: GenerationCitation[] }[] }
export interface QuizQuestion { type: 'single_choice' | 'true_false'; prompt: string; options: string[]; answerIndex: number; explanation: string; citations: GenerationCitation[] }
export interface QuizResult { schemaVersion: 1; title: string; questions: QuizQuestion[] }
export type GenerationResult = OutlineResult | ChatResult | FlashcardResult | QuizResult;
export interface GenerationUsage {
  state: 'reported' | 'unknown' | 'not_sent';
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costCredits: string | null;
  providerRequestId: string | null;
}
export const UNKNOWN_USAGE: GenerationUsage = { state: 'unknown', inputTokens: null, outputTokens: null, totalTokens: null, costCredits: null, providerRequestId: null };
export const NOT_SENT_USAGE: GenerationUsage = { ...UNKNOWN_USAGE, state: 'not_sent' };
export interface GenerationOutcome {
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  result: GenerationResult | null;
  errorCode: string | null;
  usage: GenerationUsage;
}
export interface ClaimedGeneration {
  jobId: string; attemptId: string; userId: string; studySetId: string;
  attemptNumber: number; leaseToken: string; leaseExpiresAt: string;
  snapshot: GenerationSnapshot; providerConfig: GenerationProviderConfig;
}
export interface GenerationProvider {
  readonly config: GenerationProviderConfig;
  generate(claim: ClaimedGeneration, signal: AbortSignal, onProgress?: (text: string) => Promise<void>): Promise<GenerationOutcome>;
}
export type GenerationErrorCode = 'invalid_input' | 'not_found' | 'version_conflict' | 'idempotency_conflict' | 'quota_exceeded' | 'job_conflict' | 'service_unavailable';
export class GenerationError extends Error {
  constructor(readonly code: GenerationErrorCode, message: string) { super(message); }
}
