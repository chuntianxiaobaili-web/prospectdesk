# ProspectDesk 0.6.1 中文发布说明

0.6.1 基于 0.6.0，修复 Codex 中 Zoho 网页邮箱的控件识别和连接释放问题，并公开 Codex 项目级 STDIO MCP 桥接器。Codex 使用专用 Chrome 配置登录 Zoho，运行时无需 DeepSeek Harness。

## 本次修复

- 分开识别顶层页面和 iframe 中的控件，过滤 CSS 伪控件与重复的匿名文本，避免把普通文字或原生搜索输入框当成操作按钮。
- 历史查重识别原生复选框，按填写的收件人条件查询。
- 准备草稿时核对主题字段、单一收件人和明确为空的抄送字段，确认邮件正文所在编辑区及写信面板中唯一的发送控件。
- 改进 Windows 上的 Chrome 识别。空闲时查询状态保持浏览器关闭，操作结束后正常释放连接。

## 在 Codex 中安装

在仓库根目录执行以下命令。将示例地址换成要在专用 Chrome 配置中使用的发件邮箱。

```sh
npm ci
npm --prefix codex ci
node codex/configure.mjs --account "operator@example.com"
```

要为另一个本地项目生成配置，在最后一条命令加上 `--project "<本机项目目录>"`。命令将配置片段输出到终端。把片段合并到对应项目的 `.codex/config.toml`，重新打开 Codex 项目。

先调用 `sales_browser_mail_status` 确认桥接器就绪，再用 `sales_browser_mail_compatibility` 检查浏览器连接。首次打开专用 Chrome 时，如出现登录页，请在浏览器内登录 Zoho。

## 验证结果

在 Windows 的 Codex、Chrome 和 Zoho 实际环境中通过了 9 项只读检查，包括会话连接与账号就绪、原草稿定位与准备、按收件人查重、正文与唯一发送控件识别、既有邮件发送回执与正文核对，以及浏览器连接释放。本地修复验收通过了 633 项回归测试。

本次真实邮箱验证的范围为 Codex 与 Zoho。新增实发和草稿清理本次均为 0 封。
