import { useAuth } from '../auth/AuthProvider';
import { appStorage } from '../lib/account-storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDownUp, ArrowLeft, ArrowRight, Bell, Bold, BookOpen, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock3, Download, FileText, Folder, FolderPlus, GraduationCap, Grid2X2, History, Italic, Lightbulb, List, ListFilter, ListOrdered, Maximize, MoreVertical, NotebookText, Palette, Pencil, Plus, Printer, Redo2, Save, Search, Send, Settings as SettingsIcon, Smartphone, Strikethrough, Timer, Trash2, Underline, Undo2, Upload, X } from 'lucide-react';
import { asset, getCurriculum, initialMaterials, save, stored, units } from '../data';
import './workspace-pages.css';

type Props = { page: string; topic: string; onNavigate: (page: string) => void; onUpload: () => void };
type Material = { id: string; title: string; body: string; type: '笔记' | '文档'; updated: number; folderId?: string; html?: string };
type StudyEvent = { id: string; date: string; title: string; time: string; type: string };
const materialBodies = [
  '# 多项式与二次方程基础\n\n本章从多项式的基本运算出发，学习因式分解与二次方程的求解。\n\n## 1. 多项式基础与运算\n多项式是单项式的和。同类项具有相同的字母和相同的字母指数。合并同类项时，只把系数相加，字母和指数保持不变。\n\n例如：3x² + 2x − x² + 4x = 2x² + 6x。\n\n## 2. 因式分解\n把一个多项式化为几个整式的积，叫做因式分解。常用方法有提公因式法和公式法。\n\na² − b² = (a + b)(a − b)\na² + 2ab + b² = (a + b)²\n\n## 3. 一元二次方程\n一般形式：ax² + bx + c = 0，其中 a ≠ 0。\n判别式 Δ = b² − 4ac。\nΔ > 0 时有两个不相等的实数根；Δ = 0 时有两个相等的实数根；Δ < 0 时没有实数根。\n\n## 4. 练一练\n尝试分解 x² − 5x + 6，再求方程 x² − 5x + 6 = 0 的解。',
  '# 指数与对数函数\n\n本章介绍指数函数与对数函数的基本概念、图像与运算性质。\n\n## 1. 指数函数\n指数函数的一般形式为 y = aˣ，其中 a > 0 且 a ≠ 1。它的定义域为实数集，值域为正实数集，图像经过点 (0, 1)。\n\n当 a > 1 时，函数单调递增；当 0 < a < 1 时，函数单调递减。\n\n## 2. 对数\n若 aˣ = N，则 x = logₐ N。其中 a > 0，a ≠ 1，N > 0。\n\n## 3. 运算性质\nlogₐ(MN) = logₐ M + logₐ N\nlogₐ(M/N) = logₐ M − logₐ N\nlogₐ(Mⁿ) = n logₐ M\n\n使用公式前，先检查底数与真数的取值范围。',
  '# 高次方程与复数\n\n## 1. 多项式方程\n当方程较复杂时，可以先观察是否有公因式，尝试因式分解、换元或降次。\n\n## 2. 复数的概念\n规定 i² = −1。形如 a + bi 的数叫做复数，其中 a、b 为实数。a 是实部，b 是虚部。\n\n## 3. 复数运算\n加减法：实部与实部相加减，虚部与虚部相加减。\n乘法：按照多项式乘法展开，再用 i² = −1 化简。\n\n例如：(1 + i)(1 − i) = 1 − i² = 2。\n\n## 4. 共轭复数\na + bi 与 a − bi 互为共轭复数。它们的积为 a² + b²。',
  '# 函数变换与应用\n\n## 1. 引言\n学习函数变换，能够把复杂图像与熟悉的基本函数建立联系。\n\n## 2. 平移变换\ny = f(x − h) 的图像可以由 y = f(x) 的图像向右平移 h 个单位得到（h > 0）。\ny = f(x) + k 的图像可以由 y = f(x) 的图像向上平移 k 个单位得到（k > 0）。\n\n## 3. 对称变换\ny = −f(x) 与 y = f(x) 关于 x 轴对称。\ny = f(−x) 与 y = f(x) 关于 y 轴对称。\n\n## 4. 应用\n先确定基本图像，再逐步分析变换，最后检查定义域与关键点。',
  '# 数列与组合基础\n\n本笔记涵盖数列中的核心概念：等差数列、等比数列、求和公式，以及基础概率与组合思想。\n\n## 1. 数列\n数列是按照一定顺序排列的一列数。数列中的每一个数叫做项。\n\n## 2. 等差数列\n从第二项起，每一项与前一项的差都等于同一个常数，这样的数列称为等差数列。\naₙ = a₁ + (n − 1)d\nSₙ = n(a₁ + aₙ)/2\n\n## 3. 等比数列\n从第二项起，每一项与前一项的比都等于同一个非零常数，这样的数列称为等比数列。\naₙ = a₁qⁿ⁻¹\n\n## 4. 计数思想\n分类相加，分步相乘。解决问题时，先判断是分类还是分步。',
];
function seededMaterials(): Material[] {
  const selected = getCurriculum();
  const isOriginal = selected.materials[0] === initialMaterials[0];
  const explanations: Record<string,string> = {
    '数与运算':'运算时先计算括号内的部分，再算乘除，最后算加减。同一级运算按从左到右的顺序进行。',
    '分数与小数':'分数表示把单位“1”平均分成若干份，取其中的一份或几份。分子和分母同时乘或除以同一个非零数，分数的大小不变。',
    '图形与几何':'长方形的周长是长与宽的和乘2，面积是长乘宽。计算前先统一长度单位，面积单位与长度单位不同。',
    '解决问题':'先读懂题意，找出已知条件和所求问题，再用数量关系确定计算方法。完成后检查答案是否符合实际。',
    '统计与概率':'统计图能帮助我们比较数据。阅读统计图时，先观察标题、横轴、纵轴和每个刻度表示的数量。',
    '有理数与整式':'合并同类项时，把系数相加，字母和字母的指数保持不变。去括号时，要注意括号前的符号。',
    '方程与不等式':'等式两边同时加上或减去同一个数，等式仍成立。不等式两边同时乘或除以负数时，不等号方向要改变。',
    '函数初步':'在一个变化过程中，如果每个自变量的值都对应唯一的函数值，这种对应关系称为函数关系。',
    '几何与证明':'进行几何证明时，先明确已知条件和需要证明的结论，再寻找可以使用的定义、性质或定理。',
    '字词与表达':'理解词语时，要把词语放回具体句子中，结合上下文确定它的意思，再体会表达效果。',
    '阅读理解':'阅读时先概括每段主要内容，再梳理段落之间的关系。回答问题要回到原文，寻找支持判断的依据。',
    '古诗文积累':'朗读时注意停顿与节奏；理解时结合注释和上下文；背诵时先梳理诗句的顺序与画面。',
    '写作与修改':'围绕一个明确主题组织材料。修改时检查内容是否具体、结构是否清楚、语句是否通顺。',
    '词汇与句型':'学习词汇时同时记录词义、词性和常见搭配，把单词放进句子中理解与练习。',
    '时态与语法':'一般现在时常用于习惯和客观事实，一般过去时常用于过去发生的事情。选择时态时注意上下文中的时间信息。',
    '写作与表达':'先确定要表达的信息，再组织句子。检查主谓一致、时态、拼写与标点，适当使用连接词。',
    '综合练习':'先独立完成题目，再核对解题过程。对不确定的知识点回到笔记复习，之后重新尝试。',
    '综合复习':'把学过的知识分成小主题，尝试不看笔记复述，再用具体练习检查掌握情况。',
    '观察与测量':'科学观察要围绕一个明确的问题进行。测量时先选择合适的工具和单位，再认真读取数值并记录结果。',
    '生命与生长':'观察植物和动物时，关注它们在不同阶段的变化，并记录光照、水分、温度等环境条件。',
    '物质与变化':'比较物质时，可以关注颜色、状态和其他性质。描述变化时，把观察到的现象与自己的解释分开记录。',
    '力与运动':'物体相对于其他物体的位置发生变化，就是运动。力可以改变物体的运动状态，也可以使物体发生形变。',
    '地球与环境':'记录天气时，可以观察气温、云量、降水和风。连续记录有助于发现变化，不能只用一天的观察概括长期情况。',
    '运动、力与能量基础':'平均速度等于路程除以所用时间，常用单位是米每秒。力的单位是牛顿。惯性是物体保持原来运动状态的性质，与物体的质量有关。',
    '机械运动与力':'描述运动前要先选定参照物。分析受力时，明确研究的是哪个物体，再找出周围物体对它施加的力。',
    '声与光':'声音由物体的振动产生，传播需要介质，真空不能传声。光的反射中，反射角等于入射角，两个角都相对于法线测量。',
    '电学基础':'电荷的定向移动形成电流。电压、电流与电阻之间存在联系。在适用条件下，欧姆定律表示为 I = U / R。',
    '实验与测量':'测量前检查工具的量程和分度值。比较实验结果时，应明确改变的条件、保持相同的条件以及需要观察的结果。',
    '物质、元素与化学变化':'判断化学变化的关键是是否生成新物质。化学反应前后，参加反应的物质总质量与生成的物质总质量相等。',
    '原子与分子':'分子和原子都是构成物质的微粒。化学变化中，原子的种类不变，原子会重新组合。化学式可以表示物质的组成。',
    '常见物质的性质':'水的化学式是 H₂O。氧气能支持许多物质的燃烧，但氧气本身通常不作为可燃物。学习物质性质时，应区分性质与用途。',
    '化学方程式':'化学方程式用化学式表示反应物和生成物。配平时调整化学式前面的系数，使反应前后每种元素的原子数相等，不能随意改变化学式。',
    '实验观察与分析':'实验现象是直接观察到的结果，实验结论是根据现象和已有知识作出的解释。记录时应区分这两者，并考虑实验条件。',
    '细胞、生物体与环境':'细胞是生物体结构和功能的基本单位，病毒不具有细胞结构。生态系统既包括生物，也包括与生物相互作用的非生物环境。',
    '细胞的结构与功能':'细胞膜将细胞与外界环境分隔，并控制物质进出。真核细胞的细胞核储存着重要的遗传信息。比较细胞时，注意结构与功能的联系。',
    '光合作用与呼吸作用':'绿色植物通过光合作用利用光能制造有机物。细胞通过呼吸作用分解有机物、释放能量。植物既进行光合作用，也进行呼吸作用。',
    '遗传与生命活动':'遗传信息参与控制生物的性状。研究生长与发育时，要同时考虑遗传因素与环境条件，依据观察和实验作出判断。',
    '生态系统':'生产者能够制造有机物，消费者直接或间接利用其他生物获得营养。食物链表示不同生物之间的取食关系。',
    '中国历史基础时间线':'先把重要事件放到时间线上，再联系发生的背景、过程与影响。时间顺序可以帮助我们理解变化，但不能代替对原因的分析。',
    '古代国家与制度':'比较制度时，先明确它们所处的时代，再观察组织方式、运作方式与社会影响，避免脱离历史背景作判断。',
    '统一多民族国家的发展':'通过具体史实梳理统一与分立、民族交往和中外交流。比较不同时期时，既关注变化，也关注延续。',
    '近代中国的变革':'分析近代历史事件时，可以从时代背景、主要经过与历史影响三个方面整理，并结合史料说明观点。',
    '史料与历史解释':'阅读史料时，先辨认作者、形成时间、材料类型和叙述角度，再比较不同材料，区分史实、观点与推论。',
  };
  return selected.materials.map((title,index) => ({ id:`material-${index}`, title, body:isOriginal ? materialBodies[index] : `# ${title}\n\n${explanations[title] || '围绕核心概念整理笔记，通过例子理解，再独立完成练习。'}\n\n${selected.units[index].map((unit, unitIndex) => `## ${unitIndex+1}. ${unit}\n记录关键概念、典型例子和自己的疑问。`).join('\n\n')}\n\n## 复习自查\n尝试用自己的话讲清楚本节内容，并完成一道相关练习。`,type:'笔记',updated:Date.now()-(selected.materials.length-index)*60000 }));
}
function allStoredMaterials(): Material[] {
  const seeds = seededMaterials();
  const existing = stored<Material[] | null>('materials', null);
  const all = existing ? [...existing] : seeds;
  let changed = !existing;
  if (existing) seeds.forEach(item => {
    if (!all.some(note => note.title === item.title)) {
      all.push({...item,id:`curriculum-${encodeURIComponent(item.title)}`});
      changed = true;
    }
  });
  const uploads = stored<{ title: string; text: string }[]>('uploads', []);
  uploads.forEach((item, index) => { if (!all.some(note => note.id === `upload-${index}`)) {all.push({ id: `upload-${index}`, title: item.title, body: item.text, type: '文档', updated: Date.now() });changed=true;} });
  if (changed) save('materials',all);
  return all;
}
function useMaterials() {
  const [materials, setMaterials] = useState<Material[]>(allStoredMaterials);
  useEffect(() => { const refresh = () => setMaterials(allStoredMaterials()); window.addEventListener('sf-navigation', refresh); return () => window.removeEventListener('sf-navigation', refresh); }, []);
  const update = (next: Material[]) => { setMaterials(next); save('materials', next); };
  return [materials, update] as const;
}
function dateKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
const schoolGrades = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三', '高一', '高二', '高三'];
const learningStages = ['未设置', '自主学习', '大学', '小学', '初中', '高中', ...schoolGrades];
function stageForGrade(value: string) {
  if (value === '小学' || /^[一二三四五六]年级$/.test(value)) return '小学';
  if (value === '初中' || /^初[一二三]$/.test(value)) return '初中';
  if (value === '高中' || /^高[一二三]$/.test(value)) return '高中';
  return value === '大学' || value === '自主学习' ? value : '未设置';
}
function currentGrade() {
  const stage = stored<string>('stage', '未设置');
  const grade = stored<{ grade?: string }>('profile', {}).grade;
  if (typeof grade === 'string' && learningStages.includes(grade) && stageForGrade(grade) === stage) return grade;
  return learningStages.includes(stage) ? stage : '未设置';
}

export default function WorkspacePages({ page, topic, onNavigate, onUpload }: Props) {
  if (page === 'study-plan') return <StudyPlan topic={topic} onNavigate={onNavigate} />;
  if (page === 'materials' || page === 'material') return <Materials page={page} onNavigate={onNavigate} onUpload={onUpload} />;
  if (page === 'calendar') return <StudyCalendar topic={topic} onNavigate={onNavigate} onUpload={onUpload} />;
  if (page === 'settings' || page === 'profile') return <Settings onNavigate={onNavigate} />;
  if (page === 'qbank') return <QuestionBank onNavigate={onNavigate} />;
  return <Materials page="materials" onNavigate={onNavigate} onUpload={onUpload} />;
}

function StudyPlan({ topic, onNavigate }: Pick<Props, 'topic' | 'onNavigate'>) {
  const { materials: initialMaterials, units } = getCurriculum(undefined, topic);
  const [expanded, setExpanded] = useState<number[]>([0]);
  const [complete, setComplete] = useState<string[]>(() => stored('plan-completed', []));
  const allUnits = units.flat();
  const completedCount = complete.filter(item => allUnits.includes(item)).length;
  function toggleComplete(item: string) { const next = complete.includes(item) ? complete.filter(value => value !== item) : [...complete, item]; setComplete(next); save('plan-completed', next); }
  return <section className="sf-work-page sf-work-plan">
    <div className="sf-work-plan-heading"><div><h1>学习计划</h1><p>按照自己的节奏，掌握每一个主题。</p></div><button className="btn" onClick={() => onNavigate('calendar')}><CalendarDays />学习日历</button></div>
    <div className="sf-work-plan-progress"><BookOpen size={18} /><span>{allUnits.length} 个主题</span><span className="sf-work-divider" /><CheckCircle2 size={18} /><span>已掌握 {completedCount}</span><div className="progress-track"><span style={{ width: `${completedCount / allUnits.length * 100}%` }} /></div><small>{Math.round(completedCount / allUnits.length * 100)}%</small></div>
    <div className="sf-work-timeline">
      <div className="sf-work-start"><span><Send size={21} /></span><strong>从这里开始学习</strong></div>
      {units.map((items, index) => <section className="sf-work-unit" key={initialMaterials[index]}>
        <button className="sf-work-unit-heading" aria-expanded={expanded.includes(index)} onClick={() => setExpanded(expanded.includes(index) ? expanded.filter(i => i !== index) : [...expanded, index])}><ChevronDown className={expanded.includes(index) ? '' : 'is-closed'} /><span className={`sf-work-node ${items.every(item => complete.includes(item)) ? 'is-done' : ''}`}>{items.every(item => complete.includes(item)) && <Check size={12} />}</span><strong>{initialMaterials[index]}</strong><small>{items.filter(item => complete.includes(item)).length} / {items.length}</small></button>
        {expanded.includes(index) && <div className="sf-work-unit-items">
          {index === 0 && <button className="sf-work-diagnostic" onClick={() => onNavigate('quiz')}><span className="sf-work-timer-node"><Timer size={18} /></span><span><strong>看看你已经知道了什么</strong><small>需要3分钟</small></span><span className="sf-work-time-saved">节省时间</span><ChevronRight size={16} /></button>}
          {items.map(item => <div className={`sf-work-topic ${complete.includes(item) ? 'is-done' : ''}`} key={item}><button className="sf-work-node" aria-label={`${complete.includes(item) ? '取消完成' : '标记完成'} ${item}`} aria-pressed={complete.includes(item)} onClick={() => toggleComplete(item)}>{complete.includes(item) && <Check size={13} />}</button><button className="sf-work-topic-name" onClick={() => { save('active-unit', item); onNavigate('read'); }}>{item}</button><button className="sf-work-topic-practice" onClick={() => { save('active-unit', item); onNavigate('quiz'); }}>练习<ChevronRight size={13} /></button></div>)}
        </div>}
      </section>)}
    </div>
  </section>;
}

function Materials({ page, onNavigate, onUpload }: Pick<Props, 'page' | 'onNavigate' | 'onUpload'>) {
  const [materials, setMaterials] = useMaterials();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('全部资料');
  const getSelected = () => { const value = stored<number | string>('selectedMaterial', 0); if(typeof value === 'string')return value;const title=getCurriculum().materials[value];return allStoredMaterials().find(item => item.title === title)?.id || `material-${value}`; };
  const [selected, setSelected] = useState(getSelected);
  const [sort, setSort] = useState('最近');
  const [listView, setListView] = useState(false);
  const [folders, setFolders] = useState<{ id: string; title: string }[]>(() => stored('material-folders', []));
  const [folderId, setFolderId] = useState('');
  const [folderModal, setFolderModal] = useState(false);
  const [folderName, setFolderName] = useState('');
  const material = materials.find(item => item.id === selected) || materials[0];
  useEffect(() => { if (page === 'material') setSelected(getSelected()); }, [page]);
  useEffect(() => { const refresh = () => setSelected(getSelected()); window.addEventListener('sf-navigation', refresh); return () => window.removeEventListener('sf-navigation', refresh); }, []);
  function openMaterial(id: string) { setSelected(id); save('selectedMaterial', id); onNavigate('material'); }
  function newNote() {
    const note: Material = { id: crypto.randomUUID(), title: '未命名笔记', body: '# 未命名笔记\n\n在这里记录学习内容。', type: '笔记', updated: Date.now(), folderId };
    setMaterials([note, ...materials]); setSelected(note.id); save('selectedMaterial', note.id); onNavigate('material');
  }
  const visible = materials.filter(item => item.title.toLowerCase().includes(search.toLowerCase()) && (filter === '全部资料' || item.type === filter) && (!folderId || item.folderId === folderId)).sort((a, b) => sort === '最近' ? b.updated - a.updated : a.title.localeCompare(b.title, 'zh-CN'));
  if (page === 'material' && material) return <RichNote material={material} onSave={(body, html) => setMaterials(materials.map(item => item.id === material.id ? { ...item, body, html, updated: Date.now() } : item))} />;
  return <section className="sf-work-page sf-work-materials">
    <div className="sf-work-material-heading"><div><span><FileText size={24} /></span><h1>{folderId ? folders.find(item => item.id === folderId)?.title : '材料'}</h1></div><div><button className="btn btn-soft" onClick={() => { setFolderName(''); setFolderModal(true); }}><FolderPlus />Folder</button><button className="btn btn-black" onClick={onUpload}><Upload />上传材料</button></div></div>
    <div className="sf-work-tools"><button className="sf-work-set-filter" onClick={() => { setFolderId(''); setFilter('全部资料'); }}><img src={asset('visuals')} alt="" />M.<ChevronDown size={15} /></button><label className="sf-work-filter"><ListFilter size={17} /><select value={filter} onChange={e => setFilter(e.target.value)} aria-label="资料类型"><option value="全部资料">所有类型</option><option>笔记</option><option>文档</option></select></label><label className="sf-work-filter"><ArrowDownUp size={16} /><select value={sort} onChange={e => setSort(e.target.value)} aria-label="排序方式"><option>最近</option><option>名称</option></select></label><div className="sf-work-layout-toggle"><button className={!listView ? 'is-selected' : ''} aria-label="网格视图" onClick={() => setListView(false)}><Grid2X2 size={20} /></button><button className={listView ? 'is-selected' : ''} aria-label="列表视图" onClick={() => setListView(true)}><List size={20} /></button></div><label className="sf-work-search"><Search size={18} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索材料..." /></label></div>
    <div className={`sf-work-material-grid ${listView ? 'is-list-view' : ''}`}>
      {!search && !folderId && <><button className="sf-work-material-add" onClick={onUpload}><span><Upload size={60} /></span><strong><Upload size={18} />添加材料</strong></button><button className="sf-work-material-add" onClick={() => { setFolderName(''); setFolderModal(true); }}><span><FolderPlus size={60} /></span><strong><FolderPlus size={18} />创建文件夹</strong></button>{folders.map(folder => <button className="sf-work-folder-card" key={folder.id} onClick={() => setFolderId(folder.id)}><Folder size={70} /><strong>{folder.title}</strong><span>{materials.filter(item => item.folderId === folder.id).length} 份资料</span></button>)}</>}
      {visible.map(item => <button key={item.id} className="sf-work-material-card" onClick={() => openMaterial(item.id)}><div className="sf-work-note-preview"><div className="sf-work-preview-sheet"><DocumentContent body={item.body} /></div></div><span className="sf-work-material-name"><NotebookText size={18} /><strong>{item.title}</strong><MoreVertical size={15} /></span></button>)}
    </div>
    {!visible.length && <div className="empty-state"><img src={asset('notes')} alt="" /><h2>{folderId ? '这个文件夹还没有资料' : '未找到学习资料'}</h2><p>{folderId ? '从一份新的学习笔记开始。' : '试试其他关键词，或上传新的学习资料。'}</p><button className="btn" onClick={folderId ? newNote : onUpload}><Plus />{folderId ? '创建笔记' : '上传资料'}</button></div>}
    {folderModal && <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setFolderModal(false)}><form className="modal" role="dialog" aria-modal="true" onSubmit={e => { e.preventDefault(); if (!folderName.trim()) return; const next = [...folders, { id: crypto.randomUUID(), title: folderName.trim() }]; setFolders(next); save('material-folders', next); setFolderModal(false); }}><div className="modal-head"><h2>创建文件夹</h2><button type="button" className="icon-button" aria-label="关闭" onClick={() => setFolderModal(false)}><X /></button></div><label>文件夹名称<input className="field" autoFocus required maxLength={60} value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="例如：期末复习" /></label><div className="modal-actions"><button type="button" className="btn" onClick={() => setFolderModal(false)}>取消</button><button className="btn btn-black">创建</button></div></form></div>}
  </section>;
}

function markdownToHtml(body: string) {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return body.split('\n').map(line => line.startsWith('# ') ? `<h1>${escape(line.slice(2))}</h1>` : line.startsWith('## ') ? `<h2>${escape(line.slice(3))}</h2>` : line.trim() ? `<p>${escape(line)}</p>` : '').join('');
}
function cleanNoteHtml(value: string) {
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  parsed.querySelectorAll('script,style,iframe,object,embed,link,meta,img,video,audio,svg,math').forEach(node => node.remove());
  const allowed = new Set(['P','DIV','BR','H1','H2','H3','STRONG','B','EM','I','U','S','STRIKE','UL','OL','LI','BLOCKQUOTE','PRE','CODE','HR','TABLE','THEAD','TBODY','TR','TH','TD','SPAN','FONT']);
  parsed.body.querySelectorAll('*').forEach(node => {
    if (!allowed.has(node.tagName)) { node.replaceWith(...Array.from(node.childNodes)); return; }
    Array.from(node.attributes).forEach(attribute => {
      if (!['style','face','size','color','align'].includes(attribute.name)) node.removeAttribute(attribute.name);
    });
    if (node instanceof HTMLElement) {
      const permitted = ['font-family','font-size','font-weight','font-style','text-decoration','text-align','color','background-color'];
      Array.from(node.style).forEach(property => { if (!permitted.includes(property)) node.style.removeProperty(property); });
    }
  });
  return parsed.body.innerHTML;
}
function RichNote({ material, onSave }: { material: Material; onSave: (body: string, html: string) => void }) {
  const editor = useRef<HTMLDivElement>(null);
  const savedVersion = useRef(material.html || markdownToHtml(material.body));
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState('');
  const [font, setFont] = useState('Inter');
  const [fontSize, setFontSize] = useState('11');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (editor.current) editor.current.innerHTML = cleanNoteHtml(material.html || markdownToHtml(material.body));
    savedVersion.current = material.html || markdownToHtml(material.body);
    setStatus('');
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [material.id]);
  function flush() {
    if (!editor.current) return;
    if (debounce.current) clearTimeout(debounce.current);
    onSave(editor.current.innerText, cleanNoteHtml(editor.current.innerHTML)); setStatus('已保存');
  }
  function input() { setStatus('正在保存…'); if (debounce.current) clearTimeout(debounce.current); debounce.current = setTimeout(flush, 450); }
  function command(name: string, value?: string) { editor.current?.focus(); document.execCommand(name, false, value); input(); }
  const toolbarButton = (label: string, commandName: string, Icon: typeof Bold) => <button type="button" title={label} aria-label={label} onMouseDown={e => e.preventDefault()} onClick={() => command(commandName)}><Icon size={19} /></button>;
  return <section className={`sf-work-page sf-work-rich-note ${wide ? 'is-expanded' : ''}`}>
    <div className="sf-work-rich-toolbar" role="toolbar" aria-label="笔记格式工具">
      <select aria-label="字体" value={font} onChange={e => { setFont(e.target.value); command('fontName',e.target.value); }}><option>Inter</option><option>Bitter</option><option>Georgia</option></select>
      <select aria-label="字体大小" value={fontSize} onChange={e => { setFontSize(e.target.value); command('fontSize',({ '9':'1','11':'2','14':'3','18':'4','24':'5','32':'6' } as Record<string,string>)[e.target.value]); }}><option>9</option><option>11</option><option>14</option><option>18</option><option>24</option><option>32</option></select>
      <i />{toolbarButton('粗体','bold',Bold)}{toolbarButton('斜体','italic',Italic)}{toolbarButton('下划线','underline',Underline)}{toolbarButton('删除线','strikeThrough',Strikethrough)}<i />
      <label className="sf-work-color-picker" title="文字颜色"><Palette size={19} /><input type="color" aria-label="文字颜色" defaultValue="#191919" onChange={e => command('foreColor', e.target.value)} /></label><i />
      {toolbarButton('左对齐','justifyLeft',AlignLeft)}{toolbarButton('居中','justifyCenter',AlignCenter)}{toolbarButton('右对齐','justifyRight',AlignRight)}<i />{toolbarButton('有序列表','insertOrderedList',ListOrdered)}{toolbarButton('无序列表','insertUnorderedList',List)}<i />{toolbarButton('撤销','undo',Undo2)}{toolbarButton('重做','redo',Redo2)}<i />{toolbarButton('插入分隔线','insertHorizontalRule',Plus)}<i />
      <button type="button" aria-label="版本记录" title="版本记录" onClick={() => setHistoryOpen(true)}><History size={19} /></button><button type="button" aria-label="打印笔记" title="打印笔记" onClick={() => window.print()}><Printer size={19} /></button><button type="button" aria-label={wide ? '退出展开' : '展开编辑器'} title="展开编辑器" onClick={() => setWide(!wide)}><Maximize size={19} /></button>
    </div>
    <div ref={editor} className="sf-work-rich-editor" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="编辑学习笔记" onInput={input} onBlur={flush} onPaste={e => { e.preventDefault(); command('insertText', e.clipboardData.getData('text/plain')); }} />
    {status && <span className="sf-work-rich-status" role="status"><Check size={12} />{status}</span>}
    {historyOpen && <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setHistoryOpen(false)}><section className="modal" role="dialog" aria-modal="true"><div className="modal-head"><h2>版本记录</h2><button className="icon-button" aria-label="关闭" onClick={() => setHistoryOpen(false)}><X /></button></div><p className="muted">可以恢复本次打开笔记时的版本。当前修改会被替换。</p><div className="modal-actions"><button className="btn" onClick={() => setHistoryOpen(false)}>取消</button><button className="btn btn-black" onClick={() => { if (editor.current) editor.current.innerHTML = cleanNoteHtml(savedVersion.current); flush(); setHistoryOpen(false); }}>恢复打开时的版本</button></div></section></div>}
  </section>;
}

