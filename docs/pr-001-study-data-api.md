# PR-001：StudyC 独立后端与文本资料 API

2026-11-21 用户确认：StudyC 业务代码、迁移、测试、部署工具及 PR 全部归 `is-spectator/StudyC`。分支 `codex/studyc-independent-backend`，基于 StudyC `248ccf9`。原 PlanPlan PR #40 的业务实现由本仓库接替，不再按共享业务进程方案发布。

## 1. 交付结果

独立 Hono/TypeScript 服务提供八个 `/v1/study` 接口，实现学习集与纯文本资料持久化、账户/父集合隔离、创建幂等、更新版本冲突、分页、大小限制和共享写入限流。

前端编辑器与云端保存接入仍属于 PR-002；本 PR 不意味着现有页面已完成云同步。文件上传、PDF/OCR、AI、卡片/测验、分享、支付等仍按路线后续交付。

## 2. 服务边界

| 项目 | 所属与运行方式 |
| --- | --- |
| StudyC 业务 | 本仓库 `server/`，独立 `studyc.service`，仅监听 `127.0.0.1:8790`。 |
| Clyna 账户 | 继续由既有账户服务管理注册、登录、会话、注销；不复制账户表、JWT 签名密钥或注册接口。 |
| 身份验证 | StudyC 将浏览器 Cookie 交给固定本机 `8789/v1/auth/web/session` 验证；只信任返回的用户 UUID。写入仍检查 Origin、Expected-User 和 CSRF。身份服务不可用时明确失败。 |
| 数据 | 共用现有 PostgreSQL 实例与账号 ID；StudyC 独立表、独立运行角色、独立迁移登记 `studyc_schema_migrations`。 |
| 限流 | 复用共享写入计数表与独立限流密钥，每账户与 PlanPlan 合计 120 次写入/分钟。 |
| Nginx | StudyC 的八个精确业务路由转发 8790；原账户路由继续 8789，其他业务不跨产品暴露。 |

## 3. 迁移与发布边界

生产已有历史迁移 18 创建的 `study_sets`、`study_materials`。独立迁移核验实际列、约束、索引及触发器后登记接管，不重复建表、不改 PlanPlan 迁移历史；新的 StudyC 变更由本仓库维护。新环境须先具备共享账户/生命周期及限流数据库契约，StudyC 不自行建立第二套身份系统。

PlanPlan 当前兼容回退包保留历史 18 registry；不能切回不认识 18 的原始二进制，也不执行删表 down。部署 StudyC 只启动或重启自己的服务。发布失败撤回 Study 路由并停止/回退 StudyC，保留数据。

运行命令、配置及权限见 [server/README.md](../server/README.md)。实际部署结果单独记录，不把本地测试视为线上验收。

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
- 使用 StudyC 独立迁移登记；不修改 PlanPlan 已发布迁移及 checksum。历史表接管必须核验实际结构，不能仅依赖表名。
- 新表与已有账号删除/删除期间禁止写入规则兼容；并发删除账户不得遗留资料。沿用 `user_id` 便于复用读取 `NEW.user_id` 的生命周期触发器；写事务遵循现有 `db.tx(..., userId)` 与事务内 `requireActiveUser` 约定。用户外键级联清理覆盖集合、资料及独立幂等表；保留现有业务表与账户数据。

## 5. API 契约

统一前缀 **`/v1/study`**。所有路由置于独立服务的 Clyna 会话验证中间件之后，使用已验证身份上下文。八条路由以“方法 + 路径”为单位计数。

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

## 8. 验证与交接

在 `server/` 执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm build`。测试使用隔离身份契约及临时数据库；生产验收仅创建合成测试账户，完成后按既有注销流程清理。

线上验收要覆盖八接口、账户隔离、CSRF、幂等、冲突、大小限制、StudyC 单独重启后的持久化，以及 Clyna/PlanPlan 原服务健康。部署工具与证据见 [发布记录](../deploy/release-20261121-independent-backend.md)。

PR-002 在本仓库接入列表、UUID 路由、文本编辑及保存状态。沿用本 API 的请求 ID、版本、会话头和错误协议；请求失败不能静默回退 localStorage 并显示已保存。
