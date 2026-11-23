import type { GenerationStore } from './store.js';
import {
  type ClaimedGeneration, type GenerationOutcome, type GenerationProvider, type GenerationProviderConfig,
  UNKNOWN_USAGE, NOT_SENT_USAGE,
} from './types.js';

export type GenerationWorkerStore = Pick<GenerationStore, 'recoverExpired' | 'claim' | 'shouldCancel' | 'settle'> & Partial<Pick<GenerationStore, 'recordProgress'>>;
export interface GenerationWorkerOptions {
  pollMs?: number;
  cancelPollMs?: number;
  /** Bounded shutdown, including outstanding store operations. Defaults to 9 seconds. */
  shutdownMs?: number;
  /** Receives fixed safe codes only; never raw provider/database errors or material text. */
  onError?: (code: string) => void;
}
type AbortReason = 'cancelled' | 'worker_stopped' | 'provider_timeout' | 'state_check_failed';
type Active = { controller: AbortController; done: Promise<void>; abort(reason: AbortReason): void };

const identity = (config: GenerationProviderConfig) => JSON.stringify([
  config.provider, config.baseUrl, config.model, config.outputMode, config.maxOutputTokens,
  config.timeoutMs, config.providerOnly,
]);

/** Each process is bounded too; the store's lease transaction enforces the global/per-user limits. */
export function startGenerationWorker(store: GenerationWorkerStore, provider: GenerationProvider, options: GenerationWorkerOptions = {}) {
  const pollMs = Math.max(1, options.pollMs ?? 500);
  const cancelPollMs = Math.max(1, options.cancelPollMs ?? 500);
  const shutdownMs = Math.max(10, Math.min(10_000, options.shutdownMs ?? 9000));
  const abortGraceMs = Math.max(1, Math.min(1000, Math.floor(shutdownMs / 2)));
  const active = new Map<string, Active>();
  let stopped = false;
  let pendingTick: Promise<void> | undefined;
  let pendingStop: Promise<void> | undefined;
  const report = (code: string) => { try { options.onError?.(code); } catch { /* A logger must not stop the queue. */ } };

  function execute(claim: ClaimedGeneration): void {
    const controller = new AbortController();
    let reason: AbortReason | undefined;
    let dispatched = false;
    let cancelTimer: ReturnType<typeof setInterval> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    let executionDone = false;
    const abort = (next: AbortReason) => {
      if (executionDone) return;
      if (!reason) reason = next;
      controller.abort();
    };
    const abortedOutcome = (): GenerationOutcome => ({
      status: reason === 'cancelled' ? 'cancelled' : reason === 'provider_timeout' ? 'failed' : 'interrupted',
      result: null, errorCode: reason ?? 'worker_stopped', usage: dispatched ? { ...UNKNOWN_USAGE } : { ...NOT_SENT_USAGE },
    });
    let releaseAbort!: (outcome: GenerationOutcome) => void;
    const aborted = new Promise<GenerationOutcome>(resolve => { releaseAbort = resolve; });
    controller.signal.addEventListener('abort', () => {
      // Give a cooperative provider time to return any usage already received.
      graceTimer = setTimeout(() => releaseAbort(abortedOutcome()), abortGraceMs);
    }, { once: true });
    const done = (async () => {
      let outcome: GenerationOutcome;
      try {
        if (stopped) abort('worker_stopped');
        if (!reason && await store.shouldCancel(claim)) abort('cancelled');
        if (reason) outcome = abortedOutcome();
        else if (identity(provider.config) !== identity(claim.providerConfig)) {
          outcome = { status: 'failed', result: null, errorCode: 'config_changed', usage: { ...NOT_SENT_USAGE } };
        } else {
          cancelTimer = setInterval(() => {
            if (checking || reason) return;
            checking = true;
            void store.shouldCancel(claim).then(cancel => { if (!executionDone && cancel) abort('cancelled'); })
              .catch(() => { if (!executionDone) { report('generation_state_check_failed'); abort('state_check_failed'); } })
              .finally(() => { checking = false; });
          }, cancelPollMs);
          watchdog = setTimeout(() => abort('provider_timeout'), Math.max(1, claim.providerConfig.timeoutMs) + 250);
          dispatched = true;
          const generation = Promise.resolve().then(() => provider.generate(claim, controller.signal, store.recordProgress ? text => store.recordProgress!(claim, text) : undefined)).catch((): GenerationOutcome => {
            report('generation_provider_failed');
            return { status: 'failed', result: null, errorCode: 'provider_unavailable', usage: { ...UNKNOWN_USAGE } };
          });
          // An uncooperative request may finish after the abort grace period.
          // Retain reported billing through the fenced store, never its late result.
          void generation.then(value => {
            if (executionDone && reason && value.usage.state === 'reported') {
              return store.settle(claim, { ...abortedOutcome(), usage: value.usage });
            }
          }).catch(() => { report('generation_late_usage_failed'); });
          outcome = await Promise.race([generation, aborted]);
          if (reason) outcome = { ...abortedOutcome(), usage: outcome.usage };
        }
      } catch {
        report('generation_execution_failed');
        outcome = { status: 'interrupted', result: null, errorCode: 'state_check_failed',
          usage: dispatched ? { ...UNKNOWN_USAGE } : { ...NOT_SENT_USAGE } };
      } finally {
        executionDone = true;
        clearInterval(cancelTimer); clearTimeout(watchdog); clearTimeout(graceTimer);
      }
      try { await store.settle(claim, outcome); }
      catch { report('generation_settle_failed'); /* Lease recovery keeps the unresolved attempt conservative. */ }
    })().finally(() => { active.delete(claim.attemptId); });
    active.set(claim.attemptId, { controller, done, abort });
  }

  function tick(): Promise<void> {
    if (pendingTick) return pendingTick;
    if (stopped) return Promise.resolve();
    pendingTick = Promise.resolve().then(async () => {
      try {
        await store.recoverExpired();
        while (!stopped && active.size < 2) {
          const claim = await store.claim();
          if (!claim) break;
          // A claim may finish while stop() is waiting; execute still settles it as not sent.
          execute(claim);
        }
      } catch { report('generation_poll_failed'); }
    }).finally(() => { pendingTick = undefined; });
    return pendingTick;
  }
  const timer = setInterval(() => { void tick(); }, pollMs);
  timer.unref();
  void tick();

  function stop(): Promise<void> {
    if (pendingStop) return pendingStop;
    stopped = true;
    clearInterval(timer);
    for (const task of active.values()) task.abort('worker_stopped');
    pendingStop = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finished = (async () => {
        await pendingTick;
        for (const task of active.values()) task.abort('worker_stopped');
        await Promise.all([...active.values()].map(task => task.done));
      })();
      try {
        await Promise.race([finished, new Promise<void>(resolve => {
          timeout = setTimeout(() => { report('generation_shutdown_timeout'); resolve(); }, shutdownMs);
        })]);
      } finally { clearTimeout(timeout); }
    })();
    return pendingStop;
  }
  return { tick, stop };
}
