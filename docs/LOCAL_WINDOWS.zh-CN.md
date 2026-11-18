# v0.2 本地专用浏览器版：Windows 使用说明

> 历史文档：下文记录v0.2/v0.3阶段及当时的模拟入口。v0.6真实邮箱、用户指定时长与多工具接入请先读[当前使用教程](MULTI_TOOL_QUICKSTART.zh-CN.md)和[真实验收记录](TEST_RESULTS_V06.zh-CN.md)。旧阶段的一小时说明不作为v0.6默认时限。

> v0.3 路线说明：本文保留原专用模拟浏览器流程。接入现有 Edge 邮箱标签页、1 小时截止与真实草稿测试，请使用 [浏览器会话入口](browser-mail-session.md)。

本版在云端开发，供你下载后在自己的 Windows 电脑上运行；**没有安装或操作你的电脑**。Windows 启动脚本仅做静态检查，尚未在 Windows 真机上执行。本次云端环境的浏览器运行被 socket 系统调用限制阻断，因此不能把静态/逻辑测试说成浏览器已完成实际运行验收。

## 这版能做什么

- 保留通用行业客户研究、证据与历史排重、Excel/CSV、100来源学习台账、逐客双语草稿及批准队列。
- 启动程序专用的浏览器会话，使用单独的持久化资料目录，不连接你正在使用的 Chrome/Edge，也不读取其默认用户资料。
- 固定程序按批准版本执行发送队列，支持暂停和人工接管。子代理通过只读检查验证模拟邮箱可用性。
- 目前只带 **synthetic mock webmail（合成测试邮箱）适配器**。它能演练完整流程，但不会发送真实邮件。没有把任意邮箱网页当成已经支持的服务。

**还不能据此宣称：** Zoho、Gmail、Outlook 等真实邮箱已经适配；真实账号已经登录；100篇/视频已经学完；真实模型路由或付费调用已经验证。

## 环境前提

- Windows，Node.js **22 或以上**（包含 npm）。
- 推荐使用程序下载的 Chromium。也可以选择电脑上已经安装的 Google Chrome 或 Microsoft Edge。
- 只有 XLSX 导入/导出需要额外的 Python + `openpyxl`；CSV 和浏览器本身不依赖 Python。
- 解压完整包，保留 `package.json`、`package-lock.json`、`src`、`windows` 等目录结构。请不要把文件放进 Chrome/Edge 的默认资料目录。

