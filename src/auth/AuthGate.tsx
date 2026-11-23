import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, LoaderCircle, LockKeyhole, Mail } from 'lucide-react';
import { setStorageAccount } from '../lib/account-storage';
import { previewAvailable, useAuth } from './AuthProvider';
import { accountGateView } from './session-state';
import './auth.css';

function LoadingAccount() {
  return <div className="study-auth-loading" role="status"><LoaderCircle size={22} /><span>正在验证账户…</span></div>;
}

/** A different key first unmounts the old app. Passive effects then change the
 * storage scope before any component in the new account app can render. */
function AccountBoundary({ accountId, children }: { accountId: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setStorageAccount(accountId);
    setReady(true);
    return () => setStorageAccount(null);
  }, [accountId]);
  return ready ? children : <LoadingAccount />;
}

function Brand() {
  return <div className="study-auth-brand"><img src="/assets/studyc/xiaoc-avatar.svg" alt="" /><span>StudyC</span></div>;
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { accountId, hidden, verifying } = accountGateView(auth, previewAvailable);
  const hiddenTitle = useRef<{ accountId: string; title: string } | null>(null);
  useEffect(() => { if (!accountId) setStorageAccount(null); }, [accountId]);
  useEffect(() => {
    if (!accountId) { hiddenTitle.current = null; document.title = '账户登录 | StudyC'; }
    else if (hidden) {
      if (hiddenTitle.current?.accountId !== accountId) hiddenTitle.current = { accountId, title: document.title };
      document.title = '账户登录 | StudyC';
    } else {
      if (hiddenTitle.current?.accountId === accountId) document.title = hiddenTitle.current.title;
      hiddenTitle.current = null;
    }
  }, [accountId, hidden]);
  if (accountId) return <><AccountBoundary key={accountId} accountId={accountId}><div className="study-account-surface" hidden={hidden} inert={hidden} aria-hidden={hidden}>{auth.isPreview && <div className="study-preview-badge"><span>本地界面预览 · 未登录</span><button onClick={auth.leavePreview}>登录账户 <ArrowRight size={12} /></button></div>}{children}</div></AccountBoundary>{hidden && <main className="study-auth-page study-auth-verification"><Brand />{verifying ? <LoadingAccount /> : <UnavailableAccount />}</main>}</>;
  return <main className="study-auth-page"><Brand />{auth.status === 'checking' ? <LoadingAccount /> : auth.status === 'unavailable' ? <UnavailableAccount /> : <LoginForm />}</main>;
}

function UnavailableAccount() {
  const auth = useAuth();
  return <div className="study-auth-card study-auth-unavailable"><span className="study-auth-mark"><LockKeyhole size={24} /></span><h1>暂时无法验证账户</h1><p role="alert">{auth.message}</p><button className="btn btn-black" onClick={() => void auth.refresh()}>重新验证</button>{previewAvailable && <button className="study-auth-preview-link" onClick={auth.enterPreview}>仅预览本地界面（不登录）</button>}</div>;
}

