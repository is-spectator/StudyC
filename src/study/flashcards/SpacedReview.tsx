import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { AuthApiError } from '../../auth/api';
import type { Card, Deck, Source } from './api';
const labels = { again: '还没记住', hard: '有些吃力', good: '基本记住', easy: '很熟悉' };
type Rating = keyof typeof labels;
type Session = {
    schemaVersion: 1;
    mode: 'spaced_review';
    id: string;
    deckId: string;
    studySetId: string;
    status: string;
    version: number;
    nextIndex: number;
    cards: Card[];
    sourceSnapshots: Source[];
    reviewedCount: number;
    skippedCount: number;
    current: null | {
        staleReason: string | null;
        ratingIntervalsSeconds: Record<Rating, number>;
    };
};
type Queue = {
    metrics: {
        totalReviews: number;
        ratings: Record<Rating, number>;
    };
    enabled: boolean;
    newCount: number;
    dueCount: number;
    nextDueAt: string | null;
    lastSession: null | {
        id: string;
        nextIndex: number;
        total: number;
    };
};
const duration = (n: number) => n < 86400 ? `${n / 60} 分钟` : `${n / 86400} 天`;
function select(id?: string) { const url = new URL(location.href); url.searchParams.delete('flashcardSession'); if (id)
    url.searchParams.set('spacedReviewSession', id);
else
    url.searchParams.delete('spacedReviewSession'); history.replaceState(history.state, '', url); }
