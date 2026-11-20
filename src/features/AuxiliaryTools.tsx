import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AppWindow, ArrowLeft, ArrowRight, ArrowUpDown, Bookmark, Check, ClipboardCheck, CloudUpload, Download, FileText, FileUp, Highlighter, MousePointer2, PencilLine, Plus, Search, Smartphone, Trophy, WandSparkles, X, Youtube } from 'lucide-react';
import { asset, getCurriculum, save, stored } from '../data';
import { getStudyContent } from '../data/study-content';
import './auxiliary-tools.css';

type Props = { page: string; topic: string; onNavigate: (page: string) => void };
type Kind = 'essay' | 'explainers' | 'apps';
type Draft = { id: string; kind: Kind; title: string; body: string; material: string; tool: string; created: number; stage?: string };
const metadata = {
  essay: { title: '作业批改', action: '批改新作业', icon: 'assignment-grading', color: '#ecffd5' },
  explainers: { title: '讲解', action: 'Create Video', icon: 'explainers', color: '#fbf0ff' },
  apps: { title: '学习工具', action: '创建学习工具', icon: 'visuals', color: '#f5d5ff' },
};

export default function AuxiliaryTools({ page, topic, onNavigate }: Props) {
  const kind: Kind = page.startsWith('explainers') ? 'explainers' : page === 'apps' ? 'apps' : 'essay';
  const creating = page.endsWith('-create');
  const meta = metadata[kind];
  const { materials } = getCurriculum(undefined, topic);
  const [drafts, setDrafts] = useState<Draft[]>(() => stored('auxiliary-drafts', []));
  const [search, setSearch] = useState('');
  const [newest, setNewest] = useState(true);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [material, setMaterial] = useState(materials[0]);
  const [tool, setTool] = useState('arcade');
  const [current, setCurrent] = useState<Draft | null>(null);
  const [checked, setChecked] = useState(false);
  const [slide, setSlide] = useState(0);
  const [error, setError] = useState('');
  const [inputMode, setInputMode] = useState<'file' | 'text' | 'camera'>('file');
  const [source, setSource] = useState<'material' | 'topic' | 'highlights'>('material');
  const [imagePreview, setImagePreview] = useState('');
  const [imageName, setImageName] = useState('');
  const [appTab, setAppTab] = useState<'explore'|'mine'|'saved'>('explore');
  const [favorites, setFavorites] = useState<string[]>(() => stored('favorite-apps', []));
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => { save('auxiliary-drafts', drafts); }, [drafts]);
  useEffect(() => { save('favorite-apps', favorites); }, [favorites]);
  useEffect(() => { setCurrent(null); setSearch(''); setOpen(false); setError(''); }, [page]);
  useEffect(() => () => { if (imagePreview) URL.revokeObjectURL(imagePreview); }, [imagePreview]);
  const items = drafts.filter(item => item.kind === kind);
  const visible = items.filter(item => `${item.title} ${item.body}`.toLowerCase().includes(search.toLowerCase())).sort((a,b) => newest ? b.created-a.created : a.created-b.created);
  const content = getStudyContent(current?.material || material || topic, { stage: current?.stage || stored('stage', '高中') });
  function create() {
    setTitle(''); setBody(''); setError(''); setImagePreview(''); setImageName(''); setInputMode('file');
    if (kind === 'apps') setOpen(true); else onNavigate(`${kind}-create`);
  }
  function chooseSource(next: typeof source) { setSource(next); setTitle(''); setBody(''); setError(''); setOpen(true); }
  function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) { setError('请输入名称。'); return; }
    if (kind === 'essay' && !body.trim()) { setError('请先输入或上传作业文本。'); return; }
    if (kind === 'explainers' && source !== 'material' && !body.trim()) { setError(source === 'topic' ? '请输入讲解主题。' : '请粘贴需要讲解的重点。'); return; }
    const draft: Draft = { id: crypto.randomUUID(), kind, title: title.trim(), body: body.trim(), material: kind === 'explainers' && source === 'topic' ? body.trim() : material, tool, created: Date.now(), stage: stored('stage', '高中') };
    const nextDrafts = [draft, ...drafts];
    save('auxiliary-drafts', nextDrafts);
    setDrafts(nextDrafts); setOpen(false); setCurrent(null); setChecked(false); setSlide(0); onNavigate(kind);
  }
  async function readFile(file?: File) {
    if (!file) return;
    setError('');
    if (file.size > 2 * 1024 * 1024) { setError('请选择 2 MB 以内的文件。'); return; }
    if (file.type.startsWith('image/')) {
      setImagePreview(URL.createObjectURL(file)); setImageName(file.name); setTitle(file.name.replace(/\.[^.]+$/, '')); setInputMode('camera'); return;
    }
    if (!/\.(txt|md)$/i.test(file.name)) { setError('当前可读取 TXT、Markdown 文本。PDF、Word 和图片识别尚未接入，请复制文本到编辑器。'); return; }
    try { setBody(await file.text()); setTitle(file.name.replace(/\.[^.]+$/, '')); setInputMode('text'); }
    catch { setError('无法读取这个文件，请重试或粘贴文本。'); }
  }
  function download(draft: Draft) {
    const text = kind === 'explainers' ? `${draft.title}\n\n${draft.body ? `${draft.body}\n\n` : ''}${getStudyContent(draft.material, { stage: draft.stage || stored('stage', '高中') }).sections.map(section => `${section.title}\n${section.body}\n${section.example}`).join('\n\n')}` : `${draft.title}\n\n${draft.body}`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${draft.title}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const formFields = <><label>名称<input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder={kind === 'essay' ? '例如：那一次，我长大了' : kind === 'explainers' ? '例如：二次方程解题思路' : '例如：每天十分钟复习'} maxLength={80}/></label>{kind === 'explainers' ? source === 'material' ? <label>学习资料<select value={material} onChange={event => setMaterial(event.target.value)}>{materials.map(name => <option key={name}>{name}</option>)}</select></label> : <label>{source === 'topic' ? '讲解主题' : '重点内容'}<textarea rows={5} value={body} onChange={event => setBody(event.target.value)} placeholder={source === 'topic' ? '输入你想学习的主题…' : '粘贴你想复习的重点段落…'}/></label> : kind === 'apps' ? <><label>学习工具<select value={tool} onChange={event => setTool(event.target.value)}><option value="arcade">知识配对</option><option value="flashcards">闪卡</option><option value="quiz">测验</option></select></label><label>描述<textarea rows={3} value={body} onChange={event => setBody(event.target.value)} placeholder="你想怎样使用这个学习工具？"/></label></> : <label>作业文本<textarea rows={9} value={body} onChange={event => setBody(event.target.value)} placeholder="粘贴你的文本、报告或练习内容…"/></label>}</>;
  const localNote = kind === 'essay' ? '当前支持保存作业和本地结构检查。AI 批改与评分尚未接入。' : kind === 'explainers' ? '当前保存讲解提纲，并提供内置示例。AI 视频生成尚未接入。' : '当前创建本地学习工具的快捷入口。AI 应用生成尚未接入。';
  const modal = <dialog className="sf-aux-dialog" ref={dialog} onCancel={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}><button className="sf-aux-close" aria-label="关闭" onClick={() => setOpen(false)}><X size={20}/></button><form onSubmit={saveDraft}><h2>{kind === 'explainers' ? '创建讲解提纲' : meta.action}</h2>{formFields}<p className="sf-aux-note">{localNote}</p>{error && <p className="sf-aux-error" role="alert">{error}</p>}<div className="sf-aux-dialog-actions"><button type="button" className="btn" onClick={() => setOpen(false)}>取消</button><button className="btn btn-black" type="submit"><Check/>保存{kind === 'explainers' ? '提纲' : kind === 'apps' ? '工具' : '作业'}</button></div></form></dialog>;

  if (current) return <section className="sf-auxiliary sf-aux-detail"><div className="sf-aux-back"><button className="btn" onClick={() => setCurrent(null)}><ArrowLeft/>{meta.title}</button>{kind !== 'apps' && <button className="btn" onClick={() => download(current)}><Download/>下载{kind === 'essay' ? '作业' : '提纲'}</button>}</div><h1>{current.title}</h1>
    {kind === 'essay' ? <><div className="sf-aux-essay-paper">{current.body.split('\n').map((paragraph,index) => <p key={index}>{paragraph || '\u00a0'}</p>)}</div><div className="sf-aux-essay-actions"><button className="btn btn-black" onClick={() => setChecked(!checked)}><ClipboardCheck/>{checked ? '收起结构检查' : '检查文本结构'}</button><span>本地结构检查，不是 AI 评分。</span></div>{checked && <div className="sf-aux-feedback"><h2>文本结构检查</h2><div><span>正文字符</span><strong>{current.body.replace(/\s/g,'').length}</strong></div><div><span>非空段落</span><strong>{current.body.split(/\n+/).filter(p => p.trim()).length}</strong></div><div><span>句末标点</span><strong>{(current.body.match(/[。！？.!?]/g) || []).length}</strong></div><p>以上为文本统计。可据此检查篇幅、分段和标点；作业内容的正确性、审题与表达还需要老师或 AI 反馈。</p></div>}</> : kind === 'explainers' ? <><p className="sf-aux-note">内置讲解提纲 · AI 视频生成尚未接入</p>{current.body && <p className="sf-aux-saved-text">{current.body}</p>}<div className="sf-aux-slide"><small>{slide+1} / {content.sections.length}</small><h2>{content.sections[slide].title}</h2><p>{content.sections[slide].body}</p><div>{content.sections[slide].example}</div></div><div className="sf-aux-slide-controls"><button className="btn" disabled={slide===0} onClick={() => setSlide(slide-1)}><ArrowLeft/>上一节</button><button className="btn btn-black" disabled={slide===content.sections.length-1} onClick={() => setSlide(slide+1)}>下一节<ArrowRight/></button></div></> : <div className="sf-aux-app-detail"><img src={asset(current.tool==='arcade'?'arcade':current.tool==='flashcards'?'flashcards':'practice-quiz')} alt=""/><p>{current.body || '用一个轻量的学习工具巩固知识。'}</p><button className="btn btn-black" onClick={() => onNavigate(current.tool)}>打开学习工具<ArrowRight/></button><p className="sf-aux-note">这个快捷入口使用已有的本地学习工具，没有调用 AI 应用生成服务。</p></div>}
  </section>;

  if (creating && kind === 'essay') return <section className="sf-auxiliary sf-assignment-create"><div className="sf-assignment-intro"><h1>批改新作业</h1><p>步骤1：提交你想要评分的作业。你可以上传文件，或者粘贴一些文本</p></div><div className="sf-assignment-modes">{([{id:'file',label:'上传文件',Icon:FileUp,color:'#ecffd5'},{id:'text',label:'使用文本编辑器',Icon:PencilLine,color:'#fbf0ff'},{id:'camera',label:'手机摄像头',Icon:Smartphone,color:'#ffffd0'}] as const).map(({id,label,Icon,color}) => <button key={id} className={inputMode===id?'selected':''} onClick={() => { setInputMode(id); setError(''); }}><span style={{background:color}}><Icon size={24} strokeWidth={1.3}/></span><strong>{label}</strong></button>)}</div>
    <input hidden ref={fileInput} type="file" accept=".txt,.md,text/plain,text/markdown" onChange={event => { void readFile(event.target.files?.[0]); event.target.value=''; }}/><input hidden ref={cameraInput} type="file" accept="image/*" capture="environment" onChange={event => { void readFile(event.target.files?.[0]); event.target.value=''; }}/>
    {inputMode==='file' ? <div className="sf-assignment-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void readFile(event.dataTransfer.files[0]); }}><CloudUpload size={58} strokeWidth={1.3}/><h2>将作业拖放到这里</h2><p>上传作文、报告、习题，或任何其他作业文本！</p><p>TXT、Markdown<br/>每个文件不超过 2 MB</p><button className="btn btn-black" onClick={() => fileInput.current?.click()}>浏览文件</button></div> : inputMode==='camera' && !imagePreview ? <div className="sf-assignment-drop"><Smartphone size={58} strokeWidth={1.3}/><h2>拍摄你的作业</h2><p>在手机上打开相机拍照，或从相册选择作业图片。</p><p>当前支持本地预览，图片文字识别尚未接入。</p><button className="btn btn-black" onClick={() => cameraInput.current?.click()}>打开相机或选择图片</button></div> : <form className="sf-assignment-editor" onSubmit={saveDraft}>{imagePreview && <div className="sf-assignment-image"><img src={imagePreview} alt={imageName}/><p>{imageName} · 请在下方输入图片中的作业文本。</p><button className="btn" type="button" onClick={() => cameraInput.current?.click()}>更换图片</button></div>}{formFields}<p className="sf-aux-note">{localNote}</p><div className="sf-aux-dialog-actions"><button type="button" className="btn" onClick={() => onNavigate('essay')}><ArrowLeft/>返回作业</button><button className="btn btn-black" type="submit">保存作业<ArrowRight/></button></div></form>}{error && <p className="sf-aux-error" role="alert">{error}</p>}
  </section>;

  if (creating && kind === 'explainers') return <section className="sf-auxiliary sf-explainer-create"><div className="sf-explainer-work"><h1>How would you like to create your Explainer Video?</h1><div className="sf-explainer-choices"><button onClick={() => chooseSource('material')}><span style={{background:'#a9dbdf'}}><FileText size={29} strokeWidth={1.3}/></span><strong>從材料創建</strong><small>Generate from your study materials</small></button><button onClick={() => chooseSource('topic')}><span style={{background:'#f5d5ff'}}><WandSparkles size={29} strokeWidth={1.3}/></span><strong>从主题创建</strong><small>Enter any topic you want to learn</small></button><button onClick={() => chooseSource('highlights')}><span style={{background:'#bcf887'}}><Highlighter size={29} strokeWidth={1.3}/></span><strong>Create from Highlights</strong><small>Study just the passages you marked as important.</small></button></div></div><div className="sf-explainer-illustration" aria-hidden="true"><div className="sf-explainer-placeholder"><span/><i/></div><div className="sf-explainer-cursor"><MousePointer2 size={22}/></div><div className="sf-explainer-result"><img src={asset('explainers')} alt=""/></div></div>{modal}</section>;

  if (kind === 'apps') {
    const examples = [
      {id:'example-match',title:'知识配对',tool:'arcade',icon:'arcade',description:'连接概念与答案',color:'#eceae0'},
      {id:'example-cards',title:'记忆卡片',tool:'flashcards',icon:'flashcards',description:'一点一点记住知识',color:'#e5ebdd'},
      {id:'example-quiz',title:'自测练习',tool:'quiz',icon:'practice-quiz',description:'检查你的理解',color:'#e4ece9'},
      {id:'example-audio',title:'听力复习',tool:'audio-recap',icon:'audio-recap',description:'用声音复习知识',color:'#ede7df'},
      {id:'example-read',title:'阅读角',tool:'read',icon:'notes',description:'认真读懂每一页',color:'#eee9d8'},
    ];
    const cards = appTab==='mine' ? [] : examples.filter(item => (appTab!=='saved'||favorites.includes(item.id))&&`${item.title} ${item.description}`.includes(search));
    const personal = visible.filter(item => appTab!=='saved'||favorites.includes(item.id));
    return <section className="sf-auxiliary sf-app-gallery"><div className="sf-aux-heading"><span><AppWindow size={25} strokeWidth={1.3}/></span><div><h1>学习工具</h1><p>发现适合你的学习工具，按自己的节奏积累知识。</p></div><button className="btn btn-black" onClick={create}><Plus/>创建学习工具</button></div><div className="sf-app-toolbar"><div className="sf-app-tabs">{([{id:'explore',label:'探索'},{id:'mine',label:'我的学习工具'},{id:'saved',label:'收藏'}] as const).map(tab=><button className={appTab===tab.id?'selected':''} key={tab.id} onClick={()=>setAppTab(tab.id)}>{tab.label}</button>)}</div><label><Search size={17}/><input aria-label="搜索学习工具" placeholder="搜索..." value={search} onChange={event=>setSearch(event.target.value)}/></label></div>{appTab==='explore'&&<div className="sf-app-feature"><span><Trophy size={28} fill="currentColor" strokeWidth={1}/></span><div><h2>互动练习</h2><p>从知识配对开始，用互动练习巩固所学内容。</p></div><button className="btn btn-black" onClick={()=>onNavigate('arcade')}>立即练习<ArrowRight size={16}/></button></div>}<h2 className="sf-app-section-title">{appTab==='explore'?'精选':appTab==='mine'?'我的学习工具':'收藏'}</h2><div className="sf-app-cards">{cards.map(item=><article className="sf-app-card" key={item.id}><button className="sf-app-thumbnail" style={{backgroundColor:item.color}} onClick={()=>onNavigate(item.tool)}><img src={asset(item.icon)} alt=""/><span><strong>{item.title}</strong><small>{item.description}</small></span></button><div className="sf-app-card-actions"><button aria-pressed={favorites.includes(item.id)} onClick={()=>setFavorites(current=>current.includes(item.id)?current.filter(id=>id!==item.id):[...current,item.id])}><Bookmark size={16} fill={favorites.includes(item.id)?'currentColor':'none'}/>{favorites.includes(item.id)?'已收藏':'收藏'}</button><span>学习示例</span></div><div className="sf-app-card-footer">可在本地使用</div></article>)}{personal.map(item=><article className="sf-app-card" key={item.id}><button className="sf-app-thumbnail" onClick={()=>{setCurrent(item);setChecked(false);}}><img src={asset(item.tool==='arcade'?'arcade':item.tool==='quiz'?'practice-quiz':'flashcards')} alt=""/><span><strong>{item.title}</strong><small>我的学习工具</small></span></button><div className="sf-app-card-actions"><button aria-pressed={favorites.includes(item.id)} onClick={()=>setFavorites(current=>current.includes(item.id)?current.filter(id=>id!==item.id):[...current,item.id])}><Bookmark size={16} fill={favorites.includes(item.id)?'currentColor':'none'}/>{favorites.includes(item.id)?'已收藏':'收藏'}</button><span>本地创建</span></div><div className="sf-app-card-footer">学习快捷入口</div></article>)}</div>{cards.length+personal.length===0&&<div className="sf-app-no-results"><p>{search?'没有找到相关学习工具。':appTab==='saved'?'还没有收藏。点击学习工具卡片上的收藏按钮。':'创建一个学习工具快捷入口，开始你的练习。'}</p>{appTab==='mine'&&<button className="btn btn-black" onClick={create}><Plus/>创建学习工具</button>}</div>}{modal}</section>;
  }

  return <section className={`sf-auxiliary sf-aux-${kind}`}><div className="sf-aux-heading"><span style={{background:meta.color}}>{kind==='essay'?<span className="sf-assignment-icon">A+</span>:kind==='explainers'?<Youtube size={23} strokeWidth={1.3}/>:<AppWindow size={25} strokeWidth={1.3}/>}</span><div><h1>{kind==='explainers'?<>将您的文件转换为 <em>视频</em></>:meta.title}</h1>{kind==='essay'&&<p>保存文本草稿，查看字数、段落与标点等基础统计。</p>}</div><button className="btn btn-black" onClick={create}><Plus/>{meta.action}</button></div>
    {kind!=='essay'&&<div className="sf-aux-toolbar"><strong>{kind==='explainers'?'我的视频':'我的应用'}</strong><span>{visible.length} 条结果</span><button className="btn" onClick={() => setNewest(!newest)}><ArrowUpDown size={17}/>{newest?'最新':'最早'}</button><label><Search size={17}/><input placeholder="搜索" aria-label={`搜索${meta.title}`} value={search} onChange={event => setSearch(event.target.value)}/></label></div>}
    {visible.length ? <div className="sf-aux-grid">{visible.map(item => <button key={item.id} className="sf-aux-item" onClick={() => { setCurrent(item); setChecked(false); setSlide(0); }}><span style={{background:meta.color}}><img src={asset(meta.icon)} alt=""/></span><strong>{item.title}</strong><small>{kind==='essay'?'作业草稿':'本地讲解提纲'}</small><ArrowRight size={17}/></button>)}</div> : <div className="sf-aux-empty"><img src={asset(kind==='essay'?'footer-xiaoc-dash':'xiaoc-tail-wag')} alt=""/><h2>{search?'没有找到相关内容':kind==='essay'?'暂无作业':'创建你的第一个视频'}</h2><p>{search?'尝试换一个关键词。':kind==='essay'?'创建你的第一个作业以开始':'将笔记、PDF 或讲座变成视频讲解。'}</p>{!search&&<button className={`btn ${kind==='essay'?'btn-black':''}`} onClick={create}><Plus/>{meta.action}</button>}</div>}{modal}
  </section>;
}