function LoginForm() {
  const auth = useAuth();
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now);
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const normalizedEmail = email.trim().toLowerCase();
  async function enterLocal(account: 'a' | 'b') {
    if (busy) return;
    setBusy(true); setError(false); setFeedback('');
    try { await auth.authenticate({ email: `learner-${account}@studyc.local`, password: 'local-acceptance' }); }
    catch (reason) { setError(true); setFeedback(reason instanceof Error ? reason.message : '本地账户未能打开。'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);
  function changeMode(next: typeof mode) {
    if (busy) return;
    setMode(next); setPassword(''); setCode(''); setChallengeId(''); setFeedback(''); setError(false);
  }
  async function sendCode() {
    if (busy || cooldown || mode === 'login') return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) { setFeedback('请输入有效的邮箱地址。'); setError(true); return; }
    setBusy(true); setFeedback(''); setError(false);
    try {
      const response = await auth.requestCode(normalizedEmail);
      setChallengeId(response.challengeId); setCode(''); setNow(Date.now()); setCooldownUntil(Date.now() + response.retryAfter * 1000); setFeedback(response.message);
    } catch (reason) { setError(true); setFeedback(reason instanceof Error ? reason.message : '验证码请求未完成，请重试。'); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const length = Array.from(password).length;
    if (length > 128 || length < (mode === 'login' ? 1 : 15)) { setError(true); setFeedback(mode === 'login' ? '密码最多 128 个字符。' : '请设置 15–128 个字符的密码。'); return; }
    if (mode !== 'login' && (!challengeId || !/^\d{8}$/.test(code))) { setError(true); setFeedback('请先获取并填写 8 位邮箱验证码。'); return; }
    setBusy(true); setError(false); setFeedback('');
    try {
      const body: Record<string, string> = mode === 'login' ? { email: normalizedEmail, password } : { email: normalizedEmail, password, code, challengeId };
      if (mode === 'reset') {
        await auth.resetPassword(body);
        setMode('login'); setPassword(''); setCode(''); setChallengeId('');
        setFeedback('密码已重置，请使用新密码登录。');
      } else await auth.authenticate(body);
    } catch (reason) { setError(true); setFeedback(reason instanceof Error ? reason.message : '账户请求未完成，请重试。'); }
    finally { setBusy(false); }
  }
  return <section className="study-auth-card">
    {mode !== 'login' && <button className="study-auth-back" type="button" disabled={busy} onClick={() => changeMode('login')}><ArrowLeft size={16} />返回登录</button>}
    <span className="study-auth-mark">{mode === 'reset' ? <LockKeyhole size={24} /> : <Mail size={24} />}</span>
    <h1>{mode === 'login' ? '欢迎回来' : '重置密码'}</h1>
    <p className="study-auth-intro">{mode === 'reset' ? '验证你的邮箱，设置一个新密码。' : '使用你的 Clyna 账户，继续学习。'}</p>
    <form onSubmit={event => void submit(event)}>
      <label>邮箱<input className="field" type="email" autoComplete="email" required maxLength={254} autoFocus value={email} disabled={busy} placeholder="you@example.com" onChange={event => { setEmail(event.target.value); setChallengeId(''); setCode(''); }} /></label>
      {mode !== 'login' && <label>邮箱验证码<div className="study-auth-code"><input className="field" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} required value={code} disabled={busy} placeholder="8 位验证码" onChange={event => setCode(event.target.value.replace(/\D/g, ''))} /><button className="btn" type="button" disabled={busy || cooldown > 0 || !normalizedEmail} onClick={() => void sendCode()}>{cooldown > 0 ? `${cooldown} 秒后重发` : '发送验证码'}</button></div></label>}
      <label>{mode === 'login' ? '密码' : '设置新密码'}<input className="field" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required maxLength={256} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />{mode !== 'login' && <small>15–128 个字符，可以使用一句好记的话。</small>}</label>
      {(feedback || auth.message) && <p className={`study-auth-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{feedback || auth.message}</p>}
      <button className="btn btn-black study-auth-submit" disabled={busy || mode !== 'login' && !challengeId}>{busy ? <><LoaderCircle size={17} className="study-auth-spinner" />正在处理…</> : mode === 'login' ? '登录' : '重置密码'}{!busy && <ArrowRight size={17} />}</button>
    </form>
    {mode === 'login' && <div className="study-auth-links"><a href="https://clyna.ai/?auth=register&product=studyc" referrerPolicy="no-referrer" aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={event => { if (busy) event.preventDefault(); }}>前往 Clyna 注册</a><button disabled={busy} onClick={() => changeMode('reset')}>忘记密码？</button></div>}
    <p className="study-auth-footnote">学习资料由 StudyC 按账户保存。</p>
    {import.meta.env.DEV && import.meta.env.VITE_LOCAL_ACCEPTANCE === '1' ? <div className="study-local-entry"><p>本地验收 · 使用独立测试数据</p><button className="btn" disabled={busy} onClick={() => void enterLocal('a')}>进入验收账户 A</button><button className="btn" disabled={busy} onClick={() => void enterLocal('b')}>进入验收账户 B</button></div> : null}
    {previewAvailable && <button className="study-auth-preview-link" disabled={busy} onClick={auth.enterPreview}>仅预览本地界面（不登录）</button>}
  </section>;
}
