import { appStorage } from '../lib/account-storage';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, AudioLines, BookOpen, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock, Download, Gamepad2, GraduationCap, Handshake, Highlighter, Layers, LayoutGrid, Link2, List, Mic, MicOff, MoreVertical, MousePointer2, Pause, Pencil, Phone, Play, Plus, Puzzle, RotateCcw, Search, Sparkles, Square, Trophy, Upload, Volume2, WandSparkles, X } from 'lucide-react';
import { getStudyContent } from '../data/study-content';
import type { StudyCard, StudyContent } from '../data/study-content';
import './study-tools.css';

type Props = { page: string; topic: string; onNavigate: (page: string) => void };
const asset = (name: string) => `/assets/studyc/${name}.svg`;
const toolMeta: Record<string, { title: string; icon: string; color: string }> = {
  chat: { title: '聊天', icon: 'chat', color: '#f5d5ff' },
  flashcards: { title: '闪卡', icon: 'flashcards', color: '#bcf887' },
  quiz: { title: '测验', icon: 'practice-quiz', color: '#ffca98' },
  test: { title: '模拟测试', icon: 'tests', color: '#bbeef0' },
  read: { title: '阅读', icon: 'notes', color: '#f9f284' },
  'tutor-me': { title: '小C辅导', icon: 'tutor-me-pdf', color: '#f5d5ff' },
  'audio-recap': { title: '音频复习', icon: 'audio-recap', color: '#bbeef0' },
  'live-lecture': { title: '录制讲座', icon: 'live-lecture', color: '#ffca98' },
  arcade: { title: '互动练习', icon: 'arcade', color: '#bcf887' },
};

function saveResult(key: string, value: unknown) {
  try { appStorage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing may disable persistence. */ }
}
function readLocal<T>(key: string, fallback: T): T { try { const value = appStorage.getItem(key); return value ? (JSON.parse(value) as T) ?? fallback : fallback; } catch { return fallback; } }

function Setup({ kind, content, onStart }: { kind: 'flashcards' | 'quiz' | 'test'; content: StudyContent; onStart: (count: number) => void }) {
  const [count, setCount] = useState(5);
  const meta = toolMeta[kind];
  return <div className="study-tool-setup">
    <div className="study-tool-art" style={{ background: meta.color }}><img src={asset(meta.icon)} alt="" /></div>
    <h1>{kind === 'flashcards' ? '用闪卡巩固所学' : kind === 'test' ? '准备好检验你的掌握程度了吗？' : '每一道题，学会一点新东西'}</h1>
    <p className="study-tool-subtitle">{content.title}</p>
    <div className="study-tool-form">
      <label>学习资料<div className="study-source-row"><BookOpen size={18} /><span>{content.title}</span><Check size={16} /></div></label>
      <label>{kind === 'flashcards' ? '卡片数量' : '题目数量'}<select value={count} onChange={event => setCount(Number(event.target.value))}><option value={3}>3</option><option value={5}>5</option></select></label>
      <label>学习模式<div className="study-source-row"><span>{kind === 'flashcards' ? '术语与定义' : kind === 'test' ? '答题结束后查看解析' : '每题即时反馈'}</span></div></label>
      <p className="study-local-note">使用内置示例资料，可直接开始练习。</p>
      <button className="btn btn-black study-full-button" onClick={() => onStart(count)}>开始{meta.title}<ArrowRight size={18} /></button>
    </div>
  </div>;
}

function Flashcards({ content, onNavigate }: { content: StudyContent; onNavigate: Props['onNavigate'] }) {
  const [view, setView] = useState<'library' | 'setup' | 'review'>('library');
  const [showSpaced, setShowSpaced] = useState(true);
  const [showAnki, setShowAnki] = useState(true);
  const [stats, setStats] = useState(false);
  const [grid, setGrid] = useState(true);
  const [query, setQuery] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const importInput = useRef<HTMLInputElement>(null);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [ratings, setRatings] = useState<Record<number, boolean>>({});
  const [done, setDone] = useState(false);
  const [savedDeck] = useState<{ title: string; cards: StudyCard[] } | null>(() => {
    try { const value = JSON.parse(appStorage.getItem('studyfetch-k12:created-deck') || 'null'); return value && typeof value.title === 'string' && Array.isArray(value.cards) && value.cards.length ? value : null; } catch { return null; }
  });
  const cards = (savedDeck?.cards || content.cards).slice(0, count);
  const deckTitle = savedDeck?.title || content.title;
  function rate(known: boolean) {
    const next = { ...ratings, [index]: known };
    setRatings(next);
    saveResult(`studyfetch-k12:cards:${deckTitle}`, next);
    if (index + 1 >= cards.length) setDone(true);
    else { setIndex(index + 1); setFlipped(false); }
  }
  if (view === 'library') return <div className="study-card-library"><div className="study-library-title"><div className="study-library-icon"><Layers size={22} /></div><h1>闪卡</h1><div><button className="btn btn-soft" onClick={() => { setCount(5); setView('review'); }}>间隔学习</button><button className="btn btn-black" onClick={() => onNavigate('flashcards-create')}><Plus size={20} />创建闪卡集</button></div></div>{showSpaced && <section className="study-spaced-banner"><button className="study-dismiss" aria-label="关闭间隔学习介绍" onClick={() => setShowSpaced(false)}><X size={17} /></button><div><h2>间隔学习中心</h2><p>献给闪卡重度用户：每天复习一点。查看所有卡片集中到期的内容，在一次间隔复习中一起学完。</p><button className="btn btn-black" onClick={() => { setCount(5); setView('review'); }}>打开中心</button></div><div className="study-spaced-preview" aria-hidden="true"><div className="study-mini-card"><i /><i /><div><Layers size={14} /><i /></div></div><span>1 天后</span></div></section>}{showAnki && <section className="study-anki-banner"><button className="study-dismiss" aria-label="关闭 Anki 导入介绍" onClick={() => setShowAnki(false)}><X size={17} /></button><span className="study-anki-icon"><Upload size={24} /></span><div><h2>导入你的 Anki 牌组</h2><p>已经在用 Anki？把 .apkg 牌组带过来，在这里继续学习，自带间隔重复和统计。</p></div><button className="btn btn-black" onClick={() => importInput.current?.click()}>导入 Anki 卡片集</button><input ref={importInput} hidden type="file" accept=".apkg" onChange={event => { const file = event.target.files?.[0]; if (file) setImportMessage(`已选择 ${file.name}。当前版本尚未连接 Anki 解析服务，可以先创建内置示例卡片集。`); }} /></section>}{importMessage && <p role="status" className="study-local-note">{importMessage}</p>}<div className="study-library-toolbar"><button className="study-set-selector" onClick={() => setQuery('')}><img src="/assets/studyc/studyset-cover.png" alt="" />我的学习集<ChevronDown size={16} /></button><button className="study-stats-toggle" aria-pressed={stats} onClick={() => setStats(!stats)}><span className={stats ? 'active' : ''} />显示统计</button><div className="study-view-toggle"><button className={grid ? 'active' : ''} aria-label="网格视图" onClick={() => setGrid(true)}><LayoutGrid size={19} /></button><button className={!grid ? 'active' : ''} aria-label="列表视图" onClick={() => setGrid(false)}><List size={19} /></button></div><label className="study-library-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索…" aria-label="搜索卡片集" /></label></div>{savedDeck && (!query || savedDeck.title.includes(query)) ? <button className={`study-saved-deck ${grid ? '' : 'is-list'}`} onClick={() => { setCount(savedDeck.cards.length); setView('review'); }}><img src={asset('flashcards')} alt="" /><strong>{savedDeck.title}</strong><span>{savedDeck.cards.length} 张卡片{stats ? ' · 已保存到本地' : ''}</span><ArrowRight size={18} /></button> : <div className={`study-library-empty ${grid ? '' : 'is-list'}`}>{query ? <p>没有找到“{query}”相关的卡片集</p> : <><Layers size={28} /><h2>开始创建你的第一套闪卡</h2><p>{stats ? '卡片集 0 · 已复习 0 · 已掌握 0' : '把学习资料变成可以随时复习的卡片。'}</p><button className="btn btn-soft" onClick={() => onNavigate('flashcards-create')}><Plus size={17} />创建闪卡集</button></>}</div>}</div>;
  if (!count) return <><button className="study-back-link" onClick={() => setView('library')}><ArrowLeft size={16} />卡片列表</button><Setup kind="flashcards" content={content} onStart={setCount} /></>;
  if (done) return <div className="study-result"><img src={asset('xiaoc-party-hat')} alt="" /><h1>这组卡片复习完成了</h1><p>已掌握 {Object.values(ratings).filter(Boolean).length} / {cards.length} 张卡片</p><div className="study-result-actions"><button className="btn btn-soft" onClick={() => { setCount(0); setIndex(0); setDone(false); setRatings({}); setFlipped(false); }}>返回卡片设置</button><button className="btn btn-black" onClick={() => { setIndex(0); setDone(false); setFlipped(false); setRatings({}); }}><RotateCcw size={16} />再复习一次</button></div></div>;
  return <div className="study-flashcard-view">
    <div className="study-session-heading"><div><h1>{deckTitle}</h1><p>闪卡 · {index + 1} / {cards.length}</p></div><button className="icon-button" aria-label="返回卡片设置" onClick={() => { setCount(0); setIndex(0); setFlipped(false); setRatings({}); }}><X size={20} /></button></div>
    <div className="study-progress"><span style={{ width: `${(index / cards.length) * 100}%` }} /></div>
    <button className={`study-flashcard ${flipped ? 'is-flipped' : ''}`} onClick={() => setFlipped(!flipped)} aria-label={flipped ? '查看题目' : '翻转查看答案'}>
      <span className="study-card-label">{flipped ? '答案' : '问题'}</span><span className="study-card-copy">{flipped ? cards[index].back : cards[index].front}</span><span className="study-card-hint"><RotateCcw size={15} />点击卡片翻转</span>
    </button>
    <div className="study-flashcard-controls"><button className="icon-button" aria-label="上一张" disabled={index === 0} onClick={() => { setIndex(index - 1); setFlipped(false); }}><ChevronLeft size={22} /></button><span>{index + 1} / {cards.length}</span><button className="icon-button" aria-label="下一张" disabled={index === cards.length - 1} onClick={() => { setIndex(index + 1); setFlipped(false); }}><ChevronRight size={22} /></button></div>
    <p className="study-rating-label">{flipped ? '这张卡片掌握得怎么样？' : '先回忆一下，再翻转卡片查看答案。'}</p>
    <div className="study-rating-buttons"><button disabled={!flipped} onClick={() => rate(false)}>还需练习</button><button disabled={!flipped} onClick={() => rate(true)}><Check size={17} />已经掌握</button></div>
  </div>;
}

