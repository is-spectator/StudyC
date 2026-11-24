import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { AuthApiError } from '../../auth/api';
import { createMistakeApi, uuid, type Mistake, type Review, type Origin, type History } from './api';
import '../quizzes/quizzes.css';
function selection() {
    const p = new URLSearchParams(location.search);
    for (const key of ['quizId', 'fromAttempt', 'mistakeReview'])
        if (p.getAll(key).length > 1 || (p.has(key) && !uuid.test(p.get(key)!)))
            throw Error('错题链接无效，请返回全部错题。');
    if (p.has('fromAttempt') && !p.has('quizId'))
        throw Error('原作答链接缺少测验，请返回全部错题。');
    return { quizId: p.get('quizId') ?? undefined, attemptId: p.get('fromAttempt') ?? undefined, reviewId: p.get('mistakeReview') ?? undefined };
}
function selectedReview(id?: string) {
    const u = new URL(location.href);
    if (id)
        u.searchParams.set('mistakeReview', id);
    else
        u.searchParams.delete('mistakeReview');
    history.replaceState(history.state, '', u);
}
export default function MistakesPanel({ studySetId }: {
    studySetId: string;
}) {
    const auth = useAuth();
    return <Workspace key={`${auth.user?.id}:${studySetId}`} studySetId={studySetId}/>;
}
function Workspace({ studySetId }: {
    studySetId: string;
}) {
    const auth = useAuth(), scope = useRef(new AbortController()), alive = useRef(true), lifecycle = useRef(0), pending = useRef(false), retry = useRef<(() => Promise<void>) | null>(null);
    const api = useMemo(() => createMistakeApi(auth.request, studySetId, () => scope.current.signal), [auth.request, studySetId]);
    const [items, setItems] = useState<Mistake[]>([]), [cursor, setCursor] = useState<string | null>(null), [past, setPast] = useState<History[]>([]), [pastCursor, setPastCursor] = useState<string | null>(null), [chosen, setChosen] = useState<Mistake[]>([]), [review, setReview] = useState<Review | null>(null), [index, setIndex] = useState(0), [detail, setDetail] = useState<{
        quizId: string;
        questionIndex: number;
        origins: Origin[];
        nextCursor: string | null;
    } | null>(null);
    const [enabled, setEnabled] = useState(true);
    const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const current = () => alive.current && !scope.current.signal.aborted;
    async function run(operation: () => Promise<void>, retain = false) {
        if (pending.current || auth.status !== 'authenticated')
            return;
        const epoch = lifecycle.current;
        pending.current = true;
        setBusy(true);
        setError('');
        if (retain)
            retry.current = operation;
        try {
            await operation();
            if (current() && epoch === lifecycle.current)
                retry.current = null;
        }
        catch (e) {
            if (current() && epoch === lifecycle.current) {
                setError(e instanceof Error ? e.message : '操作未完成。');
                if (e instanceof AuthApiError && ['version_conflict', 'invalid_input', 'idempotency_conflict', 'not_found'].includes(e.code))
                    retry.current = null;
            }
        }
        finally {
            if (current() && epoch === lifecycle.current) {
                pending.current = false;
                setBusy(false);
            }
        }
    }
    async function load() {
        const q = selection(), [list, history] = await Promise.all([api.list({ quizId: q.quizId, attemptId: q.attemptId }), api.history()]);
        if (current()) {
            setEnabled(list.enabled);
            setItems(list.items);
            setCursor(list.nextCursor);
            setPast(history.items);
            setPastCursor(history.nextCursor);
            setLoaded(true);
        }
    }
    function show(v: Review) {
        setReview(v);
        setIndex(Math.max(0, v.questions.findIndex(q => q.selectedAnswerIndex === null)));
        selectedReview(v.id);
    }
    useEffect(() => {
        alive.current = true;
        if (scope.current.signal.aborted)
            scope.current = new AbortController();
        pending.current = false;
        void run(async () => {
            await load();
            const q = selection();
            if (q.reviewId) {
                const v = await api.get(q.reviewId);
                if (current())
                    show(v);
            }
        });
        return () => {
            alive.current = false;
            lifecycle.current++;
            scope.current.abort();
        };
    }, []);
    function start() {
        if (!chosen.length)
            return;
        const body = { clientRequestId: crypto.randomUUID(), quizId: chosen[0].quizId, questionIndices: chosen.map(x => x.questionIndex) };
        void run(async () => {
            const v = await api.start(body);
            await load();
            if (current()) {
                show(v);
                setNotice('重练单独保存，原成绩保持原样。');
            }
        }, true);
    }
    function answer(choice: number) {
        if (!review)
            return;
        const r = review, position = index, id = crypto.randomUUID();
        void run(async () => {
            const v = await api.answer(r, position, choice, id);
            if (current()) {
                setReview(v);
                setNotice('本题选择已保存');
            }
        }, true);
    }
    function submit() {
        if (!review)
            return;
        const r = review, id = crypto.randomUUID();
        void run(async () => {
            const v = await api.submit(r, id);
            await load();
            if (current()) {
                setReview(v);
                setNotice('重练成绩已保存，原作答成绩未改变。');
            }
        }, true);
    }
    const question = review?.questions[index], answered = review?.questions.filter(q => q.selectedAnswerIndex !== null).length ?? 0;
    return <section className="quiz-panel" aria-label="错题与重练"><header className="quiz-heading"><p className="cloud-eyebrow">LEARN FROM MISTAKES</p><h1>把错过的，再想明白</h1><p>提交后的首次错误与最终错误都会保留。重练单独计分，不改变原成绩。</p></header>
 {error && <div role="alert" className="quiz-error"><p>{error}</p>{retry.current && <button className="btn" disabled={busy} onClick={() => void run(retry.current!, true)}>重试同一次请求</button>}{review && <button className="btn" disabled={busy} onClick={() => void run(async () => {
        const v = await api.get(review.id);
        if (current()) {
            setReview(v);
            retry.current = null;
        }
    })}>重新读取重练进度</button>}<button className="btn" disabled={busy} onClick={() => {
        const u = new URL(location.href);
        u.search = '';
        location.assign(u);
    }}>返回全部错题</button></div>}
 {!enabled && <p role="status">错题重练暂时关闭，已有错题和成绩仍可查看。</p>}
 <p role="status" className="quiz-status">{busy ? '正在保存或读取…' : notice}</p>
 <section className="quiz-library"><div className="quiz-actions"><h2>我的错题</h2><button className="btn" disabled={busy} onClick={() => void run(load)}>刷新错题</button>{location.search.includes('fromAttempt') && <span>仅本次原作答的错题</span>}</div>
 {loaded && !items.length && <p>当前没有已提交的错题。完成并提交一轮练习或考试后，答错的题目会出现在这里。</p>}
 <div className="mistake-list">{items.map(m => <article className="mistake-item" key={`${m.quizId}:${m.questionIndex}`}><label><input type="checkbox" checked={chosen.some(c => c.quizId === m.quizId && c.questionIndex === m.questionIndex)} disabled={busy || (!chosen.some(c => c.quizId === m.quizId && c.questionIndex === m.questionIndex) && chosen.length >= 20)} onChange={e => setChosen(old => e.target.checked ? (old[0]?.quizId === m.quizId ? [...old, m] : [m]) : old.filter(c => c.questionIndex !== m.questionIndex || c.quizId !== m.quizId))}/><strong>{m.prompt}</strong></label><p>{m.quizTitle} · 原第 {m.questionIndex + 1} 题</p><p>当前筛选内 {m.wrongCount} 次原作答出错 · 首次答错 {m.firstWrongCount} 次 · 最终仍错 {m.finalWrongCount} 次</p>{m.latestReview && <p>最近重练：{m.latestReview.correct ? '答对' : '仍需练习'}（不是永久掌握标记）</p>}<button className="btn" disabled={busy} onClick={() => void run(async () => {
        const d = await api.detail(m.quizId, m.questionIndex);
        if (current())
            setDetail({ quizId: m.quizId, questionIndex: m.questionIndex, ...d });
    })}>查看原始错答与来源</button></article>)}</div>
 {cursor && <button className="btn" disabled={busy} onClick={() => void run(async () => {
        const q = selection(), v = await api.list({ quizId: q.quizId, attemptId: q.attemptId, cursor });
        if (current()) {
            setItems(old => [...old, ...v.items]);
            setCursor(v.nextCursor);
        }
    })}>加载更多错题</button>}
 <p>选中同一测验的 1–20 道题；选择另一测验时会重新选择。</p><button className="btn btn-primary" disabled={busy || !enabled || !chosen.length} onClick={start}>开始重练选中 {chosen.length} 题</button>
 </section>
 {detail && <section className="quiz-workspace" aria-label="原始错答记录"><h2>原始错答记录</h2><button className="btn" disabled={busy} onClick={() => setDetail(null)}>收起原始记录</button>{detail.origins.map(o => <article key={o.attemptId}><h3>{o.question.prompt}</h3><p>{o.firstWrong ? '首次答错' : '首次答对'} · {o.finalWrong ? '最终仍错' : '后来改对'} · {new Date(o.submittedAt).toLocaleString()}</p><p>首次选择 {String.fromCharCode(65 + o.firstAnswerIndex)}，最终选择 {String.fromCharCode(65 + o.finalAnswerIndex)}，正确答案 {String.fromCharCode(65 + o.question.answerIndex)}</p><p>{o.question.explanation}</p>{o.question.citations.map((c, i) => <details key={i}><summary>来源 v{c.version}{c.page ? ` · 第${c.page}页` : ''}</summary><blockquote>{c.quote}</blockquote><pre>{o.sourceSnapshots.find(s => s.sourceId === c.sourceId)?.body}</pre></details>)}<a className="btn" href={`/platform/studyset/${studySetId}/practice?quizId=${detail.quizId}&attemptId=${o.attemptId}`}>查看原作答与成绩</a></article>)}{detail.nextCursor && <button className="btn" disabled={busy} onClick={() => void run(async () => {
        const v = await api.detail(detail.quizId, detail.questionIndex, detail.nextCursor!);
        if (current())
            setDetail({ ...detail, origins: [...detail.origins, ...v.origins], nextCursor: v.nextCursor });
    })}>更多原始记录</button>}</section>}
 {review && question && <section className="quiz-workspace" aria-label="错题重练"><h2>{review.title} · 错题重练</h2><p>第 {index + 1} 题 / {review.questions.length} · 已答 {answered}/{review.questions.length} · {review.status === 'submitted' ? '已提交' : '自动保存'}</p>{review.score && <div className="quiz-scores"><div><span>首次作答正确率</span><strong>{review.score.firstCorrectRate}%</strong></div><div><span>最终得分</span><strong>{review.score.finalScore}%</strong></div></div>}<fieldset className="quiz-question" disabled={busy || !enabled || review.status === 'submitted'}><legend>原第 {question.originalQuestionIndex + 1} 题 · {question.prompt}</legend>{question.options.map((o, i) => <label key={i}><input type="radio" name={`mistake-${review.id}-${index}`} checked={question.selectedAnswerIndex === i} onChange={() => answer(i)}/><span>{String.fromCharCode(65 + i)}. {o}</span></label>)}</fieldset>{question.correctAnswerIndex !== undefined && <div className="quiz-feedback"><strong>{question.correct ? '回答正确' : '需要再想一想'} · 正确答案 {String.fromCharCode(65 + question.correctAnswerIndex)}</strong><p>{question.explanation}</p><p>首次选择 {String.fromCharCode(65 + question.firstAnswerIndex!)}，当前选择 {String.fromCharCode(65 + question.selectedAnswerIndex!)}</p>{question.citations?.map((c, i) => <details key={i}><summary>查看原资料 v{c.version}</summary><blockquote>{c.quote}</blockquote><pre>{question.sourceSnapshots?.find(s => s.sourceId === c.sourceId)?.body}</pre></details>)}</div>}<div className="quiz-actions"><button className="btn" disabled={busy || index === 0} onClick={() => setIndex(i => i - 1)}>上一道错题</button><button className="btn" disabled={busy || index === review.questions.length - 1} onClick={() => setIndex(i => i + 1)}>下一道错题</button>{review.status !== 'submitted' && <button className="btn btn-primary" disabled={busy || !enabled || answered !== review.questions.length} onClick={submit}>提交重练 {review.questions.length} 题</button>}<button className="btn" disabled={busy} onClick={() => {
        setReview(null);
        selectedReview();
    }}>返回错题列表</button></div></section>}
 <section className="quiz-history"><h2>重练记录与继续学习</h2>{past.map(h => <button key={h.id} disabled={busy} onClick={() => void run(async () => {
        const v = await api.get(h.id);
        if (current())
            show(v);
    })}><span>{h.title} · {new Date(h.createdAt).toLocaleString()}</span><strong>{h.status === 'submitted' ? `查看重练成绩：${h.score?.finalScore}%` : `继续重练：${h.answeredCount}/${h.questionCount}`}</strong></button>)}{pastCursor && <button className="btn" disabled={busy} onClick={() => void run(async () => {
        const v = await api.history(pastCursor);
        if (current()) {
            setPast(old => [...old, ...v.items]);
            setPastCursor(v.nextCursor);
        }
    })}>更多重练记录</button>}</section>
 </section>;
}
