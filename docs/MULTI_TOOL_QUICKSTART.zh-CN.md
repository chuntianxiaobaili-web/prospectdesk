# Codex、Claude、DeepSeek 与 Harness（HAR）使用教程

适用版本：客拓工作台 ProspectDesk v0.6.1。本教程中的 HAR 指 DeepSeek Harness 客户端，按用户确认的名称对应。以下先完成研究与写稿，再说明真实浏览器执行的接入条件；客户端、模型和命令行入口分别说明。

## 1. 拉取完整项目，保留资料引用

在准备存放项目的目录打开 PowerShell：

```powershell
git clone https://github.com/chuntianxiaobaili-web/prospectdesk.git
Set-Location .\prospectdesk
```

解压 GitHub 下载的 ZIP 也可以。项目根目录应同时包含 `README.md`、`package.json`、`src`、`docs`、`skills` 和 `verification`。

本包部分技能会读取 `../../docs` 等相邻资源。推荐让工具在完整项目中读取原位置的 `SKILL.md`；只复制一个技能文件夹，会使这些引用失去原位置。下文的默认路线保留完整目录，不需要先把所有文件搬进工具的全局技能目录。

如果只让 AI 阅读方法、整理客户资料和撰写审阅稿，先在工具中打开这个项目即可。需要运行本地固定程序或工程检查时，再确认 Node.js 22 或更新版本，并安装锁定依赖：

```powershell
node --version
npm --version
npm ci
```

XLSX 导入/导出另需可调用的 Python 和 openpyxl；CSV 不依赖这项。完整工程检查还包含XLSX案例，运行前同样需要Python和openpyxl。工程检查命令为 `npm test`，其合成数据检查不会因此发送真实邮件；本机是否通过以实际输出为准。

| 内容 | 项目位置 | 作用 |
|---|---|---|
| 客户研究 | `skills/research/SKILL.md` | 官方证据、历史排重与客户表 |
| 首封写稿 | `skills/b2b-first-outreach/SKILL.md` | 个性化英文稿和中文审阅稿 |
| 写作教学 | `skills/b2b-first-outreach-guide/SKILL.md` | 跨行业判断方法与审核清单 |
| 浏览器执行 | `skills/browser-mail-session/SKILL.md` | 调用已接入的固定发送程序 |
| 只读检验 | `skills/mailbox-compatibility/SKILL.md` | 检查当前连接与邮箱页面 |

## 2. 在 Codex 和 Claude Code 中使用

### Codex：先用项目原目录完成研究与写稿

在 Codex 桌面中打开克隆的 `prospectdesk` 文件夹，并在这个项目中新建对话。使用 CLI 的人可在该目录运行已经安装的 `codex`。随后把下面的任务发给代理，并替换方括号中的资料和目标：

```text
请先读取 skills/research/SKILL.md、skills/b2b-first-outreach/SKILL.md
以及 docs/drafting-policy.md，按本项目的方法执行。

行业：[你的行业]
产品或服务资料：[本机资料路径或上传的文件]
目标客户与市场：[例如某地区的批发商]
完整客户历史：[历史文件路径，并说明覆盖范围]
本次研究目标：[数量]
写稿依据：product-evidence-review。

先交客户表、来源依据、逐封英文稿和中文审阅稿，保留排除原因。
待我逐封审核后，再交给已连接的浏览器执行器。
先报告当前可用的文件、搜索、浏览器和固定程序工具。
```

