import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { AuthApiError } from '../../auth/api';
import type { MaterialSummary } from '../api';
import { createQuizApi, type Attempt, type AttemptSummary, type Generation, type GenerationInput, type Quiz } from './api';
import './quizzes.css';

export default function QuizzesPanel(props: { studySetId: string; materials: MaterialSummary[] }) {
  const auth = useAuth();
  return <QuizWorkspace key={`${auth.user?.id ?? 'none'}:${props.studySetId}`} {...props} />;
}
function QuizWorkspace({ studySetId, materials }: { studySetId: string; materials: MaterialSummary[] }) {
  const auth = useAuth();
  const scope = useRef(new AbortController());
  const api = useMemo(() => createQuizApi(auth.request, studySetId, () => scope.current.signal), [auth.request, studySetId]);
  const alive = useRef(true), pending = useRef(false), activeSelection = useRef(0), lifecycle = useRef(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const retry = useRef<(() => Promise<void>) | null>(null);
  const [quizzes, setQuizzes] = useState<Quiz[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Generation[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [single, setSingle] = useState(3), [binary, setBinary] = useState(2), [language, setLanguage] = useState<'zh-CN' | 'en'>('zh-CN');
  const [quiz, setQuiz] = useState<Quiz | null>(null), [history, setHistory] = useState<AttemptSummary[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null), [index, setIndex] = useState(0), [loaded, setLoaded] = useState(false);
  const allowed = auth.status === 'authenticated';
  const canApply = () => alive.current && !scope.current.signal.aborted;
  async function perform(operation: () => Promise<void>, retain = false) {
    if (pending.current || !allowed) return;
    const epoch = lifecycle.current;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    if (retain) retry.current = operation;
    try { await operation(); if (canApply() && epoch === lifecycle.current) retry.current = null; }
    catch (failure) {
      if (canApply() && epoch === lifecycle.current && !(failure instanceof Error && failure.name === 'AbortError')) {
        setError(failure instanceof Error ? failure.message : '请求未完成，请重试。');
        if (failure instanceof AuthApiError && ['version_conflict', 'job_conflict', 'invalid_input', 'idempotency_conflict'].includes(failure.code)) retry.current = null;
      }
    } finally { if (canApply() && epoch === lifecycle.current) { pending.current = false; setBusy(false); } }
  }
  async function load() {
    const epoch = activeSelection.current;
    const [page, generations] = await Promise.all([api.list(), api.generations()]);
    if (canApply() && epoch === activeSelection.current) { setQuizzes(page.items); setCursor(page.nextCursor); setJobs(generations.items.filter(job => job.kind === 'quiz')); setLoaded(true); }
  }
  useEffect(() => {
    alive.current = true;
    if (scope.current.signal.aborted) scope.current = new AbortController();
    pending.current = false;
    void perform(async()=>{await load();const p=new URLSearchParams(location.search),qid=p.get('quizId'),aid=p.get('attemptId');const valid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;if((qid&&!valid.test(qid))||(aid&&!valid.test(aid))||(aid&&!qid))throw new Error('原作答链接无效。');if(qid){await openQuiz(qid);if(aid){const v=await api.resume(qid,aid);if(canApply()){setAttempt(v);setIndex(Math.max(0,v.questions.findIndex(q=>q.selectedAnswerIndex===null)));}}}});
    return () => { alive.current = false; scope.current.abort(); activeSelection.current++; lifecycle.current++; };
    // The keyed account/set component owns this lifetime; auth transport itself fences session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function openQuiz(id: string) {
    const epoch = ++activeSelection.current;
    const [value, past] = await Promise.all([api.get(id), api.history(id)]);
    if (canApply() && epoch === activeSelection.current) { setQuiz(value); setAttempt(null); setHistory(past.items); setHistoryCursor(past.nextCursor); setIndex(0); }
  }
  async function finishGeneration(job: Generation, saveId: string) {
    const started = Date.now();
    while (['queued', 'running'].includes(job.status)) {
      if (!canApply()) return;
      setNotice(job.status === 'queued' ? '测验已加入队列，正在等待生成…' : '正在根据所选资料生成题目…');
      if (Date.now() - started > 120000) throw new Error('生成仍在进行，可从下方生成记录继续读取。');
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { scope.current.signal.removeEventListener('abort', cancel); resolve(); }, 1500);
        scope.current.signal.addEventListener('abort', cancel, { once: true });
      });
      job = await api.generation(job.id);
    }
    if (job.status !== 'succeeded') throw new Error(`本次生成未成功（${job.errorCode ?? job.status}）。资料和历史成绩已保留，可重新发起生成。`);
    const value = await api.materialize(job.id, saveId);
    await load(); await openQuiz(value.id);
    if (canApply()) setNotice('测验已保存，选择练习或考试即可开始。');
  }
  function generate() {
    const sources = materials.filter(material => selected.includes(material.id)).map(({ id, version }) => ({ materialId: id, version }));
    const input: GenerationInput = { clientRequestId: crypto.randomUUID(), kind: 'quiz', sources, config: { language, singleChoiceCount: single, trueFalseCount: binary } };
    const saveId = crypto.randomUUID(); let job: Generation | null = null;
    void perform(async () => { job ??= await api.generate(input); if (canApply()) setJobs(old => [job!, ...old.filter(value => value.id !== job!.id)]); await finishGeneration(job, saveId); }, true);
  }
  function start(mode: 'practice' | 'exam') {
    if (!quiz) return;
    const id = crypto.randomUUID(), target = quiz.id;
    void perform(async () => { const value = await api.start(target, mode, id); const past = await api.history(target); if (canApply()) { setAttempt(value); setHistory(past.items); setHistoryCursor(past.nextCursor); setIndex(0); setNotice('作答会自动保存，可随时从历史记录继续。'); } }, true);
  }
  function answer(choice: number) {
    if (!attempt) return;
    const captured = attempt, questionIndex = index, id = crypto.randomUUID();
    void perform(async () => { const value = await api.answer(captured, questionIndex, choice, id); if (canApply()) { setAttempt(value); setHistory(old => old.map(item => item.id === value.id ? { ...item, answeredCount: value.questions.filter(q => q.selectedAnswerIndex !== null).length } : item)); setNotice('答案已保存'); } }, true);
  }
  function submit() {
    if (!attempt) return;
    const captured = attempt, id = crypto.randomUUID();
    void perform(async () => {
      const value = await api.submit(captured, id); const past = await api.history(captured.quizId);
      if (canApply()) { setAttempt(value); setHistory(past.items); setHistoryCursor(past.nextCursor); setNotice('已提交并保存成绩。'); }
    }, true);
  }
  const question = attempt?.questions[index];
  const answered = attempt?.questions.filter(value => value.selectedAnswerIndex !== null).length ?? 0;
  const totalsValid = Number.isInteger(single) && Number.isInteger(binary) && single >= 0 && single <= 10 && binary >= 0 && binary <= 10 && single + binary >= 1;
  return <section className="quiz-panel" aria-label="资料测验">
    <header className="quiz-heading"><div><p className="cloud-eyebrow">QUIZZES</p><h2>把知识变成自己的答案</h2><p>从资料生成题目，练习时即时解析，考试后统一查看成绩。</p></div></header>
    {!allowed && <p role="status">请先恢复登录状态后继续，已经保存的答案会保留。</p>}
    {error && <div className="quiz-error" role="alert"><p>{error}</p>{retry.current && <button className="btn" disabled={busy || !allowed} onClick={() => void perform(retry.current!, true)}>重试同一次请求</button>}{attempt && <button className="btn" disabled={busy || !allowed} onClick={() => void perform(async () => { const value = await api.resume(attempt.quizId, attempt.id); if (canApply()) { setAttempt(value); retry.current = null; } })}>重新读取已保存答案</button>}</div>}
    <p className="quiz-status" role="status" aria-live="polite">{notice || (busy ? '正在处理…' : '')}</p>
    <fieldset className="quiz-create" disabled={busy || !allowed}>
      <legend>生成新测验</legend><p>选择 1–5 份资料。修改资料后，已保存的测验仍保留原引用版本。</p>
      {!materials.length ? <p>先添加一份资料，再生成测验。</p> : <div className="quiz-sources">{materials.map(material => <label key={material.id}><input type="checkbox" checked={selected.includes(material.id)} disabled={!selected.includes(material.id) && selected.length >= 5} onChange={event => setSelected(old => event.target.checked ? [...old, material.id] : old.filter(id => id !== material.id))} /><span>{material.title}<small>版本 {material.version}</small></span></label>)}</div>}
      <div className="quiz-controls"><label>单选题<input aria-label="单选题数量" type="number" min="0" max="10" value={single} onChange={event => setSingle(Number(event.target.value))} /></label><label>判断题<input aria-label="判断题数量" type="number" min="0" max="10" value={binary} onChange={event => setBinary(Number(event.target.value))} /></label><label>语言<select value={language} onChange={event => setLanguage(event.target.value as 'zh-CN' | 'en')}><option value="zh-CN">中文</option><option value="en">English</option></select></label><button className="btn btn-primary" disabled={!selected.length || !totalsValid} onClick={generate}>生成 {single + binary} 道题</button></div>
    </fieldset>
    <div className="quiz-library"><h3>我的测验</h3>{!loaded && !busy && <button className="btn" disabled={!allowed} onClick={() => void perform(load)}>加载测验</button>}{loaded && !quizzes.length && <p>测验生成并保存后会出现在这里。</p>}
      <div className="quiz-saved-list">{quizzes.map(value => <button key={value.id} disabled={busy || !allowed} aria-pressed={quiz?.id === value.id} onClick={() => void perform(() => openQuiz(value.id))}><strong>{value.title}</strong><small>{value.questionCount} 题 · {new Date(value.createdAt).toLocaleDateString()}</small></button>)}</div>
      {cursor && <button className="btn" disabled={busy || !allowed} onClick={() => void perform(async () => { const page = await api.list(cursor); if (canApply()) { setQuizzes(old => [...old, ...page.items]); setCursor(page.nextCursor); } })}>更多测验</button>}
      {jobs.some(job => ['queued', 'running', 'succeeded'].includes(job.status)) && <details><summary>最近生成记录</summary>{jobs.filter(job => ['queued', 'running', 'succeeded'].includes(job.status)).map(job => <div className="quiz-job" key={job.id}><span>{job.status === 'succeeded' ? '生成完成' : '生成中'} · {job.id.slice(0, 8)}</span><button className="btn" disabled={busy || !allowed} onClick={() => { const saveId = crypto.randomUUID(); void perform(async () => finishGeneration(await api.generation(job.id), saveId), true); }}>继续读取</button></div>)}</details>}
    </div>
    {quiz && <section className="quiz-workspace"><header><h3>{quiz.title}</h3><p>练习会在作答后显示解析。考试会在提交整份试卷后显示答案。</p><div className="quiz-actions"><button className="btn" disabled={busy || !allowed} onClick={() => start('practice')}>开始新练习</button><button className="btn btn-primary" disabled={busy || !allowed} onClick={() => start('exam')}>开始新考试</button><button className="btn" disabled={busy || !allowed} onClick={() => void perform(async () => { const past = await api.history(quiz.id); if (canApply()) { setHistory(past.items); setHistoryCursor(past.nextCursor); } })}>刷新作答记录</button></div></header>
      {attempt && question && <div className="quiz-attempt"><div className="quiz-progress"><span>{attempt.mode === 'exam' ? '考试' : '练习'} · {attempt.status === 'submitted' ? '已提交' : '自动保存'} · 已答 {answered}/{attempt.questions.length}</span><strong>第 {index + 1} 题 / {attempt.questions.length}</strong></div>
        {attempt.score && <a className="btn" href={`/platform/studyset/${studySetId}/mistakes?quizId=${attempt.quizId}&fromAttempt=${attempt.id}`}>查看本次错题</a>}{attempt.score && <div className="quiz-scores"><div><span>首次作答正确率</span><strong>{attempt.score.firstCorrectRate}%</strong><small>{attempt.score.firstCorrect}/{attempt.score.total} 题</small></div><div><span>最终得分</span><strong>{attempt.score.finalScore}%</strong><small>{attempt.score.finalCorrect}/{attempt.score.total} 题</small></div></div>}
        <nav className="quiz-question-nav" aria-label="选择题目">{attempt.questions.map(value => <button key={value.index} disabled={busy} aria-current={index === value.index ? 'step' : undefined} aria-label={`第 ${value.index + 1} 题${value.selectedAnswerIndex !== null ? '，已作答' : '，未作答'}`} onClick={() => setIndex(value.index)}>{value.index + 1}{value.selectedAnswerIndex !== null ? ' ✓' : ''}</button>)}</nav>
        <fieldset className="quiz-question" disabled={busy || !allowed || attempt.status === 'submitted'}><legend>{question.type === 'true_false' ? '判断题' : '单选题'} · {question.prompt}</legend>{question.options.map((option, choice) => <label className={question.correctAnswerIndex === choice ? 'is-correct' : ''} key={choice}><input type="radio" name={`question-${attempt.id}-${index}`} checked={question.selectedAnswerIndex === choice} onChange={() => answer(choice)} /><span>{String.fromCharCode(65 + choice)}. {option}</span></label>)}</fieldset>
        {question.correctAnswerIndex !== undefined && <div className="quiz-feedback"><strong>{question.correct ? '回答正确' : '需要再想一想'} · 正确答案 {String.fromCharCode(65 + question.correctAnswerIndex)}</strong><p>{question.explanation}</p>{attempt.mode === 'practice' && attempt.status !== 'submitted' && <small>可以重新选择答案；首次作答和修改记录都会保留。</small>}{question.history && question.history.length > 1 && <p>本题记录：{question.history.map((value, position) => `${position + 1}. ${String.fromCharCode(65 + value.answerIndex)}（${value.correct ? '正确' : '错误'}）`).join(' → ')}</p>}
          {question.citations?.map((citation, citationIndex) => { const source = attempt.sourceSnapshots?.find(value => value.sourceId === citation.sourceId); const current = materials.find(value => value.id === citation.materialId); return <details key={citationIndex}><summary>查看来源：{source?.title ?? '资料'} · 版本 {citation.version}{citation.page ? ` · 第 ${citation.page} 页` : ''}{current && current.version !== citation.version ? `（当前为版本 ${current.version}）` : ''}</summary><blockquote>{citation.quote}</blockquote>{source && <details><summary>阅读提交时的完整资料</summary><pre>{source.body}</pre></details>}</details>; })}</div>}
        <div className="quiz-actions"><button className="btn" disabled={busy || index === 0} onClick={() => setIndex(value => value - 1)}>上一题</button><button className="btn" disabled={busy || index === attempt.questions.length - 1} onClick={() => setIndex(value => value + 1)}>下一题</button>{attempt.status !== 'submitted' && <button className="btn btn-primary" disabled={busy || !allowed || answered !== attempt.questions.length} onClick={submit}>提交全部 {attempt.questions.length} 题</button>}</div>
        {attempt.status !== 'submitted' && answered < attempt.questions.length && <p className="quiz-help">还有 {attempt.questions.length - answered} 题未作答，全部完成后即可提交。</p>}
      </div>}
      <section className="quiz-history"><h4>作答记录与继续学习</h4>{!history.length && <p>开始作答后可在这里恢复进度。</p>}{history.map(value => <button key={value.id} disabled={busy || !allowed} onClick={() => void perform(async () => { const resumed = await api.resume(quiz.id, value.id); if (canApply()) { setAttempt(resumed); setIndex(resumed.questions.findIndex(question => question.selectedAnswerIndex === null) >= 0 ? resumed.questions.findIndex(question => question.selectedAnswerIndex === null) : 0); } })}><span>{value.mode === 'exam' ? '考试' : '练习'} · {new Date(value.createdAt).toLocaleString()}</span><strong>{value.status === 'submitted' ? `查看成绩：${value.finalCorrect}/${value.questionCount}` : `继续作答：${value.answeredCount}/${value.questionCount}`}</strong></button>)}{historyCursor && <button className="btn" disabled={busy || !allowed} onClick={() => void perform(async () => { const page = await api.history(quiz.id, historyCursor); if (canApply()) { setHistory(old => [...old, ...page.items]); setHistoryCursor(page.nextCursor); } })}>更多记录</button>}</section>
    </section>}
  </section>;
}
