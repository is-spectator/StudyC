export type StudyCard = { front: string; back: string };
export type StudyQuestion = { question: string; options: string[]; answer: number; explanation: string; hint: string };
export type StudyContent = { title: string; subject: string; level: string; introduction: string; cards: StudyCard[]; questions: StudyQuestion[]; sections: { title: string; body: string; example: string }[] };

const algebra: StudyContent = {
  title: '一元一次方程', subject: '数学', level: '初中',
  introduction: '用一个未知数，把生活中的数量关系写成等式。先找等量关系，再一步一步求出答案。',
  cards: [
    { front: '什么是一元一次方程？', back: '只含有一个未知数，未知数的次数都是 1，且等号两边都是整式的方程。' },
    { front: '等式的基本性质是什么？', back: '等式两边加上或减去同一个数，结果仍相等；两边乘同一个数，或除以同一个不为 0 的数，结果仍相等。' },
    { front: '移项时，为什么要变号？', back: '移项本质上是在等式两边加上或减去同一项。例如 x + 3 = 8，两边减去 3 得 x = 8 − 3。' },
    { front: '解方程 3x − 6 = 9。', back: '两边加上 6，得 3x = 15；两边除以 3，得 x = 5。代入原方程验证：15 − 6 = 9。' },
    { front: '解应用题的基本步骤是什么？', back: '设未知数 → 找等量关系 → 列方程 → 解方程 → 检验并作答。答案要带上正确单位。' },
  ],
  questions: [
    { question: '方程 2x + 3 = 11 的解是？', options: ['x = 3', 'x = 4', 'x = 5', 'x = 7'], answer: 1, explanation: '两边减去 3，得 2x = 8；再同时除以 2，得 x = 4。', hint: '先想想怎样消掉左边的 +3。等式两边要做相同的运算。' },
    { question: '下列哪一个是一元一次方程？', options: ['x² = 9', 'x + y = 5', '3x − 2 = 7', '1 ÷ x = 2'], answer: 2, explanation: '3x − 2 = 7 只含一个未知数 x，且 x 的次数是 1，等式两边都是整式。', hint: '检查三个条件：只有一个未知数、未知数的次数是 1、等式两边都是整式。' },
    { question: '将方程 x − 5 = 8 中的 −5 移到右边，得到？', options: ['x = 8 − 5', 'x = 8 + 5', 'x = 5 − 8', 'x = 8 × 5'], answer: 1, explanation: '两边同时加上 5，得到 x = 8 + 5。移项时，原来的 −5 变成 +5。', hint: '左边减去的 5，要通过什么运算消掉？' },
    { question: '每本笔记本 6 元，买了 x 本，付出 30 元，找回 6 元。正确的方程是？', options: ['6x + 30 = 6', '6x − 6 = 30', '6x + 6 = 30', 'x + 6 = 30'], answer: 2, explanation: '笔记本的总价 + 找回的钱 = 付出的钱，所以 6x + 6 = 30。', hint: '把实际花费和找零加起来，应等于付出的钱。' },
    { question: '方程 3(x − 2) = 12 的解是？', options: ['x = 2', 'x = 4', 'x = 6', 'x = 8'], answer: 2, explanation: '两边除以 3，得 x − 2 = 4；两边加上 2，得 x = 6。', hint: '先把等式两边同时除以 3，可以让式子更简单。' },
  ],
  sections: [
    { title: '从数量关系到方程', body: '方程是含有未知数的等式。设一个未知数 x，找出题目中相等的两个量，就能用方程表达它们之间的关系。', example: '一支笔 3 元，买 x 支共花 15 元，可以列出：3x = 15。' },
    { title: '让等式始终保持平衡', body: '解方程就像保持天平平衡。两边必须同时加、减同一个数，或者同时乘、除同一个不为 0 的数。我们的目标是让等号的一边只剩下 x。', example: '2x + 3 = 11 → 2x = 8 → x = 4。' },
    { title: '移项与去括号', body: '把一项从等式的一边移到另一边时，要改变它的符号。遇到括号时可以利用分配律展开，括号前是负号时，要改变括号内每一项的符号。', example: '3(x − 2) = 12 → 3x − 6 = 12 → 3x = 18 → x = 6。' },
    { title: '别忘记检验', body: '把求出的解代回原方程，确认等式成立。应用题还要检查答案是否符合实际情境，并写清楚单位。', example: '将 x = 6 代入 3(x − 2) = 12：左边 = 3 × 4 = 12，与右边相等。' },
  ],
};

