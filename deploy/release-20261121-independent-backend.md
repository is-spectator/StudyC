# StudyC 独立后端发布记录

状态：正在验证独立服务，尚未开放新接口。本文将在实际验收后更新。

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
