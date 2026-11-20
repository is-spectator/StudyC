import { appStorage } from './lib/account-storage';
export const asset = (name:string) => `/assets/studyc/${name}.svg`;
export const initialMaterials = ['多项式与二次方程基础','指数与对数函数','高次方程与复数','函数变换与应用','数列与组合基础'];
export const units = [['多项式基础与运算','因式分解技巧','二次方程求解与判别式','二次函数与抛物线性质'],['指数函数及其性质','对数函数与运算性质','指数与对数方程求解'],['高次方程与代数基本定理','复数及其运算','复数的几何意义'],['函数的基本几何变换','函数变换的系统建模'],['等差与等比数列','级数与求和公式','基础概率理论']];
export const modalities = [
 {id:'chat',label:'引导式聊天',asset:'pictogram-chat',color:'#f5d5ff',caption:'推荐'},
 {id:'read',label:'阅读',asset:'pictogram-read',color:'#f9f284',caption:'快速赶上'},
 {id:'flashcards',label:'闪卡',asset:'pictogram-flashcards',color:'#bcf887',caption:'最受欢迎的功能'},
 {id:'quiz',label:'测验',asset:'pictogram-quizzes',color:'#bbeef0',caption:'检查你的理解'},
 {id:'test',label:'模拟测试',asset:'pictogram-test',color:'#bbeef0',caption:'为考试做好准备'},
 {id:'tutor-me',label:'小C辅导',asset:'pictogram-tutor-me',color:'#f5d5ff',caption:'一起把问题讲明白'},
 {id:'audio-recap',label:'音频复习',asset:'pictogram-audio-recap',color:'#ffca98',caption:'听一听，学一学'},
 {id:'arcade',label:'互动练习',asset:'pictogram-arcade',color:'#bcf887',caption:'让学习更有趣'},
];
export function stored<T>(key:string,fallback:T):T {try{return JSON.parse(appStorage.getItem(`sf-k12:${key}`)||'null')??fallback;}catch{return fallback;}}
export function save(key:string,value:unknown){appStorage.setItem(`sf-k12:${key}`,JSON.stringify(value));}

export function getCurriculum(stage = stored('stage', '未设置'), topic = stored('topic', '')) {
 if (/科学/.test(topic)) return {materials:['观察与测量','生命与生长','物质与变化','力与运动','地球与环境'],units:[['提出可以研究的问题','记录观察结果','比较与测量'],['植物的生长','动物的生活','生命与环境'],['物质的不同性质','水的三态变化','日常生活中的变化'],['物体的运动','常见的力','力与运动的关系'],['天气与季节','认识地球','保护身边的环境']]};
 if (/物理|Physics/i.test(topic)) return {materials:['运动、力与能量基础','机械运动与力','声与光','电学基础','实验与测量'],units:[['速度与路程','力的单位','惯性与质量','重力势能'],['运动的描述','常见的力','力与运动的关系'],['声音的产生与传播','光的反射','光的折射'],['认识电路','电流与电压','电阻与欧姆定律'],['长度与时间的测量','控制变量','分析实验数据']]};
 if (/化学|Chemistry/i.test(topic)) return {materials:['物质、元素与化学变化','原子与分子','常见物质的性质','化学方程式','实验观察与分析'],units:[['物理变化与化学变化','元素与物质','质量守恒定律'],['认识原子与分子','元素符号','化学式与物质组成'],['水与空气','氧气的性质','常见酸碱盐'],['书写化学方程式','化学方程式的配平','反应前后的质量关系'],['实验现象与结论','实验条件的比较','整理实验记录']]};
 if (/生物|Biology/i.test(topic)) return {materials:['细胞、生物体与环境','细胞的结构与功能','光合作用与呼吸作用','遗传与生命活动','生态系统'],units:[['细胞与生物体','生物的基本特征','生物与环境的关系'],['细胞膜的作用','细胞核与遗传信息','植物细胞与动物细胞'],['光合作用的意义','呼吸作用的意义','物质与能量的变化'],['遗传信息的传递','生物的生长与发育','观察生命现象'],['生态系统的组成','生产者与消费者','食物链与食物网']]};
 if (/历史|History/i.test(topic)) return {materials:['中国历史基础时间线','古代国家与制度','统一多民族国家的发展','近代中国的变革','史料与历史解释'],units:[['商鞅变法','秦的统一','张骞出使西域','明朝建立','辛亥革命'],['比较政治制度','经济与社会生活','文化与科技成就'],['统一与分立','民族交往与交流','中外交流的历史'],['近代社会的变化','探索与变革','认识重要历史事件'],['辨别史料类型','联系时代背景','用史料支持观点']]};
 const subject = /语文|阅读|文学|古诗|作文|写作/.test(topic) ? '语文' : /英语|English|词汇|语法/.test(topic) ? '英语' : '数学';
 if (subject === '语文') return {materials:['字词与表达','阅读理解','古诗文积累','写作与修改','综合复习'],units:[['字音与字形','词语的理解与运用','句子表达'],['概括文章内容','理解人物与情感','寻找文章依据'],['诗句朗读与积累','理解诗歌意象'],['确定写作主题','组织文章结构','修改与润色'],['基础知识练习','阅读综合练习','写作练习']]};
 if (subject === '英语') return {materials:['词汇与句型','时态与语法','阅读理解','写作与表达','综合练习'],units:[['日常主题词汇','词性与搭配','基本句型'],['一般现在时','一般过去时','现在进行时'],['寻找文章主旨','定位细节信息'],['组织句子','连词与衔接','短文写作'],['词汇复习','语法练习','阅读练习']]};
 if (stage === '小学') return {materials:['数与运算','分数与小数','图形与几何','解决问题','统计与概率'],units:[['整数的认识','四则运算顺序','简便运算'],['分数的意义','分数的基本性质','小数与分数'],['平面图形周长','平面图形面积','立体图形认识'],['数量关系','应用题的分析','检查与验证'],['数据整理','条形统计图','可能性的大小']]};
 if (stage === '初中') return {materials:['有理数与整式','方程与不等式','函数初步','几何与证明','统计与概率'],units:[['有理数运算','整式的加减','因式分解'],['一元一次方程','二元一次方程组','一元一次不等式'],['函数与坐标','一次函数','二次函数初步'],['三角形与全等','勾股定理','圆的基本性质'],['数据分析','平均数与方差','简单概率']]};
 return {materials:initialMaterials,units};
}