function FlashcardCreate({ content, onNavigate }: { content: StudyContent; onNavigate: Props['onNavigate'] }) {
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('');
  const [title, setTitle] = useState(content.title);
  const [text, setText] = useState('');
  const [count, setCount] = useState(5);
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [error, setError] = useState('');
  const [manualCards, setManualCards] = useState<StudyCard[]>([{ front: '', back: '' }]);
  const choices = [
    { id: 'manual', title: '从头创建', description: '逐张添加卡片，创建自己的卡片集', color: '#f9f284', icon: <Pencil size={29} /> },
    { id: 'material', title: '从资料创建', description: '从学习资料生成', color: '#a6d9db', icon: <img src={asset('DOC')} alt="" /> },
    { id: 'topic', title: '从主题创建', description: '根据学习主题创建卡片', color: '#f5d5ff', icon: <WandSparkles size={29} /> },
    { id: 'quizlet', title: '导入 Quizlet', description: '导入已有的 Quizlet 卡片集', color: '#f3f3f3', icon: <img src={asset('Quizlet-v2')} alt="" /> },
    { id: 'anki', title: '导入 Anki', description: '导入 Anki 牌组', color: '#f3f3f3', icon: <img src={asset('Anki-v2')} alt="" /> },
    { id: 'text', title: '从划线内容创建', description: '复习你标记为重点的内容。', color: '#bcf887', icon: <Highlighter size={29} /> },
  ];
  function choose(id: string) { setMode(id); setStep(2); setError(''); }
  function next() {
    if (!title.trim()) { setError('请为卡片集填写一个名称。'); return; }
    if (step === 2) {
      if (mode === 'manual') {
        if (manualCards.some(card => !card.front.trim() || !card.back.trim())) { setError('请填写每张卡片的问题和答案。'); return; }
        setCards(manualCards.map(card => ({ front: card.front.trim(), back: card.back.trim() })));
      } else if (mode === 'text') {
        const parsed = text.split('\n').filter(line => line.trim()).map(line => { const split = line.search(/[:：\t]/); return { front: line.slice(0, split).trim(), back: line.slice(split + 1).trim(), split }; });
        if (!parsed.length || parsed.some(card => card.split < 1 || !card.back)) { setError('请每行填写一张卡片，用冒号分隔问题和答案，例如：分母：平均分成的份数。'); return; }
        setCards(parsed.map(({ front, back }) => ({ front, back })));
      } else if (mode === 'anki' || mode === 'quizlet') { setError('当前版本尚未连接第三方导入服务。可以返回选择“从划线内容创建”，导入你自己的问题和答案。'); return; }
      else setCards(content.cards);
      setError(''); setStep(3);
    } else if (step === 3) { setCards(cards.slice(0, count)); setStep(4); }
    else { saveResult('studyfetch-k12:created-deck', { title: title.trim(), cards, createdAt: new Date().toISOString() }); onNavigate('flashcards'); }
  }
  return <div className="study-create-page"><div className="study-create-work"><p className="study-create-progress">步骤 {step} / 4</p><h1>{step === 1 ? '您想如何创建您的闪卡？' : step === 2 ? '添加您的学习内容' : step === 3 ? '设置您的闪卡' : '您的闪卡已准备好'}</h1>{step === 1 ? <div className="study-create-choices">{choices.map(choice => <button key={choice.id} onClick={() => choose(choice.id)}><span style={{ background: choice.color }}>{choice.icon}</span><strong>{choice.title}</strong><small>{choice.description}</small></button>)}</div> : <div className="study-create-details">{step === 2 && <><label>卡片集名称<input value={title} onChange={event => setTitle(event.target.value)} /></label>{mode === 'manual' ? <><div className="study-manual-cards">{manualCards.map((card, i) => <div key={i}><span>卡片 {i + 1}</span><input aria-label={`卡片 ${i + 1} 问题`} placeholder="问题或术语" value={card.front} onChange={event => setManualCards(manualCards.map((c, n) => n === i ? { ...c, front: event.target.value } : c))} /><textarea aria-label={`卡片 ${i + 1} 答案`} placeholder="答案或定义" value={card.back} onChange={event => setManualCards(manualCards.map((c, n) => n === i ? { ...c, back: event.target.value } : c))} /></div>)}</div><button className="btn btn-soft" onClick={() => setManualCards([...manualCards, { front: '', back: '' }])}><Plus size={17} />添加卡片</button></> : mode === 'text' ? <label>粘贴卡片内容<textarea rows={8} value={text} onChange={event => setText(event.target.value)} placeholder={'每行一张卡片，用冒号分隔问题与答案。\n分母：表示平均分成的份数\n分子：表示取出的份数'} /></label> : mode === 'anki' || mode === 'quizlet' ? <p className="study-create-info">{mode === 'anki' ? 'Anki 牌组需要导入解析服务。' : 'Quizlet 导入需要连接第三方服务。'}当前可以返回并通过“从划线内容创建”粘贴卡片。</p> : <div className="study-create-source"><BookOpen size={20} /><div><strong>{content.title}</strong><p>{content.level} · {content.subject} · 内置示例 · {content.cards.length} 个知识点</p></div><Check size={18} /></div>}{(mode === 'material' || mode === 'topic') && <p className="study-local-note">当前使用内置知识点创建卡片，尚未连接 AI 生成服务。</p>}</>}{step === 3 && <><label>卡片数量<select value={Math.min(count, cards.length)} onChange={event => setCount(Number(event.target.value))}>{Array.from({ length: cards.length }, (_, i) => i + 1).map(value => <option value={value} key={value}>{value} 张</option>)}</select></label><label>卡片类型<div className="study-source-row">术语与定义<Check size={17} /></div></label><p className="study-local-note">卡片会保存在当前浏览器中，支持翻转、自评和重复复习。</p></>}{step === 4 && <><p className="study-create-summary">{title} · {cards.length} 张卡片</p><div className="study-created-preview">{cards.map((card, i) => <div key={i}><strong>{card.front}</strong><p>{card.back}</p></div>)}</div></>}{error && <p className="study-create-error" role="alert">{error}</p>}<div className="study-create-footer"><button className="btn btn-soft" onClick={() => { setStep(step - 1); setError(''); }}><ArrowLeft size={17} />返回</button><button className="btn btn-black" onClick={next}>{step === 4 ? '保存闪卡集' : '继续'}<ArrowRight size={17} /></button></div></div>}</div><div className="study-create-illustration" aria-hidden="true"><div className="study-creation-placeholder"><span /><i /></div><div className="study-creation-cursor"><MousePointer2 size={21} /></div><div className="study-created-card"><img src={asset('flashcards')} alt="" /></div></div></div>;
}