const fractions: StudyContent = {
  title: '分数的认识与运算', subject: '数学', level: '小学', introduction: '把一个整体平均分成几份，认识其中的一份或几份，再学会比较和计算。',
  cards: [
    { front: '分母表示什么？', back: '分母表示把单位“1”平均分成了多少份。' },
    { front: '分子表示什么？', back: '分子表示取了这样的多少份。' },
    { front: '同分母分数怎样相加？', back: '分母不变，分子相加。例如 1/5 + 2/5 = 3/5。' },
    { front: '分数 2/4 可以约分成多少？', back: '分子和分母同时除以 2，得到 1/2。分数的大小不变。' },
    { front: '怎样比较同分母分数？', back: '同分母分数，分子越大，分数越大。例如 3/5 > 2/5。' },
  ],
  questions: [
    { question: '把一块蛋糕平均分成 4 份，取其中 1 份，用分数表示是？', options: ['1/2', '1/3', '1/4', '4/1'], answer: 2, explanation: '平均分成 4 份，分母是 4；取 1 份，分子是 1，因此是 1/4。', hint: '先看平均分成几份，再看取了几份。' },
    { question: '1/5 + 2/5 等于多少？', options: ['3/10', '3/5', '2/5', '1/5'], answer: 1, explanation: '同分母分数相加，分母不变，分子相加：1 + 2 = 3。', hint: '每一份的大小没有变，只是份数增加了。' },
    { question: '下面哪个分数与 1/2 相等？', options: ['1/4', '2/3', '2/4', '3/4'], answer: 2, explanation: '1/2 的分子和分母同时乘以 2，得到 2/4，大小不变。', hint: '把半块蛋糕再分一分，能变成四份中的几份？' },
    { question: '下面哪个分数最大？', options: ['1/7', '3/7', '2/7', '5/7'], answer: 3, explanation: '分母相同，分子越大，分数越大。5 是这些分子中最大的。', hint: '分母都是 7，直接比较分子。' },
    { question: '4/6 约分后是多少？', options: ['1/3', '2/3', '3/4', '2/6'], answer: 1, explanation: '分子 4 和分母 6 同时除以公因数 2，得到 2/3。', hint: '4 和 6 都可以除以哪个大于 1 的整数？' },
  ],
  sections: [
    { title: '认识分数', body: '把一个整体平均分成若干份，其中的一份或几份可以用分数表示。“平均分”是关键，每一份都要同样大。', example: '一张纸平均分成 4 份，每份是这张纸的 1/4。' },
    { title: '分子与分母', body: '分数线下方的数叫分母，上方的数叫分子。分母说明平均分成多少份，分子说明取了多少份。', example: '3/5 表示把整体平均分成 5 份，取其中 3 份。' },
    { title: '同分母加减法', body: '同分母分数的分数单位相同，所以分母不变，只对分子进行加减。', example: '2/7 + 3/7 = 5/7；5/7 − 2/7 = 3/7。' },
    { title: '约分与通分', body: '分子和分母同时乘或除以同一个不为 0 的数，分数的大小不变。约分可以让分数变得更简洁。', example: '4/6 = (4 ÷ 2)/(6 ÷ 2) = 2/3。' },
  ],
};

const functions: StudyContent = {
  title: '函数的概念与性质', subject: '数学', level: '高中', introduction: '通过对应关系理解函数，结合图像研究定义域、值域和变化规律。',
  cards: [
    { front: '函数关系最关键的条件是什么？', back: '对于定义域中每一个 x，按照对应关系，都有唯一确定的 y 与它对应。' },
    { front: '什么是函数的定义域？', back: '自变量 x 的取值范围，即函数有意义时所有 x 组成的集合。' },
    { front: 'y = 1/x 的定义域是什么？', back: '所有不为 0 的实数，即 {x ∈ R | x ≠ 0}。' },
    { front: '什么是增函数？', back: '在给定区间内，若 x₁ < x₂ 总有 f(x₁) < f(x₂)，则函数在该区间上单调递增。' },
    { front: '偶函数的图像有什么特点？', back: '定义域关于原点对称，且 f(−x) = f(x)，图像关于 y 轴对称。' },
  ],
  questions: [
    { question: '函数 y = 1/(x − 2) 的定义域应排除哪个值？', options: ['−2', '0', '1', '2'], answer: 3, explanation: '分母不能为 0，因此 x − 2 ≠ 0，即 x ≠ 2。', hint: '分式有意义时，分母需要满足什么条件？' },
    { question: '函数 f(x) = 2x + 1 在实数范围内的单调性是？', options: ['单调递增', '单调递减', '先增后减', '保持不变'], answer: 0, explanation: '一次函数的斜率为 2，大于 0，因此在实数范围内单调递增。', hint: '观察一次项系数的正负。' },
    { question: '下列哪个函数是偶函数？', options: ['f(x) = x', 'f(x) = x³', 'f(x) = x²', 'f(x) = x + 1'], answer: 2, explanation: '对于 f(x) = x²，有 f(−x) = (−x)² = x² = f(x)。', hint: '把 x 换成 −x，看看函数值是否不变。' },
    { question: 'f(x) = x² − 1，则 f(3) 等于多少？', options: ['2', '5', '8', '10'], answer: 2, explanation: '将 x = 3 代入，f(3) = 3² − 1 = 9 − 1 = 8。', hint: '函数符号 f(3) 表示自变量取 3 时的函数值。' },
    { question: '函数 y = x² 的值域是？', options: ['所有实数', '所有非负实数', '所有正实数', '所有负实数'], answer: 1, explanation: '任何实数的平方都不小于 0，且任意非负实数都能表示为某个实数的平方，因此值域为 [0, +∞)。', hint: '实数的平方可能是负数吗？能等于 0 吗？' },
  ],
  sections: [
    { title: '函数是一种对应关系', body: '设 A、B 是非空的数集。如果按照某种对应关系 f，对于集合 A 中的任意一个数 x，在集合 B 中都有唯一确定的数 y 与之对应，那么称 f 为从 A 到 B 的一个函数。', example: 'f(x) = 2x + 1，给定 x = 3，唯一对应的函数值为 7。' },
    { title: '定义域与值域', body: '定义域是自变量的允许取值范围；值域是所有函数值组成的集合。研究函数时，应先确定定义域。', example: 'y = 1/x 的定义域为 x ≠ 0；y = x² 的值域为 y ≥ 0。' },
    { title: '观察变化趋势', body: '函数的单调性描述自变量增大时函数值如何变化。单调性总要结合具体区间来讨论。', example: 'y = x² 在 (−∞, 0] 上递减，在 [0, +∞) 上递增。' },
    { title: '利用图像的对称性', body: '偶函数的图像关于 y 轴对称，奇函数的图像关于原点对称。判断前应先检查定义域是否关于原点对称。', example: 'x² 是偶函数；x³ 是奇函数。' },
  ],
};

