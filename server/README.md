# StudyC data service

StudyC 的业务后端独立运行，代码、测试、迁移和发布由本仓库维护。生产监听 `127.0.0.1:8790`，Nginx 以明确白名单开放学习资料、PDF 和生成任务接口。账户路由仍交给现有 Clyna 服务（8789）。接口契约见 [PR-001](../docs/pr-001-study-data-api.md)、[PR-003](../docs/pr-003-pdf-upload.md) 和 [PR-004](../docs/pr-004-generation-foundation.md)。前端云端编辑由 PR-002 提供；本轮生成基础尚不包含聊天或闪卡界面。

## 开发与验证

Node 24、pnpm 10.33.2：在本目录运行 `pnpm install --frozen-lockfile`，然后 `pnpm typecheck`、`pnpm test`、`pnpm build`。测试使用临时 PGlite 或独立测试 PostgreSQL schema；不会创建生产账户或调用真实 AI。

生产入口 `node dist/main.js`；`node dist/main.js check` 只读核验；`node dist/main.js migrate` 显式迁移。服务启动不自动修改 schema。测试身份 fixture 仅用于测试，不是注册服务或生产初始化脚本。

## 身份和数据边界

每次请求使用固定的本机 Clyna 会话接口验证 Cookie，无身份缓存，不持有 JWT 签名密钥。身份接口返回用户 ID 与 CSRF 后，StudyC 校验 `X-PlanPlan-Expected-User`；POST/PATCH 还要求 `Origin: https://study.clyna.ai` 和匹配的 `X-CSRF-Token`。认证失败 401、账号不符 409、Origin/CSRF 不符 403、上游不可用 503。仅支持现有安全 Cookie，未另建 Bearer 认证。PlanPlan 原认证能力不受影响。

共用 PostgreSQL 的 `users`、`request_rate_limits` 和已有生命周期触发器；维护 `study_sets`、`study_materials`、`study_source_files`、`study_source_pages`、生成任务/尝试/全局日预算表和 `studyc_schema_migrations`。资料事务沿用账户 advisory lock，生成任务的预算和状态使用独立全局 advisory lock，删除账户可级联清理学习资料和上传记录。共用 RATE_LIMIT_SECRET 使两个进程共享每账户写入预算，该密钥独立于 JWT 密钥。

PDF 原文件只放在 `STUDYC_FILE_ROOT` 下的 `{userId}/{fileId}`，不使用用户提供的路径。单文件不超过 8 MiB、30 页，提取正文不超过 1 MiB。`page_count` 记录 PDF 总页数，正文只保留有文字的页。扫描件、加密件和损坏文件只记录失败状态，不写入空的成功正文。解析超时不落库，可用同一次 `clientRequestId` 重试。服务运行后每分钟清理磁盘：账户删除后移除该用户目录；没有数据库记录的文件保留 15 分钟，避免删掉尚未提交的上传。

`migrate` 在现有身份数据库契约上创建 StudyC 表，或逐项校验既有列、默认值、约束、索引和触发器后登记接管。结构缺损、部分表存在、历史/指纹漂移均拒绝继续；不自动修补未知 schema，不执行 PlanPlan 迁移。

## 生产配置

`/etc/studyc/runtime.env` 只配置以下非秘密值：

```
STUDYC_SECRETS_FILE=/etc/studyc/secrets.json
PG_CA_FILE=/etc/studyc/pg-ca.pem
PORT=8790
RELEASE_ID=git:<StudyC-commit>
STUDYC_FILE_ROOT=/var/lib/studyc/files
```

`secrets.json` 只允许 `DATABASE_URL` 与 `RATE_LIMIT_SECRET` 两个字符串。文件由 root 管理，组为 studyc，0640（或更严格），目录 0750；禁止 JWT、邮箱、AI 或其他应用秘密。数据库使用显式 TLS CA 与证书验证；URL 不接受覆盖 SSL 的参数。迁移用 owner 权限另行执行，运行服务只用 `studyc_app`。

运行角色需要 public schema USAGE、数据库 CONNECT、学习业务表及共享限流表 SELECT/INSERT/UPDATE/DELETE、StudyC 迁移登记 SELECT、users 的 SELECT(id,deleted_at)。现有账户生命周期函数使用 `FOR SHARE`，因此还需要 `UPDATE(created_at)` 列权限以允许 PostgreSQL 行锁；业务不会更新此列，不授予 ID、登录信息、token_version 或 deleted_at 的修改权限。不能授予角色创建 schema/表/角色或读取登录凭据的权限。

现有已上线的 PlanPlan 历史迁移 18 保持不变，兼容包必须继续认识它。StudyC 独立迁移登记从版本 1 开始。不得切回不认识历史 18 的 PlanPlan 包，也不得把删表当成发布回退。

## OpenRouter 生成基础

见 [PR-004 完整契约](../docs/pr-004-generation-foundation.md)。AI 默认关闭；启用时设置 `STUDYC_AI_ENABLED=true`、`STUDYC_AI_SECRETS_FILE`，独立 JSON 文件仅包含 `OPENROUTER_API_KEY`，沿用 PlanPlan 的模型与路由配置。StudyC 不直接读取 `/etc/planplan-web`，不把 AI key 加进数据库/rate-limit 的秘密文件。历史生成记录和取消接口在 AI 关闭时仍可用。

生成结果会校验结构和逐字来源。失败、取消、超时和未知用量都明确保存；未返回真实用量时保留预算，不当作零支出。跨 UTC 午夜的排队任务在领取前重新核对当天额度；已外发的任务不自动重试。服务退出时中断本进程调用，未完成尝试由数据库租约恢复。

自动测试不调用模型。仅在用户已授权复用配置时，用以下显式命令进行一次合成资料真实调用：

```sh
pnpm verify:generation:live --run --planplan-config /绝对路径/受限OpenRouter.env --report /绝对路径/新验收结果.json
```

命令只读取 OpenRouter 必要字段、不输出 key，固定已约定的免费模型，最多发出一次模型请求；默认使用临时 PGlite。若设置 `TEST_DATABASE_URL`，必须指向专用 `*_test` PostgreSQL 且配置 `PG_CA_FILE`，工具使用独立 schema 并清理。未加 `--run` 时只显示说明。上游限流是验收失败，不会输出假成功。

## 部署与回退

固定 Git 提交打包、锁定依赖构建，安装到 `/opt/studyc-api/releases/<commit>/server`，由 root 拥有；服务用户只读。模板见 [studyc.service](../deploy/backend/studyc.service)。启动前显式迁移、授予运行角色登记表只读权限、执行 check，随后启动服务并核验 readyz release。

确认独立进程健康后，仅向已核验的 Study 主机配置插入业务路由；`nginx -t` 通过再 reload。使用有界只读重试等待 worker 切换，写请求不自动重试。验收工具通过两个合成账户验证公网 API、独立重启持久化及注销清理；不发送邮件、不调用 AI。运行前阅读工具头部参数与私密报告要求。

迁移版本 3 应用后，旧代码因不认识新增登记不能直接启动；先关闭 AI 并保持兼容版本 3 的程序，或准备显式兼容迁移登记的回退构建。不得删除表或登记记录来回退。Nginx 可恢复先前 Study 配置以关闭生成入口，保留业务表与资料。Clyna/PlanPlan 进程与静态资源不参与 StudyC 发布切换。实际结果见 [发布记录](../deploy/release-20261121-independent-backend.md)。
