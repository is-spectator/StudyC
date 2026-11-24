# PR-011～017 本地集成交付

2026-11-24，StudyC 独立仓库，分支 `codex/studyc-local-import`。生产与 main 没有自动更新。以下均为逐个独立栈 PR，需按依赖顺序审查后合并。

| 功能编号 | GitHub | 本地入口 |
| --- | --- | --- |
| PR-011 计划 | [#12](https://github.com/is-spectator/StudyC/pull/12) | 学习集 → 学习计划 |
| PR-012 日历 | [#13](https://github.com/is-spectator/StudyC/pull/13) | `/platform/calendar` |
| PR-013 搜索 | [#14](https://github.com/is-spectator/StudyC/pull/14) | `/platform/search` |
| PR-014 文件夹 | [#15](https://github.com/is-spectator/StudyC/pull/15) | `/platform/folders` |
| PR-015 回收站 | [#16](https://github.com/is-spectator/StudyC/pull/16) | `/platform/trash`；学习集页可移入 |
| PR-016 文本副本 | [#17](https://github.com/is-spectator/StudyC/pull/17) | 学习集页或已保存资料页 → 复制 |
| PR-017 旧文本导入 | [#18](https://github.com/is-spectator/StudyC/pull/18) | `/platform/local-data` → 导入旧文本资料 |

本地地址 `http://127.0.0.1:5180`，点击「进入验收账户 A」或 B，无需另建账号。后端 `127.0.0.1:18790`，学习数据保存在 `.local/acceptance`；重启不重置验收记录。沿用原 OpenRouter/Baidu 免费模型配置，本轮功能未调用模型，不需要等待限流恢复。

账户A可查看「原模型实测 18:56:37」的真实原文、笔记、卡组和测验；其「水循环学习目标 · PR011验收」保留计划任务及真实学习完成依据。日历切到 2026-12-01 所在周可看全天/定时/冲突样例。文件夹「理科资料 · 验收…」保留该学习集归类。新保留的「回收站完整流程…」已恢复原资料，「独立文本副本 · 验收…」展示独立编辑副本，「本机资料导入 · 验收…」保留导入后云端编辑和去重结果。

最新本地校验：后端477项（29文件）、前端117项、部署配置23项全部通过，前后端类型检查/构建通过。迁移已到v15，旧表/迁移校验和未改写；升级、账户删除、功能关闭和权限边界在专项及全量回归中验证。

桌面1440×1000、手机390×844使用真实 Chrome/Playwright（Browser plugin not available）。各任务书记录实际步骤及边界，特别覆盖成功响应丢失的同意图重试、真实双页409、夏令时/跳过日期、精确搜索跳转、归类并发、回收站子内容隐藏/恢复、复制不带旧历史、逐项旧数据导入与不覆盖云端编辑。A/B跨账户访问/写入拒绝。审查发现的计划请求/加载状态、日历跳过日期及文件夹云端目标问题均已修复并浏览器回归。

临时浏览器脚本、运行报告、截图和合成原始备份在 `/tmp/studyc-pr011`～`/tmp/studyc-pr017`，不提交仓库；项目运行日志不包含模型密钥。没有生产发布、自动合并、模型切换或新增支付/OCR/媒体功能。复制首版仅当前纯文本；导入首版仅当前账户旧 uploads 文本，详见相应任务书。
