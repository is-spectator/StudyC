# StudyC 独立后端发布记录

本记录描述 PR-001 后端发布时点。随后 PR-002 已上线云端前端；当前页面版本与静态回退见 [PR-002 记录](../docs/pr-002-cloud-workspace.md)。

状态：**2026-11-21 已部署并通过公网验收。** 业务 PR：[StudyC #1](https://github.com/is-spectator/StudyC/pull/1)。原 PlanPlan #40 已关闭并指向本 PR。

## 架构与历史状态

2026-11-21 用户明确要求 StudyC 独立后端、业务 PR 全部放 StudyC。既有 Clyna 注册服务、账户数据库和服务器继续共用。

此前共享后端激活尝试已自动回退；PlanPlan 当前兼容 release 为 `4692cb11f7fdeb4f8ea7fdb69750e3dbe71880c25f36e76c791497fdcbb56f98`。历史迁移 18 已创建学习表，兼容包保留其 registry；不再部署原共享业务候选，也不回退数据库删除新表。

本次独立 StudyC 服务监听 127.0.0.1:8790，StudyC repo 自有业务代码与迁移登记。既有账户服务 8789 只提供身份会话验证；StudyC 不持有它的 JWT/邮件/AI 密钥。运行 DB 角色 studyc_app 使用单独密码和最小表权限。

## 发布步骤

1. 本地类型、业务/认证/迁移测试与构建；Nginx 模板规则测试。
2. 固定 StudyC Git 提交，在服务器隔离构建目录安装锁定依赖；有界 systemd unit 在独立测试数据库验证 PostgreSQL 路径。
3. 核验私密加密备份和当前 PlanPlan/Nginx 状态；独立迁移严格接管历史表，检查 registry 与权限。
4. 启动 StudyC，核验 loopback readyz；只插入 Study 业务路由，nginx -t 后 reload。
5. 两个合成账户公网验收八接口、隔离/幂等/冲突/CSRF/大小限制、单独重启持久化、账户删除清理；确认 PlanPlan PID 和既有静态资源保持不变。

PR-001 只交付后端，前端页面云同步仍由 PR-002 实现。

## 最终部署与验证

- 部署代码：`9ee739a51473293a500efdc471c0bc4f5b4c70a5`；独立服务 `studyc.service` 已启用开机启动，readyz 返回 `git:9ee739a51473293a500efdc471c0bc4f5b4c70a5`。
- 安装位置：`/opt/studyc-api/releases/9ee739a51473293a500efdc471c0bc4f5b4c70a5`，`/opt/studyc-api/current` 指向该目录。源码、编译文件和依赖由 root 拥有，studyc 组只读。
- PlanPlan 仍为兼容 release `4692cb11...`，发布前后进程 PID 均为 `306993`。未切换其应用或重启进程。
- 独立迁移版本 1 登记为 `adopted=true`；原 PlanPlan 1–18 记录保留。
- 写入迁移前的加密备份：`/var/lib/planplan-web-backups/database/backup-2026-11-21T02-43-47.484Z-f6e7f686`。

| 验证 | 实际结果 |
| --- | --- |
| 本地后端 | 134 项通过；类型检查与构建通过 |
| Nginx/部署规则 | 23 项通过；目标机 nginx -t 与 systemd unit 校验通过 |
| GitHub CI | 部署代码的 StudyC backend workflow 成功 |
| 隔离 PostgreSQL 15 | 26 项通过，1 项仅适用 PGlite 的空库案例明确排除；该案例已在本地通过 |
| 公网验收 | 112 项断言通过，八接口、隔离、幂等、版本冲突、认证、请求限制、独立重启持久化均通过 |
| 测试数据 | 两个合成账户通过现有注销工作流清理，学习集与资料级联清理核验通过 |
| 其他产品 | Clyna/PlanPlan 健康与原计划接口通过；PlanPlan PID 未变 |
| 静态前端 | 三站首页及全部引用 JS/CSS 摘要与部署前完全一致 |
| 数据权限 | StudyC 角色不能读 PlanPlan 计划、不能读 token_version、不能改用户 ID/注销状态、不能在 public 创建对象 |

首次公网验收在创建测试账户之前停止：脚本错误地从 Study 公网地址读取只在本机开放的 `/readyz`。已修正为固定 loopback 健康探测，业务代码与 Nginx 暴露范围未改；第二次完整验收成功。首次失败记录保留，不计作通过。

脱敏汇总：[部署证据](evidence/20261121-independent-backend.json)。原始私密报告位于 `/root/studyc-independent-20261121/`，包括 `activation.json`、`target-tests.json` 和 `online-v2/acceptance.json`；合成身份、会话、数据库凭据不写入仓库。

## 回退与后续

本次为独立服务首发。如需回退，先恢复 `/root/studyc-independent-20261121/clyna-study.before.conf` 到 Study Nginx 配置，执行 `nginx -t` 后 reload，再停止 `studyc.service`。保留学习数据、独立迁移登记及 PlanPlan 历史 18；不能切回不识别 18 的旧 PlanPlan 程序。后续已有 StudyC 稳定版本时，优先只切回前一个 StudyC release。

当前八个资料 API 已可用，现有页面尚未接入云端资料读写。下一步是同仓库 PR-002，完成列表、UUID 路由、编辑器和保存/冲突状态。
