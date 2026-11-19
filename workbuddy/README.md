# 在腾讯 WorkBuddy 使用 ProspectDesk

工作流和邮箱连接器可以分别使用。本地技能提供客户研究和双语开发信审阅。自定义连接器通过本机进程验证邮箱，并由独立 Chrome 配置运行。

## 1. 导入客户研究与写稿技能

从仓库根目录运行以下任一命令，将 `prospectdesk-review/` 保留为 ZIP 内的顶层目录。

Windows PowerShell

```powershell
Compress-Archive -Path .\workbuddy\skills\prospectdesk-review -DestinationPath .\prospectdesk-review.zip
```

macOS 或其他安装了 `zip` 的环境

```sh
(cd workbuddy/skills && zip -r ../../prospectdesk-review.zip prospectdesk-review)
```

在 WorkBuddy 左侧打开「专家·技能·连接器 → 技能 → 添加技能 → 上传技能」，选择生成的 ZIP。然后让 WorkBuddy 使用 ProspectDesk 客户开发审阅技能，读取本轮产品资料和目标客户。 [WorkBuddy 技能上传指南](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) · [技能文件规范](https://open.workbuddy.cn/docs/skill)

## 2. 添加本地只读邮箱连接器

在安装 WorkBuddy 的同一台电脑上准备完整仓库、Node.js 22 或更新版本及 Chrome。在仓库根目录运行：

```sh
npm ci
npm --prefix codex ci
node workbuddy/configure.mjs --account "operator@example.com"
```

将示例邮箱替换为需要核对的自己的邮箱。输出的 JSON 是待合并的配置，不会自动修改客户端。在 WorkBuddy 打开「专家·技能·连接器 → 连接器 → 自定义连接器 → 添加 MCP」，将 `prospectdesk-review` 条目加入现有的 `mcpServers`，保留其他条目。保存后核对弹出的命令和文件路径，再按客户端提示建立信任。 [WorkBuddy 连接器指南](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector) · [自定义 MCP 的参数规范](https://open.workbuddy.cn/docs/connector) · [客户端配置示例](https://docs.ardot.tencent.com/ardot-mcp/ide-integration.html#workbuddy)

- 要先验证工具注册，可以省略 `--account`。此时状态工具可用，邮箱兼容检查会报告缺少账号且不会打开浏览器。
- 默认使用 Zoho 草稿箱地址。若邮箱站点或 Chrome 安装位置不同，可分别提供 `--mail-url` 或 `--chrome-executable`。需要打开邮箱时，请在专用 Chrome 窗口内登录。
- 默认注册状态、兼容性两项只读工具。需要核对一封已知草稿时，可带 `--allow-inspect` 重新生成配置。该工具要求提供准确的草稿 ID、已知收件人及主题，返回正文长度和核验摘要。
- 连接器使用独立目录 `~/.prospectdesk/workbuddy/`。目录和实际邮箱配置仅存放在运行连接器的设备上。这套接入没有邮件发送、编辑和清理工具。

## 3. 验收方式

```sh
node workbuddy/verify.mjs
```

测试覆盖独立的 STDIO 注册、冷启动状态、缺少账号时的保护、两种工具清单及写入工具不可调用。测试不会打开邮箱。此版本已在开发环境用标准 MCP 客户端通过协议测试。WorkBuddy 图形客户端的实际导入和已登录邮箱仍需现场验收。其他支持本地 STDIO 的桌面代理也可以用同一接入验证协议，客户端的安装、交互和审批仍以各自实测为准。
