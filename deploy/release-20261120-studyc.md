# 2026-11-20 StudyC 品牌发布

状态：**已激活，[StudyC](https://study.clyna.ai) 公网产物与本次构建匹配，实际浏览器登录、注册页面均显示 StudyC，登录页标识为“StudyC K12”。** 激活器返回 `activated-and-probed`。本记录依据主代理完成的部署与验证结果整理，没有重新执行线上操作。

| 项目 | 本次记录 |
| --- | --- |
| StudyC 静态产物 SHA256 | `51b74a01275d70335a1fd6b216843ca49e51b81d0efc531f5d59549c9de429b4` |
| 静态文件数 | 76 |
| 上一静态产物 SHA256 | `df8dcc5f68d2fb6954fad1ccde847d824b513a80c9469a7f4f8d6316f9f0aa32` |
| 主 JavaScript / CSS | `index-B0uExh_v.js` / `index-WZcVxWdZ.css` |
| 备份 / journal 目录 | `/var/backups/clyna-study/20261120T010302Z-d9fee1da` |
| PlanPlan 就绪 release | `9f763547a80cb687125ad9078de22e021e6e0050cf4f8c040f25d19c35191201`，保持不变 |

上述 StudyC SHA256 标识静态文件内容，不冒充 Git 提交。远端 `/opt/clyna-study/current` 已确认指向 `/opt/clyna-study/releases/51b74a01275d70335a1fd6b216843ca49e51b81d0efc531f5d59549c9de429b4`；两个 Nginx 配置的 SHA256 与更新前一致。PlanPlan 未重新发布，账户服务与数据库继续复用。

## 界面与素材

- 产品为 **StudyC**，助手为 **小C**；功能名称统一为 **小C辅导、学习集、互动练习、学习工具、音频复习、闪卡**。
- 会员卡片、按钮和确认弹窗使用 **StudyC进阶版 / StudyC全能版**，价格及演示结账行为保持。
- 公开素材路径为 `/assets/studyc/`。旧 StudyFetch 文字标识、头像标识与二维码从公开素材中移除，原文件保留在 [`reference/archived-brand-assets/`](../reference/archived-brand-assets/)。功能路由、内部标识和旧存储键保持兼容。

页面结构、部分字体和插画仍参考实际采集的 StudyFetch 页面及公开素材。改名不改变来源事实；[来源证据](../reference/source-evidence.md)与[素材来源记录](../reference/asset-sources-studyfetch.json)继续保留真实来源名称，不作为自有原创素材声明。

## 验证与边界

- 本次生产构建、8 项账户存储测试通过；本地 DEV 预览的主页、引导、会员卡片和确认弹窗已检查。
- 激活与探针成功；公网 HTML、上述 JavaScript 和 CSS 与构建匹配，匿名认证请求为 401，缓存策略为 `no-store, private`。
- 在线登录、注册页面未见破图或旧品牌文本；5 张 PNG 已人工检查，未见旧品牌字样。登录页临时截图为 `/tmp/studyc-live-20261120.png`，不作为仓库内的长期证据。
- **未执行真实生产账号登录、注册、验证码邮件或密码重置邮件验收。** 页面可见与匿名探针通过，不代表这些流程已通过。

[首次双域发布记录](release-20261120.md)原样保留。此前 31 项离线测试、双账户 UI 隔离、证书续期模拟和失败回滚检查没有计为本次全量重跑。

本次未新增 AI、支付或学习资料云同步；学习资料仍按验证后的账户 ID 保存在当前浏览器。记录不包含密码、会话、邮箱名单、Cookie、连接串或用户资料。