export default function SpacedReview({ deck, onActive }: {
    deck: Deck;
    onActive: (active: boolean) => void;
}) {
    const { request } = useAuth(), root = `/v1/study/sets/${deck.studySetId}/flashcard-decks/${deck.id}`;
    const [queue, setQueue] = useState<Queue | null>(null), [session, setSession] = useState<Session | null>(null), [flipped, flip] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
    const pending = useRef<{
        path: string;
        body: Record<string, unknown>;
    } | null>(null), controller = useRef<AbortController | null>(null), alive = useRef(true);
    function validate(v: Session) { if (!v || v.schemaVersion !== 1 || v.mode !== 'spaced_review' || v.deckId !== deck.id || v.studySetId !== deck.studySetId || !Array.isArray(v.cards) || v.nextIndex < 0 || v.nextIndex > v.cards.length || v.reviewedCount + v.skippedCount !== v.nextIndex)
        throw Error('无法读取复习记录。'); return v; }
    async function read(signal: AbortSignal) { const q = await request<Queue>(root + '/review-queue', { signal }); if (!signal.aborted)
        setQueue(q); return q; }
    useEffect(() => { alive.current = true; controller.current?.abort(); const c = new AbortController(); controller.current = c; void (async () => { try {
        const q = await read(c.signal), url = new URL(location.href), id = url.searchParams.get('spacedReviewSession');
        if (id && url.searchParams.has('flashcardSession'))
            throw Error('复习模式链接冲突，请返回卡组重新进入。');
        if (id && q.enabled) {
            const r = await request<{
                session: Session;
            }>(root + '/review-sessions/' + encodeURIComponent(id), { signal: c.signal });
            if (!c.signal.aborted) {
                setSession(validate(r.session));
                onActive(true);
            }
        }
    }
    catch (e) {
        if (!c.signal.aborted)
            setError(e instanceof Error ? e.message : '读取失败');
    } })(); return () => { alive.current = false; c.abort(); controller.current?.abort(); }; }, [root, request]);
    async function execute(path?: string, body?: Record<string, unknown>) { if (busy)
        return; if (!pending.current && path && body)
        pending.current = { path, body }; if (!pending.current)
        return; setBusy(true); setError(''); controller.current?.abort(); const c = new AbortController(); controller.current = c; try {
        const r = await request<{
            session: Session;
            outcome?: {
                kind: string;
                nextDueAt: string | null;
            };
        }>(pending.current.path, { method: 'POST', body: pending.current.body, signal: c.signal });
        if (!alive.current || c.signal.aborted)
            return;
        setSession(validate(r.session));
        onActive(true);
        select(r.session.id);
        flip(false);
        setNotice(r.outcome?.nextDueAt ? `已保存，下次复习：${new Date(r.outcome.nextDueAt).toLocaleString()}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）` : r.outcome?.kind === 'skipped' ? '已跳过失效卡片。' : '');
        pending.current = null;
    }
    catch (e) {
        if (alive.current && !c.signal.aborted) {
            setError(e instanceof Error ? e.message : '保存失败');
            if (e instanceof AuthApiError && e.status >= 400 && e.status < 500) {
                pending.current = null;
                await read(c.signal).catch(() => {});
            }
        }
    }
    finally {
        if (alive.current && !c.signal.aborted)
            setBusy(false);
    } }
    async function refresh() { controller.current?.abort(); const c = new AbortController(); controller.current = c; try {
        if (session) {
            const r = await request<{
                session: Session;
            }>(root + '/review-sessions/' + session.id, { signal: c.signal });
            if (!c.signal.aborted) {
                setSession(validate(r.session));
                flip(false);
            }
        }
        await read(c.signal);
        setError('');
    }
    catch (e) {
        if (!c.signal.aborted)
            setError(String(e));
    } }
    function act(action: string, rating?: Rating) { if (!session)
        return; void execute(root + '/review-sessions/' + session.id + '/actions', { clientRequestId: crypto.randomUUID(), version: session.version, position: session.nextIndex, cardId: session.cards[session.nextIndex]!.id, action, ...(rating ? { rating } : {}) }); }
    const card = session?.cards[session.nextIndex];
    return <section className="fc-spaced" aria-label="到期复习"><h2>到期复习</h2>{error && <div role="alert"><p>{error}</p>{pending.current ? <button className="btn" disabled={busy} onClick={() => void execute()}>重试同一次保存</button> : <button className="btn" onClick={() => void refresh()}>重新读取复习进度</button>}</div>}{notice && <p role="status">{notice}</p>}
 {!queue ? <p>正在读取复习安排…</p> : !queue.enabled ? <p>到期复习已关闭，已有记录保留。可继续自由翻卡。</p> : !session ? <><p>有效到期复习 {queue.metrics.totalReviews} 次 · {Object.entries(labels).map(([r, l]) => `${l} ${queue.metrics.ratings[r as Rating]}`).join(" · ")}</p><p>新卡 {queue.newCount} 张 · 现在到期 {queue.dueCount} 张</p><p>{queue.nextDueAt ? `下次到期：${new Date(queue.nextDueAt).toLocaleString()}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）` : '每次保存自评后安排下次复习。'}</p><div className="fc-actions">{queue.lastSession && <button className="btn" onClick={async () => { controller.current?.abort(); const c = new AbortController(); controller.current = c; try {
        const r = await request<{
            session: Session;
        }>(root + '/review-sessions/' + queue.lastSession!.id, { signal: c.signal });
        if (!c.signal.aborted) {
            setSession(validate(r.session));
            select(r.session.id);
            onActive(true);
        }
    }
    catch (e) {
        if (!c.signal.aborted)
            setError(String(e));
    } }}>继续复习 {queue.lastSession.nextIndex}/{queue.lastSession.total}</button>}<button className="btn btn-black" disabled={busy || queue.newCount + queue.dueCount === 0} onClick={() => void execute(root + '/review-sessions', { clientRequestId: crypto.randomUUID() })}>开始一轮复习（最多20张）</button></div>{queue.newCount + queue.dueCount === 0 && <p>现在没有待复习卡片。</p>}</> : <><button className="btn" disabled={busy || !!pending.current} onClick={() => { setSession(null); onActive(false); select(); setNotice(''); controller.current?.abort(); const c = new AbortController(); controller.current = c; void read(c.signal).catch(e => { if (!c.signal.aborted)
        setError(String(e)); }); }}>退出并稍后继续</button><p>本轮已保存 {session.nextIndex}/{session.cards.length} · 有效复习 {session.reviewedCount} · 跳过 {session.skippedCount}</p>{session.status === 'completed' ? <h3>这一轮复习完成了</h3> : session.current?.staleReason ? <><p>{session.current.staleReason === 'card_changed' ? '卡片已修改，跳过后请复习新版本。' : '这张卡已在另一轮复习。'}</p><button className="btn" disabled={busy} onClick={() => act('skip_stale')}>跳过失效卡片</button></> : card ? <><button className="fc-flip-card" onClick={() => flip(v => !v)} aria-label={flipped ? '查看复习问题' : '翻开复习答案'}><small>卡片版本 {card.version} · {flipped ? '答案' : '问题'}</small><span>{flipped ? card.back : card.front}</span></button>{flipped ? <><details className="fc-sources"><summary>查看原始出处</summary>{card.citations.length ? card.citations.map((c, i) => <section key={i}><blockquote>{c.quote} · 资料 v{c.version}{c.page !== null ? ` · 第 ${c.page} 页` : ""}</blockquote><details><summary>查看生成时资料快照</summary><pre>{session.sourceSnapshots.find(s => s.sourceId === c.sourceId)?.body ?? c.quote}</pre></details><a href={`/platform/studyset/${deck.studySetId}/material/${c.materialId}`}>打开当前资料</a></section>) : <p>手动卡片 · 没有资料引用</p>}</details><div className="fc-rating">{(Object.keys(labels) as Rating[]).map(r => <button className="btn" key={r} disabled={busy || !!pending.current} onClick={() => act('rate', r)}>{labels[r]} · {duration(session.current!.ratingIntervalsSeconds[r])}</button>)}</div></> : <button className="btn" onClick={() => flip(true)}>翻开复习答案</button>}</> : null}</>}
 <small>按主观自评安排间隔，不代表客观掌握率。自由翻卡不会改变到期安排。修改卡片后按新版本重新学习。</small></section>;
}