function PracticeLibrary({ test, onNavigate }: { test: boolean; onNavigate: Props['onNavigate'] }) {
  const [tab, setTab] = useState(test ? '考试' : '测验');
  const [menu, setMenu] = useState(false);
  const [grid, setGrid] = useState(true);
  const [query, setQuery] = useState('');
  return <div className="study-card-library study-practice-library"><div className="study-library-title"><div className="study-library-icon practice"><GraduationCap size={25} /></div><h1>练习</h1><div className="study-practice-create-menu"><button className="btn btn-black" onClick={() => setMenu(!menu)}><Plus size={20} />创建<ChevronDown size={18} /></button>{menu && <div className="study-create-dropdown"><button onClick={() => onNavigate('quiz-create')}><img src={asset('practice-quiz')} alt="" />测验</button><button onClick={() => onNavigate('test-create')}><img src={asset('tests')} alt="" />考试</button></div>}</div></div><div className="study-practice-tabs">{['全部', '考试', '测验'].map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div><div className="study-library-toolbar"><button className="study-set-selector" onClick={() => setQuery('')}><img src="/assets/studyc/studyset-cover.png" alt="" />我的学习集<ChevronDown size={16} /></button><div className="study-view-toggle"><button className={grid ? 'active' : ''} aria-label="网格视图" onClick={() => setGrid(true)}><LayoutGrid size={19} /></button><button className={!grid ? 'active' : ''} aria-label="列表视图" onClick={() => setGrid(false)}><List size={19} /></button></div><label className="study-library-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索…" aria-label="搜索练习" /></label></div><div className={`study-practice-empty ${grid ? '' : 'is-list'}`}>{query ? <p>没有找到“{query}”相关的练习</p> : <><img src={asset('xiaoc-tail-wag')} alt="小C" /><h2>{tab === '考试' ? '准备好下一场考试' : '自我测验'}</h2><p>{tab === '考试' ? '把学习资料变成模拟考试，检验你对知识的掌握。' : '把材料变成贴合你正在学的内容的测验。在漏洞找上你之前先找到它们。'}</p><button className="btn btn-black" onClick={() => onNavigate(tab === '考试' ? 'test-create' : 'quiz-create')}><Plus size={16} />创建新的</button></>}</div></div>;
}

function QuizCreate({ content, test, onNavigate }: { content: StudyContent; test: boolean; onNavigate: Props['onNavigate'] }) {
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('');
  const [count, setCount] = useState(5);
  const [title, setTitle] = useState(content.title);
  const [error, setError] = useState('');
  const choices = [{ id: 'material', title: '从资料创建', description: '从学习资料生成', icon: 'DOC', color: '#a6d9db' }, { id: 'cards', title: '从闪卡创建', description: '使用现有闪卡', icon: 'flashcards', color: '#bcf887' }, { id: 'highlights', title: '从划线内容创建', description: '复习你标记为重点的内容。', icon: '', color: '#bcf887' }];
  function next() { if (!title.trim()) { setError('请填写练习名称。'); return; } if (step < 4) setStep(step + 1); else { saveResult('sf-k12:quiz-config', { count, title, test }); onNavigate(test ? 'test-session' : 'quiz-session'); } }
  return <div className="study-create-page study-quiz-create"><div className="study-create-work"><p className="study-create-progress">{step}/4</p><h1>{step === 1 ? `您想如何创建您的${test ? '模拟考试' : '测验'}？` : step === 2 ? '选择您的学习内容' : step === 3 ? '设置练习' : '准备开始练习'}</h1>{step === 1 ? <div className="study-create-choices">{choices.map(choice => <button key={choice.id} onClick={() => { setMode(choice.id); setStep(2); }}><span style={{ background: choice.color }}>{choice.icon ? <img src={asset(choice.icon)} alt="" /> : <Highlighter size={29} />}</span><strong>{choice.title}</strong><small>{choice.description}</small></button>)}</div> : <div className="study-create-details">{step === 2 && <><label>练习名称<input value={title} onChange={event => setTitle(event.target.value)} /></label><div className="study-create-source"><BookOpen size={21} /><div><strong>{content.title}</strong><p>{content.level} · {content.subject} · 内置示例</p></div><Check size={18} /></div><p className="study-local-note">当前使用内置示例题目。{mode === 'cards' ? '自定义卡片出题' : mode === 'highlights' ? '划线内容出题' : '上传资料出题'}需连接 AI 服务。</p></>}{step === 3 && <><label>题目数量<select value={count} onChange={event => setCount(Number(event.target.value))}><option value={3}>3 道</option><option value={5}>5 道</option></select></label><label>题目类型<div className="study-source-row">单项选择<Check size={17} /></div></label><label>反馈方式<div className="study-source-row">{test ? '完成全部题目后查看答案与解析' : '每一道题即时反馈'}</div></label></>}{step === 4 && <><div className="study-create-source"><img src={asset(test ? 'tests' : 'practice-quiz')} width="48" height="48" alt="" /><div><strong>{title}</strong><p>{count} 道题 · {content.subject} · {content.level}</p></div></div><p className="study-local-note">完成后，答题记录将保存在当前浏览器中。</p></>}{error && <p role="alert" className="study-create-error">{error}</p>}<div className="study-create-footer"><button className="btn btn-soft" onClick={() => setStep(step - 1)}><ArrowLeft size={17} />返回</button><button className="btn btn-black" onClick={next}>{step === 4 ? '开始练习' : '继续'}<ArrowRight size={17} /></button></div></div>}</div><div className="study-create-illustration" aria-hidden="true"><div className="study-creation-placeholder"><span /><i /></div><div className="study-creation-cursor"><MousePointer2 size={21} /></div><div className="study-created-card quiz"><img src={asset(test ? 'tests' : 'practice-quiz')} alt="" /></div></div></div>;
}

function Quiz({ content, test = false, initialCount = 0 }: { content: StudyContent; test?: boolean; initialCount?: number }) {
  const [count, setCount] = useState(initialCount);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [answers, setAnswers] = useState<number[]>([]);
  const [done, setDone] = useState(false);
  const [hint, setHint] = useState(false);
  const questions = content.questions.slice(0, count);
  function advance() {
    const next = [...answers, selected!];
    setAnswers(next);
    if (index === questions.length - 1) {
      setDone(true);
      saveResult(`studyfetch-k12:quiz:${content.title}`, { answers: next, correct: next.filter((answer, i) => answer === questions[i].answer).length, total: questions.length, completedAt: new Date().toISOString() });
      saveResult(`studyfetch-k12:mistakes:${content.title}`, questions.filter((question, i) => next[i] !== question.answer));
      const correct = next.filter((answer, i) => answer === questions[i].answer).length;
      const result = { topic: content.title, subject: content.subject, level: content.level, correct, total: questions.length, completedAt: new Date().toISOString() };
      const history = readLocal<typeof result[]>('sf-k12:quiz-stats', []);
      saveResult('sf-k12:quiz-stats', [...history, result]);
      if (correct === questions.length) { const mastered = readLocal<string[]>('sf-k12:mastered-topics', []); saveResult('sf-k12:mastered-topics', [...new Set([...mastered, content.title])]); }
    } else { setIndex(index + 1); setSelected(null); setSubmitted(false); setHint(false); }
  }
  function restart() { setCount(0); setIndex(0); setSelected(null); setSubmitted(false); setAnswers([]); setDone(false); setHint(false); }
  if (!count) return <Setup kind={test ? 'test' : 'quiz'} content={content} onStart={setCount} />;
  if (done) {
    const correct = questions.filter((q, i) => answers[i] === q.answer).length;
    return <div className="study-quiz-results"><div className="study-result"><img src={asset('xiaoc-party-hat')} alt="" /><h1>{correct === questions.length ? '全部答对了！' : '每一次练习，都离掌握更近一点'}</h1><p>答对 {correct} / {questions.length} 题 · 正确率 {Math.round(correct / questions.length * 100)}%</p><button className="btn btn-black" onClick={restart}><RotateCcw size={17} />再练习一次</button></div><div className="study-answer-review"><h2>答案与解析</h2>{questions.map((q, i) => <section key={q.question}><div className="study-review-title"><span className={answers[i] === q.answer ? 'study-status-correct' : 'study-status-wrong'}>{answers[i] === q.answer ? <Check size={17} /> : <X size={17} />}</span><h3>{i + 1}. {q.question}</h3></div><p>你的答案：{q.options[answers[i]]}　{answers[i] !== q.answer && `正确答案：${q.options[q.answer]}`}</p><p>{q.explanation}</p></section>)}</div></div>;
  }
  const question = questions[index];
  return <div className="study-quiz-view"><div className="study-session-heading"><div><h1>{content.title}</h1><p>{test ? '模拟测试' : '测验'} · 第 {index + 1} 题，共 {questions.length} 题</p></div><button className="icon-button" aria-label="结束练习" onClick={restart}><X size={20} /></button></div><div className="study-progress"><span style={{ width: `${index / count * 100}%` }} /></div><p className="study-question-type">单项选择</p><h2 className="study-question">{question.question}</h2><div className="study-options">{question.options.map((option, i) => <button key={option} disabled={submitted} onClick={() => setSelected(i)} className={`${selected === i ? 'is-selected' : ''} ${submitted && i === question.answer ? 'is-correct' : ''} ${submitted && selected === i && i !== question.answer ? 'is-wrong' : ''}`}><span>{String.fromCharCode(65 + i)}</span>{option}{submitted && i === question.answer && <Check size={19} />}</button>)}</div>{!test && !submitted && <button className="study-hint-button" onClick={() => setHint(!hint)}><CircleHelp size={17} />{hint ? '收起提示' : '给我一点提示'}</button>}{hint && !submitted && <p className="study-question-hint">{question.hint}</p>}{submitted && <div className={`study-feedback ${selected === question.answer ? 'is-correct' : ''}`} role="status"><strong>{selected === question.answer ? '回答正确！' : '再看一看解题思路'}</strong><p>{question.explanation}</p></div>}<div className="study-quiz-footer"><button className="btn btn-black" disabled={selected === null} onClick={() => test || submitted ? advance() : setSubmitted(true)}>{test || submitted ? index === questions.length - 1 ? '查看结果' : '下一题' : '检查答案'}<ArrowRight size={18} /></button></div></div>;
}

function Reading({ content, onNavigate }: { content: StudyContent; onNavigate: Props['onNavigate'] }) {
  const [read, setRead] = useState(() => readLocal<boolean>(`studyfetch-k12:read:${content.title}`, false));
  const [playing, setPlaying] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState('');
  const readingText = [content.title, content.introduction, ...content.sections.flatMap(section => [section.title, section.body, ...(section.example !== section.body ? [section.example] : [])])].join('。');
  const minutes = Math.max(1, Math.ceil(readingText.length / 300));
  useEffect(() => () => { window.speechSynthesis?.cancel(); }, []);
  function markRead() { setRead(true); setMenu(false); saveResult(`studyfetch-k12:read:${content.title}`, true); }
  function listen() {
    if (!('speechSynthesis' in window)) { setNotice('此浏览器暂不支持语音朗读，您可以继续阅读文章。'); return; }
    if (playing) { window.speechSynthesis.cancel(); setPlaying(false); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(readingText); utterance.lang = 'zh-CN'; utterance.rate = 0.9;
    utterance.onend = () => setPlaying(false);
    utterance.onerror = event => { setPlaying(false); if (!['interrupted', 'canceled'].includes(event.error)) setNotice('浏览器朗读未能启动，请检查系统语音设置。'); };
    setPlaying(true); setNotice('正在使用浏览器语音朗读。'); window.speechSynthesis.speak(utterance);
  }
  return <article className="study-reading"><div className="study-reading-meta"><BookOpen size={15} strokeWidth={1.3} />阅读</div><h1>{content.title}指南</h1><div className="study-reading-details"><span><Clock size={15} strokeWidth={1.4} />{minutes} 分钟阅读</span><button className="study-reading-listen" onClick={listen}>{playing ? <Pause size={16} /> : <Volume2 size={16} />}{playing ? '停止' : '听'}</button><div className="study-reading-more"><button className="icon-button" aria-label="文章选项" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreVertical size={16} /></button>{menu && <div className="study-reading-menu"><button onClick={markRead}>{read ? '已完成阅读' : '标记为已读'}</button><button onClick={() => onNavigate('flashcards-create')}>制作闪卡</button><button onClick={() => onNavigate('quiz-create')}>开始测验</button></div>}</div></div><div className="study-reading-source"><span>来源</span><span><BookOpen size={13} />{content.title} · 示例资料</span></div><div className="study-reading-divider" />{notice && <p className="study-reading-notice" role="status">{notice}</p>}<div className="study-reading-body"><p className="study-reading-intro">{content.introduction}</p>{content.sections.map((section, i) => <section key={section.title}><h2>{i + 1}. {section.title}</h2><p>{section.body}</p>{section.example !== section.body && <p className="study-reading-example">例如：{section.example}</p>}</section>)}</div><div className="study-reading-actions"><button className="btn btn-soft" onClick={markRead}>{read ? <><Check size={17} />已完成阅读</> : '标记为已读'}</button><button className="btn btn-black" onClick={() => onNavigate('quiz-create')}>用测验巩固一下<ArrowRight size={17} /></button></div></article>;
}

function Chat({ content, onNavigate }: { content: StudyContent; onNavigate: Props['onNavigate'] }) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [notice, setNotice] = useState('');
  const [more, setMore] = useState(false);
  const [guided, setGuided] = useState(false);
  const attachInput = useRef<HTMLInputElement>(null);
  function send(event: React.FormEvent) { event.preventDefault(); if (!input.trim()) return; setMessages([...messages, { role: 'user', text: input.trim() }, { role: 'assistant', text: '当前版本尚未连接 AI 服务，无法生成实时回答。你可以先阅读内置知识讲解，或通过闪卡和测验练习这个主题。' }]); setInput(''); }
  return <div className="study-chat"><div className="study-chat-body">{messages.length === 0 ? <div className="study-chat-welcome"><div className="study-chat-avatar"><img src={asset('xiaoc-avatar')} alt="小C 学习伙伴" /></div><button className="study-character-button" onClick={() => setNotice('当前使用 小C 学习伙伴。更多角色需要连接 AI 角色服务。')}>更换角色</button><h1>有什么可以帮您的吗？</h1><div className="study-chat-suggestions"><button onClick={() => onNavigate('read')}><Brain size={17} />这个学习集是关于什么的？</button><button onClick={() => { setInput('这些主题之间有什么联系？'); }}><Brain size={17} />这些主题之间有什么联系？</button><button onClick={() => onNavigate('study-plan')}><BookOpen size={17} />制定学习计划</button><button onClick={() => onNavigate('quiz')}><BookOpen size={17} />用这个学习集考我</button><button onClick={() => onNavigate('flashcards')}><Pencil size={17} />为这套卡片生成闪卡</button><button onClick={() => onNavigate('read')}><Pencil size={17} />创建学习摘要</button>{more && <><button onClick={() => onNavigate('arcade')}>通过配对游戏复习</button><button onClick={() => onNavigate('audio-recap')}>听一听知识点复习</button></>}</div><button className="study-chat-more" onClick={() => setMore(!more)}>{more ? '收起' : '查看更多'}</button><div className="study-chat-action-row"><button className="btn btn-soft" onClick={() => setNotice('插件服务尚未连接。当前练习使用内置示例资料。')}><Puzzle size={17} />插件</button><button className="btn btn-soft" onClick={() => setNotice('当前学习场景：知识巩固。你可以使用卡片、测验和阅读工具继续学习。')}><Sparkles size={17} />场景</button></div><button className="btn btn-soft study-start-guided" onClick={() => onNavigate('tutor-me')}><Link2 size={17} />开始引导式学习<span><ArrowRight size={16} /></span></button></div> : messages.map((message, i) => <div className={`study-message ${message.role}`} key={i}>{message.role === 'assistant' && <img src={asset('xiaoc-avatar')} alt="" />}<p>{message.text}</p></div>)}</div>{notice && <div className="study-chat-notice" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={15} /></button></div>}<form className="study-chat-composer" onSubmit={send}><div className="study-composer-first-row"><textarea value={input} onChange={event => setInput(event.target.value)} placeholder="向小C提问任何问题…" aria-label="输入问题" rows={1} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(event); } }} /><button type="button" className="study-call-button" onClick={() => setNotice('实时语音通话尚未连接。你可以打开音频复习，用浏览器朗读知识点。')}><Phone size={17} />通话</button><button type="submit" className="study-send-button" aria-label="发送问题" disabled={!input.trim()}><ArrowUp size={20} /></button></div><div className="study-composer-bottom-row"><button type="button" aria-label="添加资料" onClick={() => attachInput.current?.click()}><Plus size={21} /></button><input hidden ref={attachInput} type="file" accept=".pdf,.txt,.docx,.png,.jpg,.jpeg" onChange={event => { const file = event.target.files?.[0]; if (file) setNotice(`已选择 ${file.name}。当前聊天尚未连接文件解析与 AI 服务。`); }} /><button type="button" className={guided ? 'active' : ''} onClick={() => { setGuided(!guided); setNotice(guided ? '已关闭引导模式。' : '引导模式已选中；点击“开始引导式学习”可体验内置逐步练习。'); }}><Link2 size={18} />引导</button><button type="button" aria-label="语音输入" className="study-microphone-button" onClick={() => setNotice('语音输入尚未连接。可以在输入框中输入问题。')}><MicOff size={17} /></button></div></form></div>;
}

