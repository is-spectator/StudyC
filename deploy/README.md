# StudyC / PlanPlan 双域部署

2026-11-21 **StudyC 独立后端已部署并通过 112 项公网验收**；参见 [PR-001 发布结果](release-20261121-independent-backend.md)。`render-config.py --enable-study-api` 可显式生成八个学习数据接口的白名单，默认仍不启用。下文的注册与静态站点发布状态是此前已完成的记录。

状态：**统一注册首页已激活。** `https://clyna.ai/` 承载 Clyna 注册，StudyC 与 PlanPlan 的注册入口均指向主站；两个产品保留各自登录/重置流程和 host-only Cookie。当前 Study 静态产物为 `8e77afb69baebb995287145bb625d7e6b4dc7f6e9dec69c18ee573fe22350371`；Clyna/PlanPlan 静态 UI 为 `0dbe9865a46c472edea6ece13598417004624e0c95b3db5a69219e15ed4358ee`，独立目录 `/opt/planplan-web-ui/current/web`。统一注册发布时的后端为 `9f763547…`；当前账户服务为兼容包 `4692cb11…`，StudyC 业务为独立服务，详见上述 11 月 21 日记录。统一激活返回 `activated-and-probed`，备份 `/var/backups/clyna-central-registration/20261120T030319Z-e9c28888`。真实生产注册和邮件投递未在本次执行；本地模拟注册验证通过。

本次只把注册变更应用到核对过的线上 PlanPlan 源快照，未部署本地 main 中其他尚未上线的功能。保留 58 个原公开哈希资源，供已打开页面继续加载。新增 `activate-central-registration.py` 用于本次双前端切换，默认只检查，显式 `--apply` 才修改；包含三配置摘要/旧链接守卫、备份、语法检查、严格 TLS 探针与失败回滚。首次迁移专用脚本不能原样重跑（当前根目录已迁移）。后续仅更新 Study 时，先用下面的新静态根重新渲染配置，再核对当前配置摘要，不能复用历史候选。

保留[此前品牌发布记录](release-20261120-studyc.md)和[首次双域发布记录](release-20261120.md)。

下文是后续发布的操作手册，不能直接重复执行已完成的首次安装步骤。工具默认只检查或生成候选文件，不连接 SSH，不读取私钥内容，不创建数据库，也不执行数据库迁移。两个新域名的证书及续期 dry-run 验收沿用首次双域发布记录，不表示本次重新执行了续期模拟。

2026-11-20 主代理的远端检查已确认下表；执行前仍核对实际状态，不能把历史记录当作当前服务状态。

| 项目 | 已确认目标 |
| --- | --- |
| 主机 | `8.211.187.188`，既有服务器 |
| StudyC | `study.clyna.ai`，静态目录 `/opt/clyna-study/releases/<静态产物SHA256>/web`，`/opt/clyna-study/current` 软链接 |
| PlanPlan 新别名 | `planplan.clyna.ai`，静态使用 `/opt/planplan-web-ui/current/web`，API 沿用 `127.0.0.1:8789` |
| 主站 | `clyna.ai` 首页统一注册；`www.clyna.ai` 继续跳转主域。旧 PlanPlan 应用路由继续可用，静态根改为上述 UI 目录；当前账户 API 后端为兼容包 `4692cb11…` |
| 注册服务与数据库 | 复用现有 PlanPlan 网页 API 及 `planplan_web`；不使用旧 8787/PGlite，也不新建或迁移库 |
| Nginx 配置目录 | `/etc/nginx/conf.d` |
| 两个新域名证书 | `/etc/letsencrypt/live/clyna-products/fullchain.pem` 与 `privkey.pem`；覆盖两个新域名，有效期至 2027-02-17 |
| ACME / 续期 | `/var/lib/planplan-web-acme`；既有 `planplan-cert-renew` timer |
| DNS | 两个新域名 A 记录指向上述主机，DNS only；本候选不调整 Cloudflare 全局配置 |

## 文件与修改范围

