# PR-004：生成任务、输入快照与用量控制

状态：代码与自动化验收已完成，尚未部署；真实生成验收受 OpenRouter/Baidu 上游 429 限流阻塞，不能视为生成成功。

基线是 PR-003 合并提交 `7717493`，业务代码全部在 StudyC。用户指定复用 PlanPlan 的 OpenRouter 模型配置；默认使用 `baidu/ernie-5.5-flash-preview:free`、compact 输出、Baidu provider、禁用 fallback。此 PR 建立后端生成基础；不包含 PR-005 的聊天页面、PR-006 的牌组或 PR-007 的测验界面。

## 首个真实任务

`study_outline` 从当前账户同一学习集的 1–5 份资料生成学习提纲。输入必须指定每份资料的准确版本；资料不能为空，正文合计不超过 32 KiB。配置只允许 `language`（`zh-CN` 或 `en`）与 `pointCount`（1–8）。客户端不能指定任意提示词、模型、上游 URL 或令牌预算。

任务创建时持久化标题、正文、版本、正文摘要、生成配置、提示词版本和公开模型配置。资料之后被编辑，不改变已经提交的任务。PDF 页码只对未编辑的原始提取正文有效；编辑后的资料可以生成，但不再把旧字符区间当作有效 PDF 页码。

模型必须返回约定的 JSON 和准确数量的要点，每个要点包含原文引用。服务端核验 sourceId 和逐字引用，再从快照计算资料版本、字符区间与可确认的页码。无法定位的引用、坏 JSON、截断或空输出都不能标为成功。引用可定位不等于语义一定正确；这里完成结构和来源校验，教学质量评测由后续产品 PR 补充。

## 接口契约