Playwright 官方支持通过 `channel: chrome` / `msedge` 启动已安装的品牌浏览器，但企业浏览器策略可能影响启动。推荐先用与依赖版本匹配的 Chromium 验收。[Playwright 浏览器说明](https://playwright.dev/docs/browsers)

## 安装（由你在本地执行）

在解压目录打开 PowerShell：

```powershell
.\windows\install.ps1
```

该命令执行锁定版本的依赖安装，然后下载对应 Chromium 到：

```text
%LOCALAPPDATA%\B2BSalesHarness\browser-binaries
```

不会申请管理员权限，不会修改执行策略，不会替换你的正常浏览器。首次安装需要网络；若组织策略或下载被阻止，脚本会报告失败，不绕过限制。

如果 PowerShell 提示脚本执行受到策略限制，应按你所在组织允许的方式处理；本包不提供 `ExecutionPolicy Bypass` 等绕过命令。

如果要使用已安装的 Edge 或 Chrome，可在安装与启动时使用相同选项：

```powershell
.\windows\install.ps1 -Browser msedge
.\windows\start.ps1 -Browser msedge
```

`-Browser chrome` 对应 Chrome。选择这两个渠道时，安装脚本不会下载、升级或替换品牌浏览器；浏览器缺失时启动应失败并提示。

## 启动

```powershell
.\windows\start.ps1
```

默认以可见窗口启动专用 Chromium，队列初始为暂停。启用模拟功能后，先运行只读兼容性检查，再装入合成测试样例，核对并批准邮件。可填写带时区的计划开始时间，如 `2026-12-01T09:00:00+08:00`，然后启动模拟队列。脚本在前台运行，保留窗口以便查看错误并停止应用。可另设程序的数据根目录，安装与启动使用同一个路径。

```powershell
.\windows\install.ps1 -DataDir "D:\B2B Sales Data"
.\windows\start.ps1 -DataDir "D:\B2B Sales Data"
```

安装和启动在任何建目录、安装依赖或下载浏览器之前，先调用只读目录校验器；默认浏览器资料路径或指向其的符号链接等不安全路径会被拒绝。不要传入浏览器默认资料目录。应用内部派生自己的专用 profile，不接受连接默认 Chrome/Edge 的远程调试地址。控制面只在本机使用，不向局域网或公网开放 CDP 端口。

Playwright 的持久上下文使用独立 `userDataDir`；同一目录不能由多个浏览器实例同时占用。官方也明确不支持自动化 Chrome 的默认用户资料目录。[launchPersistentContext 官方说明](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)

## 暂停、人工接管与关闭

1. **暂停**：停止安排新的队列动作；正在进行的动作需等待结果明确。暂停不是“撤回已被邮箱接受的信”。
2. **人工接管**：先暂停并等待自动操作停止，再由你在专用浏览器窗口中操作；接管期间不能让自动执行器同时点击。
3. **恢复自动操作**：重新核对账号、最新回复、停止要求和批准内容。确认兼容性，再显式恢复。未知结果还需先核对回执。
4. **关闭**：使用本地关闭控制，或在启动的 PowerShell 中按 `Ctrl+C`。程序应等待自己发起的操作收尾，不会按浏览器进程名称批量结束其他 Chrome/Edge 窗口。
5. **重启**：不能自动续发。先检查保留的状态；不确定发送必须核对后处理，不能盲重试。

本版没有真实邮箱适配器，因此不要把在专用窗口登录某个邮箱理解为“已经允许自动发送”。也不要在模拟网页输入真实密码或真实客户收件人。

## 数据与隐私

程序使用自己的状态与浏览器资料目录。持久资料可能包含你手工登录后产生的 Cookie 或会话信息，应像账号数据一样保管：不要上传、打包分享或提交到代码仓库。不需要把密码交给插件或写进配置。

停止程序后再备份状态。不要在浏览器或执行器仍运行时删除锁、拷贝 profile 或启动第二份实例；遇到陈旧锁应先确认原进程已经结束。

## 测试和故障排查

```powershell
npm test
```

普通测试不会发送真实邮件。浏览器端到端测试及其环境要求以包内验证说明为准；Linux 云端通过的测试不等于 Windows、Chrome、Edge 或真实邮箱都验证完成。

- **缺少 Node/npm**：安装 Node.js 22+，重新打开 PowerShell。
- **缺少 package-lock.json**：重新解压完整 v0.2 包；安装器不会退回不锁定的安装。
- **Chromium 未找到**：用同一个 `-DataDir` 重新运行安装脚本；检查网络/组织策略，不改用不可信下载。
- **Chrome/Edge 启动失败**：确认渠道已安装且组织策略允许；可用 Chromium 先验收。
- **Excel 不可用**：另外安装 Python/openpyxl；或先使用 CSV。不要把这个问题误判成浏览器不可用。
- **profile/状态已占用**：先退出已有实例，保留其他浏览器和当前状态锁。
- **模拟邮箱兼容性变化**：在模拟浏览器处于可用状态时读取本地 `GET /api/compatibility`。子代理只读取检查结果。控件缺失或含义不明确时暂停，确认账号和控件标识正常后再恢复。

## 下一步接入真实邮箱的边界

选择邮箱服务后，接入服务支持的发送 API 或官方定时发送功能。在授权的测试账号中核验账号识别、收件人归属、批准原文、额度、回执和异常核对。
