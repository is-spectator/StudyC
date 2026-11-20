import { appStorage, captureStorageSession } from '../lib/account-storage';
import { stored } from '../data';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, BookOpen, BookText, Check, ChevronDown, Clipboard, GraduationCap, Lightbulb, Mic, MoreHorizontal, NotebookText, Pencil, Send, SkipForward, Timer, UserRound, X } from 'lucide-react';
import './onboarding.css';

type Step = 'studying' | 'how_you_heard' | 'student_upload' | 'topics' | 'familiarity' | 'student_processing' | 'paywall' | 'student_study_plan';
type Dialog = 'paste' | 'handwrite' | 'quizlet' | 'custom' | 'record' | 'file' | null;
type Props = { onComplete: (topic: string, stage: string) => void; renderPaywall?: (onContinue: () => void, onBack: () => void) => ReactNode };
const asset = (name: string) => `/assets/studyc/${name}.svg`;
const validSteps: Step[] = ['studying', 'how_you_heard', 'student_upload', 'topics', 'familiarity', 'student_processing', 'paywall', 'student_study_plan'];
const getStep = (): Step => {
  const step = new URLSearchParams(window.location.search).get('currentStep') as Step;
  return validSteps.includes(step) ? step : 'studying';
};
function persistSource(data: { name: string; text?: string; [key: string]: unknown }) {
  appStorage.setItem('studyfetch:k12:source', JSON.stringify(data));
  if (data.text?.trim()) {
    let uploads: { title: string; text: string }[] = [];
    try { uploads = JSON.parse(appStorage.getItem('sf-k12:uploads') || '[]'); } catch { uploads = []; }
    if (!uploads.some(item => item.title === data.name && item.text === data.text)) uploads.push({ title: data.name, text: data.text });
    appStorage.setItem('sf-k12:uploads', JSON.stringify(uploads));
  }
}
const topicsByStage: Record<string, string[]> = {
  小学: ['分数与小数', '阅读与写作', '英语基础', '图形与几何', '古诗词', '科学探索'],
  初中: ['一元一次方程', '中国历史', '函数基础', '化学基础', '现代文阅读', '物理基础'],
  高中: ['生物基础', '中国历史', '多项式与二次方程', '化学基础', '现代文阅读', '物理基础'],
};
const curriculum: Record<string, string[]> = {
  小学: ['认识分数', '分数的基本性质', '分数加减法', '分数与小数的互化', '分数的实际应用', '综合练习'],
  初中: ['等式的基本性质', '一元一次方程的解法', '去括号与去分母', '列方程解决实际问题', '方程的检验', '综合练习'],
  高中: ['多项式基础与运算', '因式分解技巧', '二次方程求解与判别式', '高次方程与代数基本定理', '二次函数与抛物线性质', '复数及其运算'],
};
function learningUnits(topic: string, stage: string) {
  if (/阅读|文学|写作/.test(topic)) return ['理解词语与句子', '梳理文章结构', '概括主要内容', '分析人物与情感', '赏析表达方法', '阅读与写作练习'];
  if (/历史/.test(topic)) return ['建立历史时间线', '了解重要历史事件', '理解制度与社会生活', '辨析历史材料', '归纳变化与联系', '专题复习'];
  if (/英语/.test(topic)) return ['基础词汇', '词类与句子成分', '常用句型', '时态与语法', '阅读理解', '表达与写作'];
  if (/化学/.test(topic)) return ['物质及其变化', '元素与原子', '化学式与化学方程式', '常见物质的性质', '实验观察与分析', '基础计算与应用'];
  if (/物理/.test(topic)) return ['运动与测量', '力与运动', '能量与机械', '声与光', '电学基础', '实验与综合应用'];
  if (/生物|科学/.test(topic)) return ['观察与提出问题', '认识生命现象', '细胞与生物体', '生物与环境', '实验与探究', '知识巩固'];
  if (/古诗/.test(topic)) return ['朗读与节奏', '理解字词', '感受诗歌意象', '理解诗人情感', '背诵与默写', '积累与运用'];
  if (/几何|图形/.test(topic)) return ['认识基本图形', '角与线', '长度与周长', '面积与体积', '观察图形变换', '解决实际问题'];
  if (/方程|多项式|函数|分数|小数/.test(topic)) return curriculum[stage] || curriculum.高中;
  return ['预览学习资料', '梳理核心概念', '整理重要知识点', '理解与应用', '练习与自查', '总结与复习'];
}