Codex 的标准本地技能目录包括项目中的 `.agents/skills` 和用户目录下的 `~/.agents/skills`，CLI/IDE 也可通过技能选择或 `$技能名` 调用已经安装的技能。本教程采用直接读取完整项目的方法，避免移动目录后丢失引用；直接读文件并不意味着技能已自动安装到选择器。[官方技能说明](https://learn.chatgpt.com/docs/build-skills.md)

0.6.1 提供 Codex 桌面项目级接入，使用专用 Chrome 窗口和 Zoho 草稿箱。需要执行时，请按 [Codex 接入教程](../codex/README.md)安装依赖并生成配置。0.6.0 的 Edge 和 Gmail 实发记录来自 Codex/CUA 桌面环境，复用该方式时仍需宿主具备浏览器连接与固定程序接口。

### Claude Code：同样先读取项目文件

在克隆目录运行已安装的 Claude Code：

```powershell
claude
```

把上面的研究与写稿任务发给 Claude，并要求先读取这几个项目文件。Claude Code 的原生技能位置为项目 `.claude/skills/<名称>/SKILL.md` 或个人 `~/.claude/skills/<名称>/SKILL.md`；已正确安装的技能可按其命令名调用。这里没有要求把带外部引用的技能孤立搬过去。[Claude Code 官方技能说明](https://code.claude.com/docs/en/skills)

本包目前是 Harness 原生工具插件，不是已经打包的 Claude Code MCP 服务。Claude Code 可以按文件中的写稿与研究方法工作；其真实浏览器发送连接尚未在本项目中验收。先让它列出可用工具，再按下一节接入真实连接。不要把桌面、CLI、网页或云端会话当成同一运行环境。

### Claude 网页版 / 桌面聊天：复用资料与写稿方法

在本机打开本包，把选用技能的完整 `SKILL.md`、其引用的相关 `docs` / `references` 文档及业务资料一起提供给会话，保留原文件名作为材料标题。可以粘贴完整文字，或整理为界面支持的 TXT、CSV、PDF 等文件上传；不要只给一个仓库名称或不完整的技能片段。[官方文件上传说明](https://support.claude.com/en/articles/8241126-upload-files-to-claude)

然后发送：

```text
请按我提供的完整技能和参考资料，先列出已读文件与缺项，
再整理客户表并撰写逐封英文稿、中文审阅稿，等待我审核。
此阶段只生成方法、分析和审阅稿，不安排发送。
```

这里的 `git clone` 在你自己的本机终端运行；把资料交给聊天会话不会自动建立本机浏览器连接。Claude 各端的本地文件与浏览器能力须按其当前环境实际接入，本包尚未验收 Claude 网页/桌面聊天中的固定实发链路。[Claude 各端能力说明](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)

## 3. DeepSeek 网页、Harness（HAR）客户端与原生插件

### DeepSeek 网页或模型

使用 DeepSeek 网页做研究方法整理或写稿时，可把对应 `SKILL.md`、卖方资料、客户表和历史记录提供给支持这些输入的会话，并明确要逐封英文稿与中文审阅稿。提示词和模型本身不提供本机邮箱标签页连接。

若用 DeepSeek 作为代理宿主的模型后端，应在该宿主中配置实际可用的 provider/model。模型 API 与执行工具是两个部分；本包不替使用者猜测模型 ID，也不把模型调用当作邮件已发送。当前接口配置以[DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)为准。

### DeepSeek Harness（HAR）客户端：打开完整项目

打开已安装的 DeepSeek Harness 客户端，在工作区选择界面添加并选中完整 `prospectdesk` 目录，再新建会话。官方 Web 界面的入口名为 **Choose workspace**，选择工作区后才能开始会话；桌面客户端使用同一应用的桌面载体，并支持本地文件夹选择。界面的实际语言和入口以安装版本为准。[官方工作区说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)、[官方桌面说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)

先发送第 2 节的研究与写稿任务，让代理实际读取完整 `skills/research/SKILL.md`、`skills/b2b-first-outreach/SKILL.md` 与引用资料。随后可发送以下只读检查任务：

```text
请读取 skills/mailbox-compatibility/SKILL.md 和 docs/browser-mail-session.md。
列出本会话真实可调用的 sales_* 工具和浏览器连接状态。
若 sales_browser_mail_compatibility 已注册，执行一次只读检查，
核对当前浏览器、准确邮箱账号、连接对象与页面。
保留实际工具输出；缺少的工具或连接逐项写明。
本次检查不创建邮件、不发送、不清理草稿。
```

工作区文件可读，只证明资料已接入；浏览器执行须有当前宿主真实注册的固定工具与连接。本包尚未在 DeepSeek Harness 桌面客户端完成真实邮箱发送验收，已有 20 封实发记录来自 Codex/CUA 桌面环境。

### Harness 原生插件：当前官方命令仍为 dsh

Harness 是运行代理和工具的宿主，DeepSeek 可以是其模型来源。本包的 `src/plugin.js` 导出 `name`、`inject` 和 `apply`，要求宿主提供 `tools`、`llm`，再注册 `sales_*` 工具。本包技术手册记录的历史对接目标是 `@deepseek-ai/dsh 0.2.1-rc.2`；其他版本须重新核对加载和接口。

截至本教程核对时，官方 README 与 CLI 文档仍将启动命令命名为 `dsh`；HAR 在本教程中是客户端简称，并非另一个已核实的命令名。桌面客户端如需启用命令，可使用应用菜单 **Manage dsh Command…** 的安装入口，完成后打开新终端运行 `dsh --version`。菜单名称可能按语言本地化。[官方客户端命令说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#terminal-command)、[官方 CLI 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)

已经具备 `dsh` 命令的用户，在 ProspectDesk 根目录先检查版本，再复制一个独立的本地配置：

```powershell
dsh --version
Copy-Item .\examples\plugin.patch.yml .\plugin.local.patch.yml
```

编辑 `plugin.local.patch.yml`，替换其中全部绝对路径、品牌资料、状态/导入/导出目录、准确邮箱账号和实际模型路由。该文件名已列入本包忽略规则。填写完成后，可在这个目录运行：

```powershell
dsh web --patch ((Resolve-Path .\plugin.local.patch.yml).Path)
```

这里的命令启动带配置的 Web 宿主，不会把插件注入另一个已经运行的桌面客户端。未安装命令的用户可按官方 README 使用 `npx @deepseek-ai/dsh web` 启动基础 Web 界面；该基础启动同样没有自动装入本包。桌面客户端中的插件加载需按其安装版本的实际插件设置重新检查。本教程不把历史插件配置视为所有桌面版本的一键安装包。官方提供 Harness 的启动与插件路径要求：[Harness 项目](https://github.com/deepseek-ai/deepseek-harness)、[官方插件入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)。该样例不自动取得正在登录的邮箱。

真实浏览器路线还需要宿主在同一运行进程中，把实际连接对象传给插件的 `browserMail.connection`，或传入兼容的 `browserMail.tab`；同时配置准确 `config.accountId`。Gmail 需显式选择 `mailProfile: 'chinese-gmail-ui'`。连接对象包含运行中的方法与身份校验，不是可以写进静态 YAML 的一段账号字符串。[浏览器接入说明](browser-mail-session.md)

接线后的宿主必须能正常注册和调用工具；单纯把 `sales_*` 名字写进提示词不会创建这些工具。[Harness 官方工具注册说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)

当前版本的加载成功、`tools` / `llm` 服务可用与浏览器接线，需要分别取得实际检查结果。历史 `0.2.1-rc.2` 目标和当前客户端版本保留在记录中，避免把加载记录混作实发记录。

## 4. 首次真实执行、故障判断与日常更新

### 第一次先做只读检查

让当前代理读取 `skills/mailbox-compatibility/SKILL.md`，调用已经真实注册的 `sales_browser_mail_compatibility({})`。检查结果需对应本次浏览器、准确账号和邮箱页面。浏览器身份通过不等于全部编辑、发送和回执步骤都已通过；原文仍在每封执行前核对。

若当前会话没有该工具、没有连接对象或报告未连接，先完成客户表与草稿交付，并说明缺少哪一层连接。不要把演示页面或指令文件的成功加载算作真实邮箱验收。

### 用户批准后再运行固定程序

新稿先完成真实客户历史核对和精确收件人、主题、英文全文、中文稿审核。批准由可信宿主保存，或按[中文技术手册](../README.zh-CN.md)中的交互审核台执行；AI自评通过不代替用户批准。

已接入的宿主按以下工具顺序执行。这是工具调用次序，不是 PowerShell 命令；`leadId` 和批准摘要均从本轮真实记录取得：

```text
sales_browser_mail_save_approved_draft
  → 保存一封已批准文案，核对准确新草稿编号和全文
sales_browser_mail_prepare_approved_drafts
  → 选择本次已绑定的 leadIds，设置 target、可选 workDuration 和固定间隔
sales_browser_mail_start
  → 启动本轮
sales_browser_mail_step
  → 每次最多一封，在当前宿主中等待发送、回执与原稿处理
sales_browser_mail_finish
  → 核对最终草稿总数，归档并释放账号锁
```

如果使用邮箱里原有的草稿，则走 `sales_browser_mail_prepare`，先明确准确原稿范围并核对历史。新稿与原有稿的完整步骤见[草稿交接](APPROVED_DRAFT_FLOW.zh-CN.md)和[浏览器会话](browser-mail-session.md)。永久删除残稿只使用本次准确范围的确认，未确认发送或内容变化的原稿保留。

用户命令可以指定工作1小时或5小时；工具字段传对应单一时长，例如 `workDuration: '1小时'`。省略时长不设时间截止，达到数量目标或队列耗尽仍结束本批。连续8小时提醒需要宿主实际显示或活跃代理显示后确认，期间工作继续。退出进程不会自行续发。

### 看什么结果，怎样升级

正常结果应分开列出实际发送、已确认移除原稿、待发、待清理、未知与邮箱最终草稿总数。Gmail可能自动消耗原稿；程序应完整核对准确编号消失。已发送记录表示邮箱接受提交，不表示客户已阅读。真实结果与工程检查分别见[实发报告](TEST_RESULTS_V06.zh-CN.md)、[脱敏结果](LIVE_ACCEPTANCE_V06.json)及[程序验证摘要](../verification/V06_QA_SUMMARY.json)。

升级前结束当前会话并等待归档，保留本地配置与状态。回到项目根目录：

```powershell
git status --short
git pull --ff-only
npm ci
```

如有本地改动或版本冲突，先处理并保留改动，再继续更新。更新后先重新做只读兼容检查；旧版本的浏览器验收记录不自动代表新界面仍可用。旧 `LOCAL_WINDOWS` 与 `DEEPSEEK_WINDOWS_TEST_HANDOFF` 文档保留早期演示记录，当前真实入口以本教程和v0.6会话文档为准。

### 当前验收状态

| 使用环境 | 本包可复用部分 | 本项目的实际验收 |
|---|---|---|
| Codex 桌面 + 实际CUA连接 | 资料、研究、写稿及已接入的固定执行器 | Edge与Chrome各10封实发，逐封核回执与原稿 |
| Codex CLI / IDE | 项目文件与技能方法 | 仍需对应宿主的真实浏览器接线，未把桌面验收移作CLI验收 |
| Claude Code | 项目文件中的研究与写稿方法 | 本项目尚未验收Claude Code真实邮箱发送连接 |
| DeepSeek 网页 / 单独模型API | 文案方法与结构化输入输出 | 需要代理执行宿主，未验收为独立桌面控制器 |
| DeepSeek Harness（HAR）桌面客户端 | 在完整工作区读取资料与技能；实际工具需检查注册和连接 | 本项目尚未完成该客户端的真实发送验收 |
| Harness / dsh 原生插件入口 | 原生插件与工具注册接口；历史目标0.2.1-rc.2 | 保留历史加载/接口记录；本轮20封实发来自Codex/CUA环境 |

本教程未触发任何邮件发送；可见范围和程序验收以仓库内具体记录为准。

公开版使用[MIT许可证](../LICENSE)。本地状态、账号、客户资料和浏览器登录信息仍由使用者各自配置。