- `package-release.py`：只打包已完成认证检查、已经构建的 `dist`。产物摘要来自静态文件内容，不冒充 Git 提交。归档包含 `release.json` 和 `web/`，不含源码、服务器秘密、用户数据或 node_modules。
- `check-release.py` / `release_lib.py`：校验路径、文件类型、摘要、数量和大小；拒绝符号链接、越界成员和被修改的产物。只有指定新的 `--extract-to` 才解包，不自动切换。
- `render-config.py` / `nginx/*.conf.in`：生成两个新增域名的待审配置和摘要，不安装。证书路径、PlanPlan 静态根目录均必须显式传入。
- `merge-origins.py`：仅输出 `WEB_ALLOWED_ORIGINS` 合并片段，保留全部现有值；不修改真实 `runtime.env`，不打印其他配置。
- `activate-release.py`：默认校验。显式 `--apply` 后才备份两个目标配置、安装配置、执行 `nginx -t`、原子切换 StudyC `current` 并 reload Nginx。仅做匿名 GET 探针，失败自动恢复两个目标配置与原 StudyC 软链接。不会修改 PlanPlan 代码、运行配置或数据库。
- `tests/test_deploy.py`：离线合成数据测试，包括篡改/路径/符号链接拒绝、origin 合并、认证边界和激活失败回滚；不构建真实 StudyC，也不访问服务器。

下表列出 StudyC 的账号接口，另有下节列出的八个学习业务接口；这些接口同源转发，保留 `Host`、`Origin`、Cookie、`X-CSRF-Token`、`X-PlanPlan-Expected-User`，不重写 Cookie Domain，不添加 CORS，不自动重试写请求。响应为 `no-store, private`。其余 `/v1` 返回 404，允许路径上的其他方法返回 405。

| 方法 | 路径 |
| --- | --- |
| GET | `/v1/auth/web/session` |
| POST | `/v1/auth/web/email/code` |
| POST | `/v1/auth/web/email/register` |
| POST | `/v1/auth/web/email/login` |
| POST | `/v1/auth/web/email/reset` |
| GET | `/v1/me` |
| POST | `/v1/logout` |

PlanPlan 新别名沿用原站 `/v1`、`/legal`、`/healthz`、`/readyz` 的 API 转发规则；这个较宽的规则**不用于 StudyC**。StudyC 条款链接使用 `https://clyna.ai/legal/terms` 和 `https://clyna.ai/legal/privacy`。

两站共用注册账户，但 `__Host-planplan-session` 是各自 host 的 Cookie，所以默认分别登录，不宣称跨子域免登。退出或重置密码的跨站失效语义由现有 PlanPlan 服务控制。现有注册白名单等规则继续生效，不在部署脚本中扩大权限。

## StudyC 独立后端模板（待安装）

`backend/studyc.service` 是 StudyC 仓库内独立后端的 systemd 模板；模板本身不执行安装；本次实际安装及启用结果见独立后端发布记录。学习业务代码、迁移和运行版本由 StudyC 管理。`render-config.py --enable-study-api` 将四组路径的八个学习接口转发至 `127.0.0.1:8790`；上述七个账号接口继续转发至 `127.0.0.1:8789`，PlanPlan 配置不变。严格 UUID 路径、方法白名单、16 KiB 默认请求上限、材料接口 2 MiB 上限以及禁止缓存、禁止上游重试的设置保持一致。未启用开关时不开放学习接口。

模板使用独立系统用户和组 `studyc`，工作目录 `/opt/studyc-api/current/server`，Node 24 可执行文件 `/usr/bin/node-24`。`ExecStartPre` 执行 `dist/main.js check`，只检查数据库迁移状态；正式进程运行 `dist/main.js`，代码固定监听 `127.0.0.1`。服务的内存硬上限为 512 MiB，384 MiB 开始回收压力，不使用交换空间；最多 64 个任务，禁止 core dump。发布文件及软链接应由 root 持有，不能被 `studyc` 写入。

`/etc/studyc/runtime.env` 由 root 持有、权限 `0600`，只配置以下非秘密值；`RELEASE_ID` 必须填写此次实际发布版本，端口必须与 Nginx 的 8790 一致：

```dotenv
STUDYC_SECRETS_FILE=/etc/studyc/secrets.json
PG_CA_FILE=/etc/studyc/pg-ca.pem
PORT=8790
RELEASE_ID=git:实际提交SHA
```

`secrets.json` 精确包含 `DATABASE_URL` 与 `RATE_LIMIT_SECRET` 两项，不得包含 PlanPlan 的 JWT、Cookie 签名或其他认证秘密。文件可设为 `root:studyc 0640`，父目录 `/etc/studyc` 为 `root:studyc 0750`；权限仅允许 root 与服务读取。数据库 URL 只放在该私有文件中，禁止写入 unit、命令参数、Git 或日志，也不通过 URL 参数关闭 TLS。`pg-ca.pem` 是独立复制到 StudyC 目录的可信数据库 CA；连接固定验证证书。限流密钥需符合应用配置的至少 32 字节要求，并按共享写入预算契约配置；它不是账号签名密钥。