function DocumentContent({ body }: { body: string }) {
  return <div className="sf-work-document-content">{body.split('\n').map((line, index) => line.startsWith('# ') ? <h1 key={index}>{line.slice(2)}</h1> : line.startsWith('## ') ? <h2 key={index}>{line.slice(3)}</h2> : line.trim() ? <p key={index}>{line}</p> : <div className="sf-work-doc-space" key={index} />)}</div>;
}

function StudyCalendar({ topic, onNavigate, onUpload }: Pick<Props, 'topic' | 'onNavigate' | 'onUpload'>) {
  const now = useMemo(() => new Date(), []);
  const [focusDate, setFocusDate] = useState(() => new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [events, setEvents] = useState<StudyEvent[]>(() => stored('calendar-events', []));
  const [selectedDate, setSelectedDate] = useState('');
  const [eventTitle, setEventTitle] = useState('');
  const [eventTime, setEventTime] = useState('16:00');
  const [eventType, setEventType] = useState('学习');
  const [error, setError] = useState('');
  const [view, setView] = useState('周');
  const [banner, setBanner] = useState(() => !stored('calendar-reminder-dismissed', false));
  const [connection, setConnection] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [timeZone, setTimeZone] = useState(() => stored('calendar-zone', '中国时间'));
  const weekScroller = useRef<HTMLDivElement>(null);
  const pendingEventFocus = useRef<{date:string;time:string} | null>(null);
  const [calendarFeedback, setCalendarFeedback] = useState('');
  useEffect(() => {
    const scroller = weekScroller.current;
    if (!scroller) return;
    const pending = pendingEventFocus.current;
    if (pending) {
      const [year,monthIndex,day] = pending.date.split('-').map(Number);
      const eventDate = new Date(year,monthIndex-1,day);
      scroller.scrollTop = Math.max(0,(Number(pending.time.split(':')[0])-1)*52);
      scroller.scrollLeft = view === '日' ? 0 : Math.max(0,80+eventDate.getDay()*120-(scroller.clientWidth-120)/2);
      pendingEventFocus.current = null;
    } else scroller.scrollTop = 7*52;
  }, [view, focusDate, events]);
  useEffect(() => { if(!calendarFeedback)return; const timer = setTimeout(() => setCalendarFeedback(''),4000);return () => clearTimeout(timer); },[calendarFeedback]);
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = firstDay.getDay();
  const days = Array.from({ length: 42 }, (_, index) => new Date(month.getFullYear(), month.getMonth(), index - offset + 1));
  const start = new Date(focusDate.getFullYear(), focusDate.getMonth(), focusDate.getDate() - focusDate.getDay());
  const weekDays = view === '日' ? [focusDate] : Array.from({ length: 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  const end = weekDays[weekDays.length - 1];
  const displayDate = (date: Date) => `${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()}`;
  function changeDate(direction: number) {
    const next = new Date(focusDate);
    if (view === '月') next.setMonth(next.getMonth() + direction);
    else next.setDate(next.getDate() + direction * (view === '周' ? 7 : 1));
    setFocusDate(next); setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  }
  function openDay(date: string, time = '16:00', type = '学习') { setSelectedDate(date); setEventTitle(''); setEventTime(time); setEventType(type); setError(''); }
  function createEvent() {
    if (!eventTitle.trim()) { setError('请输入事件名称'); return; }
    if (!eventTime || !selectedDate) { setError('请输入日期与时间'); return; }
    const next = [...events, { id:crypto.randomUUID(),date:selectedDate,title:eventTitle.trim(),time:eventTime,type:eventType }];
    const [year,monthIndex,day] = selectedDate.split('-').map(Number);
    pendingEventFocus.current = { date:selectedDate,time:eventTime };
    setEvents(next);save('calendar-events',next);
    setFocusDate(new Date(year,monthIndex-1,day));setMonth(new Date(year,monthIndex-1,1));
    setCalendarFeedback(`已添加：${eventTitle.trim()} · ${selectedDate} ${eventTime}`);setSelectedDate('');
  }
  function removeEvent(id: string) { const next = events.filter(item => item.id !== id); setEvents(next); save('calendar-events', next); }
  const thisWeekEmpty = !events.some(item => weekDays.some(day => dateKey(day) === item.date));
  return <section className="sf-work-page sf-work-calendar">
    <div className="sf-work-calendar-toolbar"><div><button className="btn" onClick={() => { setFocusDate(now); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); }}>今天</button><button className="icon-button" aria-label="上一时段" onClick={() => changeDate(-1)}><ChevronLeft /></button><button className="icon-button" aria-label="下一时段" onClick={() => changeDate(1)}><ChevronRight /></button><h1>{view === '月' ? `${month.getFullYear()}年${month.getMonth()+1}月` : view === '日' ? displayDate(focusDate) : `${displayDate(start)} – ${displayDate(end)}`}</h1></div><div><div className="sf-work-calendar-view">{['日', '周', '月'].map(item => <button className={view === item ? 'is-selected' : ''} key={item} onClick={() => setView(item)}>{item}</button>)}</div><button className="btn btn-black" onClick={() => openDay(dateKey(focusDate))}><Plus />添加</button><button className="icon-button" aria-label="日历设置" onClick={() => setShowSettings(true)}><SettingsIcon /></button></div></div>
    {banner && <div className="sf-work-reminders"><Bell size={23} /><div><strong>Be ready when class starts</strong><p>Get reminders for classes, exams and study sessions, plus a nudge to record when class starts.</p></div><button className="btn btn-black" onClick={() => setConnection('学习提醒')}>Enable reminders</button><button className="icon-button" aria-label="关闭提醒提示" onClick={() => { setBanner(false); save('calendar-reminder-dismissed', true); }}><X size={18} /></button></div>}
    <div className="sf-work-calendar-body">
      <aside className="sf-work-mini-calendar"><div className="sf-work-mini-month"><strong>{month.getFullYear()}年{month.getMonth()+1}月</strong><button className="icon-button" aria-label="上一个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth()-1, 1))}><ChevronLeft size={16} /></button><button className="icon-button" aria-label="下一个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth()+1, 1))}><ChevronRight size={16} /></button></div><div className="sf-work-mini-weekdays">{['日','一','二','三','四','五','六'].map(day => <span key={day}>{day}</span>)}</div><div className="sf-work-mini-days">{days.map(day => <button key={dateKey(day)} className={`${day.getMonth() !== month.getMonth() ? 'is-muted' : ''} ${dateKey(day) === dateKey(now) ? 'is-today' : ''} ${weekDays.some(weekDay => dateKey(weekDay) === dateKey(day)) ? 'is-week' : ''}`} onClick={() => setFocusDate(day)}>{day.getDate()}</button>)}</div><div className="sf-work-calendar-links"><button onClick={() => setConnection('Canvas 日历')}><span className="sf-work-canvas-mark">◉</span>Link Canvas calendar</button><button onClick={() => setConnection('Google 日历')}><img src={asset('source-google')} alt="" />关联 Google 日历</button></div><div className="sf-work-syllabus"><h2>整理学习安排</h2><p>添加学习资料，在日历中手动安排复习。</p><button onClick={onUpload}><img src={asset('visuals')} alt="" /><span>{topic}</span><Upload size={16} /></button><button className="sf-work-syllabus-new" onClick={() => onNavigate('studysets')}><Plus size={16} />新建学习集</button></div></aside>
      <div className="sf-work-calendar-main">{view === '月' ? <div className="sf-work-calendar-grid"><div className="sf-work-weekdays">{['星期日','星期一', '星期二', '星期三', '星期四', '星期五', '星期六'].map(day => <span key={day}>{day}</span>)}</div><div className="sf-work-days">{days.map(day => <button className={`sf-work-day ${day.getMonth() !== month.getMonth() ? 'is-other-month' : ''} ${dateKey(day) === dateKey(now) ? 'is-today' : ''}`} key={dateKey(day)} onClick={() => openDay(dateKey(day))}><span className="sf-work-day-number">{day.getDate()}</span><span className="sf-work-day-events">{events.filter(item => item.date === dateKey(day)).slice(0, 3).map(item => <span className={`sf-work-calendar-event sf-event-${item.type}`} key={item.id}><small>{item.time}</small>{item.title}</span>)}</span></button>)}</div></div> : <div className="sf-work-week-view"><div className="sf-work-week-scroll" ref={weekScroller}><div className="sf-work-week-header" style={{ gridTemplateColumns: `80px repeat(${weekDays.length}, minmax(120px,1fr))` }}><span>{timeZone}</span>{weekDays.map(day => <button key={dateKey(day)} onClick={() => { setFocusDate(day); setView('日'); }}><small>周{['日','一','二','三','四','五','六'][day.getDay()]}</small><strong className={dateKey(day) === dateKey(now) ? 'is-today' : ''}>{day.getDate()}</strong></button>)}</div><div className="sf-work-hour-rows">{Array.from({length:24},(_,index) => index).map(hour => <div key={hour} className="sf-work-hour-row" style={{ gridTemplateColumns: `80px repeat(${weekDays.length}, minmax(120px,1fr))` }}><span>{hour}:00</span>{weekDays.map(day => <button key={dateKey(day)} aria-label={`${dateKey(day)} ${hour}:00 ${events.filter(item => item.date === dateKey(day) && Number(item.time.split(':')[0]) === hour).map(item => `${item.time} ${item.title}`).join('；')} 添加事件`} onClick={() => openDay(dateKey(day), `${String(hour).padStart(2,'0')}:00`)}>{events.filter(item => item.date === dateKey(day) && Number(item.time.split(':')[0]) === hour).map(item => <span key={item.id} className={`sf-work-calendar-event sf-event-${item.type}`}>{item.time} {item.title}</span>)}</button>)}</div>)}</div></div>{thisWeekEmpty && <div className="sf-work-first-exam"><CalendarDays size={36} strokeWidth={1.5} /><h2>添加你的第一场考试</h2><p>告诉我们考试的时间和范围，我们会在你空闲的时段安排学习时间。</p><button className="btn btn-black" onClick={() => openDay(dateKey(focusDate),'16:00','考试')}><GraduationCap />添加考试</button></div>}</div>}</div>
    </div>
    {calendarFeedback && <div className="toast" role="status">{calendarFeedback}</div>}
    {selectedDate && <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setSelectedDate('')}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="sf-calendar-dialog"><div className="modal-head"><h2 id="sf-calendar-dialog">安排事件</h2><button className="icon-button" aria-label="关闭" onClick={() => setSelectedDate('')}><X /></button></div><p className="muted">在这里你可以安排即将到来的考试、作业、测验或学习时间。</p><label>名称<input className="field" autoFocus value={eventTitle} onChange={e => setEventTitle(e.target.value)} placeholder="例如：复习二次方程" /></label><div className="sf-work-event-fields"><label>日期<input className="field" type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} /></label><label>时间<input className="field" type="time" value={eventTime} onChange={e => setEventTime(e.target.value)} /></label></div><label>类型<select className="field" value={eventType} onChange={e => setEventType(e.target.value)}>{['学习', '考试', '作业', '测验'].map(type => <option key={type}>{type}</option>)}</select></label>{events.filter(item => item.date === selectedDate).length > 0 && <div className="sf-work-day-agenda"><h3>当天安排</h3>{events.filter(item => item.date === selectedDate).map(item => <div key={item.id}><span>{item.time} · {item.title}</span><button className="icon-button" aria-label={`删除 ${item.title}`} onClick={() => removeEvent(item.id)}><Trash2 size={14} /></button></div>)}</div>}{error && <p className="sf-work-form-error" role="alert">{error}</p>}<div className="modal-actions"><button className="btn" onClick={() => setSelectedDate('')}>取消</button><button className="btn btn-black" onClick={createEvent}>创建事件</button></div></section></div>}
    {(connection || showSettings) && <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && (setConnection(''),setShowSettings(false))}><section className="modal" role="dialog" aria-modal="true"><div className="modal-head"><h2>{connection || '日历设置'}</h2><button className="icon-button" aria-label="关闭" onClick={() => {setConnection('');setShowSettings(false);}}><X /></button></div>{showSettings ? <><label>显示时区<select className="field" value={timeZone} onChange={e => {setTimeZone(e.target.value);save('calendar-zone',e.target.value);}}><option>中国时间</option><option>本地时间</option></select></label><p className="muted">所有安排保存在当前浏览器。</p></> : <p className="muted">{connection === '学习提醒' ? '此本地版本尚未连接推送通知。你可以在日历中保存学习安排，并在此查看。' : `${connection}同步尚未连接。你可以先手动添加课程和考试。`}</p>}<div className="modal-actions"><button className="btn btn-black" onClick={() => {setConnection('');setShowSettings(false);}}>完成</button></div></section></div>}
  </section>;
}

