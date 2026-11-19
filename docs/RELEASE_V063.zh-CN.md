# ProspectDesk 0.6.3 中文发布说明

本版更新 Codex 与 Chrome 的 Zoho 邮箱适配，并加入腾讯 WorkBuddy 客户端的技能与只读连接器。

- 富文本正文从当前可见且已核验的同源编辑器读取。Chrome 返回 `about:srcdoc` 的 `securityOrigin = "://"` 时用实际的同源访问和控件归属验证，沙箱隔离、编辑器变化或收件人歧义仍会中止操作。
- Windows 上的旧启动锁仅在确认原进程已退出且专用浏览器配置未被占用后备份移走。活动锁及无法确定归属的锁继续保留。
- 批次可显式使用 `retainSentDrafts: true`。收到新回执且仍残留的原稿单独计入 `retainedOriginalDrafts`，不得同时提交永久删除许可。
- 自动准备区分草稿箱总数和可见页覆盖范围。已核对候选数少于目标时，准备会中止，便于保留已发送的回执和原批次。全箱翻页仍待验收。
- Codex MCP 注册 10 个工具。WorkBuddy 提供独立安装入口，接口只报告状态与只读检查。具体宿主支持范围见[兼容性表](CLIENT_COMPATIBILITY.zh-CN.md)。

## 验证范围

已在本地使用实际安装的 Chrome 和隔离测试页复现富文本问题，验证读回和异常拒绝，也验证 Windows 启动锁恢复。675 项自动测试全部通过。WorkBuddy 只读连接器通过标准 MCP 客户端的协议验收，已确认桌面客户端内有技能和连接器菜单，实际导入待验收。新 MCP 进程在空闲状态下可列出工具，首次只读检查才启动专用浏览器。用户报告其现有 Codex 发件任务已恢复正常。本次发布过程未在用户邮箱中发送、删除或变更草稿。

安装与升级见 [Codex 教程](../codex/README.md) 及 [WorkBuddy 教程](../workbuddy/README.md)。
