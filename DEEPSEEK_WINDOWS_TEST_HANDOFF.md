# 笔记本 DeepSeek / Windows 测试交接 · v0.2

> 历史交接：下文保留v0.2/v0.3当时的测试范围和模拟入口。当前v0.6接入、真实发送和时长规则以[多工具使用教程](docs/MULTI_TOOL_QUICKSTART.zh-CN.md)及[真实验收记录](docs/TEST_RESULTS_V06.zh-CN.md)为准。公开仓库中代码位于根目录，不再需要旧工作区的plugins子路径。

> v0.3 路线说明：本文保留原专用模拟浏览器流程。接入现有 Edge 邮箱标签页、1 小时截止与真实草稿测试，请使用 [浏览器会话入口](docs/browser-mail-session.md)。

## 本次只验证什么

验证**专用浏览器隔离、模拟邮箱流程和暂停/接管/恢复**。不要登录真实邮箱，不导入真实客户，不发送真实邮件，不填写模型 API key，不调用付费模型。当前真实邮箱适配器未实现。

代码位于仓库 `plugins/harness-sales-workflow/`。不要改仓库旧工作台、根目录依赖或已有浏览器用户资料。此包保留原 Harness 通用行业研究、官方邮箱证据/历史排重、100篇/视频学习台账、逐客双语稿和分组队列；本次新增的是本地浏览器外壳与模拟邮箱。

## 先检查依赖

- Windows 10/11；Node.js >=22，npm 可用。
- 默认测试 Chromium；脚本会安装固定依赖与专用浏览器二进制，不覆盖日常浏览器。
- 完整34项原有测试中部分Excel测试需要 Python + openpyxl。如果缺失，只记录缺项；可先运行本次浏览器定向测试。
- PowerShell 脚本若被组织策略禁止，停止并报告，不使用执行策略绕过或管理员提权。

## 命令（PowerShell，进入插件目录执行）

```powershell
Set-Location .\plugins\harness-sales-workflow
node --version
npm --version
.\windows\install.ps1 -Browser chromium
node --test test/local-browser.test.js
npm test
.\windows\start.ps1 -Browser chromium
```

若以仓库其他路径拉取，先调整 Set-Location。install/start 默认数据目录是 `%LOCALAPPDATA%\B2BSalesHarness`，profile固定派生为 `browser-profiles\chromium`。禁止传入日常 Chrome/Edge 的 User Data 或其子目录。需要Edge测试时可选 `-Browser msedge`，使用已安装Edge、仍然派生独立profile；不要安装/替换用户现用Edge。

### 预期浏览器流程

1. 打开一个新专用浏览器窗口，显示“B2B 本地专用浏览器”控制台；初始 paused，真实联系数为0。
2. 点“准备一条合成客户与草稿”，只生成 `.test` 合成地址；检查完整英文、中文、主题、leadId与hash。
3. 不批准直接启动，必须拒绝或提示无批准队列。
4. 在审核栏**手动复制核对** leadId、完整hash、完整收件邮箱、审核人，勾选核对后批准入队。
5. 点“允许模拟浏览器自动化”，运行只读兼容性检查并确认通过。可填写带时区的最早开始时间，再点“启动已批准模拟队列”。固定程序在计划时间到达并通过发送前检查后，将精确批准的邮件提交到模拟邮箱。最终状态应含 `mode: mock`，`realCustomerContacts` 为 0。
6. 检查mock回执recipient/subject/body/approvedHash与批准快照完全一致；重复启动不得重复这条回执。
7. 新建第二条模拟记录，审核入队；启动后测试“暂停”和“暂停并人工接管”。接管后不得继续自动操作；明确启用后才可重新开始队列。暂停不能宣称撤回已经接受的模拟提交。
8. 测试“关闭专用浏览器”，然后终端 Ctrl+C 停止本地服务。重新 start：状态仍暂停，历史mock回执保留，不自动再发送。
9. 启动第二个同目录实例应被profile/workflow锁拒绝；不得清锁强行并发。正常关闭后可重启。
10. 日常Chrome/Edge窗口、历史记录与登录状态应不受影响。不要为验证而读取、导出或上传它们。

## 补充自动验证（本机允许启动loopback HTTP时）

```powershell
node verification/local-browser-qa.mjs
node verification/local-app-qa.mjs
```

这些使用**假浏览器driver**，不证明真浏览器已经启动；真实浏览器仍以手工流程结果为准。`npm test` 原34项加本次11项共45项；后续若补测试，以实际输出为准。若缺Python，只把Excel前提缺失单列，不虚称全过。

## 已知限制及严禁“修复”方式

- 云端真实Chromium曾因 `socket(): Operation not permitted` 被限制；未通过关闭sandbox等办法重试。Windows真机验证正是本次待办。
- 不使用 `--no-sandbox`、关闭安全策略、开放远程CDP、使用日常profile、复制登录cookie等办法“修复”。失败时保留错误并停止相关项。
- 自动化仅实现本地模拟邮箱；不是Gmail/Zoho/Outlook通用发送器，不要自行换真实邮箱URL。
- Playwright、浏览器和PowerShell的企业策略可能阻止启动。请报告，不绕过。
- 独立profile会保存网站状态；不要上传profile、state.json、mock客户以外的数据、token、凭据或真实邮件截图。
- 专用模拟控制台是伴随工具，**不包含Harness运行时**。真正Harness插件使用另行安装的官方Harness；本次不要求调用真实模型。可另用 `examples/create-local-patch.js` 生成配置，但不要和控制台占用同一profile。

## 请按此模板回报

```text
系统版本：
Node/npm版本：
浏览器选项及版本：
安装：通过 / 失败（完整错误，不含凭据）
定向测试：通过数 / 失败数
完整测试：通过数 / 失败数 / Python缺项
真实专用浏览器启动：通过 / 被阻止 / 未测
默认profile隔离：通过 / 未测（不要上传默认资料）
模拟精确审批→DOM填写→回执：通过 / 失败 / 未测
暂停/人工接管/关闭/重启：
重复进程锁及无重复模拟提交：
真实邮件发送数：0
是否有修改代码：文件及原因（不要改旧工作台）
阻碍操作、对象、原因和最小复现：
```