function subjectPack(title: string, subject: string, level: string, cards: StudyCard[], questions: StudyQuestion[]): StudyContent {
  return { title, subject, level, introduction: `通过知识卡片与随堂练习，复习${title}中的核心知识。`, cards, questions, sections: cards.slice(0, 4).map(card => ({ title: card.front, body: card.back, example: questions.find(question => question.explanation.includes(card.back.slice(0, 4)))?.explanation || card.back })) };
}
const englishPrimary = subjectPack('基础词汇与日常表达', '英语', '小学', [
  { front: 'apple 的意思是什么？', back: 'apple 是“苹果”。例如：I like apples. 我喜欢苹果。' },
  { front: '早上见面怎样打招呼？', back: 'Good morning! 意思是“早上好！”' },
  { front: 'book 的复数形式是什么？', back: 'books。多数可数名词在词尾加 s 表示复数。' },
  { front: '怎样表达“我有一支铅笔”？', back: 'I have a pencil.' },
  { front: '怎样询问对方的名字？', back: 'What is your name?' },
], [
  { question: 'apple 的中文意思是？', options: ['香蕉', '苹果', '橙子', '葡萄'], answer: 1, hint: '它是一种常见的圆形水果。', explanation: 'apple 的意思是苹果。' },
  { question: '早晨见到老师，应该说？', options: ['Good night!', 'Goodbye!', 'Good morning!', 'Good afternoon!'], answer: 2, hint: 'morning 表示早晨。', explanation: 'Good morning! 是早上好。Good night! 通常用于睡前道别。' },
  { question: 'two ___（两本书）应填？', options: ['book', 'books', 'a book', 'bookes'], answer: 1, hint: 'two 表示两个，需要用名词复数。', explanation: 'book 是可数名词，复数是 books。' },
  { question: '“我有一支铅笔”正确的英语是？', options: ['I am a pencil.', 'I have a pencil.', 'I is a pencil.', 'I has a pencil.'], answer: 1, hint: 'have 表示拥有。', explanation: 'I have a pencil. 表示我有一支铅笔。' },
  { question: '别人问 What is your name?，应怎样回答？', options: ['I am fine.', 'It is red.', 'My name is Li Ming.', 'It is a book.'], answer: 2, hint: 'name 指的是名字。', explanation: 'My name is Li Ming. 表示我的名字是李明。' },
]);
const englishMiddle = subjectPack('一般现在时与一般过去时', '英语', '初中', [
  { front: '一般现在时通常表达什么？', back: '表示经常发生的动作、习惯或客观事实。第三人称单数主语通常要求动词使用单数形式。' },
  { front: 'go 的第三人称单数形式是什么？', back: 'goes。例如：She goes to school by bus.' },
  { front: '一般过去时表示什么？', back: '表示过去某个时间发生的动作或存在的状态，常与 yesterday、last week 等连用。' },
  { front: 'go 的过去式是什么？', back: 'went。例如：I went to the park yesterday.' },
  { front: 'did 后面的实义动词用什么形式？', back: '使用动词原形。例如：Did you watch the film?' },
], [
  { question: 'She ___ to school every day.', options: ['go', 'goes', 'going', 'went'], answer: 1, hint: 'every day 表示习惯；主语是第三人称单数。', explanation: '一般现在时中，She 后的 go 应变为 goes。' },
  { question: 'I ___ a film yesterday.', options: ['watch', 'watches', 'watched', 'watching'], answer: 2, hint: 'yesterday 表示过去的时间。', explanation: 'watch 的过去式是 watched。' },
  { question: 'Did he ___ his homework?', options: ['finished', 'finishes', 'finish', 'finishing'], answer: 2, hint: '助动词 did 已经表达了过去时。', explanation: '助动词 did 后的实义动词使用原形 finish。' },
  { question: 'We ___ to the museum last Sunday.', options: ['go', 'goes', 'went', 'going'], answer: 2, hint: 'go 的过去式是不规则变化。', explanation: 'last Sunday 是过去时间，go 的过去式是 went。' },
  { question: '下列哪一句表达客观事实？', options: ['I visited Beijing yesterday.', 'The sun rises in the east.', 'She will come tomorrow.', 'They were playing.'], answer: 1, hint: '客观事实通常用一般现在时。', explanation: 'The sun rises in the east. 表示太阳从东方升起，是客观事实。' },
]);
const englishHigh = subjectPack('定语从句与被动语态', '英语', '高中', [
  { front: '定语从句有什么作用？', back: '修饰名词或代词，说明所指的人或事物。被修饰的词叫先行词。' },
  { front: '先行词指人，关系词在从句中作主语时可用什么？', back: '通常使用 who 或 that。' },
  { front: '被动语态的基本结构是什么？', back: 'be + 及物动词的过去分词。be 的形式随时态和主语变化。' },
  { front: '一般过去时的被动语态是什么结构？', back: 'was / were + 过去分词。' },
  { front: 'which 在定语从句中通常指代什么？', back: '指代事物，可以在从句中作主语或宾语。' },
], [
  { question: 'The girl ___ is reading is my sister.', options: ['which', 'who', 'where', 'when'], answer: 1, hint: '先行词 girl 指人，关系词在从句中作主语。', explanation: 'who 可引导修饰人的定语从句，在这里作从句主语。' },
  { question: 'The bridge ___ in 2020.', options: ['builds', 'built', 'was built', 'has building'], answer: 2, hint: '桥是被建造的，且时间是过去。', explanation: '一般过去时被动语态为 was / were + 过去分词，主语单数用 was built。' },
  { question: '被动语态的基本结构是？', options: ['have + 原形', 'be + 过去分词', 'do + 现在分词', 'be + 原形'], answer: 1, hint: '想想 is made、was written 的共同结构。', explanation: '被动语态的基本结构是 be + 及物动词的过去分词。' },
  { question: 'This is the book ___ I bought yesterday.', options: ['who', 'where', 'which', 'when'], answer: 2, hint: 'book 是事物，关系词在从句中作 bought 的宾语。', explanation: 'which 指代先行词 book，并在定语从句中作宾语。' },
  { question: 'English ___ in many countries.', options: ['speaks', 'is spoken', 'spoke', 'is speaking'], answer: 1, hint: 'English 与 speak 是被动关系。', explanation: '这里表示一般事实，使用一般现在时被动语态 is spoken。' },
]);
const chinesePrimary = subjectPack('句子与标点', '语文', '小学', [
  { front: '表示一句话说完了，通常使用什么标点？', back: '句号（。），表示陈述句末尾的停顿。' },
  { front: '问号有什么作用？', back: '问号（？）用在疑问句末尾，表示提问。' },
  { front: '怎样把句子写具体？', back: '可以补充时间、地点，以及人物的动作、神态等细节。' },
  { front: '比喻句有什么特点？', back: '用一种事物来打比方，描写另一种有相似点的事物。' },
  { front: '阅读时怎样找到主要内容？', back: '先弄清谁在什么地方做了什么，再用简短的话说清楚。' },
], [
  { question: '“你今天读书了吗”末尾应使用？', options: ['句号', '问号', '逗号', '顿号'], answer: 1, hint: '这句话是在向别人提问。', explanation: '疑问句末尾使用问号。' },
  { question: '下面哪句运用了比喻？', options: ['小鸟飞走了。', '他正在读书。', '弯弯的月亮像小船。', '今天很晴朗。'], answer: 2, hint: '找出把一种事物比作另一种事物的句子。', explanation: '把弯月比作小船，突出了它们形状上的相似之处。' },
  { question: '“我喜欢苹果、香蕉和橙子。”中的顿号用来分隔？', options: ['句子', '并列的词语', '段落', '提问'], answer: 1, hint: '苹果和香蕉是并列的水果名称。', explanation: '顿号可用于分隔并列的词语。' },
  { question: '下面哪句话把“他跑过来”写得更具体？', options: ['他来了。', '他飞快地向操场跑过来。', '他跑。', '他在。'], answer: 1, hint: '留意描述速度和地点的词语。', explanation: '“飞快地”写速度，“向操场”写方向，使动作更具体。' },
  { question: '“小明在图书馆认真读书。”主要写谁在做什么？', options: ['图书馆在开门', '小明在读书', '小明在跑步', '老师在上课'], answer: 1, hint: '找到人物和他的主要动作。', explanation: '人物是小明，主要动作是读书。' },
]);
const chineseMiddle = subjectPack('修辞手法与阅读理解', '语文', '初中', [
  { front: '比喻有什么表达作用？', back: '借助事物之间的相似点，使描述更生动、形象。' },
  { front: '拟人有什么特点？', back: '把事物当作人来写，赋予它人的动作、情感或性格。' },
  { front: '排比句有什么特点？', back: '由三个或三个以上结构相似、语气一致、内容相关的短语或句子组成。' },
  { front: '概括段落内容应注意什么？', back: '抓住主要对象与核心事件，使用简洁的语言，不添加原文没有的信息。' },
  { front: '怎样理解词语在文中的含义？', back: '结合上下文，先理解本义，再分析具体语境中的意义和感情色彩。' },
], [
  { question: '“春风轻轻抚摸着我的脸。”主要使用哪种修辞？', options: ['拟人', '反问', '排比', '设问'], answer: 0, hint: '“抚摸”原本是人的动作。', explanation: '把春风当作人来写，赋予它抚摸的动作，是拟人。' },
  { question: '排比通常要求几个或几个以上相关结构？', options: ['1 个', '2 个', '3 个', '任意数量'], answer: 2, hint: '排比强调连续展开的气势和节奏。', explanation: '排比通常由三个或三个以上结构相似、内容相关的短语或句子组成。' },
  { question: '理解词语在文章中的含义，最应该？', options: ['只看字典第一个解释', '结合上下文', '凭空猜测作者经历', '只看字数'], answer: 1, hint: '同一个词在不同语境中可能有不同含义。', explanation: '应联系上下文，理解具体语境中的意义。' },
  { question: '“时间是一条长河。”使用的修辞是？', options: ['拟人', '夸张', '比喻', '反复'], answer: 2, hint: '把时间比作一种具体的事物。', explanation: '将时间比作长河，借助流动性表现时间不断前行。' },
  { question: '概括文章内容时，哪种做法合适？', options: ['加入自己编造的情节', '保留所有修饰词', '抓住主要事件简洁表达', '只摘录文章第一句'], answer: 2, hint: '概括需要准确，也要简洁。', explanation: '抓住主要对象和核心事件，避免加入原文没有的信息。' },
]);
const chineseHigh = subjectPack('文言文常见虚词', '语文', '高中', [
  { front: '“学而时习之”中的“而”表示什么关系？', back: '通常表示承接关系，连接学习和按时温习。' },
  { front: '“吾妻之美我者”中的“美”怎样理解？', back: '“美”是形容词的意动用法，意为“认为……美”。' },
  { front: '“师者，所以传道受业解惑也”中的“所以”怎样理解？', back: '“所以”在这里表示“用来……的”。' },
  { front: '翻译文言文的基本要求是什么？', back: '忠实原意、表达通顺，落实关键词语，不随意增减信息。' },
  { front: '“之”的常见用法有哪些？', back: '可以作代词、结构助词，也可用在主谓之间取消句子独立性；须结合语境判断。' },
], [
  { question: '“学而时习之”中的“之”指代什么？', options: ['老师', '学过的知识', '时间', '朋友'], answer: 1, hint: '温习的是前面提到的学习内容。', explanation: '“之”作代词，指代学过的知识。' },
  { question: '“吾妻之美我者”中“美”属于？', options: ['使动用法', '意动用法', '名词作状语', '普通名词'], answer: 1, hint: '意思是认为我美，而不是使我变美。', explanation: '形容词“美”的意动用法，意为认为……美。' },
  { question: '“师者，所以传道受业解惑也”中的“所以”意为？', options: ['因此', '……的原因', '用来……的', '所有'], answer: 2, hint: '这句话说明老师的作用。', explanation: '“所以”在句中表示“用来……的”，说明老师传道受业解惑的作用。' },
  { question: '判断文言虚词意义，最可靠的依据是？', options: ['现代汉语同形词', '上下文和句法位置', '字数多少', '个人直觉'], answer: 1, hint: '同一个虚词常有多种不同用法。', explanation: '结合语境和句法成分，可以确定虚词在具体句子中的用法。' },
  { question: '文言文翻译时，正确做法是？', options: ['逐字机械替换', '任意加入现代情节', '忠实原意并表达通顺', '忽略所有虚词'], answer: 2, hint: '翻译既要准确，也要让读者理解。', explanation: '翻译应忠实原意，落实关键字词，并用通顺的现代汉语表达。' },
]);

