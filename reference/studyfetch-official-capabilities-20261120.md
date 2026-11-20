# StudyFetch 官方功能说明核对

核对日期：2026-11-20（Asia/Shanghai）。

**证据等级：官方说明 未实测。** 本文仅依据本次通过 web 工具取得的官方产品页、StudyFetch Academy 操作文档和官方更新说明。没有进入登录后产品、生成内容、上传文件、调用账户 API、使用当前浏览器会话，也没有把仓库旧 JS、旧截图或本地仿制功能当作当前原站运行证据。以下测试项均为待执行建议。

官网文档目录为 [StudyFetch Academy](https://www.studyfetch.com/docs)，功能导航见 [官方教程入口](https://www.studyfetch.com/tutorial)。部分目录的 `/docs/<标题>-<id>` 链接本次返回 404；同篇 `/docs/docs/<id>` 或搜索收录的官方子域地址可以读取。工具偶尔把 Academy 页面显示为重定向到其托管站；下列保留实际请求成功的 StudyFetch 官方入口。页面可读取与功能可用是两种证据。

## 优先安排的实测

| 优先级 | 测试任务 | 需要留下的证据 |
| --- | --- | --- |
| P0 | 用同一份短资料完成上传→笔记→闪卡→测验→结果→继续学习 | 各产物是否使用该资料；来源页码/时间戳是否可打开；刷新后是否持久保存；是否落在正确学习集 |
| P0 | 区分 QuizFetch 与 Practice Test 的完整答题流程 | 前者的信心评分、重复出题、掌握度与续做；后者的改答案、提交确认、最终评分与复盘 |
| P0 | 先检查当前账户套餐与剩余额度，再决定生成动作 | 付费提示、实际数量上限、失败是否消耗额度；不能用宣传页的“无限”替代账户观察 |
| P0 | 上传失败与材料不足 | 空文件、空白页、无正文 PDF、过短内容、失败后重试/重新选择；不得把预置内容误记为成功解析 |
| P1 | Tutor Me 的来源选择及权限边界 | 单材料选择、40/41 页边界、页码范围；屏幕/相机权限拒绝、取消、断开；是否有 Pro 限制 |
| P1 | Notes 的编辑、引用与历史 | 编辑后自动保存；原文对照；恢复历史是否正确；数学与图像是否保留 |
| P1 | 录音的拒绝同意、拒绝麦克风、断网、停止、恢复 | 不同意前不录音；音频、转写、自己的笔记、增强笔记分别保存；恢复是否追加到同一会话 |
| P1 | 音频生成与播放器 | 各类型切换时选项一致；转写与引用；提问暂停、回答后续播；失败重试与页面离开后的生成状态 |
| P1 | 分享、私有/公开、删除 | 私有资料默认状态；访客访问范围；公开分享不意外暴露整个学习集；删除确认和级联范围。使用专门的测试资料，不删除已有内容 |
| P2 | 视频、Arcade、Mini Apps、Plugins | 真正产生并运行目标内容，或明确付费/不可用；不要把预览图、介绍页、示例卡片计作成功 |

这些项目是基于下文证据提出的验证方案，不是已发现的原站缺陷。

## 功能、名称与实际流程应如何对应

本表每行均为 **官方说明 未实测**。中文名称只用于工作对照，不代表原站中文界面一定采用该译名。

| 官方名称 / 中文工作名 | 官方描述的能力与流程 | 官方证据 |
| --- | --- | --- |
| Study Set / 学习集 | 是资料与生成工具的容器。打开后展示学习计划推荐；可更改封面、标题、描述和公开性；删除会连同资料、聊天、练习和进度一起移除。 | [Manage Study Sets](https://sso.studyfetch.com/docs/docs/getting-started/manage-study-sets) |
| Notes、Notes AI / 笔记 | 上传时或已有资料中生成三种深度的笔记；可分章节、显示原文对照及来源页码；可编辑、自动保存、比较及恢复版本，选中文字让助手改写。 | [Notes Tutorial](https://www.studyfetch.com/docs/docs/6a614c99e6cf0a17b3f206ad) |
| Sparky、Spark.E Chat / 聊天 | 文本、图像和选定资料问答；来源定位；另可主动启用网页搜索和学术搜索；聊天内容能继续转换成其他学习工具。 | [Using Spark.E Chat](https://www.studyfetch.com/docs/docs/6a61801a609b2cff6eb182aa) |
| Guided Chat / 引导式聊天 | 输入目标后提出学习步骤；用户可修改计划；接受后打开相应闪卡、测验等活动，并带着当前活动上下文继续辅导。此处为官方更新说明，不能替代完成一次实际跨工具链路。 | [Guided Chat 官方更新，2026-06-18](https://www.studyfetch.com/blog/meet-guided-chatting-on-studyfetch) |
| Sparky Visuals / 图像理解 | 圈选资料中的图像局部并提问，后续追问保持选择区域的上下文；不是仅上传图片后展示缩略图。 | [Sparky Visuals](https://www.studyfetch.com/features/sparky-visuals) |
| Tutor Me / 结构化辅导 | 来源为资料、主题、屏幕共享或相机；设置探索/掌握模式、目标、语言，再生成课程并开始。屏幕和相机标为 Pro；屏幕理解标为实验性。 | [Create a Tutor Me Session](https://www.studyfetch.com/docs/docs/6a52d0b480aa1a08bac85025) |
| Tutor Me 会话内学习 | 问答与当前讲解页有关；可临时要求练习题并获得反馈；可恢复、改名、删除会话或转成其他学习工具。 | [Tutor Me Study Tips and Capabilities](https://www.studyfetch.com/docs/docs/6a52d639e694ed41fe73b2b6) |
| Live Lecture、Record Lecture / 学习录音 | 创建会话后启动录制，需先确认参与者同意；显示麦克风、音质、网络、转写和录制状态。 | [Create and Record a Live Lecture](https://www.studyfetch.com/docs/docs/6a564434d866323b6cee47da) |
| 录音后处理 | 录音结束后可再生成增强笔记；自己的笔记、增强笔记、转写、分段音频是不同对象；音频可播放、定位及下载，恢复录制继续同一会话。 | [Review Enhanced Notes, Transcript, and Audio](https://www.studyfetch.com/docs/docs/6a614017ef92b4660b0734d6) |
| Flashcards / 闪卡 | 四步向导；官方创建页列手工、资料、主题、Quizlet、Anki 五种来源。AI生成可选类型/数量、语言和插件；导入会跳过类型/数量步骤。Quizlet转术语定义，Anki尽可能保留字段格式。 | [Access and Create Flashcards](https://www.studyfetch.com/docs/docs/6a55598e886bfe1f9e31ff5b) |
| Flashcard 编辑与复习 | 编辑文档另列图像遮挡、完形填空、输入填空、选择题等类型；正反面可加图及语音。间隔复习宣传说明按自评安排下次出现时间。 | [Create Flashcard Types](https://www.studyfetch.com/docs/docs/6a5255e59f1499ded290856a)、[Spaced Repetition](https://www.studyfetch.com/spaced-repetition-app) |
| QuizFetch、Quizzes AI / 自适应测验 | 从资料或已有闪卡创建。资料路径可混合选择、判断、填空、短答、自由回答、多层段落等题型，并设置语言、插件和重点；闪卡路径直接生成20道单选。 | [Create a QuizFetch Quiz](https://sso.studyfetch.com/docs/docs/quizfetch/create-a-quizfetch-quiz) |
| QuizFetch 作答与结果 | 回答与信心评分自动保存，可跨次续做；错误会影响该题掌握进度，反复错误可能暂停并建议复习；统计、重新开始和继续学习推荐各有入口。 | [QuizFetch Results and Recommendations](https://sso.studyfetch.com/docs/docs/quizfetch/quizfetch-results-and-recommendations) |
| Practice Test、Test / 模拟考试 | 四步来源、材料、题型、设置流程；可选考试格式。空或过短材料在最终生成时应报错，并引导回材料选择。 | [Create a Practice Test](https://www.studyfetch.com/docs/docs/6a63bfe5ee9569d818eecc3c) |
| Practice Test 作答与复盘 | 单题或全部题目布局；提交前可返回修改。全部答完后激活提交并确认评分；结果有正确数、分主题表现、答案复盘及针对当前题目的聊天。 | [Take and Review a Practice Test](https://sso.studyfetch.com/docs/docs/practice-tests/take-and-review-a-practice-test) |
| Exam-Specific Questions / 考试题型 | 是测验/模拟考试生成向导中的题型分类，不应仅理解为独立静态题库。文档列医学、金融、法学、AP等分类及题型示例。 | [Exam-Specific Question Types](https://sso.studyfetch.com/docs/docs/product-docs/6a56334f8bf6b7690658d8ba) |
| Audio Recap / 音频复习 | 三步创建；操作指南来源列资料或主题，之后配置标题、重点、长度、类型、声音及语言。 | [Audio Recap: Access and Create](https://www.studyfetch.com/docs/docs/audio-recaps/audio-recap-access-and-create) |
| Audio Recap 输出类型 | 可生成摘要、讲课、播客、有声书或歌曲。播客可单人/双人；歌曲不提供声音选择，且有独立时长选项。 | [Customize and Generate](https://sso.studyfetch.com/docs/docs/product-docs/6a5425c2deb2f78c2a5f9b4a) |
| Audio Recap 播放 | 有进度、速度、音量、回退15秒/前进30秒、同步文字及来源；文字或语音提问会暂停，回答后可从原位置继续。 | [Listen and Ask Questions](https://sso.studyfetch.com/docs/docs/product-docs/6a5429228cd4ff1a19b6e136) |
| Explainers、Explainer Video / 视频讲解 | 从资料或主题创建；主题路径还选择学习层次。输出是视频而非仅一段文字。 | [Create an Explainer](https://www.studyfetch.com/docs/docs/6a563998f5c9d6009d35890c) |
| 视频样式与生成 | 经典讲解、实验性单人动画、实验性双人对话；配置呈现风格、时长、主题、语言，可选加入网页内容/图像。生成页显示进度/等待状态。 | [Choose and Customize an Explainer Video](https://www.studyfetch.com/docs/docs/product-docs/6a5639aff5c9d6009d358912) |
| Essay Grader、Assignment Grader / 作业批改 | 营销名称偏作文，操作文档覆盖一般作业：文件、富文本或手机拍照；可自带评分量表或自动生成，提交后返回分项成绩与反馈。 | [Submit an Assignment](https://www.studyfetch.com/docs/docs/6a52f58124a5c54b90a40cdf) |
| Arcade / 互动练习 | 有社区探索与我的游戏、搜索和排序；从资料/主题/闪卡创建，选游戏类型、名称和风格后生成并运行；文档列8种游戏，含配对、跑酷、射击和多人问答。 | [Arcade Tutorial](https://www.studyfetch.com/docs/docs/6a5451b3b47a1f7e9e4bb168) |
| Mini Apps / 学习工具 | 独立的社区应用与自定义应用能力；官方页称可从个人资料生成、发布或自用，公共画廊可不登录试玩。它与固定模板的 Arcade 不是同一项。 | [Mini Apps](https://www.studyfetch.com/features/mini-apps) |
| Plugins / 教学风格插件 | 自定义生成/教学指令，可应用到聊天、闪卡、测验和考试；提供社区浏览与创建发布入口。插件并非简单切换助手头像。 | [StudyFetch Plugins](https://www.studyfetch.com/features/plugins) |
| Study Plan / 学习计划 | 按单元组织主题，可关联大纲及考试；有突击/标准/全面模式，不同排序及筛选；覆盖与掌握度分开统计。 | [Study Plan](https://www.studyfetch.com/docs/docs/6a519349893cd6f616be1054) |
| Calendar / 日历 | 任务/日/周/月视图；手工事件与任务、筛选；输入考试安排后生成学习日程。 | [Calendar Tutorial](https://www.studyfetch.com/docs/docs/6a066a70da6aa7877d2de1dc) |
| Insights / 学习洞察 | 从测试、闪卡和辅导活动产生强弱项、进度与学习建议；文档仍列单独入口，但其附图时间较旧，应核对当前账号是否仍单独存在。 | [Insights Tutorial](https://www.studyfetch.com/docs/docs/6a066a15ec6cd1436c204091) |
| Text Sparky / iMessage学习助手 | 宣传通过iMessage文字和图片提问、主动复习提醒及群聊测验。与网页聊天、语音通话、手机拍照上传是不同链路；本次未尝试发消息。 | [Text Sparky](https://www.studyfetch.com/features/text-sparky) |

## 输入类型与明示边界

每项均为 **官方说明 未实测**。未列出的格式不自动判定为不支持；没有找到的限制也不等于无限制。

| 项目 | 明示内容 | 证据性质与来源 |
| --- | --- | --- |
| 一般资料上传 | PDF、DOCX、PPTX、TXT、PNG、JPEG；上传时可开图像提取、笔记生成及章节拆分。 | 操作文档正文：[Upload method guides](https://www.studyfetch.com/docs/docs/6a542f744aad29a96f070b4e) |
| 其他输入入口 | MP3、MP4；YouTube链接；Google Drive连接；Quizlet链接；粘贴笔记、空白笔记、手机二维码拍照、无资料主题生成。主题生成称产出3–8份材料。 | 同一[上传指南](https://www.studyfetch.com/docs/docs/6a542f744aad29a96f070b4e)。这是文档列举，不是完整 MIME/大小白名单。 |
| 上传次数 | 免费累计2次；删除不返还额度；Premium写为不限上传次数。 | 操作文档正文：[Upload study materials](https://www.studyfetch.com/docs/docs/6a542e364aad29a96f070b20)。不推导为所有生成、时长或文件大小无限制。 |
| Tutor Me材料 | 每次仅选1份材料，最多40页；更长材料需拆成多次。 | 操作文档正文：[Create a Tutor Me Session](https://www.studyfetch.com/docs/docs/6a52d0b480aa1a08bac85025)。同页主题输入附图显示500字符计数，服务器是否同样限500仍需实测。 |
| 测验/考试题数 | 向导附图说明显示总数250、每种题型最多200；并非本次亲自操作上限控件所得。 | [QuizFetch创建](https://sso.studyfetch.com/docs/docs/quizfetch/create-a-quizfetch-quiz)、[Practice Test创建](https://www.studyfetch.com/docs/docs/6a63bfe5ee9569d818eecc3c) |
| 学习集封面 | PNG、JPG、GIF，最多5 MB。 | [Manage Study Sets](https://sso.studyfetch.com/docs/docs/getting-started/manage-study-sets) 的附图说明；不能套用为资料文件上限。 |
| 作业批改文件 | PDF、DOC、DOCX、PPT、PPTX、PNG、JPEG；还可富文本/手机拍照。 | [Submit an Assignment](https://www.studyfetch.com/docs/docs/6a52f58124a5c54b90a40cdf)。此入口比一般资料上传列举的格式更广。 |
| 音频输出时长 | 常规六档长度；歌曲独立为15秒、30秒、1分钟、2分钟。常规六档未在该操作页逐档映射分钟数。 | [Audio Recap配置](https://sso.studyfetch.com/docs/docs/product-docs/6a5425c2deb2f78c2a5f9b4a) |
| 视频输出时长 | 短约3分钟、中约3–8分钟、长约8–12分钟、加长18–20分钟。 | [Explainer配置](https://www.studyfetch.com/docs/docs/product-docs/6a5639aff5c9d6009d358912)，是目标长度说明，不是实测生成保证。 |
| 尚未确认的限制 | 单资料MB上限、扫描PDF页数、文档总页数、录音单次硬上限、YouTube字幕/地区/私有视频要求、并发生成数、Anki媒体兼容范围、每套餐各工具次数。 | 本次读取的操作文档没有给出足够统一的明确值；需查看当前账户控件及受控测试。 |

## 必须保留的不一致与待核实项

1. **入口名称不同，不代表不同产品。** 官网导航使用 Notes AI、Quizzes AI、Essay Grader；文档常写 Notes、QuizFetch、Assignment Grader。`PDF to …` 等页是按输入/任务组织的营销入口，官方工具目录说明其导向对应产品功能，不应逐页算成独立实现。[官方工具目录](https://www.studyfetch.com/tools)
2. **创建来源选项可能有版本差异。** 当前操作文档的闪卡列5项、测验/考试和音频列2项，Arcade列3项。文档没有据此证明 Highlights 来源已移除，也不能证明所有账号都没有该入口。应逐页记录当前屏幕和实际可用分支；本报告不拿旧截图纠正文档。
3. **聊天不是一律禁止外部资料。** [聊天产品页](https://www.studyfetch.com/features/chat)强调围绕上传资料；[聊天操作文档](https://www.studyfetch.com/docs/docs/6a61801a609b2cff6eb182aa)明确存在用户启用的网页/学术搜索。应验证默认模式、开关状态、引用来源及失败回退，不能只按“RAG聊天”概括。
4. **音视频格式与时长宣传并不统一。** [音频营销页](https://www.studyfetch.com/section/lecture-audio-to-ai-study-materials)另列WAV/M4A并称时长不限；[转写营销页](https://www.studyfetch.com/section/ai-powered-lecture-transcription-and-quiz-generator)列AAC并建议低于4小时；[视频营销页](https://www.studyfetch.com/section/lecture-video-to-ai-study-guide-video-lecture-notes-generator)列AVI/MOV并建议低于2小时。这些是官方营销说明，不能当作上传控件已接受所有格式、无服务器硬限制的证明。
5. **免费额度并非所有页面统一口径。** 上传操作文档写累计2次上传；[教师录课营销页](https://www.studyfetch.com/section/teacher-s-ai-note-taker-capture-and-share-lecture-content-easily)写免费每月5小时。这可能是不同场景或版本，不能合并成当前消费者套餐。优先记录账户实际付费门槛及计数，不在未知情况下反复消耗额度。
6. **Audio Recap不能只按旧分钟区间验收。** [较泛化的实时笔记营销页](https://www.studyfetch.com/section/real-time-ai-notes-during-lectures)仍写音频6–45分钟；具体配置文档新增歌曲与不同档位。以当前具体类型和参数实测，不把歌曲15秒判成异常。
7. **LMS入口未必是已连接的导入器。** 上传指南说明未接入学校的 Brightspace/Canvas/Blackboard 入口可能只生成请求集成的邮件模板。看到按钮不能就记为已完成OAuth或导入。[上传指南](https://www.studyfetch.com/docs/docs/6a542f744aad29a96f070b4e)

## 细化的边界用例

以下为测试设计，不是官网承诺，也不是已有测试结果。

- **生成链路：** 每份合成资料放独有标识和少量可人工核对的事实；检查笔记、题目和语音是否真的使用了所选资料，改变资料选择后是否仍引用旧文件。记录生成ID、耗时、终态和刷新恢复。
- **题目配置：** 0题、单题型上限附近、合计上限附近、混合题型、未命名、非英文输出、插件与重点条件。检查UI计数、生成数和结果分母是否一致，不实际发起不必要的大批量生成。
- **闪卡：** 手工空行、删除最后一张、反向卡、多空完形、无正确答案选择题、图像遮挡；Quizlet/Anki导入结果与源内容逐项比对，不能把提示“导入成功”当作完整字段/媒体支持。
- **续做：** 测验答错后重新出现、信心评分影响、关闭后继续、重启统计；模拟考试跳题、返回改答、未完成提交、复盘后重考。分别记录“完成率”“正确率”“掌握度”，不混为一个百分比。
- **媒体与权限：** 无声录音、中文/英文混合、中文标点和数学符号、拒绝麦克风、屏幕分享取消、网络中断、后台/锁屏、暂停后恢复。跨设备拍照还需检查取消、重拍、多页及过期二维码。
- **异步状态：** 生成过程中离页再回来、刷新、重复点击、失败重试、达到限额后的按钮状态。区分真正云端持续生成与只存在当前页面的计时动画。
- **计划和日历：** 没有材料/没有考试日期、过去日期、同日多考试、编辑/删除日期、跨时区日期；检查重排是否保存、用户自建事件是否保留。
- **隐私与分享：** 仅用无个人信息的测试学习集验证公开/私有和访客权限；不要为验收主动发邮件、iMessage、公开发布社区内容或删除用户现有资料。

## 本轮没有得出的结论

没有认定任何上述功能在当前账户可免费使用、没有测得AI准确率或生成成功率、没有核实价格与付款条款、没有确认地区/浏览器/手机平台的完整支持矩阵，也没有确认所有宣传功能都已向所有账号开放。官网提及的效果提升、转写准确率、用户数量和社区播放数未作为实施要求或实测结果收录。