function ListToolbar({ query, setQuery, grid, setGrid, noView = false, session = false }: { query: string; setQuery: (value: string) => void; grid: boolean; setGrid: (value: boolean) => void; noView?: boolean; session?: boolean }) {
  return <div className="study-library-toolbar"><button className="study-set-selector" onClick={() => setQuery('')}><img src="/assets/studyc/studyset-cover.png" alt="" />我的学习集<ChevronDown size={16} /></button>{!noView && <div className="study-view-toggle"><button className={grid ? 'active' : ''} aria-label="网格视图" onClick={() => setGrid(true)}><LayoutGrid size={19} /></button><button className={!grid ? 'active' : ''} aria-label="列表视图" onClick={() => setGrid(false)}><List size={19} /></button></div>}<label className="study-library-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={session ? '搜索会话…' : '搜索…'} aria-label={session ? '搜索会话' : '搜索'} /></label></div>;
}

function Tutor({ content, onNavigate }: { content: StudyContent; onNavigate: Props['onNavigate'] }) {
  const [started, setStarted] = useState(false);
  const [query, setQuery] = useState('');
  const [grid, setGrid] = useState(true);
  const [notice, setNotice] = useState('');
  const [step, setStep] = useState(0);
  const [revealed, setRevealed] = useState(false);
  if (!started) return <div className="study-session-library study-tutor-library"><div className="study-library-title"><img className="study-tutor-library-avatar" src={asset('xiaoc-avatar')} alt="" /><div className="study-session-title"><h1>小C辅导</h1><p>结合您的学习资料，进行一对一个性化辅导</p></div><button className="btn btn-black" onClick={() => setStarted(true)}><Plus size={19} />新会话</button></div><div className="study-tutor-upgrade">小C辅导是高级功能，升级后即可使用。<button onClick={() => setNotice('当前本地版本未连接订阅或实时 AI 辅导服务。点击“新会话”可以体验内置引导示例。')}>升级</button></div>{notice && <p className="study-local-note" role="status">{notice}</p>}<ListToolbar query={query} setQuery={setQuery} grid={grid} setGrid={setGrid} /><div className={`study-session-empty ${grid ? '' : 'is-list'}`}>{query ? <p>没有找到“{query}”相关的会话</p> : <><img src={asset('xiaoc-tail-wag')} alt="小C" /><h2>还没有会话</h2><p>用学习资料开始与小C的一对一辅导会话。</p><button className="btn btn-black" onClick={() => setStarted(true)}><Plus size={16} />新会话</button></>}</div></div>;
  return <div className="study-tutor"><div className="study-tool-art" style={{ background: '#f5d5ff' }}><img src={asset('tutor-me-pdf')} alt="" /></div><h1>我们一步一步来</h1><p className="study-tool-subtitle">{content.title} · 内置引导练习</p><div className="study-tutor-conversation"><img src={asset('xiaoc-avatar')} alt="" /><div><p>{content.questions[step].question}</p><p className="study-tutor-hint">{content.questions[step].hint}</p>{revealed && <p className="study-tutor-explanation">{content.questions[step].explanation}</p>}</div></div><div className="study-tutor-actions"><button className="btn btn-soft" onClick={() => setRevealed(!revealed)}>{revealed ? '收起解析' : '看看完整思路'}</button><button className="btn btn-black" onClick={() => { if (step < content.questions.length - 1) { setStep(step + 1); setRevealed(false); } else onNavigate('quiz'); }}>{step < content.questions.length - 1 ? '下一道引导练习' : '开始独立测验'}<ArrowRight size={17} /></button></div><p className="study-local-note">这是预设的学习引导示例。实时语音辅导需连接 AI 服务。</p></div>;
}

