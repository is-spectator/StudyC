import { appStorage } from '../lib/account-storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpCircle, CalendarDays, Check, ChevronDown, Clock3, FileText, Folder, FolderPlus, MoreVertical, NotebookPen, Pencil, Plus, Search, Smartphone, X } from 'lucide-react';
import { asset, getCurriculum, modalities } from '../data';
import { getStudyContent } from '../data/study-content';
import './library.css';

type Props = { page: string; topic: string; onNavigate: (page: string) => void; onCreate: () => void; onUpload: () => void; onSelectStudySet?: (name: string) => void; onRenameStudySet?: (previous: string, next: string) => void };
type LocalFolder = { id: string; name: string; createdAt: number };
function readLocal<T,>(key: string, fallback: T): T { try { return JSON.parse(appStorage.getItem(`sf-k12:${key}`) || 'null') ?? fallback; } catch { return fallback; } }

export default function Library({ page, topic, onNavigate, onCreate, onUpload, onSelectStudySet, onRenameStudySet }: Props) {
  const {materials:initialMaterials} = getCurriculum(undefined, topic);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [sortOpen, setSortOpen] = useState(false);
  const [folders, setFolders] = useState<LocalFolder[]>(() => readLocal('folders', []));
  const [openFolder, setOpenFolder] = useState<LocalFolder | null>(null);
  const [folderAssignments, setFolderAssignments] = useState<Record<string,string>>(() => readLocal('set-folders', {}));
  const [dialog, setDialog] = useState<'folder' | 'canvas' | 'sparky' | 'rename' | 'move' | null>(null);
  const [folderName, setFolderName] = useState('');
  const [formError, setFormError] = useState('');
  const setName = topic;
  const [studySets, setStudySets] = useState<string[]>(() => [...new Set(readLocal<string[]>('sets', [topic]).concat(topic))]);
  const [renameTarget, setRenameTarget] = useState(topic);
  const [draftName, setDraftName] = useState(topic);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [bannerVisible, setBannerVisible] = useState(() => !readLocal('hide-sparky', false));
  const [calendarTab, setCalendarTab] = useState<'today' | 'exam'>('today');
  const modalRef = useRef<HTMLDialogElement>(null);

  useEffect(() => { appStorage.setItem('sf-k12:folders', JSON.stringify(folders)); }, [folders]);
  useEffect(() => { appStorage.setItem('sf-k12:sets', JSON.stringify(studySets)); }, [studySets]);
  useEffect(() => { appStorage.setItem('sf-k12:set-folders', JSON.stringify(folderAssignments)); }, [folderAssignments]);
  useEffect(() => { if (dialog) modalRef.current?.showModal(); else modalRef.current?.close(); }, [dialog]);
  useEffect(() => { setOpenFolder(null); setQuery(''); setSortOpen(false); }, [page]);

  const search = query.trim().toLocaleLowerCase();
  const shownFolders = useMemo(() => {
    const result = folders.filter((folder) => folder.name.toLocaleLowerCase().includes(search));
    return result.sort((a, b) => sort === 'az' ? a.name.localeCompare(b.name, 'zh') : sort === 'za' ? b.name.localeCompare(a.name, 'zh') : b.createdAt - a.createdAt);
  }, [folders, search, sort]);
  const shownSets = studySets.filter(name => (!openFolder || folderAssignments[name] === openFolder.id) && (!search || `${name} ${getCurriculum(undefined,name).materials.join(' ')}`.toLocaleLowerCase().includes(search))).sort((a,b) => sort === 'az' ? a.localeCompare(b,'zh') : sort === 'za' ? b.localeCompare(a,'zh') : sort === 'created' ? studySets.indexOf(b)-studySets.indexOf(a) : Number(b===topic)-Number(a===topic));
  const sortNames: Record<string, string> = { recent: '上次访问', created: '最近创建', az: '按字母顺序 (A-Z)', za: '按字母顺序 (Z-A)' };
  const todayKey = new Intl.DateTimeFormat('en-CA', {year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Asia/Shanghai'}).format(new Date());
  const calendarEvents = readLocal<{id:string;date:string;title:string;time:string;type:string}[]>('calendar-events', []);
  const todayEvents = calendarEvents.filter(event => event.date === todayKey);
  const examEvents = calendarEvents.filter(event => event.type === '考试' && event.date >= todayKey);
  const visibleEvents = (calendarTab === 'today' ? todayEvents : examEvents).sort((a,b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' }).format(new Date());
  const completedUnits = readLocal<string[]>('plan-completed', []);
  const progressFor = (name: string) => { const topics = getCurriculum(undefined,name).units.flat(); return Math.round(topics.filter(unit => completedUnits.includes(unit)).length / topics.length * 100); };

  const openModal = (name: typeof dialog) => { setFormError(''); setFolderName(''); setDialog(name); };
  function openSet(name: string) { if(onSelectStudySet) onSelectStudySet(name); else { appStorage.setItem('sf-k12:topic', JSON.stringify(name)); onNavigate('dashboard'); } }
  const studyCard = (setName: string) => (
    <article className="sf-studyset-card" key={setName}>
      <button className="sf-studyset-open" onClick={() => openSet(setName)} aria-label={`打开 ${setName}`}>
        <span className="sf-studyset-title-row"><span className="sf-studyset-icon"><img src={asset('tutor-me-pdf')} alt="" /></span><span className="sf-studyset-name"><strong>{setName}</strong><span className="sf-studyset-progress"><span style={{background:`linear-gradient(to right,#b4d985 ${progressFor(setName)}%,#e5e5e5 ${progressFor(setName)}%)`}}/><small>{progressFor(setName)}%</small></span></span></span>
        <span className="sf-studyset-count"><Pencil size={12} />{initialMaterials.length} 学习资料</span>
        <span className="sf-studyset-last"><span>上次学习</span><span>刚才</span></span>
        <span className="sf-studyset-lesson">{getCurriculum(undefined,setName).materials[0]}</span>
      </button>
      <div className="sf-studyset-menu-wrap"><button className="sf-library-icon-button" aria-label="学习集菜单" aria-expanded={menuOpen === setName} onClick={() => setMenuOpen(menuOpen === setName ? null : setName)}><MoreVertical size={16} /></button>{menuOpen === setName && <div className="sf-library-dropdown"><button onClick={() => { setRenameTarget(setName); setDraftName(setName); setMenuOpen(null); openModal('rename'); }}><Pencil size={14} />编辑学习集</button><button onClick={() => { setRenameTarget(setName); setMenuOpen(null); openModal('move'); }}><Folder size={14} />移入文件夹</button><button onClick={() => { setMenuOpen(null); if(setName !== topic) openSet(setName); onUpload(); }}><Plus size={14} />添加资料</button></div>}</div>
    </article>
  );

  return <div className={`sf-library ${page === 'home' ? 'sf-library-home' : 'sf-library-sets'}`}>
    {page === 'home' ? <>
      <div className="sf-home-greeting"><span className="sf-home-avatar"><img src={asset('xiaoc-avatar-stay')} alt="小C" /></span><p>一次简短的<button onClick={() => onNavigate('tutor-me')}>小C辅导</button>会话可能是您进入状态所需的催化剂。</p></div>
      {bannerVisible && <div className="sf-sparky-banner"><div><strong>小C</strong><p>手机端入口尚未开放。</p><div><button onClick={() => openModal('sparky')}>了解更多</button><button onClick={() => { setBannerVisible(false); appStorage.setItem('sf-k12:hide-sparky', 'true'); }}>不再显示</button></div></div><button className="sf-sparky-qr" onClick={() => openModal('sparky')} aria-label="了解小C手机端功能"><Smartphone size={36} strokeWidth={1.5} aria-hidden="true" /></button></div>}
      <div className="sf-home-columns">
        <div className="sf-home-primary">
          <section className="sf-home-materials"><h2>您的资料</h2><div className="sf-material-carousel">{[initialMaterials[4],initialMaterials[2],initialMaterials[1],initialMaterials[3],initialMaterials[0]].map((title, index) => <button className="sf-material-card" key={title} onClick={() => { appStorage.setItem('sf-k12:selectedMaterial', JSON.stringify(initialMaterials.indexOf(title))); onNavigate('material'); }}><DocumentPreview title={title} index={index} /><span><NotebookPen size={18} /><span>{title}</span></span></button>)}</div></section>
          <section className="sf-home-restart"><h2>重新开始</h2><div className="sf-home-restart-grid"><button className="sf-resume-card" onClick={() => onNavigate('dashboard')}><span className="sf-studyset-icon"><img src={asset('tutor-me-pdf')} alt="" /></span><span><strong>{setName}</strong><small>刚才</small></span></button><div className="sf-new-set-prompt"><h3>升级你的资料库</h3><p>你已经有了一个很棒的开始，拥有了一个学习集。再创建一个，以便更好地整理你的不同主题。</p><button onClick={onCreate}>创建另一个学习集</button></div></div></section>
          <section className="sf-home-tools"><h2>开始学习</h2><div>{modalities.slice(0,4).map((tool) => <button key={tool.id} onClick={() => onNavigate(tool.id)}><span style={{background:tool.color}}><img src={asset(tool.asset)} alt="" /></span><strong>{tool.label}</strong></button>)}</div></section>
        </div>
        <aside className="sf-home-secondary"><section className="sf-home-upgrade"><h2><ArrowUpCircle size={20} />升级到 StudyC 进阶版</h2><p>全天候提供小C辅导课程、高级笔记捕捉以及历史学习路径访问。</p><button onClick={() => onNavigate('paywall')}>立即升级</button></section><section className="sf-home-calendar"><h2><CalendarDays size={20} />即将到来<button onClick={() => onNavigate('calendar')}>{dateLabel}</button></h2><div className="sf-home-calendar-tabs"><button className={calendarTab === 'today' ? 'active' : ''} onClick={() => setCalendarTab('today')}>今天 ({todayEvents.length})</button><button className={calendarTab === 'exam' ? 'active' : ''} onClick={() => setCalendarTab('exam')}>考试 ({examEvents.length})</button></div>{visibleEvents.length ? <div className="sf-home-event-list">{visibleEvents.slice(0,4).map(event => <button key={event.id} onClick={() => onNavigate('calendar')}><span>{calendarTab === 'exam' ? `${event.date} · ` : ''}{event.time}</span><strong>{event.title}</strong></button>)}</div> : <><strong>{calendarTab === 'today' ? '今天没有安排' : '暂无考试安排'}</strong><p>{calendarTab === 'today' ? '日历是空的。要添加一个学习时段吗？' : '为下一次考试设置日期，提前安排复习。'}</p></>}<button className="sf-library-text-button" onClick={() => onNavigate('calendar')}>{calendarTab === 'today' ? '添加学习时段' : '添加考试'}</button></section></aside>
      </div>
    </> : <>
      {openFolder && <div className="sf-folder-breadcrumb"><button onClick={() => setOpenFolder(null)}><ArrowLeft size={16}/>我的学习集</button><span>/</span><strong>{openFolder.name}</strong></div>}
      <div className="sf-library-toolbar"><label className="sf-library-search"><Search size={18}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索学习集..." aria-label="搜索学习集" />{query && <button aria-label="清除搜索" onClick={() => setQuery('')}><X size={15}/></button>}</label><div className="sf-library-sort"><button className="sf-library-pill" aria-expanded={sortOpen} onClick={() => setSortOpen(!sortOpen)}><Clock3 size={16}/>{sortNames[sort]}<ChevronDown size={13}/></button>{sortOpen && <div className="sf-library-dropdown">{Object.entries(sortNames).map(([key,label]) => <button key={key} onClick={() => { setSort(key); setSortOpen(false); }}>{label}{sort === key && <Check size={15}/>}</button>)}</div>}</div><button className="sf-library-pill" onClick={() => onNavigate('materials')}><FileText size={16}/>资料</button><button className="sf-library-pill" onClick={() => openModal('folder')}><FolderPlus size={16}/>新建文件夹</button><button className="sf-library-pill sf-library-dark" onClick={onCreate}><Plus size={17}/>创建学习集</button></div>
      <div className="sf-studyset-grid">
        {!query && !openFolder && <button className="sf-create-studyset" onClick={onCreate}><span><Plus size={26} strokeWidth={1}/></span><strong>创建学习集</strong><p>创建一个新的学习集来整理你的学习资料</p></button>}
        {!openFolder && shownFolders.map((folder) => <button key={folder.id} className="sf-library-folder-card" onClick={() => setOpenFolder(folder)}><Folder size={36} strokeWidth={1.2}/><strong>{folder.name}</strong><small>{studySets.filter(name => folderAssignments[name] === folder.id).length} 个学习集</small></button>)}
        {shownSets.map(studyCard)}
      </div>
      {!shownSets.length && (openFolder || shownFolders.length === 0) && <div className="sf-library-empty"><Folder size={38} strokeWidth={1}/><h2>{openFolder ? '这个文件夹还是空的' : '未找到学习集'}</h2><p>{openFolder ? '从学习集菜单选择「移入文件夹」，开始整理你的学习资料。' : '尝试调整您的搜索词'}</p></div>}
      {!openFolder && <section className="sf-canvas-section"><h2>Canvas classes</h2><button className="sf-library-pill" onClick={() => openModal('canvas')}>Connect Canvas</button></section>}
    </>}
    <dialog ref={modalRef} className="sf-library-dialog" onCancel={() => setDialog(null)} onClick={(event) => { if(event.target === event.currentTarget) setDialog(null); }}><button className="sf-library-dialog-close" aria-label="关闭" onClick={() => setDialog(null)}><X size={20}/></button>
      {dialog === 'folder' && <form onSubmit={(event) => { event.preventDefault(); const name = folderName.trim(); if(!name) { setFormError('请输入文件夹名称'); return; } setFolders([...folders,{id:crypto.randomUUID(),name,createdAt:Date.now()}]);setDialog(null); }}><h2>新建文件夹</h2><p>整理你的主题和学习集。</p><label>文件夹名称<input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="例如：阅读与写作" maxLength={60}/></label>{formError && <p role="alert" className="sf-library-error">{formError}</p>}<div className="sf-library-dialog-actions"><button className="sf-library-pill" type="button" onClick={() => setDialog(null)}>取消</button><button className="sf-library-pill sf-library-dark" type="submit">创建文件夹</button></div></form>}
      {dialog === 'rename' && <form onSubmit={(event) => { event.preventDefault(); if(!draftName.trim()) { setFormError('学习集名称是必填的');return; }const next = draftName.trim();if(next !== renameTarget && studySets.includes(next)){setFormError('已有同名学习集，请使用其他名称');return;}setStudySets(current => current.map(name => name === renameTarget ? next : name));setFolderAssignments(current => {const result={...current};if(result[renameTarget]){result[next]=result[renameTarget];delete result[renameTarget];}return result;});if(onRenameStudySet)onRenameStudySet(renameTarget,next);else if(renameTarget === topic)appStorage.setItem('sf-k12:topic',JSON.stringify(next));setDialog(null); }}><h2>编辑学习集</h2><label>学习集名称<input value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={80}/></label>{formError && <p role="alert" className="sf-library-error">{formError}</p>}<div className="sf-library-dialog-actions"><button type="button" className="sf-library-pill" onClick={() => setDialog(null)}>取消</button><button type="submit" className="sf-library-pill sf-library-dark">保存</button></div></form>}
      {dialog === 'move' && <><h2>移入文件夹</h2><p>{renameTarget}</p><div className="sf-library-folder-options">{folders.map(folder => <button key={folder.id} className="sf-library-pill" onClick={() => {setFolderAssignments(current=>({...current,[renameTarget]:folder.id}));setDialog(null);}}><Folder size={16}/>{folder.name}{folderAssignments[renameTarget]===folder.id&&<Check size={15}/>}</button>)}<button className="sf-library-pill" onClick={() => {setFolderAssignments(current=>{const result={...current};delete result[renameTarget];return result;});setDialog(null);}}>不归入文件夹</button>{folders.length===0&&<button className="sf-library-pill sf-library-dark" onClick={()=>openModal('folder')}><FolderPlus size={16}/>新建文件夹</button>}</div></>}
      {dialog === 'canvas' && <><h2>Connect Canvas</h2><p>将课程与学习资料放在一起。</p><p>此版本尚未接入 Canvas。你可以先上传资料、阅读笔记或练习题，建立自己的学习集。</p><button className="sf-library-pill sf-library-dark" onClick={() => { setDialog(null); onUpload(); }}>上传学习资料</button></>}
      {dialog === 'sparky' && <><h2>随时随地，与小C一起学习</h2><p>你可以在 StudyC 中打开学习集、查看笔记和练习。手机端入口尚未开放，短信服务暂未接入。</p><button className="sf-library-pill sf-library-dark" onClick={() => { setDialog(null); onNavigate('chat'); }}>开始聊天</button></>}
    </dialog>
  </div>;
}

export function DocumentPreview({title,index}:{title:string;index:number}) {
  const section = getStudyContent(title, { stage: readLocal('stage', '高中') }).sections[0];
  return <span className="sf-document-preview" aria-hidden="true"><span className="sf-document-sheet back-one"/><span className="sf-document-sheet back-two"/><span className="sf-document-sheet front"><strong>{title}</strong><p>本笔记涵盖了学习中的核心概念：基础知识、重要方法以及练习要点。通过理解和练习，掌握知识之间的联系。</p><b>{index+1}. {section.title}</b><p>{section.body}</p><b>{index+1}.1 例题与分析</b><p>{section.example}</p><p>从简单练习开始，一步一步理解知识。</p></span></span>;
}