沿用安全 Cookie、Expected-User、Origin 和 CSRF，不另建账号或 Bearer 认证。下列路由均 `private, no-store`，JSON 请求最多 16 KiB。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/study/sets/:setId/generations` | 创建任务；新建 202，同一意图重放 200 |
| GET | `/v1/study/sets/:setId/generations` | 分页查看当前学习集任务 |
| GET | `/v1/study/sets/:setId/generations/:jobId` | 任务状态、原输入、结果和尝试记录 |
| POST | `/v1/study/sets/:setId/generations/:jobId/cancel` | 取消排队或执行中的任务 |
| POST | `/v1/study/sets/:setId/generations/:jobId/retry` | 新 `clientRequestId` 明确重试，沿用原快照 |
| GET | `/v1/study/generation-usage` | 当前账户当天用量、保留预算和限额 |

创建示例：

```json
{
  "clientRequestId": "11111111-1111-4111-8111-111111111111",
  "kind": "study_outline",
  "sources": [{ "materialId": "22222222-2222-4222-8222-222222222222", "version": 1 }],
  "config": { "language": "zh-CN", "pointCount": 3 }
}
```

请求 ID 相同而输入不同返回 409；资料版本不匹配返回 409；越权对象返回 404；限额不足返回 429；未启用模型配置时，新生成和重试返回 503。明确重试不改变原资料快照，也不偷偷改用新模型配置；上游配置变化会要求重新创建任务。

## 持久任务与失败语义

任务和每次尝试保存在 PostgreSQL。领取任务时先提交独立尝试和租约，再发给 OpenRouter。运行中的尝试依赖租约及完成条件检查，多个 worker 不能领取同一份任务；迟到的完成回调不能覆盖已经取消的任务或更新的尝试。

排队任务在进程重启后继续。已发出而没有确定结果的任务在租约到期后进入 `interrupted`，保留未知用量，不自动重复发给模型。用户可明确重试，默认每个任务最多 3 次。取消会尝试中止上游连接，但不承诺上游一定停止计费；取消和失败也保留已知实际用量。

## 用量与限额

数据库事务串行核对并预留预算，避免多个请求同时通过检查。默认按 UTC 日计算：

| 限制 | 默认值 |
| --- | --- |
| 每用户 / 全局每日尝试次数 | 20 / 200 |
| 每用户 / 全局每日 token 预算 | 100,000 / 1,000,000 |
| 每用户 / 全局活动任务数 | 3 / 100 |
| 每用户 / 全局同时运行数 | 1 / 2 |
| 每任务最大尝试次数 | 3 |

排队任务跨 UTC 午夜时，领取前把未发送的预算转移到实际调用日并重新核对当天限额；当天额度不足则明确失败，不会绕过额度继续调用。已经外发的尝试不改变其预算日。

调用前以输入字节和最大输出预算保守预留；取得上游实际 token 用量后结算。没有发送的尝试可释放 token 预留；发送结果不明时保留预留，不能把未知支出显示为零。上游返回的 credits 成本单独记录，不按本地单价猜测。全局账本保留已经消耗的合计，注销账户不会重置全局预算。

这些是 StudyC 的限额。复用同一个 OpenRouter key 时，供应方账户配额仍与 PlanPlan 共享；StudyC 的账本不统计 PlanPlan 的调用。不会因免费模型限流而自动改用付费模型。

运行限额由 `STUDYC_AI_USER_DAILY_REQUESTS`、`STUDYC_AI_GLOBAL_DAILY_REQUESTS`、`STUDYC_AI_USER_DAILY_TOKENS`、`STUDYC_AI_GLOBAL_DAILY_TOKENS`、`STUDYC_AI_USER_ACTIVE_JOBS`、`STUDYC_AI_GLOBAL_ACTIVE_JOBS`、`STUDYC_AI_USER_CONCURRENCY`、`STUDYC_AI_GLOBAL_CONCURRENCY` 和 `STUDYC_AI_MAX_ATTEMPTS` 配置；运行时拒绝不合法或互相矛盾的值。

## 配置与发布边界

AI 默认关闭。启用时，在 StudyC 非秘密运行配置中设置：

```dotenv
STUDYC_AI_ENABLED=true
STUDYC_AI_SECRETS_FILE=/etc/studyc/ai-secrets.json
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=baidu/ernie-5.5-flash-preview:free
OPENROUTER_OUTPUT=compact
OPENROUTER_TIMEOUT_MS=60000
```

`ai-secrets.json` 仅允许 `OPENROUTER_API_KEY`；普通私密文件，root 管理，StudyC 组只读。不得直接把 PlanPlan 整份秘密文件或 JWT/邮件密钥交给 StudyC；原 `secrets.json` 仍仅允许数据库和共享写限额密钥。复用 key 通过受控配置执行，不写进代码、文档、命令参数或前端构建。

StudyC 迁移版本 3 只追加自己的生成表、约束与迁移登记，保留版本 1、2 和 PlanPlan 历史。发布需要先以 owner 执行显式迁移并授予运行角色所需表权限，再运行 `check`，固定代码版本启动。Nginx 只增加上述六个方法/路径组合；既有资料、PDF 和账户接口的请求大小与上游规则保留。

已有旧程序严格检查迁移历史长度，应用新迁移后不能直接切回只认识版本 2 的程序。首选关闭 `STUDYC_AI_ENABLED` 并运行认识版本 3 的代码，停止新调用而保留资料、快照、尝试和账本；如确需旧代码回退，须先提供兼容版本 3 的回退构建。禁止删除新表或迁移登记伪装回退。

## 验收

自动测试使用合成身份、隔离 PGlite/PostgreSQL 和可控制上游，覆盖归属与版本、幂等与并发预算、输入不可变、PDF 页码失效、进程恢复、取消/迟到结果、上游错误和记录结算。真实 OpenRouter 验收仅用合成学习资料，复用用户指定的配置，不读取真实用户学习内容。构建、测试和真实调用结果在 PR 描述中记录；代码完成不等于已部署或已有聊天前端。

协议依据：[Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)、[Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)、[Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)。