const sciencePrimary = subjectPack('科学观察与生活', '科学', '小学', [
  { front: '怎样比较两个物体的长度？', back: '使用尺子测量，把物体一端对准零刻度，读出另一端对应的刻度，并使用相同单位比较。' },
  { front: '大多数绿色植物生长需要什么？', back: '适宜的阳光、水、空气、温度和养分。不同植物的具体需求有所不同。' },
  { front: '水结成冰，主要发生了什么变化？', back: '水从液态变成固态。通常情况下，冰融化后又变成液态水。' },
  { front: '磁铁能吸引哪些常见材料？', back: '磁铁可以吸引铁等材料，但不能吸引所有金属。例如铝和铜通常不会被普通磁铁明显吸引。' },
  { front: '地球上的昼夜交替主要由什么造成？', back: '地球自转造成昼夜交替。面向太阳的一侧是白天，背向太阳的一侧是黑夜。' },
], [
  { question: '用尺子测量铅笔长度时，通常先把铅笔一端对准？', options: ['尺子任意位置', '零刻度线', '最大的刻度', '尺子背面'], answer: 1, hint: '从起点开始读数，测量会更方便。', explanation: '将物体一端对准零刻度线，再读另一端的刻度，便能直接得到长度。' },
  { question: '大多数绿色植物正常生长需要？', options: ['只有黑暗', '阳光、水和空气等适宜条件', '只有石头', '完全没有水'], answer: 1, hint: '想一想我们平时怎样照顾盆栽。', explanation: '多数绿色植物需要适宜的阳光、水、空气、温度和养分。' },
  { question: '水结成冰时，状态怎样变化？', options: ['液态变固态', '固态变气态', '气态变液态', '液态变气态'], answer: 0, hint: '水可以流动，冰通常有固定形状。', explanation: '水是液态，冰是固态，结冰是由液态变为固态。' },
  { question: '普通磁铁最容易吸引下面哪件物品？', options: ['木头尺子', '塑料杯', '铁钉', '玻璃珠'], answer: 2, hint: '比较这些物品的材料。', explanation: '铁钉由铁制成，通常能被磁铁吸引；木头、塑料和玻璃不能被普通磁铁吸引。' },
  { question: '昼夜交替主要与地球的哪种运动有关？', options: ['自转', '绕月球转动', '完全不动', '忽然停止转动'], answer: 0, hint: '地球不同部分轮流朝向太阳。', explanation: '地球自转使不同地区轮流面向或背向太阳，从而形成昼夜交替。' },
]);