认证上游由代码固定为 `http://127.0.0.1:8789/v1/auth/web/session`，不从环境读取可变 URL。StudyC 通过该只读接口确认会话；模板禁止进程读取 `/etc/planplan-web`。不得把 PlanPlan 的整份 `runtime.env`、秘密文件或用户凭据复制进 StudyC。

安装前由发布流程核对独立服务账号、目录权限、TLS CA、数据库权限及迁移验收，使用迁移专用的私有 owner 配置单独执行 `dist/main.js migrate`；运行服务只使用日常业务权限，启动前检查不会自动迁移。安装 unit 后需在目标 Linux 主机执行 `systemd-analyze verify`，再由发布流程安装并启用 `studyc.service`、验证本地 `http://127.0.0.1:8790/readyz` 的 `service: "studyc"` 和准确版本，最后审核 Study 专属 Nginx 候选、执行 `nginx -t` 后再开放路由。既有静态发布脚本不负责安装此服务或执行业务迁移。

## 1. 认证完成后构建与打包

每次发布先确认最终认证代码及错误提示完成，再执行以下本地命令。本轮已经完成，后续不要在没有代码变化或验证需要时重复生成候选。

```sh
npm run build
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/tests -p 'test_*.py' -v
python3 deploy/package-release.py --dist dist --output /受限候选目录/study --auth-reviewed
```

只有源码确实对应某个提交时才加 `--source-revision <已核对GitSHA>`；否则保留 `unrecorded`。文件内容的完整 SHA256 仍可精确识别发布版本。打包器不会自行构建，不覆盖既有候选。校验包的命令为：

```sh
python3 deploy/check-release.py /受限候选目录/study/study-实际SHA.tar.gz
```

使用已确认的受控通道传输归档、`.sha256`、本目录脚本及模板。不要传整个工作区、任何 `.env`、私钥或用户资料；不要关闭 SSH 主机校验。

## 2. 渲染两个独立域名配置

下列参数对应主代理确认的服务器状态；渲染器不读取证书内容，也不判断证书是否已安装。使用一个新的输出目录：

```sh
python3 deploy/render-config.py \
  --study-cert /etc/letsencrypt/live/clyna-products/fullchain.pem \
  --study-key /etc/letsencrypt/live/clyna-products/privkey.pem \
  --planplan-cert /etc/letsencrypt/live/clyna-products/fullchain.pem \
  --planplan-key /etc/letsencrypt/live/clyna-products/privkey.pem \
  --planplan-root /opt/planplan-web-ui/current/web \
  --acme-webroot /var/lib/planplan-web-acme \
  --output /root/study-rendered-20261120
```

当前 DNS only 不需要 `--trusted-proxy-include`。若以后改用 Cloudflare 代理，必须另行核对仅这两个 host 的可信来源范围和缓存策略，不能信任任意 `CF-Connecting-IP` 或改动全局 real-IP 规则。

确认现有 `/etc/nginx/conf.d/zzzz-clyna-products-bootstrap.conf` 仅用于这两个域名的证书引导后，由操作者备份并移出生效 include 目录。脚本不会擅自删除它；存在同名 host 的其他配置时会拒绝继续。也要检查其他 include 路径，不只看 `conf.d`。

## 3. 合并允许的来源，不改原账户库

首次发布前的值仅为 `https://clyna.ai`，本轮已保留它并加入两个新域名。后续发布仍须在服务器上读取当时实际值并合并，不能直接用固定值覆盖未知现值：

```sh
python3 deploy/merge-origins.py \
  --runtime-env /etc/planplan-web/runtime.env \
  --output /root/study-origins-review.env
```

操作者只将这个单项片段合并进原配置，保持其他字段、权限与所有已有 origins 不变。先做受限备份，再重启既有 `planplan-web.service` 并验证原 `clyna.ai`、8789 的就绪和认证边界；失败使用自己的运行配置备份恢复。该步骤不属于静态激活脚本自动修改范围。不要输出整份环境文件、执行 `migrate up/down`、新建 users 表或复制认证秘密。

## 4. 在服务器检查、安装与切换

