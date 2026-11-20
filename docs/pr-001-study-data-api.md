# PR-001：StudyC 学习集与纯文本资料后端

状态：2026-11-20 已实现并提交草稿 [PR #40](https://github.com/is-spectator/planplan/pull/40)，待审查/合并，未部署。所属路线：[S1 学习空间与文本资料](implementation-roadmap.md)。

实现提交 `5083016`，接口与运行说明见 [后端 STUDYC_API.md](https://github.com/is-spectator/planplan/blob/50830163407548a31d965b7db53e5cc4ca723fd3/server/STUDYC_API.md)。认证前置另列 [PR #41](https://github.com/is-spectator/planplan/pull/41)，基线 `d6f6166`。本地 StudyC 集成测试 17/17 通过，后端全量 334 项通过、1 项 PostgreSQL 专用测试跳过，类型检查和构建通过；GitHub CI 结果以 PR 页面为准。

实施中的迁移边界：干净远程基线只有迁移 1–10，本 PR 追加迁移 11；原脏工作区另有模板迁移 11–17。发布前必须统一完整迁移序列，不能把此分支直接用于那条迁移线的库；回退应用也须保留已应用迁移的 registry。下文保留完整任务契约供审查。

**建议标题：** `feat(studyc): persist study sets and text materials with account isolation`

**仓库：** `is-spectator/planplan`，共享后端 `server/`。建议分支：`codex/studyc-data-api`。本任务书存放在 StudyC 仓库，方便统一交接；实现不放进只有前端的 StudyC 仓库，也不新建注册服务。

## 1. 要解决的问题与交付结果

StudyC 目前把学习集保存为名字数组，资料写在账户级 localStorage。改名或建立另一学习集，没有建立独立的服务端内容空间；换浏览器无法恢复资料。

本 PR 交付 **可调用、可持久化、按账户和学习集隔离的八个后端接口**。例如同一账户创建“数学”和“历史”两个学习集，各存一段文本；重启服务后仍可分别读取，另一账户无法访问。更新冲突不会覆盖正文，创建重试不会增加副本。

本 PR 不接页面，因此合并后 StudyC 线上界面暂时不变。PR-002 再完成动态路由、编辑保存与同源代理；不要用“云同步已上线”描述 PR-001 的完成状态。

## 2. 开工前固定基线

| 项目 | 当前已知 / 接手要求 |
| --- | --- |
| StudyC | `https://github.com/is-spectator/StudyC`，审计基线 `89ecc31`。只用于核对当前前端契约。 |
| 后端仓库 | `https://github.com/is-spectator/planplan`。需同时拥有该仓库读取与提交 PR 的权限。 |
| 本地认证实现线索 | `/Users/fangnaoke/Documents/ChatGPT/planplan-web-session`；分支 `codex/web-session`、HEAD `1fc1bc5`。工作区有大量未提交内容，`server/src/api/web-session.ts`、对应测试尚为未跟踪文件。**这些不是已合入远程 main 的证据。** |
| 基线交接（已完成） | 已提取并推送独立基线 `d6f6166a7eedbeafffbfcf757f03d1c7ee9fe219`，分支 `codex/studyc-web-session-base`，见认证 PR #41。包含 Cookie/CSRF、测试和配置文档；没有带入其他未提交功能。PR #40 当前以该分支为 base，认证先合入主线后再调整 base。 |
| 已发现栈 | Hono、TypeScript、现有 `Db` 抽象与 PostgreSQL/PGlite；沿用仓库锁文件与运行方式，不另选 ORM/数据库或建立第二份账户表。 |
| 环境 | 使用临时测试库和测试账户；不连接生产数据库跑迁移或验收。线上部署不在此开发 PR 的验收动作内。 |

**认证基线已经独立固定，不属于 PR #40 的业务差异。** 后续接手者从上述可访问分支/提交读取，不能用伪造用户 ID 或绕过会话完成替代实现。先阅读目标仓库实际的 `AGENTS.md` 和贡献规则。

## 3. 必做与不做

必做：

1. 追加独立学习集、纯文本资料表及索引/外键，接入现有迁移机制。
2. 学习集列表、创建、读取、改名；集合内文本资料列表、创建、读取、更新。
3. 复用现有身份验证、Cookie 变更请求校验、共享写入限流和账户生命周期约束；所有权在服务端确定。
4. 创建幂等、更新版本冲突、输入限制、标准错误及接口测试。
5. 交付 API 契约、临时环境验收方法、迁移/回退说明，供 PR-002 直接接入。

本 PR **不包含**：前端/路由/Nginx 修改、删除/回收站、复制/文件夹/分享、文件上传/PDF/OCR、富文本/完整历史版本、AI/卡片/测验、学习计划/日历、订阅/支付、本地数据自动导入、注册/SSO 重构。账户整体注销的既有清理行为仍须兼容新表，这不等于增加产品的资料删除接口。

## 4. 数据约定

以下是本 PR 的目标契约。表名建议 `study_sets`、`study_materials`；与既有数据库命名一致即可，API 字段保持下表约定。

| 对象 | 字段与规则 |
| --- | --- |
| StudySet | `id`：服务端 UUID；`user_id`：现有认证用户，即所有者；`title`；`version`：整数从 1 开始；`created_at`、`updated_at`：服务端时间。 |
| TextMaterial | `id`：服务端 UUID；`study_set_id`；`user_id`；`title`；`body`：原样纯文本；`format` 固定 `plain_text`；`version` 从 1 开始；两个时间字段。 |
| 创建去重 | 两类资源各保存 `client_request_id` 和规范化创建输入的摘要，或采用等效的原子幂等记录。唯一范围为“账户 + 资源类型 + clientRequestId”；材料摘要包含目标学习集。 |

- 所有权使用现有用户 UUID；材料通过复合外键或等效数据库约束，保证 `study_set_id` 与 `user_id` 匹配。所有业务查询仍必须带认证所有者条件，不能只依赖难猜的 UUID。
- 标题允许重复，身份由 ID 决定；学习集标题 trim 后 1–60 个 Unicode 码点，资料标题 1–120 个；不以标题建立唯一约束。
- `body` 字段必填，可为空字符串，便于新建空白笔记；上限 **1,048,576 个 UTF-8 字节**。保留换行和文本内容，不按 HTML 解析；客户端提供的 HTML 仅视为文本。
- 接受 JSON，字段严格校验；客户端不能提交 `userId`、`user_id`、`ownerId`、`owner_id`、`id`、时间戳等服务端字段。禁止用 body/header 中的用户 ID 代替已认证身份。
- API 返回 camelCase 字段，时间为 UTC ISO 8601；不返回 owner、去重摘要或数据库内部字段。
- `version` 只表示并发更新版本，本 PR 不宣称可恢复每一版正文。AI 接入前，PR-004 另建不可变输入快照。
- 追加迁移，禁止修改已发布迁移及 checksum。当前本地 registry 到 17，但实际版本号以接手基线为准，不硬编码“下一版一定是 18”。
- 新表与已有账号删除/删除期间禁止写入规则兼容；并发删除账户不得遗留资料。沿用 `user_id` 便于复用读取 `NEW.user_id` 的生命周期触发器；写事务遵循现有 `db.tx(..., userId)` 与事务内 `requireActiveUser` 约定。用户外键级联清理覆盖集合、资料及独立幂等表；保留现有业务表与账户数据。

## 5. API 契约

统一前缀 **`/v1/study`**。所有路由置于现有认证中间件之后，沿用 `uid(c)` 或等效已认证上下文。八条路由以“方法 + 路径”为单位计数。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /v1/study/sets` | `{clientRequestId, title}` | 首次 201，重放 200；`{studySet}`。 |
| `GET /v1/study/sets` | 可选 `limit`、`cursor` | 200；`{items: StudySet[], nextCursor}`。 |
| `GET /v1/study/sets/:setId` | UUID 路径参数 | 200；`{studySet}`。 |
| `PATCH /v1/study/sets/:setId` | `{version, title}` | 200；`{studySet}`，版本递增。 |
| `POST /v1/study/sets/:setId/materials` | `{clientRequestId, title, body}` | 首次 201，重放 200；`{material}`，含正文。 |
| `GET /v1/study/sets/:setId/materials` | 可选 `limit`、`cursor` | 200；`{items: MaterialSummary[], nextCursor}`，列表不含正文。 |
| `GET /v1/study/sets/:setId/materials/:materialId` | 两个 UUID | 200；`{material}`，含正文。 |
| `PATCH /v1/study/sets/:setId/materials/:materialId` | `{version, title?, body?}`，至少提交 title/body 之一 | 200；`{material}`，版本递增。 |

`StudySet` 返回 `id, title, version, createdAt, updatedAt`；`MaterialSummary` 返回 `id, studySetId, title, format, version, createdAt, updatedAt`；`material` 在摘要基础上增加 `body`。所有成功响应为 JSON。

### 列表、大小与状态码

- `limit` 默认 50、范围 1–100。排序固定 `created_at DESC, id DESC`；游标表达上一项边界；`nextCursor` 无下一页时为 `null`。无效游标返回 400。相同时间戳不会造成漏项或重复，修改标题不改变创建排序。
- 学习集及资料的写入必须限制请求大小：普通小请求保持现有小请求限制；资料 POST/PATCH **JSON 请求体总上限 2 MiB**，另校验正文 1 MiB，两个条件须同时满足。转义后 JSON 超限仍返回 413，即使解码正文未超 1 MiB。中间件需覆盖无 Content-Length 的请求，不能只信任头部。
- 列表仅返回自己的资源。集合不存在/无权访问返回 404；资料不属于路径中的集合同样 404，即使两个集合都属于同一账户。先校验父集合，不能对别人的集合返回“空列表”。
- 失败沿用 `{error:{code,message}}`；错误文本不包含正文、会话信息、SQL 或其他账户资源细节。
- 400：`invalid_input`，本路由格式/长度/字段错误；认证继续沿用现有 401/403/409 及对应错误码；404：`not_found`；业务 409：`version_conflict` 或 `idempotency_conflict`；413：`payload_too_large`；429：沿用既有限流约定；5xx：明确失败，不返回成功对象。补齐新错误类型及状态映射，不能让新错误落入现有默认 422；不改变已有 PlanPlan 路由的错误语义。
- `version_conflict` 与现有 `account_mismatch` 必须区分。现有前端会因后者清除身份，编辑冲突不得使用该码。
- StudyC 响应设置 `Cache-Control: private, no-store`；不开放公共 CORS。POST/PATCH 复用现有 `write` 限流，每账户 120 次/分钟，与该账户的 PlanPlan 写请求共享预算；GET 保持认证及分页，本 PR 不新建通用 read 限流体系。

### 创建重试与并发更新

`clientRequestId` 是客户端为一次创建意图生成的 UUID。第一次提交失败后重试必须复用它；想再创建一份同名内容必须换 UUID。

1. 相同账户、相同资源类型、相同 request ID 和相同规范化创建输入，只创建一条记录；重放返回 200 和该资源的**当前**内容/版本。规范化只对标题 trim、UUID 统一形式；正文原样保留，摘要使用固定字段顺序或稳定序列化，不受 JSON 属性顺序影响。首次创建输入摘要保留不变，后续改名不影响重放识别。
2. 同一个 request ID 改了创建输入（包括材料所属集合）返回 409 `idempotency_conflict`；不改写原资源。不同账户可以使用相同 request ID，互不共享返回结果。
3. 去重在数据库唯一约束/事务内原子执行；两条并发创建不能仅靠“先查再插”避重。
4. PATCH 使用 `WHERE user_id = 当前用户 AND version = 请求版本` 等效的原子条件更新；成功版本 +1。两个客户端以同一版本编辑，恰好一个成功，另一个 409。
5. 冲突后客户端重新 GET 当前内容再决定如何处理。后端不自动合并、覆盖或把失败当作成功。

### 请求示例

以下 ID 仅是测试样例。实际 Cookie/CSRF 由现有登录流程取得，不能把真实会话写入文档或提交仓库。

```http
POST /v1/study/sets
Content-Type: application/json
X-PlanPlan-Expected-User: <当前会话的用户 UUID>
X-CSRF-Token: <当前会话 CSRF>
Origin: <联调环境允许的 StudyC origin>

{"clientRequestId":"c21b378a-2222-4222-8222-222222222222","title":"线段计数"}
```

Cookie 随同源请求发送。以上头名称已与当前 `web-session.ts` 和 StudyC `src/auth/api.ts` 核对；接手时保留这一认证契约，不能另造一套认证头。

```json
{
  "studySet": {
    "id": "3f623e5a-1111-4111-8111-111111111111",
    "title": "线段计数",
    "version": 1,
    "createdAt": "2026-11-20T03:00:00.000Z",
    "updatedAt": "2026-11-20T03:00:00.000Z"
  }
}
```

材料创建输入示例：

```json
{
  "clientRequestId": "e22b378a-3333-4333-8333-333333333333",
  "title": "等分线段",
  "body": "一条线段分为6份，共有7个端点。\n任选两个端点确定一条线段，共21条。"
}
```

## 6. 认证与代码落点

以下现有文件在本地认证 checkout 中观察到，接手时以固定后的基线复核：

| 位置 | 实现要求 |
| --- | --- |
| `server/src/api/app.ts` | 在现有 `/v1/*` 身份中间件之后注册 StudyC 路由。通过已验证上下文取得 owner；不要挂到免认证 `/v1/auth/*`。 |
| `server/src/api/web-session.ts` | 复用 Cookie 会话、Expected-User、Origin/CSRF 校验。新业务 API 不自行解析客户端声明的身份，不放宽已有 PlanPlan 客户端认证规则。 |
| `server/src/db/migrations.ts` 及相邻 schema 文件 | 追加新迁移，保持 checksum 检查；沿用现有 Db/事务能力和实际账户生命周期约束。 |
| 新增独立 StudyC 路由/领域/持久化模块 | 遵循现有目录惯例，避免把所有 SQL 与校验继续堆进 `app.ts`。模块名由仓库规范决定。 |
| `server/test/` | 增加真实路由与临时数据库集成测试，不仅 mock 一个成功 JSON。 |
| 后端 API 文档 | 固化八个接口、响应类型/样例、错误码、大小与限流、运行和迁移命令；可用 OpenAPI 或仓库现有格式，不另引文档框架。 |

Cookie 请求必须经过现有 Expected-User 校验，变更请求还需允许的 Origin 与 CSRF。请求体中的 `ownerId` 应因严格 schema 被拒绝。只要有效会话属于用户 B，传用户 A 的路径 ID 也不能读写 A 的内容。

现有后端还服务 PlanPlan；如保留其已认证 Bearer 客户端能力，继续采用既有策略，不能为本任务删除它，也不能让浏览器为使用 StudyC 而保存 Bearer token。

## 7. 验收清单

使用临时数据库、账户 A/B、学习集 A1/A2/B1/B2；材料至少两份内容明显不同。每条记录具体测试名或可复现步骤。

| ID | 操作 | 通过标准 |
| --- | --- | --- |
| AC-01 | A 创建同名的两个学习集，再列表/读取/改名 | ID 不同；改一个不影响另一个；字段/版本/时间正确。 |
| AC-02 | 在 A1/A2 各建一份资料，保存换行、中文、emoji，再分别读取 | 正文逐字一致；列表不带正文；资料不会串集；空正文允许。 |
| AC-03 | 用 B 列表并尝试访问/更新 A 的集合和材料；用 A2 路径访问 A1 的材料 | 不泄露或改写内容；错误为约定 404；B 列表只含 B 的对象。 |
| AC-04 | 无会话；伪造 owner；Cookie 请求缺/错 Expected-User；变更请求缺/错 CSRF 或 Origin | 按认证/输入规则拒绝，无新记录或更新；原有认证行为不回退。 |
| AC-05 | 创建请求重放/并发；换正文复用 request ID；另一账户使用相同 request ID | 同账户同意图仅一条；改输入返回 409；跨账户独立。集合/材料两类都测。 |
| AC-06 | 两个客户端以 version=1 同时更新同一资料；集合改名同样测试 | 恰好一次成功；另一次 409；获胜版本为 2；失败方不覆盖。 |
| AC-07 | 边界标题、空白标题、无效 UUID/游标/字段/版本、正文恰好上限/超上限、JSON 超限 | 限制一致；UTF-8 按字节算；413 不写入；不能靠缺失 Content-Length 绕过限制。 |
| AC-08 | 至少 101 条资源，其中多条同时间戳；遍历列表；尝试跨账户游标 | 分页稳定无漏项/重复，不越权；无下一页返回 null。 |
| AC-09 | 创建后关闭应用/数据库连接，使用同一测试库重新启动进程再读 | 数据仍在，不能依赖进程内 Map 或浏览器缓存。 |
| AC-10 | 空库迁移；已有旧 schema 的测试库升级；重复执行迁移 | 新旧路径通过；既有数据、迁移 checksum 和 PlanPlan 业务不变；重复执行无损。 |
| AC-11 | 按既有流程删除测试账户，并模拟删除与资料写入竞争 | 不留下孤儿私有资料，不允许绕过账户删除状态继续写入。 |
| AC-12 | 既有认证/PlanPlan 回归、限流、数据库失败 | 既有行为通过；限流生效；数据库失败返回错误且无部分创建；日志不包含正文/凭据。 |

验证命令以交接基线的 `server/package.json` 为准；当前已观察到的脚本如下，在隔离测试环境的 `server/` 目录执行：

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

新增测试至少覆盖上述关键身份、归属、幂等、并发和数据库持久化场景。不要以单元测试中 fake Map 的“重建对象”代替 AC-09 的持久化验证。若现有套件有与本 PR 无关的失败，记录基线复现和差异，不把失败改写为通过。

## 8. 迁移、联调与回退

1. 先在隔离库验证追加迁移和旧数据兼容，再提交代码与证据。本 PR 不操作生产服务器。
2. 服务端能力先准备好；StudyC 原前端仍可运行。PR-002 才新增 `/v1/study` 精确路径/方法的 Nginx 白名单，并对资料写入配置 2 MiB 请求体上限，其他路径保持原限制。不得直接代理所有 PlanPlan `/v1/*`。
3. PR-002 联调时明确 API 地址：当前 StudyC 本地代理 8786，生产 Nginx 模板上游 8789；这不是可以直接照抄的两个相同环境。
4. 发布故障优先回退应用代码，保留新增表和用户内容。追加表迁移需与旧应用兼容；不要把删表当默认生产回滚。破坏性 down 只在明确的临时测试库中验证。
5. 接手开发者交付迁移命令、健康检查、八接口冒烟方法和回退步骤；不在脚本中写生产密码、token、数据库连接串。

## 9. 提交时必须附带

- PR 的准确后端基线 SHA、分支与关联 StudyC 路线链接。
- 新增表/索引/迁移，以及八个接口的契约和实际调用样例。
- AC-01 至 AC-12 对应的自动化测试/人工证据，完整验证结果。
- 是否仍需配置项及其用途；前端 PR-002 的接入说明；部署与回退边界。
- 明确写出“前端尚未接入”，不把此 PR 称为 StudyC 全功能或云同步上线。

可直接交给开发者的任务摘要：

> 在 PlanPlan 现有 Hono/TypeScript 后端上，为 StudyC 实现学习集和纯文本资料持久化。先取得包含现有 Web Session 的干净、可访问基线，沿用账户、Cookie/CSRF、Db、迁移和测试规范。按本任务书增加八个 `/v1/study` 接口，完成账户/学习集隔离、创建幂等、更新版本冲突、输入限制和账户生命周期兼容。使用临时数据库通过 AC-01～AC-12，提交接口文档、迁移与回退说明。此 PR 不做前端、文件解析、AI、删除/分享或本地数据导入；前端另由 StudyC 的 PR-002 接入。