function AudioLibrary({ onNavigate }: { onNavigate: Props['onNavigate'] }) {
  const [query, setQuery] = useState('');
  const saved = readLocal<{ title: string } | null>('sf-k12:audio-config', null);
  return <div className="study-session-library study-audio-library"><div className="study-library-title"><div className="study-library-icon audio"><AudioLines size={25} strokeWidth={1.5} /></div><h1>音频复习</h1><button className="btn btn-black" onClick={() => onNavigate('audio-create')}><Plus size={19} />生成音频复习</button></div><ListToolbar query={query} setQuery={setQuery} grid={true} setGrid={() => {}} noView />{saved && (!query || saved.title.includes(query)) ? <button className="study-audio-saved" onClick={() => onNavigate('audio-session')}><img src={asset('audio-recap')} alt="" /><span><strong>{saved.title}</strong><small>浏览器语音朗读 · 本地示例</small></span><Play size={22} /></button> : <div className="study-session-empty">{query ? <p>没有找到“{query}”相关的音频</p> : <><img src={asset('xiaoc-tail-wag')} alt="小C" /><h2>回听你学过的内容</h2><p>把材料变成可在公交、路上，或任何眼睛需要休息时收听的复盘。</p><button className="btn btn-black" onClick={() => onNavigate('audio-create')}><Plus size={16} />生成音频复习</button></>}</div>}</div>;
}

