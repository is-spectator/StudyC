# PR-003：文本型 PDF 上传与文字提取

状态：待审查，未部署。基于已合并的 PR-002（`20982db`，分支 `codex/studyc-independent-backend`）。GitHub `main` 在实现时仍停在 PR-001 的合并提交，没有 PR-002 的云端页面，因此本分支从 PR-002 的合并结果继续。

## 范围

登录后的学习集可以上传一个 PDF。服务端只认文件头 `%PDF-`，不认扩展名。提取文字写入该学习集的纯文本资料，正文用 `[第 N 页]` 标出来源页，并在 `study_source_pages` 记录字符区间。原文件以 `{用户}/{文件}` 存在 `STUDYC_FILE_ROOT`，下载必须带已登录 Cookie 和 Expected-User。

不接入 AI、OCR、Word 或图片。扫描件、加密件、损坏文件、超过 30 页或提取文字超过 1 MiB 时，只保存失败状态，不创建正文，也不把空字符串当成解析成功。解析超时不落库，可用同一个 `clientRequestId` 重试。同一请求改了文件内容返回 `idempotency_conflict`。

单文件上限 8 MiB。`pageCount` 是 PDF 的总页数，空白页也计入；正文和页码区间只包含提取到文字的页。Nginx 只给 `POST /v1/study/sets/{id}/files` 放宽到 8256 KiB，用来容纳 8 MiB 文件和 64 KiB 的 multipart 开销。文本资料仍是 2m。服务进程每分钟核对磁盘：账户已经删除时立即删除该用户目录；没有对应记录的文件要过 15 分钟才删除，避免清掉尚未提交的上传。

## 迁移

`node dist/main.js migrate` 在现有 StudyC 版本 1 之后追加版本 2：`study_source_files` 与 `study_source_pages`。不修改 PlanPlan 的迁移登记，也不改已有学习集和资料表。回退应用时保留这两张表和已保存的 PDF。

部署时在 `/etc/studyc/runtime.env` 增加 `STUDYC_FILE_ROOT=/var/lib/studyc/files`。`studyc.service` 使用 `StateDirectory=studyc`，进程只能写 `/var/lib/studyc`。`check` 和 `migrate` 也要求该变量是绝对路径，但不会自动建库或清文件。上传列表最多返回最近 100 条，同一文件内容用不同请求标识会各保存一份。