function Settings({ onNavigate }: Pick<Props, 'onNavigate'>) {
  const auth = useAuth();
  const [profile, setProfile] = useState(() => ({ name:'学习者', username:'learner', language:'简体中文', avatar:'', ...stored<Record<string,string>>('profile', {}), grade:currentGrade() }));
  const [activeTab, setActiveTab] = useState('设置');
  const [feedback, setFeedback] = useState('');
  const [notice, setNotice] = useState('');
  const avatarInput = useRef<HTMLInputElement>(null);
  const tabs = ['设置','订阅','用量','通知','个性化','应用集成','隐私与数据','支持'];
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile.name.trim() || !profile.username.trim()) { setFeedback('请输入名字和用户名。'); return; }
    save('profile', { ...profile, name:profile.name.trim(),username:profile.username.trim() });
    save('stage', stageForGrade(profile.grade));
    setFeedback('更改已保存在此设备。');window.dispatchEvent(new Event('sf-profile-updated'));
  }
  function exportData() {
    const data:Record<string,unknown> = {};
    for (const key of appStorage.keys()) { const value=appStorage.getItem(key);try {data[key]=JSON.parse(value || 'null');} catch {data[key]=value;} }
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`studyc-${dateKey(new Date())}.json`;link.click();setTimeout(() => URL.revokeObjectURL(url),1000);
    setFeedback('学习数据已导出。');
  }
  const profileFields = <div className="sf-profile-fields"><label>账户<input className="field" value={auth.isPreview ? "本地界面预览" : "PlanPlan 共用账户"} disabled /><small>{auth.isPreview ? "尚未登录" : "与 PlanPlan 使用相同的注册邮箱和密码"}</small></label><label>你的用户名<input className="field" value={profile.username} onChange={e => setProfile({...profile,username:e.target.value})} maxLength={30} autoComplete="username" /></label><label>你的名字<input className="field" value={profile.name} onChange={e => setProfile({...profile,name:e.target.value})} maxLength={30} autoComplete="name" /></label><label>语言<select className="field" value={profile.language} onChange={e => setProfile({...profile,language:e.target.value})}><option>简体中文</option></select></label><label>学习阶段（可选）<select className="field" value={profile.grade} onChange={e => setProfile({...profile,grade:e.target.value})}>{learningStages.map(grade => <option key={grade}>{grade}</option>)}</select></label></div>;
  return <section className="sf-work-page sf-work-settings sf-profile-page">
    <div className="sf-profile-navigation"><div className="sf-profile-tabs" role="tablist" aria-label="设置分类">{tabs.map(tab => <button role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? 'is-selected' : ''} key={tab} onClick={() => {setActiveTab(tab);setFeedback('');}}>{tab}</button>)}</div><button className="sf-profile-mac" onClick={() => setNotice('Mac 应用尚未提供。你可以继续在浏览器中使用学习工具。')}>获取 Mac 应用</button><button className="btn sf-profile-signout" onClick={() => { if(auth.isPreview) auth.leavePreview(); else void auth.logout(); }}>{auth.isPreview ? '登录账户' : '退出所有设备'}</button></div>
    {activeTab === '设置' ? <form className="sf-profile-form" onSubmit={submit}>
      <div className="sf-profile-avatar-field"><label>头像</label><button className="sf-profile-avatar" type="button" title="更换头像" onClick={() => avatarInput.current?.click()}>{profile.avatar ? <img src={profile.avatar} alt="你的头像" /> : <span>{profile.name.trim().slice(0,2).toUpperCase() || 'SC'}</span>}</button><input ref={avatarInput} type="file" hidden accept="image/*" onChange={e => { const file=e.target.files?.[0];if(!file)return;if(file.size>2*1024*1024){setNotice('请选择小于 2 MB 的图片。');return;}const reader=new FileReader();reader.onload=() => setProfile(p => ({...p,avatar:String(reader.result)}));reader.readAsDataURL(file); }} /><small>推荐尺寸：200x200</small></div>
      <div className="sf-profile-mobile-cards"><div><h2>StudyC 手机端</h2><p>手机端入口尚未开放。</p><button type="button" className="btn btn-black" onClick={() => setNotice('StudyC 手机端入口尚未开放。当前资料与学习记录仅保存在此浏览器。')}><Smartphone size={15} />了解手机端</button></div><div className="sf-profile-sparky-card"><div><h2><Smartphone size={18} />小C短信</h2><p>手机端入口尚未开放。</p></div><span aria-hidden="true" style={{width:'clamp(106px, 10vw, 120px)',aspectRatio:'1',flexShrink:0,display:'grid',placeItems:'center',alignSelf:'center',borderRadius:12,background:'white',boxShadow:'0 5px 10px #19191913'}}><Smartphone size={48} strokeWidth={1.5}/></span></div></div>
      {profileFields}<div className="sf-profile-save"><button type="submit" className="btn btn-black">保存更改</button>{feedback && <span role="status">{feedback}</span>}</div>
    </form> : activeTab === '个性化' ? <form className="sf-profile-form sf-profile-tab-panel" onSubmit={submit}><h1>个性化</h1><p>设置你的显示名称，也可以选择学习阶段。学习阶段不限制可使用的工具。</p>{profileFields}<div className="sf-profile-save"><button type="submit" className="btn btn-black">保存更改</button>{feedback && <span role="status">{feedback}</span>}</div></form> : <div className="sf-profile-tab-panel" role="tabpanel"><h1>{activeTab}</h1>
      {activeTab === '订阅' ? <><p>当前使用本地预览模式。你可以查看会员方案，付费功能尚未开放。</p><button className="btn btn-black" onClick={() => onNavigate('paywall')}>查看会员方案</button></> : activeTab === '用量' ? <><p>此浏览器中的学习记录。</p><div className="sf-profile-usage">{[{label:'学习材料',value:allStoredMaterials().length},{label:'学习安排',value:stored<StudyEvent[]>('calendar-events',[]).length},{label:'已完成主题',value:stored<string[]>('plan-completed',[]).length}].map(item => <div key={item.label}><strong>{item.value}</strong><span>{item.label}</span></div>)}</div></> : activeTab === '通知' ? <><p>推送通知尚未连接。你可以在日历中查看并安排学习时间。</p><button className="btn" onClick={() => onNavigate('calendar')}><CalendarDays />打开学习日历</button></> : activeTab === '应用集成' ? <><p>连接你的日历与学习工具。</p><div className="sf-profile-integrations">{['Google 日历','Canvas 日历'].map(name => <button className="btn" key={name} onClick={() => setNotice(`${name}同步尚未连接。你可以先在学习日历中手动添加课程与考试。`)}>{name}<Plus size={16} /></button>)}</div></> : activeTab === '隐私与数据' ? <><p>个人资料、笔记和学习进度保存在此浏览器。你可以导出一份副本。</p><button className="btn" onClick={exportData}><Download />导出学习数据</button>{feedback && <p role="status">{feedback}</p>}</> : <><p>从学习计划开始，阅读材料、练习知识点，再用学习日历安排复习。</p><button className="btn" onClick={() => onNavigate('study-plan')}><BookOpen />查看学习计划</button></>}
    </div>}
    {notice && <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setNotice('')}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="sf-profile-notice"><div className="modal-head"><h2 id="sf-profile-notice">功能说明</h2><button className="icon-button" aria-label="关闭" onClick={() => setNotice('')}><X /></button></div><p className="muted">{notice}</p><div className="modal-actions"><button className="btn btn-black" onClick={() => setNotice('')}>知道了</button></div></section></div>}
  </section>;
}