const physics = subjectPack('运动、力与能量基础', '物理', '初高中', [
  { front: '速度的基本公式是什么？', back: '速度 = 路程 ÷ 时间，即 v = s/t。计算时应统一单位。' },
  { front: '力的国际单位是什么？', back: '牛顿，符号 N。' },
  { front: '惯性大小与什么因素有关？', back: '惯性大小与物体的质量有关，质量越大，惯性越大。' },
  { front: '声音能在真空中传播吗？', back: '不能。声音的传播需要介质。' },
  { front: '重力势能与什么有关？', back: '相对于同一参考面，物体质量越大、位置越高，重力势能通常越大。' },
], [
  { question: '一名同学 10 秒跑过 50 米，他的平均速度是？', options: ['2 m/s', '5 m/s', '10 m/s', '50 m/s'], answer: 1, hint: '用路程除以所用时间。', explanation: 'v = s/t = 50 米 ÷ 10 秒 = 5 m/s。' },
  { question: '力的国际单位是？', options: ['米', '秒', '牛顿', '千克'], answer: 2, hint: '力的单位符号是 N。', explanation: '力的国际单位是牛顿，符号 N。千克是质量单位。' },
  { question: '物体的惯性大小主要取决于？', options: ['速度', '质量', '温度', '颜色'], answer: 1, hint: '惯性是物体保持原来运动状态的性质。', explanation: '惯性大小与质量有关。质量越大，惯性越大。' },
  { question: '下列哪种环境不能传播声音？', options: ['空气', '水', '钢铁', '真空'], answer: 3, hint: '声音的传播需要介质。', explanation: '真空中没有传播声音的介质，因此不能传声。' },
  { question: '同一物体被举到更高的位置，相对于地面的重力势能会？', options: ['增大', '减小', '不变', '变成零'], answer: 0, hint: '质量不变时，比较高度的变化。', explanation: '相对于同一参考面，物体被举得越高，重力势能越大。' },
]);
const chemistry = subjectPack('物质、元素与化学变化', '化学', '初高中', [
  { front: '化学变化最根本的特征是什么？', back: '有新物质生成。' },
  { front: '化学变化中，原子的种类和数目会改变吗？', back: '在普通化学反应中，原子的种类和数目不变；原子重新组合成新的物质。' },
  { front: '水的化学式是什么？', back: 'H₂O。一个水分子由两个氢原子和一个氧原子构成。' },
  { front: '氧气能燃烧吗？', back: '氧气通常能支持燃烧，但它本身不是可燃物。' },
  { front: '什么是质量守恒定律？', back: '参加化学反应的各物质的质量总和，等于反应后生成的各物质的质量总和。' },
], [
  { question: '下列哪一种属于化学变化？', options: ['冰融化', '水蒸发', '铁生锈', '纸张折叠'], answer: 2, hint: '判断有没有新物质生成。', explanation: '铁生锈生成了与铁不同的新物质，因此属于化学变化。' },
  { question: '一个水分子中含有几个氢原子？', options: ['1 个', '2 个', '3 个', '4 个'], answer: 1, hint: '观察化学式 H₂O 中氢元素右下角的数字。', explanation: 'H₂O 表示一个水分子含有两个氢原子和一个氧原子。' },
  { question: '关于氧气，下列描述正确的是？', options: ['氧气是可燃物', '氧气通常支持燃烧', '氧气不能参与化学反应', '氧气是一种金属'], answer: 1, hint: '助燃性与可燃性是不同的性质。', explanation: '氧气具有助燃性，通常能支持燃烧，但本身不是可燃物。' },
  { question: '普通化学反应前后一定不变的是？', options: ['分子种类', '物质种类', '原子的种类和数目', '物质颜色'], answer: 2, hint: '化学反应是原子的重新组合。', explanation: '化学反应中原子重新组合，原子的种类和数目不变。' },
  { question: '化学反应中，反应物总质量与生成物总质量的关系是？', options: ['前者一定更大', '后者一定更大', '一定相等', '无法判断'], answer: 2, hint: '考虑参加反应的全部物质，包括气体。', explanation: '根据质量守恒定律，参加反应的物质总质量等于生成物总质量。' },
]);
const biology = subjectPack('细胞、生物体与环境', '生物', '初高中', [
  { front: '细胞膜的主要功能是什么？', back: '控制物质进出细胞，将细胞与周围环境分隔开。' },
  { front: '绿色植物光合作用的主要场所是什么？', back: '叶绿体。光合作用利用光能，将二氧化碳和水转变为有机物，并释放氧气。' },
  { front: '动植物细胞中常见的遗传信息主要储存在哪里？', back: '细胞核中的 DNA 携带主要的遗传信息。' },
  { front: '生态系统由哪些部分组成？', back: '由生物部分和非生物部分共同组成。' },
  { front: '食物链中的生产者通常是谁？', back: '绿色植物等能制造有机物的生物通常是生产者。' },
], [
  { question: '控制物质进出细胞的结构是？', options: ['细胞膜', '叶绿体', '液泡', '染色体'], answer: 0, hint: '它位于细胞边界。', explanation: '细胞膜将细胞与外界分隔，并控制物质进出。' },
  { question: '绿色植物进行光合作用的主要场所是？', options: ['线粒体', '叶绿体', '细胞壁', '细胞核'], answer: 1, hint: '它含有能吸收光能的色素。', explanation: '绿色植物主要在叶绿体中进行光合作用。' },
  { question: '典型植物细胞具有、典型动物细胞不具有的结构是？', options: ['细胞膜', '细胞质', '细胞核', '细胞壁'], answer: 3, hint: '它位于细胞膜外侧，起支持和保护作用。', explanation: '植物细胞有细胞壁，典型动物细胞没有细胞壁。' },
  { question: '一个完整的生态系统包括？', options: ['只有动物', '只有植物', '生物和非生物部分', '只有生产者和消费者'], answer: 2, hint: '阳光、水和空气也会影响生物生活。', explanation: '生态系统由生物部分及其所处的非生物环境共同组成。' },
  { question: '在“草→兔→狐”中，生产者是？', options: ['草', '兔', '狐', '三者都是'], answer: 0, hint: '谁能够通过光合作用制造有机物？', explanation: '草能通过光合作用制造有机物，是这条食物链中的生产者。' },
]);
const history = subjectPack('中国历史基础时间线', '历史', '初高中', [
  { front: '秦统一六国是哪一年？', back: '公元前 221 年，秦完成统一。' },
  { front: '商鞅变法发生在哪个诸侯国？', back: '秦国。变法推动了秦国的发展与强大。' },
  { front: '丝绸之路与哪位汉代人物密切相关？', back: '张骞。张骞出使西域促进了汉朝与西域的联系。' },
  { front: '明朝建立于哪一年？', back: '1368 年，朱元璋建立明朝。' },
  { front: '辛亥革命发生于哪一年？', back: '1911 年。它推动了清朝统治的结束。' },
], [
  { question: '秦完成统一六国的时间是？', options: ['公元前 221 年', '公元 221 年', '公元前 202 年', '公元 618 年'], answer: 0, hint: '注意公元前与公元后的区别。', explanation: '公元前 221 年，秦完成统一六国。' },
  { question: '商鞅变法发生在？', options: ['齐国', '楚国', '秦国', '燕国'], answer: 2, hint: '这一改革增强了后来统一六国的国家的实力。', explanation: '商鞅在秦国推行变法，推动了秦国的强大。' },
  { question: '汉代出使西域、促进中外交流的人物是？', options: ['张骞', '郑和', '李白', '王安石'], answer: 0, hint: '郑和生活在明代，不是汉代。', explanation: '张骞出使西域，促进了汉朝与西域的联系。' },
  { question: '明朝建立于？', options: ['618 年', '960 年', '1271 年', '1368 年'], answer: 3, hint: '建立者是朱元璋。', explanation: '1368 年，朱元璋建立明朝。' },
  { question: '辛亥革命发生于？', options: ['1840 年', '1894 年', '1911 年', '1919 年'], answer: 2, hint: '“辛亥”是当年的干支纪年。', explanation: '辛亥革命发生于 1911 年，推动了清朝统治的结束。' },
]);
const polynomial = subjectPack('多项式与二次方程', '数学', '初高中', [
  { front: '合并同类项时怎样计算？', back: '把同类项的系数相加，字母和字母的指数不变。' },
  { front: '平方差公式是什么？', back: 'a² − b² = (a + b)(a − b)。' },
  { front: '一元二次方程的一般形式是什么？', back: 'ax² + bx + c = 0，其中 a ≠ 0。' },
  { front: '二次方程的判别式是什么？', back: 'Δ = b² − 4ac。Δ > 0 时有两个不相等的实数根。' },
  { front: '怎样分解 x² − 5x + 6？', back: 'x² − 5x + 6 = (x − 2)(x − 3)。' },
], [
  { question: '合并同类项 3x² + 2x − x² + 4x，结果为？', options: ['2x² + 6x', '4x² + 6x', '2x² − 2x', '8x³'], answer: 0, hint: '把含 x² 的项放在一起，含 x 的项放在一起。', explanation: '3x² − x² = 2x²；2x + 4x = 6x，所以结果是 2x² + 6x。' },
  { question: 'x² − 9 的因式分解是？', options: ['(x − 3)²', '(x + 3)²', '(x + 3)(x − 3)', '(x − 9)(x + 1)'], answer: 2, hint: '利用平方差公式。', explanation: 'x² − 9 = x² − 3² = (x + 3)(x − 3)。' },
  { question: '方程 x² − 5x + 6 = 0 的两个根是？', options: ['1 和 6', '2 和 3', '−2 和 −3', '0 和 5'], answer: 1, hint: '找两个乘积为 6、和为 5 的数。', explanation: '原方程可写为 (x − 2)(x − 3) = 0，因此 x = 2 或 x = 3。' },
  { question: '方程 x² + 2x + 1 = 0 的判别式是？', options: ['−4', '0', '4', '8'], answer: 1, hint: '代入 a = 1，b = 2，c = 1。', explanation: 'Δ = b² − 4ac = 4 − 4 = 0。' },
  { question: '一元二次方程 ax² + bx + c = 0 中必须满足？', options: ['a = 0', 'b ≠ 0', 'c ≠ 0', 'a ≠ 0'], answer: 3, hint: '二次项不能消失。', explanation: '二次项系数 a 必须不为 0，否则方程不是一元二次方程。' },
]);

