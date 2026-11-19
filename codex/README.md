# 在 Codex 桌面接入 ProspectDesk 0.6.3

使用 Node.js 22 或更新版本与 Chrome。在完整仓库根目录执行以下命令，将示例换成要处理的 Zoho 邮箱地址。

```sh
npm ci
npm --prefix codex ci
node codex/configure.mjs --account "operator@example.com"
```

把终端输出合并到当前项目的 `.codex/config.toml`，保留已有项目设置，再重新打开 Codex 项目。若是在另一个项目使用，生成配置时传入 `--project "<该项目的目录>"`。生成器只输出配置片段。邮箱地址、实际配置和项目下的 `.prospectdesk/` 数据目录应留在本机。若使用已经验收的本机接入，可保留原配置路径。

在 Codex 中调用 `sales_browser_mail_status` 确认版本为 0.6.3 且连接处于初始状态。正常加载后共有 10 个工具。再调用 `sales_browser_mail_compatibility` 做只读检查。首次检查会打开专用 Chrome 窗口。有登录提示时在浏览器中登录，随后再次检查。默认打开 `https://mail.zoho.com/zm/#mail/folder/drafts`。可在配置的 `env` 表中以 `PROSPECTDESK_MAIL_URL` 指定本账号使用的 HTTPS 草稿箱地址。

兼容性检查通过后再准备批次。每次执行 `sales_browser_mail_step` 最多处理一封到期草稿，项目配置要求 Codex 逐次向用户确认。回执确认和原草稿清理沿用已有批次核验流程。需要永久删除时，须在准备批次时明确授权相应草稿。保留配置中的逐次确认和禁用并行调用。

如需只读验收单封既有草稿，调用 `sales_browser_mail_inspect_draft`，输入精确草稿 ID、收件人和主题。结果报告正文长度、哈希及序列化信息。自动批次状态中的 `scanCoverage` 仅证明已核对范围。选择保留已发送的残留原稿时设置 `retainSentDrafts: true`，且不传永久删除草稿 ID。

本次桥接验收覆盖 Windows 上的 Codex 桌面、Chrome 和 Zoho。历史 Edge 和 Gmail 实发记录见仓库的 v0.6.0 验收报告。