export default function Onboarding({ onComplete, renderPaywall }: Props) {
  const [step, setStep] = useState<Step>(getStep);
  // Legacy stage selects existing examples only; it is no longer an onboarding requirement.
  const [stage] = useState(() => stored('stage', appStorage.getItem('studyfetch:k12:stage') || '未设置'));
  const [learningGoal, setLearningGoal] = useState(() => appStorage.getItem('studyfetch:k12:learning-goal') || '');
  const [source, setSource] = useState(() => appStorage.getItem('studyfetch:k12:referral') || '朋友推荐');
  const [topic, setTopic] = useState(() => appStorage.getItem('studyfetch:k12:topic') || '多项式与二次方程');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recordedUrl, setRecordedUrl] = useState('');
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const activeStream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const notes = learningUnits(topic, stage);

  useEffect(() => {
    const onPop = () => setStep(getStep());
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      activeStream.current?.getTracks().forEach(track => track.stop());
    };
  }, []);
  useEffect(() => () => { if (recordedUrl) URL.revokeObjectURL(recordedUrl); }, [recordedUrl]);
  useEffect(() => {
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !recording) setDialog(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, recording]);

  function go(next: Step) {
    const url = new URL(window.location.href);
    url.pathname = '/platform/onboarding';
    url.searchParams.set('currentStep', next);
    window.history.pushState({ step: next }, '', url);
    setStep(next);
    window.scrollTo(0, 0);
  }
  function back() {
    const previous: Partial<Record<Step, Step>> = { how_you_heard: 'studying', student_upload: 'how_you_heard', topics: 'student_upload', familiarity: 'topics', student_processing: 'familiarity', paywall: 'student_processing', student_study_plan: 'paywall' };
    if (step === 'studying') { window.location.assign('/platform'); return; }
    go(previous[step] || 'studying');
  }
  function chooseTopic(value: string) {
    setTopic(value);
    appStorage.setItem('studyfetch:k12:topic', value);
    setDialog(null);
    go('familiarity');
  }
  function openDialog(value: Dialog) { setError(''); setText(''); setDialog(value); }
  function acceptFile(next: File | undefined) {
    if (!next) return;
    if (next.size > 50 * 1024 * 1024) { setError('请选择 50 MB 以内的文件。'); setDialog('file'); return; }
    setError(''); setFile(next); setDialog('file');
  }
  async function useFile() {
    if (!file) return;
    const isCurrentAccount = captureStorageSession();
    const isText = /\.(txt|md|csv)$/i.test(file.name);
    const content = isText ? await file.text() : '';
    if (!isCurrentAccount()) return;
    persistSource({ name: file.name, size: file.size, type: isText ? 'text' : file.type, text: content.slice(0, 150000) });
    chooseTopic(file.name.replace(/\.[^.]+$/, ''));
  }
  function useNotes() {
    if (!text.trim()) { setError('请先输入学习材料。'); return; }
    if (dialog === 'custom') { chooseTopic(text.trim().slice(0, 80)); return; }
    if (dialog === 'quizlet') {
      const pairs = text.trim().split('\n').map(row => row.split('\t')).filter(row => row.length > 1);
      if (!pairs.length) { setError('请粘贴 Quizlet 导出的词条，每行使用制表符分隔术语与定义。'); return; }
      persistSource({ name: 'Quizlet 词条', text, cards: pairs, type: 'text' });
      chooseTopic(pairs[0][0]); return;
    }
    persistSource({ name: '学习笔记', text, type: 'text' });
    chooseTopic(text.trim().split('\n')[0].slice(0, 50));
  }
  async function startRecording() {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持录音，请上传音频文件。');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      activeStream.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      recorder.current = mediaRecorder; chunks.current = [];
      mediaRecorder.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks.current, { type: mediaRecorder.mimeType });
        setRecordedBlob(blob); setRecordedUrl(URL.createObjectURL(blob)); setRecording(false);
        stream.getTracks().forEach(track => track.stop());
      };
      mediaRecorder.start(); setRecording(true); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '无法使用麦克风，请检查浏览器权限。'); }
  }

  if (step === 'paywall' && renderPaywall) return <>{renderPaywall(() => go('student_study_plan'), () => go('student_processing'))}</>;

  return <main className={`sf-onboarding sf-onboarding--${step}`}>
    {!['student_processing', 'student_study_plan'].includes(step) && <button className="sf-ob-back" onClick={back}><ArrowLeft size={20} strokeWidth={1.8} /> 返回</button>}
    {step === 'student_upload' && <button className="sf-ob-skip" onClick={() => go('topics')}>我没有材料</button>}

    {step === 'studying' && <section className="sf-ob-study">
      <h1>你的学习目标是什么？</h1>
      <div className="sf-ob-stage-list">
        {[
          { name: '课程学习', desc: '理解课程内容，整理重点知识', icon: BookText, tone: 'lime' },
          { name: '考试准备', desc: '梳理复习范围，巩固薄弱知识点', icon: GraduationCap, tone: 'peach' },
          { name: '自主探索', desc: '从感兴趣的主题开始，按自己的节奏学习', icon: Lightbulb, tone: 'teal' },
        ].map(({ name, desc, icon: Icon, tone }) => <button key={name} className="sf-ob-choice" aria-pressed={learningGoal === name} onClick={() => { setLearningGoal(name); appStorage.setItem('studyfetch:k12:learning-goal', name); go('how_you_heard'); }}>
          <span className={`sf-ob-round sf-ob-tone-${tone}`}><Icon size={22} strokeWidth={1.6} /></span>
          <span className="sf-ob-choice-copy"><strong>{name}</strong><span>{desc}</span></span>
        </button>)}
      </div>
    </section>}

    {step === 'how_you_heard' && <section className="sf-ob-source">
      <h1>你是从哪里听说 StudyC 的？</h1>
      <div className="sf-ob-source-grid">
        {[
          ['Pinterest', 'source-pinterest'], ['Instagram', 'social-2'], ['抖音', 'social-6'], ['ChatGPT', 'source-openai'],
          ['脸书', 'source-facebook'], ['优兔', 'social-5'], ['朋友推荐', 'person'], ['谷歌', 'source-google'], ['红迪', 'source-reddit'], ['其他', 'more'],
        ].map(([label, name]) => <button key={label} className={`sf-ob-source-option ${source === label ? 'is-selected' : ''}`} onClick={() => { setSource(label); appStorage.setItem('studyfetch:k12:referral', label); go('student_upload'); }}>
          {name === 'person' || name === 'more' ? <span className="sf-ob-round sf-ob-tone-neutral">{name === 'person' ? <UserRound size={24} strokeWidth={1.5} /> : <MoreHorizontal size={24} strokeWidth={1.5} />}</span> : <img className={`sf-ob-social-icon sf-ob-social-${name}`} src={asset(name)} alt="" />}
          <span>{label}</span>
        </button>)}
      </div>
    </section>}

    {step === 'student_upload' && <section className="sf-ob-upload">
      <h1>StudyC 陪你学懂每一个知识点。</h1>
      <div className="sf-ob-upload-card">
        <button className={`sf-ob-upload-drop ${dragging ? 'is-dragging' : ''}`} onClick={() => fileInput.current?.click()} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); acceptFile(e.dataTransfer.files[0]); }}>
          <img className="sf-ob-upload-art" src={asset('upload-materials')} alt="文档、PDF、音频和视频学习资料" />
          <span className="sf-ob-upload-heading">上传你的资料、笔记、幻灯片，<br />照片，或音频或视频录音</span>
          <span className="sf-ob-upload-types">PDF, PPTX, DOC, TXT,<br />图片、音频、视频和 <u>更多</u></span>
          <span className="sf-ob-device">从设备选择</span>
        </button>
        <input className="sf-ob-visually-hidden" ref={fileInput} type="file" accept=".pdf,.ppt,.pptx,.doc,.docx,.txt,.md,.csv,image/*,audio/*,video/*" onChange={e => acceptFile(e.target.files?.[0])} aria-label="选择学习资料" />
        <div className="sf-ob-import-options">
          <button onClick={() => openDialog('quizlet')}><img src={asset('Quizlet-v2')} alt="" />导入 Quizlet</button>
          <button onClick={() => openDialog('paste')}><Clipboard size={19} color="#c2a738" strokeWidth={1.5} />粘贴笔记</button>
          <button onClick={() => openDialog('handwrite')}><Pencil size={19} color="#c38acf" strokeWidth={1.5} />手写笔记</button>
        </div>
      </div>
      <div className="sf-ob-upload-alternatives">
        <button onClick={() => go('topics')}><Lightbulb size={20} strokeWidth={1.4} />输入主题</button><span>或</span><button onClick={() => openDialog('record')}><Mic size={20} color="#c2a738" strokeWidth={1.4} />开始录音</button>
      </div>
    </section>}

    {(step === 'topics' || step === 'familiarity') && <section className={`sf-ob-topics ${step === 'familiarity' ? 'sf-ob-topics--level' : ''}`}>
      <h1>从一个主题开始</h1>
      {step === 'topics' ? <>
        <p className="sf-ob-topic-intro">为你的第一个学习集选择主题</p>
        <div className="sf-ob-topics-grid">{(topicsByStage[stage] || topicsByStage.高中).map(item => <button key={item} onClick={() => chooseTopic(item)}>{item}</button>)}</div>
        <button className="sf-ob-custom" onClick={() => openDialog('custom')}><Pencil size={19} strokeWidth={1.5} />输入自己的主题</button>
      </> : <div className="sf-ob-level-card">
        <p className="sf-ob-current-topic">{topic}</p>
        <h2>你对此有什么了解？</h2>
        <div className="sf-ob-level-grid">
          {[{ label: '刚接触', detail: '我重新开始', icon: NotebookText, tone: 'teal' }, { label: '一些背景', detail: '我懂基础', icon: BookOpen, tone: 'pink' }, { label: '掌握', detail: '我想深入下去', icon: GraduationCap, tone: 'lime' }].map(({ label, detail, icon: Icon, tone }) => <button key={label} onClick={() => { appStorage.setItem('studyfetch:k12:level', label); go('student_processing'); }}>
            <span className={`sf-ob-level-icon sf-ob-tone-${tone}`}><Icon size={26} strokeWidth={1.3} /></span><strong>{label}</strong><span>{detail}</span>
          </button>)}
        </div>
      </div>}
    </section>}

    {step === 'student_processing' && <section className="sf-ob-processing">
      <img className="sf-ob-running" src={asset('xiaoc-running')} alt="小C" />
      <h1>让我们开始学习吧!</h1>
      <div className="sf-ob-processing-grid">
        <div className="sf-ob-processing-panel"><h2>学习材料<span><Check size={20} strokeWidth={1.5} /></span></h2><div className="sf-ob-processing-rows">{[topic, ...notes.slice(0, 5)].map((item, index) => <div key={`${item}-${index}`}><NotebookText size={18} strokeWidth={1.3} /><span>{item}</span><Check size={11} /></div>)}</div></div>
        <div className="sf-ob-processing-panel"><h2>学习计划<span><Check size={20} strokeWidth={1.5} /></span></h2><div className="sf-ob-processing-rows">{notes.map((item, index) => <div key={item}><span className="sf-ob-unit-number">{String(index + 1).padStart(2, '0')}</span><span>{item}</span><Check size={11} /></div>)}</div></div>
        <div className="sf-ob-processing-panel"><h2>学习资料<span><Check size={20} strokeWidth={1.5} /></span></h2><div className="sf-ob-material-grid">{[['arcade', '互动练习'], ['audio-recap', '音频复习'], ['flashcards', '闪卡'], ['notes', '笔记']].map(([name, label]) => <div key={name}><img src={asset(name)} alt="" /><span>{label}</span></div>)}</div></div>
      </div>
      <OnboardingFooter label="继续" onClick={() => go(renderPaywall ? 'paywall' : 'student_study_plan')} />
    </section>}

    {step === 'paywall' && !renderPaywall && <section className="sf-ob-fallback"><h1>选择你的 StudyC 方案</h1><p>继续使用本地体验版。</p><button className="sf-ob-black" onClick={() => go('student_study_plan')}>暂时跳过</button></section>}

    {step === 'student_study_plan' && <section className="sf-ob-plan">
      <h1>你的学习计划规划了学习内容和学习时间。</h1>
      <div className="sf-ob-plan-body">
        <div className="sf-ob-plan-start"><span><Send size={22} strokeWidth={1.4} /></span><strong>从这里开始学习</strong></div>
        <div className="sf-ob-plan-outline">
          <button className="sf-ob-plan-title" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}><ChevronDown size={17} className={!expanded ? 'is-collapsed' : ''} /><i /><strong>{topic}</strong></button>
          {expanded && <div className="sf-ob-plan-items"><button className="sf-ob-plan-assessment" onClick={() => onComplete(topic, stage)}><span className="sf-ob-timer"><Timer size={19} strokeWidth={1.5} /></span><span><strong>看看你已经知道了什么</strong><small>需要3分钟</small></span><span className="sf-ob-save-time">节省时间</span><span className="sf-ob-plan-skip"><SkipForward size={13} />跳过</span></button>
          {notes.map(item => <button key={item} className="sf-ob-plan-item" onClick={() => onComplete(topic, stage)}><i /><span>{item}</span></button>)}
          </div>}
        </div>
      </div>
      <OnboardingFooter label="开始学习" onClick={() => onComplete(topic, stage)} />
    </section>}

    {dialog && <div className="sf-ob-dialog-backdrop" onClick={e => { if (e.target === e.currentTarget && !recording) setDialog(null); }}><section className="sf-ob-dialog" role="dialog" aria-modal="true" aria-labelledby="sf-ob-dialog-title">
      <button className="sf-ob-dialog-close" onClick={() => { recorder.current?.state === 'recording' && recorder.current.stop(); setDialog(null); }} aria-label="关闭"><X size={22} /></button>
      <h2 id="sf-ob-dialog-title">{{ paste: '粘贴笔记', handwrite: '手写笔记', quizlet: '导入 Quizlet', custom: '输入学习主题', record: '学习录音', file: '学习资料' }[dialog]}</h2>
      {dialog === 'file' ? <><div className="sf-ob-file-preview"><NotebookText size={30} strokeWidth={1.3} /><strong>{file?.name || '未选择文件'}</strong>{file && <span>{(file.size / 1024 / 1024).toFixed(2)} MB</span>}</div><p className="sf-ob-dialog-hint">文件保存在当前设备。本地体验可预览文本资料，PDF、图片及音视频的 AI 解析尚未连接。</p><button className="sf-ob-black" onClick={useFile} disabled={!file || Boolean(error)}>使用这份资料</button></> : dialog === 'record' ? <>
        <div className={`sf-ob-recording ${recording ? 'is-recording' : ''}`}><Mic size={42} strokeWidth={1.3} /><p>{recording ? '正在录制，完成后点击停止。' : recordedUrl ? '录制完成' : '录制你想复习的内容。'}</p></div>
        {recordedUrl && <audio controls src={recordedUrl} />}
        <button className="sf-ob-black" onClick={() => recording ? recorder.current?.stop() : startRecording()}>{recording ? '停止录制' : recordedUrl ? '重新录制' : '开始录音'}</button>
        {recordedUrl && <a className="sf-ob-record-download" href={recordedUrl} download="学习录音.webm">保存录音（{Math.round((recordedBlob?.size || 0) / 1024)} KB）</a>}
      </> : <><p className="sf-ob-dialog-hint">{dialog === 'quizlet' ? '粘贴从 Quizlet 导出的内容，术语与定义之间用制表符分隔，每行一张卡片。' : dialog === 'custom' ? '告诉我们你想学习什么。' : '把课程笔记、阅读摘录或复习提纲放在这里。'}</p>{dialog === 'custom' ? <input autoFocus value={text} maxLength={80} onChange={e => setText(e.target.value)} placeholder="例如：一元一次方程" onKeyDown={e => e.key === 'Enter' && useNotes()} /> : <textarea autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={dialog === 'quizlet' ? '术语\t定义' : '在这里输入或粘贴笔记…'} rows={8} />}<button className="sf-ob-black" onClick={useNotes}>继续</button></>}
      {error && <p className="sf-ob-error" role="alert">{error}</p>}
    </section></div>}
  </main>;
}

function OnboardingFooter({ label, onClick }: { label: string; onClick: () => void }) {
  return <div className="sf-ob-footer"><button className="sf-ob-black" onClick={onClick}>{label}</button><span className="sf-ob-journey"><svg viewBox="0 0 112 52" aria-hidden="true"><path d="M108 30c-39 19-57 12-62-4C37-2 68-1 70 18c2 32-36 27-62 10m0 0 13 0M8 28v12" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" /></svg><em>开启你的学习之旅</em></span></div>;
}