先核对归档的外部 `.sha256`，再运行内部 manifest 校验。以 root 建立独立 `/opt/clyna-study/releases`，解包到由校验器报告的完整摘要目录；该目录必须不存在：

```sh
python3 deploy/check-release.py /root/study-candidate/study-实际SHA.tar.gz \
  --extract-to /opt/clyna-study/releases/实际64位SHA
```

产物归 root 所有且不可被普通用户修改。配置候选也要归 root 所有，私有目录中保存 `review.json`。先执行默认检查：

```sh
python3 deploy/activate-release.py \
  --release /opt/clyna-study/releases/实际64位SHA \
  --rendered /root/study-rendered-20261120 \
  --nginx-conf-dir /etc/nginx/conf.d
```

默认预期 `clyna-study.conf` 和 `clyna-planplan-alias.conf` 尚不存在。后续更新必须分别传 `--expected-study-config <已审现文件SHA256>` 与 `--expected-planplan-config <已审现文件SHA256>`；没有覆盖已有文件的强制开关。

检查通过，确认 host/证书/续期/原配置已审且 additive origins 已生效后，在同一条命令追加：

```text
--apply --confirmed-host-review --origins-reviewed
```

执行顺序：核对静态产物与现配置 → 0700 备份目录及 journal → 安装两个域名文件 → `nginx -t` → 原子替换 StudyC `current` → reload → 通过回环地址、严格 TLS 与真实域名验证新站 HTML、PlanPlan 别名 HTML/readyz、StudyC 未登录 401、错误方法 405、非认证 API 404。reload 后的匿名 GET 检查最多重试 10 轮、间隔 0.5 秒，各请求保留原超时；不会重试写入、认证请求或 reload。不会停止或重启旧 8787/8788 服务。

完成后仍要做公网检查与真实浏览器登录/退出验收，包括保留原 `clyna.ai` 行为、两个新域名 TLS、API 不缓存和既有账号登录。激活脚本不会自动发送验证码、注册账号或调用付费模型；匿名探针通过不等于认证全流程通过。

## 5. 回滚与中断恢复

激活前会打印 `/var/backups/clyna-study/<UTC时间-随机标识>`，其中 `journal.json` 记录旧 StudyC 软链接、原两个配置是否存在、权限及候选摘要。切换或探针失败会自动恢复旧文件与旧软链接，重新执行 `nginx -t` 和 reload；回滚失败则记录具体步骤名，不伪报成功。

若进程被强制终止，自动回滚不保证执行。操作者先核对 journal、当前 StudyC 目标和两个配置的 hash，排除其他人已发布的新版本，再仅恢复该次备份涉及的两个配置（原先不存在的文件移出生效目录）及旧 StudyC 软链接，执行 `nginx -t` 后 reload。首次发布没有旧 StudyC 软链接时移除本次新链接。保留 release 与备份用于调查，不删除旧版本。

本流程没有数据库写入或迁移，所以不恢复数据库快照。若单独改过 PlanPlan origins，其恢复由第 3 步的独立备份负责，不能拿旧整体环境覆盖后来配置。证书续期和现有 clyna.ai/nginx 主配置不属于本脚本的回滚范围。

## 当前验证记录

- 本次 StudyC 品牌发布：生产构建与 8 项账户存储测试通过；本地 DEV 预览的主页、引导、会员卡片与确认弹窗已检查。公开素材目录为 `assets/studyc`，旧品牌标识和二维码只保留在本地参考归档。
- 激活器返回 `activated-and-probed`；公网 HTML、`index-B0uExh_v.js`、`index-WZcVxWdZ.css` 与本次构建一致；匿名认证请求为 401，响应包含 `no-store, private`。实际浏览器登录、注册页面均显示 StudyC，未见破图或旧品牌文本；5 张 PNG 已人工检查。远端 `current` 已复核，两个 Nginx 配置的 SHA256 与更新前一致。
- PlanPlan 就绪 release 保持 `9f763547a80cb687125ad9078de22e021e6e0050cf4f8c040f25d19c35191201`；本次未重新发布该应用或修改账户数据。
- 首次双域发布的 31 项测试（23 项 Node、8 项部署测试）、实际失败回滚、本地双账户隔离及证书续期验收保留为历史证据，没有计作本次全量重跑。
- 未输入真实生产凭证、创建生产测试账户或执行生产注册／重置邮件流程。公开页面与匿名探针通过不代表这些流程已验收。