function AudioCreate({ content, onNavigate }: { content: StudyContent; onNavigate: Props['onNavigate'] }) {
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('');
  const [title, setTitle] = useState(content.title);
  const [rate, setRate] = useState('0.9');
  const [error, setError] = useState('');
  const choices = [{ id: 'material', title: '从资料创建', color: '#a6d9db', icon: <img src={asset('DOC')} alt="" /> }, { id: 'topic', title: '从主题创建', color: '#f5d5ff', icon: <WandSparkles size={29} /> }, { id: 'highlights', title: '从划线内容创建', color: '#bcf887', icon: <Highlighter size={29} /> }];
  function next() { if (!title.trim()) { setError('请填写音频名称。'); return; } if (step === 2) setStep(3); else { saveResult('sf-k12:audio-config', { title: title.trim(), topic: content.title, subject: content.subject, level: content.level, rate: Number(rate), createdAt: new Date().toISOString() }); onNavigate('audio-session'); } }
  return <div className="study-create-page study-audio-create"><div className="study-create-work"><p className="study-create-progress">步骤 {step} / 3</p><h1>{step === 1 ? '您想如何创建您的音频复习？' : step === 2 ? '选择您的音频内容' : '准备您的音频复习'}</h1>{step === 1 ? <div className="study-create-choices">{choices.map(choice => <button key={choice.id} onClick={() => { setMode(choice.id); setStep(2); }}><span style={{ background: choice.color }}>{choice.icon}</span><strong>{choice.title}</strong>{choice.id === 'highlights' && <small>复习你标记为重点的内容。</small>}</button>)}</div> : <div className="study-create-details">{step === 2 ? <><label>音频名称<input value={title} onChange={event => setTitle(event.target.value)} /></label><div className="study-create-source"><BookOpen size={22} /><div><strong>{content.title}</strong><p>{content.level} · {content.subject} · 内置示例</p></div><Check size={18} /></div><p className="study-local-note">{mode === 'highlights' ? '当前尚未连接划线内容提取服务。' : '当前尚未连接 AI 音频生成服务。'}此体验将使用浏览器语音朗读上述示例资料。</p></> : <><label>朗读速度<select value={rate} onChange={event => setRate(event.target.value)}><option value="0.7">慢速</option><option value="0.9">标准</option><option value="1.1">稍快</option></select></label><div className="study-created-preview">{content.sections.map(section => <div key={section.title}><strong>{section.title}</strong><p>{section.body}</p></div>)}</div><p className="study-local-note">点击下方按钮后打开播放器，再点击“开始朗读”播放。语音由当前浏览器提供。</p></>}{error && <p className="study-create-error" role="alert">{error}</p>}<div className="study-create-footer"><button className="btn btn-soft" onClick={() => { setStep(step - 1); setError(''); }}><ArrowLeft size={17} />返回</button><button className="btn btn-black" onClick={next}>{step === 3 ? '创建音频复习' : '继续'}<ArrowRight size={17} /></button></div></div>}</div><div className="study-create-illustration" aria-hidden="true"><div className="study-creation-placeholder"><span /><i /></div><div className="study-creation-cursor"><MousePointer2 size={21} /></div><div className="study-created-card audio"><img src={asset('audio-recap')} alt="" /></div></div></div>;
}

function AudioRecap({ content }: { content: StudyContent }) {
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState('');
  const [active, setActive] = useState(-1);
  useEffect(() => () => { window.speechSynthesis?.cancel(); }, []);
  function toggle() {
    if (!('speechSynthesis' in window)) { setStatus('这个浏览器暂不支持语音朗读，可以阅读下方文字稿。'); return; }
    if (playing) { window.speechSynthesis.cancel(); setPlaying(false); return; }
    window.speechSynthesis.cancel(); setPlaying(true); setStatus('');
    content.sections.forEach((section, i) => {
      const utterance = new SpeechSynthesisUtterance(`${section.title}。${section.body}。例如，${section.example}`);
      utterance.lang = 'zh-CN'; utterance.rate = readLocal<{rate: number}>('sf-k12:audio-config', {rate: 0.9}).rate;
      utterance.onstart = () => setActive(i);
      utterance.onend = () => { if (i === content.sections.length - 1) { setPlaying(false); setActive(-1); } };
      utterance.onerror = event => { if (event.error !== 'interrupted' && event.error !== 'canceled') setStatus('朗读未能启动，请检查浏览器的语音支持。'); setPlaying(false); };
      window.speechSynthesis.speak(utterance);
    });
  }
  return <div className="study-audio"><div className="study-tool-art" style={{ background: '#bbeef0' }}><img src={asset('audio-recap')} alt="" /></div><h1>{readLocal<{title: string}>('sf-k12:audio-config', {title: '听一听，复习一遍'}).title}</h1><p className="study-tool-subtitle">{content.title}</p><div className="study-audio-player"><div><Volume2 size={22} /><span>知识点语音复习<small>使用浏览器中文语音朗读</small></span></div><button className="btn btn-black" onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}{playing ? '停止朗读' : '开始朗读'}</button></div>{status && <p role="status" className="study-local-note">{status}</p>}<div className="study-transcript"><h2>文字稿</h2>{content.sections.map((section, i) => <section key={section.title} className={active === i ? 'is-active' : ''}><h3>{section.title}</h3><p>{section.body}</p></section>)}</div></div>;
}