function QuestionBank({ onNavigate }: Pick<Props, 'onNavigate'>) {
  const [subject, setSubject] = useState('数学');
  const [search, setSearch] = useState('');
  const [chosenStage,setChosenStage] = useState('');
  const [demo,setDemo] = useState(0);
  const [demoAnswer,setDemoAnswer] = useState<number | null>(null);
  const courseSubjects: Record<string, string[]> = {
    小学: ['数学','语文','英语','科学'],
    初中: ['数学','语文','英语','物理','化学','生物','历史'],
    高中: ['数学','语文','英语','物理','化学','生物','历史'],
  };
  const courseStages = chosenStage && chosenStage !== 'all' ? [chosenStage] : Object.keys(courseSubjects);
  const subjects = [...new Set(courseStages.flatMap(stage => courseSubjects[stage]))];
  const available = Object.fromEntries(subjects.map(name => {
    const topics = new Map<string, { topic: string; stage: string }>();
    for (const stage of courseStages) {
      if (!courseSubjects[stage].includes(name)) continue;
      for (const topic of getCurriculum(stage, name).units.flat()) {
        if (!topics.has(topic)) topics.set(topic, { topic, stage });
      }
    }
    return [name, [...topics.values()]];
  }));
  const items = (available[subject] || []).filter(item => item.topic.includes(search));
  function chooseStage(stage: string) {
    setChosenStage(stage);
    if (stage !== 'all' && !courseSubjects[stage].includes(subject)) setSubject('数学');
    setSearch('');
  }
  function chooseSubject(name: string) { setSubject(name); setChosenStage('all'); setSearch(''); }
  if (!chosenStage) return <section className="sf-work-page sf-work-qbank sf-qbank-overview">
    <div className="sf-qbank-hero"><div className="sf-qbank-intro"><h1>从一个主题<br />开始练习</h1><p>理解每一个答案。逐题查看你的进度。</p></div><div className="sf-qbank-demo"><div className="sf-qbank-demo-card"><div className="sf-qbank-demo-label"><BookOpen size={16} />{['知识点示例','练习','理解','追踪进度'][demo]}</div><div className={`sf-qbank-demo-body sf-qbank-demo-body-${demo}`}>
      {demo === 0 ? <><BookOpen className="sf-qbank-demo-symbol" size={44} strokeWidth={1.6} /><h2>从理解一道题开始<br />逐步掌握一个知识点</h2><p>选择感兴趣的主题，先练习，再查看解析，<br />把不确定的知识点逐个弄明白。</p></> : demo === 1 ? <><span className="sf-qbank-demo-number">示例题 · 多项式</span><h2>x² − 5x + 6 的因式分解是？</h2><div className="sf-qbank-demo-answers">{['(x − 2)(x − 3)','(x + 2)(x + 3)','(x − 1)(x − 6)'].map((answer,index) => <button className={demoAnswer === index ? index === 0 ? 'is-correct' : 'is-incorrect' : ''} key={answer} onClick={() => setDemoAnswer(index)}><span>{String.fromCharCode(65+index)}</span>{answer}{demoAnswer === index && (index === 0 ? <Check size={15} /> : <X size={15} />)}</button>)}</div>{demoAnswer !== null && <p className="sf-qbank-demo-feedback">{demoAnswer === 0 ? '答对了！两个数的和是 −5，积是 6。' : '再想一想：哪两个数的和是 −5、积是 6？'}</p>}</> : demo === 2 ? <><Lightbulb className="sf-qbank-demo-symbol" size={42} strokeWidth={1.6} /><h2>理解答案背后的原因</h2><p>寻找两个数，使它们的和为 −5，积为 6。<br />这两个数是 −2 和 −3。<br />因此 x² − 5x + 6 = (x − 2)(x − 3)。</p></> : <><CheckCircle2 className="sf-qbank-demo-symbol" size={44} strokeWidth={1.6} /><h2>每一道练习，都有记录</h2><p>{demoAnswer === 0 ? '你已答对这道示例题。' : demoAnswer === null ? '先到“练习”试着回答一道题。' : '这道示例题还需要再巩固一次。'}</p><div className="sf-qbank-demo-progress"><span style={{width:demoAnswer === 0 ? '100%' : '0%'}} /></div><small>{demoAnswer === 0 ? '1' : '0'} / 1 已掌握</small></>}
    </div></div><div className="sf-qbank-demo-tabs">{['知识点示例','练习','理解','追踪进度'].map((label,index) => <button key={label} className={demo === index ? 'is-selected' : ''} onClick={() => setDemo(index)}>{label}</button>)}</div></div></div>
    <h2 className="sf-qbank-stage-heading">按主题探索</h2><div className="sf-qbank-stages">{[{name:'数学',tag:'概念与解题',color:'#bbeef0',description:'从运算、代数与函数等已有示例开始，理解解题过程。'},{name:'语文',tag:'阅读与表达',color:'#bcf887',description:'练习理解文本、组织思路与表达，积累阅读和写作方法。'},{name:'英语',tag:'词汇与语法',color:'#f5d5ff',description:'通过已有词汇、句型和语法示例，检查你的理解。'}].map(category => <button key={category.name} onClick={() => chooseSubject(category.name)}><span className="sf-qbank-stage-top"><span className="sf-qbank-stage-mark" style={{background:category.color}}>{category.name}</span><span><strong>{category.name}</strong><small>{category.tag}</small></span><ArrowRight size={19} /></span><p>{category.description}</p><span className="sf-qbank-stage-bottom">按主题浏览<span><BookOpen size={13} />内置示例</span></span></button>)}</div><button className="btn" style={{marginTop:20}} onClick={() => chooseSubject('数学')}>浏览全部主题<ArrowRight size={16}/></button>
  </section>;
  return <section className="sf-work-page sf-work-qbank"><button className="btn sf-qbank-back" onClick={() => setChosenStage('')}><ArrowLeft />返回题库</button><div className="sf-work-qbank-heading"><div><h1>{subject}练习</h1><p>选择一个知识点，检查你的理解。当前提供有限的内置示例。</p></div><select className="field" aria-label="课程分类（可选）" value={chosenStage} onChange={e => chooseStage(e.target.value)}><option value="all">所有课程示例</option>{Object.keys(courseSubjects).map(stage => <option key={stage} value={stage}>{stage}课程示例</option>)}</select></div><div className="sf-work-qbank-tools"><div className="sf-work-subject-tabs">{Object.keys(available).map(item => <button key={item} className={subject === item ? 'is-selected' : ''} onClick={() => setSubject(item)}>{item}</button>)}</div><label className="sf-work-search"><Search size={18} /><input placeholder="搜索知识点..." value={search} onChange={e => setSearch(e.target.value)} /></label></div><div className="sf-work-question-grid">{items.map(item => <button key={item.topic} onClick={() => { save('active-unit', item.topic); save('practice-context', { grade: item.stage, subject, topic: item.topic }); onNavigate('quiz'); }}><span className="sf-work-question-icon"><img src={asset('practice-quiz')} alt="" /></span><span><small>{subject} · {chosenStage === 'all' ? '内置示例' : `${item.stage}课程示例`}</small><strong>{item.topic}</strong><span>开始练习</span></span><ChevronRight size={18} /></button>)}</div>{!items.length && <div className="empty-state"><h2>没有找到对应知识点</h2><p>换个关键词再试试。</p></div>}</section>;
}