export function getStudyContent(topic: string, options: { stage?: string; subject?: string } = {}): StudyContent {
  const stage = options.stage || '';
  const high = /高中|高[一二三]/.test(stage);
  const primary = !high && /小学|[一二三四五六]年级/.test(stage);
  if (primary && (options.subject === '科学' || /科学|观察与测量|生命与生长|物质的变化|地球与环境/.test(topic))) return sciencePrimary;
  if (options.subject === '物理' || /物理|力与运动|声与光|电学|运动与测量|能量与机械/.test(topic)) return physics;
  if (options.subject === '化学' || /化学|物质及其变化|元素与原子|化学式/.test(topic)) return chemistry;
  if (options.subject === '生物' || options.subject === '科学' || /生物|科学探索|细胞|生命现象/.test(topic)) return biology;
  if (options.subject === '历史' || /历史|朝代|时间线/.test(topic)) return history;
  if (options.subject === '英语' || /英语|单词|词汇|语法|时态|从句|被动|English/i.test(topic)) return primary ? englishPrimary : high ? englishHigh : englishMiddle;
  if (options.subject === '语文' || /语文|阅读|写作|现代文|修辞|标点|古诗|文言|汉字|拼音/.test(topic)) return primary ? chinesePrimary : high ? chineseHigh : chineseMiddle;
  if (/多项式|二次方程|因式分解|整式|判别式/.test(topic)) return polynomial;
  if (/分数|小学|三年级|四年级|五年级|六年级/.test(topic)) return fractions;
  if (/函数|高中|高一|高二|高三/.test(topic)) return functions;
  if (primary) return fractions;
  if (high) return functions;
  return algebra;
}