function Lecture() {
  const [view, setView] = useState<'library' | 'recorder'>('library');
  const [consent, setConsent] = useState(false);
  const [query, setQuery] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const audioUrlRef = useRef('');
  const [seconds, setSeconds] = useState(0);
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState(() => readLocal<string>('studyfetch-k12:lecture-notes', ''));
  useEffect(() => { if (!recording) return; const id = window.setInterval(() => setSeconds(value => value + 1), 1000); return () => window.clearInterval(id); }, [recording]);
  useEffect(() => () => { if (recorder.current?.state === 'recording') recorder.current.stop(); streamRef.current?.getTracks().forEach(track => track.stop()); if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); }, []);
  async function start() {
    setConsent(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setStatus('这个浏览器暂不支持录音。请在支持麦克风录音的浏览器中打开。'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream); recorder.current = mediaRecorder; chunks.current = [];
      mediaRecorder.ondataavailable = event => { if (event.data.size) chunks.current.push(event.data); };
      mediaRecorder.onstop = () => { const blob = new Blob(chunks.current, { type: mediaRecorder.mimeType }); if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); const url = URL.createObjectURL(blob); audioUrlRef.current = url; setAudioUrl(url); stream.getTracks().forEach(track => track.stop()); };
      mediaRecorder.start(); setSeconds(0); setRecording(true); setStatus(''); setView('recorder');
    } catch { streamRef.current?.getTracks().forEach(track => track.stop()); setStatus('没有获得麦克风权限。请允许访问麦克风后重试。'); }
  }
  function stop() { recorder.current?.stop(); setRecording(false); }
  if (view === 'library') return <div className="study-session-library study-lecture-library"><div className="study-library-title"><div className="study-library-icon lecture"><Mic size={25} strokeWidth={1.5} /></div><h1>历史会话</h1><button className="btn btn-black" onClick={() => setConsent(true)}><Plus size={17} />创建实时讲座</button></div><ListToolbar query={query} setQuery={setQuery} grid={true} setGrid={() => {}} noView session />{status && <p className="study-local-note" role="status">{status}</p>}<div className="study-session-empty">{query ? <p>没有找到“{query}”相关的会话</p> : <><img src={asset('xiaoc-tail-wag')} alt="小C" /><h2>暂无录音会话</h2><p>打开学习资料，开始录制你的学习内容</p><button className="btn btn-black" onClick={() => setConsent(true)}><Plus size={16} />创建新的</button></>}</div>{consent && <div className="study-consent-overlay" role="presentation" onClick={event => { if (event.target === event.currentTarget) setConsent(false); }}><section className="study-recording-consent" role="dialog" aria-modal="true" aria-labelledby="recording-consent-title"><div><Handshake size={31} strokeWidth={1.5} /></div><h2 id="recording-consent-title">录制同意书</h2><p>确保所有参与者均同意被录音录像</p><footer><button className="btn" autoFocus onClick={() => setConsent(false)}>不</button><button className="btn btn-black" onClick={start}>是的，现在开始录制</button></footer></section></div>}</div>;
  return <div className="study-lecture"><div className="study-tool-art" style={{ background: '#ffca98' }}><img src={asset('live-lecture')} alt="" /></div><h1>记录学习过程中的每一个重点</h1><p className="study-tool-subtitle">录音保留在当前页面，可以回放或下载；刷新页面后将清除。</p><div className="study-recording-panel"><span className={recording ? 'study-recording-light active' : 'study-recording-light'} /><strong>{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</strong><button className="btn btn-black" onClick={recording ? stop : start}>{recording ? <Square size={16} /> : <Mic size={18} />}{recording ? '结束录音' : '开始录音'}</button></div>{status && <p role="status" className="study-local-note">{status}</p>}{audioUrl && <div className="study-recording-result"><audio controls src={audioUrl} /><a className="btn btn-soft" href={audioUrl} download="学习录音.webm"><Download size={17} />下载录音</a></div>}<label className="study-notes-label">学习笔记<textarea value={notes} onChange={event => { setNotes(event.target.value); saveResult('studyfetch-k12:lecture-notes', event.target.value); }} placeholder="记下今天听到的重点…" rows={7} /></label><p className="study-local-note">当前支持本地录音和手动笔记，尚未连接 AI 转写。</p></div>;
}

function ArcadeLibrary({ content, onNavigate }: { content: StudyContent; onNavigate: Props['onNavigate'] }) {
  const [tab, setTab] = useState('探索');
  const [sort, setSort] = useState('相似');
  const [query, setQuery] = useState('');
  const saved = readLocal<{ title: string; topic: string; subject: string; level: string } | null>('sf-k12:arcade-config', null);
  const games = [
    { title: `${content.subject}知识配对`, topic: content.title, subject: content.subject, level: content.level, color: '#c5ecdf', symbol: 'A ↔ B' },
    { title: '数学公式配对', topic: '多项式', subject: '数学', level: '高中', color: '#f5d5ff', symbol: 'x² − 9' },
    { title: '英语词汇配对', topic: '英语', subject: '英语', level: content.level, color: '#bbeef0', symbol: 'Hello!' },
    { title: '语文知识配对', topic: '语文', subject: '语文', level: content.level, color: '#ffca98', symbol: '诗 · 文' },
    { title: '生物知识配对', topic: '生物', subject: '生物', level: '初高中', color: '#bcf887', symbol: 'DNA' },
    { title: '物理知识配对', topic: '物理', subject: '物理', level: '初高中', color: '#bbeef0', symbol: 'v = s/t' },
    { title: '历史时间配对', topic: '历史', subject: '历史', level: '初高中', color: '#f9f284', symbol: '221 BC' },
    { title: '化学知识配对', topic: '化学', subject: '化学', level: '初高中', color: '#f5d5ff', symbol: 'H₂O' },
  ];
  let shown = (tab === '我的练习' ? saved ? [{...saved, color: '#bcf887', symbol: 'A ↔ B'}] : [] : games).filter(game => !query || `${game.title}${game.topic}`.toLowerCase().includes(query.toLowerCase()));
  const plays = readLocal<Record<string, number>>('sf-k12:arcade-plays', {});
  if (sort === '最新') shown = [...shown].reverse();
  else if (sort === '热门') shown = [...shown].sort((a, b) => (plays[b.title] || 0) - (plays[a.title] || 0));
  function play(game: typeof games[number]) { saveResult('sf-k12:arcade-config', { title: game.title, topic: game.topic, subject: game.subject, level: game.level }); saveResult('sf-k12:arcade-plays', {...plays, [game.title]: (plays[game.title] || 0) + 1}); onNavigate('arcade-session'); }
  return <div className="study-arcade-library"><div className="study-arcade-heading"><div className="study-library-icon arcade"><Gamepad2 size={26} strokeWidth={1.5} /></div><div><h1>将您的资料转换成<span>互动练习</span></h1><p>将您的学习资料转化为有趣的互动练习</p></div><button className="btn btn-black" onClick={() => onNavigate('arcade-create')}><Plus size={18} />创建互动练习</button></div><div className="study-arcade-toolbar"><div className="study-arcade-tabs">{['探索', '我的练习'].map(item => <button key={item} onClick={() => setTab(item)} className={tab === item ? 'active' : ''}>{item}</button>)}</div><div className="study-arcade-sort">{[{ label: '相似', icon: Sparkles }, { label: '最新', icon: Clock }, { label: '热门', icon: Trophy }].map(item => <button key={item.label} className={sort === item.label ? 'active' : ''} onClick={() => setSort(item.label)}><item.icon size={18} strokeWidth={1.5} />{item.label}</button>)}</div><label className="study-library-search"><Search size={18} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索" aria-label="搜索互动练习" /></label></div><div className="study-arcade-gallery">{shown.map((game, i) => <button className="study-arcade-tile" key={`${game.title}:${i}`} onClick={() => play(game)}><div className={`study-game-thumbnail thumb-${i % 4}`} style={{ background: game.color }}><span>{game.symbol}</span><i>知识配对</i><img src={asset('xiaoc-running')} alt="" /></div><strong>{game.title}</strong><small><Gamepad2 size={13} />知识配对 · 本地示例{plays[game.title] ? ` · ${plays[game.title]}次练习` : ''}</small></button>)}</div>{!shown.length && <div className="study-library-empty"><Gamepad2 size={28} /><h2>{query ? '没有找到相关互动练习' : '还没有创建互动练习'}</h2><button className="btn btn-black" onClick={() => onNavigate('arcade-create')}><Plus size={17} />创建互动练习</button></div>}<p className="study-local-note">以上为可体验的本地知识配对示例。社区游戏与 PDF 自动生成服务尚未接入。</p></div>;
}

