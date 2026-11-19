# ProspectDesk 客户端与云电脑兼容性

核对日期为 2026-11-19。各处可复用 [研究](../skills/research/SKILL.md)、[首封写稿](../skills/b2b-first-outreach/SKILL.md)和[写作指南](../skills/b2b-first-outreach-guide/SKILL.md)。邮件执行还需要在同一运行环境中提供 Node.js、浏览器、登录后的专用邮箱配置和执行工具审批。

| 客户端或环境 | 目前接入方式 | 邮件验收状态 |
| --- | --- | --- |
| Codex 桌面 Windows | [完整安装](../codex/README.md)。项目级 MCP 使用独立 Chrome 配置。 | 本机 Zoho 是已运行的组合。 |
| 自管 Windows 云电脑 | 在云电脑内安装 Codex 桌面、Node.js 和 Chrome，重新完成邮箱登录。使用同一个 Codex 安装指南。 | 可按相同架构部署，需在目标云电脑验收。 |
| 托管 Codex Cloud | 仓库技能、研究写稿、代码和测试。官方当前把计算机操作列为托管环境的限制。 | 尚无本项目的浏览器执行通道。[官方文档](https://learn.chatgpt.com/docs/environments/cloud-environments#current-limitations) |
| Claude Code | 可读取 `SKILL.md` 并使用本地 stdio MCP。Web 任务使用独立云环境。 | 客户研究和写稿可用项目文件。邮箱连接和发送审批需另行验收。[技能](https://code.claude.com/docs/en/skills) · [MCP](https://code.claude.com/docs/en/mcp) · [网页版](https://code.claude.com/docs/en/claude-code-on-the-web) |
| Grok Bot | 官方支持私有技能和云电脑上的自定义 MCP。Grok Build CLI 也支持技能与 MCP。 | 可按官方能力接入只读工具，尚未完成本项目的客户端验收。[Grok Bot 技能](https://docs.x.ai/grok-bot/skills-routines-and-automations) · [Grok Bot 云电脑](https://docs.x.ai/grok-bot/computer-and-apps) · [Grok Build MCP](https://docs.x.ai/build/features/mcp-servers) |
| Muse（按 Meta Muse 核对） | 提供独立虚拟机和可接入的连接器平台。 | 可复用文字指南。尚未核实第三方 SKILL.md 或本地 stdio MCP 的安装入口。[Muse 连接器平台](https://platform.muse.ai/docs) |
| ChatGPT 的你的 Dot | 可协调研究和写稿，也可委派到 Work 或 Codex。在组织设置与账号允许时，可访问获准的本地电脑。 | 项目级邮件工具仍由接入它的宿主执行，具体审批和登录留在该宿主。[你的 Dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) · [云端与本机访问](https://learn.chatgpt.com/docs/enterprise/cloud-local-access) |
| 腾讯 WorkBuddy | [客户端安装教程](../workbuddy/README.md)。提供可导入技能和标准 stdio 只读 MCP。 | 只读接入。验证状态和邮箱兼容性，实发仍由已验收的宿主执行。[腾讯客户端接入文档](https://docs.ardot.tencent.com/ardot-mcp/ide-integration.html) |

新机器或虚拟机应使用自身的专用 Chrome 配置和独立数据目录。首次启动先核对版本和工具清单，再登录并执行只读兼容检查。已有账号的活动发送批次统一留在原宿主；同一个邮箱避免在多个宿主同时运行发送。