function ArcadeCreate({ content, onNavigate }: { content: StudyContent; onNavigate: Props['onNavigate'] }) {
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState(`${content.subject}知识配对`);
  const [error, setError] = useState('');
  const choices = [{ title: '从资料创建', color: '#a6d9db', icon: <img src={asset('DOC')} alt="" /> }, { title: '从主题创建', color: '#f5d5ff', icon: <WandSparkles size={29} /> }, { title: '从闪卡创建', color: '#bcf887', icon: <img src={asset('flashcards')} alt="" /> }];
  function next() { if (!title.trim()) { setError('请填写练习名称。'); return; } if (step < 4) setStep(step + 1); else { saveResult('sf-k12:arcade-config', { title: title.trim(), topic: content.title, subject: content.subject, level: content.level }); onNavigate('arcade-session'); } }
  return <div className="study-create-page study-arcade-create"><div className="study-create-work"><p className="study-create-progress">步骤 {step} / 4</p><h1>{step === 1 ? '您想如何创建您的互动练习？' : step === 2 ? '选择您的学习内容' : step === 3 ? '选择练习模式' : '您的互动练习已准备好'}</h1>{step === 1 ? <div className="study-create-choices">{choices.map(choice => <button key={choice.title} onClick={() => setStep(2)}><span style={{ background: choice.color }}>{choice.icon}</span><strong>{choice.title}</strong></button>)}</div> : <div className="study-create-details">{step === 2 && <><label>练习名称<input value={title} onChange={event => setTitle(event.target.value)} /></label><div className="study-create-source"><BookOpen size={22} /><div><strong>{content.title}</strong><p>{content.level} · {content.subject} · 内置示例</p></div><Check size={18} /></div><p className="study-local-note">当前使用内置知识卡片创建互动练习，上传资料或自定义主题的自动生成需连接 AI 服务。</p></>}{step === 3 && <><div className="study-create-source"><Gamepad2 size={30} /><div><strong>知识配对</strong><p>找出每一道问题对应的答案，完成 4 组配对。</p></div><Check size={18} /></div><p className="study-local-note">此版本支持本地配对游戏，跑酷、竞速等 3D 游戏引擎尚未接入。</p></>}{step === 4 && <><div className="study-create-source"><Gamepad2 size={30} /><div><strong>{title}</strong><p>{content.title} · 4 组知识配对</p></div></div><p className="study-local-note">创建记录将保存到当前浏览器的“我的练习”。</p></>}{error && <p className="study-create-error" role="alert">{error}</p>}<div className="study-create-footer"><button className="btn btn-soft" onClick={() => { setStep(step - 1); setError(''); }}><ArrowLeft size={17} />返回</button><button className="btn btn-black" onClick={next}>{step === 4 ? '开始练习' : '继续'}<ArrowRight size={17} /></button></div></div>}</div><div className="study-create-illustration study-arcade-create-art" aria-label="互动练习预览"><div className="study-arcade-preview-stack">{[1,2,3].map(i => <img key={i} src={`/assets/studyc/game-create-${i}.png`} alt="" />)}</div></div></div>;
}

function Arcade({ content }: { content: StudyContent }) {
  const pairs = content.cards.slice(0, 4);
  const [selected, setSelected] = useState<number | null>(null);
  const [matched, setMatched] = useState<number[]>([]);
  const [feedback, setFeedback] = useState('');
  const order = [2, 0, 3, 1];
  function chooseAnswer(index: number) { if (selected === null) { setFeedback('先选择左边的一张问题卡片。'); return; } if (selected === index) { const next = [...matched, index]; setMatched(next); setFeedback(next.length === pairs.length ? '全部配对成功！' : '配对正确，继续！'); setSelected(null); } else setFeedback('还差一点，读一读定义再试试。'); }
  return <div className="study-arcade"><div className="study-session-heading"><div><h1>知识配对</h1><p>{content.title} · 已完成 {matched.length} / {pairs.length} 组</p></div><button className="btn btn-soft" onClick={() => { setMatched([]); setSelected(null); setFeedback(''); }}><RotateCcw size={16} />重新开始</button></div><p className="study-game-instructions">选一个问题，再找到它对应的答案。</p><div className="study-match-grid"><div>{pairs.map((pair, i) => <button className={`${selected === i ? 'is-selected' : ''} ${matched.includes(i) ? 'is-matched' : ''}`} disabled={matched.includes(i)} key={pair.front} onClick={() => { setSelected(i); setFeedback(''); }}>{matched.includes(i) && <Check size={17} />}{pair.front}</button>)}</div><div>{order.map(i => <button className={matched.includes(i) ? 'is-matched' : ''} disabled={matched.includes(i)} key={pairs[i].back} onClick={() => chooseAnswer(i)}>{matched.includes(i) && <Check size={17} />}{pairs[i].back}</button>)}</div></div><p className="study-game-feedback" role="status">{feedback || '每配对成功一组，都会变成绿色。'}</p></div>;
}

export function StudyTools({ page, topic, onNavigate }: Props) {
  const context = readLocal<{ grade?: string; subject?: string; topic?: string }>('sf-k12:practice-context', {});
  const activeUnit = readLocal<string>('sf-k12:active-unit', '') || readLocal<string>('sf-k12:activeTopic', '');
  const audioConfig = readLocal<{title?: string; topic?: string; level?: string; subject?: string}>('sf-k12:audio-config', {});
  const selectedTopic = (page === 'audio-session' ? audioConfig.topic : '') || activeUnit || context.topic || topic;
  const stage = (context.topic === activeUnit ? context.grade : '') || readLocal<string>('sf-k12:stage', '') || readLocal<string>('studyfetch:k12:stage', '初中');
  const subjectFromSet = /物理/.test(topic) ? '物理' : /化学/.test(topic) ? '化学' : /科学/.test(topic) ? '科学' : /生物/.test(topic) ? '生物' : /历史/.test(topic) ? '历史' : /语文|阅读|写作|古诗/.test(topic) ? '语文' : /英语|English/i.test(topic) ? '英语' : undefined;
  const content = getStudyContent(selectedTopic, { stage: (page === 'audio-session' ? audioConfig.level : '') || stage, subject: (page === 'audio-session' ? audioConfig.subject : undefined) || (context.topic === activeUnit ? context.subject : undefined) || subjectFromSet });
  const meta = toolMeta[page] || toolMeta.read;
  return <div className={`study-tools-page tool-${page}`} aria-label={meta.title}><div className="study-tools-content" key={`${page}:${content.title}`}>{page === 'flashcards' ? <Flashcards content={content} onNavigate={onNavigate} /> : page === 'flashcards-create' ? <FlashcardCreate content={content} onNavigate={onNavigate} /> : page === 'quiz-create' || page === 'test-create' ? <QuizCreate content={content} test={page === 'test-create'} onNavigate={onNavigate} /> : page === 'quiz-session' || page === 'test-session' ? <Quiz content={content} test={page === 'test-session'} initialCount={readLocal<{ count: number }>('sf-k12:quiz-config', { count: 5 }).count} /> : page === 'quiz' || page === 'quizzes' || page === 'test' ? <PracticeLibrary test={page === 'test'} onNavigate={onNavigate} /> : page === 'chat' ? <Chat content={content} onNavigate={onNavigate} /> : page === 'tutor-me' ? <Tutor content={content} onNavigate={onNavigate} /> : page === 'audio-recap' ? <AudioLibrary onNavigate={onNavigate} /> : page === 'audio-create' ? <AudioCreate content={content} onNavigate={onNavigate} /> : page === 'audio-session' ? <AudioRecap content={content} /> : page === 'live-lecture' ? <Lecture /> : page === 'arcade' ? <ArcadeLibrary content={content} onNavigate={onNavigate} /> : page === 'arcade-create' ? <ArcadeCreate content={content} onNavigate={onNavigate} /> : page === 'arcade-session' ? <Arcade content={getStudyContent(readLocal<{topic: string}>('sf-k12:arcade-config', {topic: content.title}).topic, {stage: readLocal<{level: string}>('sf-k12:arcade-config', {level: content.level}).level, subject: readLocal<{subject: string}>('sf-k12:arcade-config', {subject: content.subject}).subject})} /> : <Reading content={content} onNavigate={onNavigate} />}</div></div>;
}
