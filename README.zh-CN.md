# 客拓工作台 ProspectDesk v0.6.3 · 中文技术手册

产品介绍、功能总览及实发结果见[产品首页](README.md)。当前跨工具接入步骤见[Codex / Claude Code / DeepSeek / Harness教程](docs/MULTI_TOOL_QUICKSTART.zh-CN.md)。

## v0.6.3 Codex 与 WorkBuddy 接入

[0.6.3 发布说明](docs/RELEASE_V063.zh-CN.md) · [客户端与云电脑兼容性](docs/CLIENT_COMPATIBILITY.zh-CN.md)

## v0.6.1 Codex 接入修复

参见 [0.6.1 更新与验收说明](docs/RELEASE_V061.zh-CN.md)和 [Codex 安装教程](codex/README.md)。

## v0.6 工作指令与邮箱页面

工作时长按本次明确指令设置：workDuration 可填“1小时”“5小时”等，或直接传正整数 durationMs；省略／null 表示不设时间截止。重复 start 不延长已确定的截止。数量目标和本次获授权草稿仍限定发送范围；达到目标、队列耗尽、暂停或异常会结束／暂停相应会话，不擅自新增收件人。

运行中不做例行进度汇报。连续运行8小时只产生一次工作时长提醒，工作继续；宿主可接 onRuntimeReminder，活跃代理实际向用户显示后调用 sales_browser_mail_ack_runtime_reminder。通知未接入或失败会如实记录，不把事件落盘当已通知。该提醒不创建定时任务，也不重置工作截止。

Edge、Chrome、Yandex 是连接层；企业邮箱和Gmail是独立页面配置。显式 mailProfile: chinese-gmail-ui 使用Gmail读写和兼容检查，默认企业邮箱保持原页面适配。真实浏览器结果与代码检查分别记录，不调用邮箱API。详见 [会话接口](docs/browser-mail-session.md)。

2026-11-18已完成本版真实验收：Edge企业邮箱发送10封、确认移除原稿10封，草稿529→519；Chrome Gmail发送10封、确认原稿自动消耗10封，草稿10→0。20封各有唯一新回执，未重复发送。详见[v0.6真实验收](docs/TEST_RESULTS_V06.zh-CN.md)。Yandex实发与连续8小时提醒尚未现场验证。

新增两项独立写作技能：[首封开发信写稿](skills/b2b-first-outreach/SKILL.md) 与 [跨行业写作指南](skills/b2b-first-outreach-guide/SKILL.md)。写稿根据用户行业、实体/数字/服务以及客群适配；指南基于已有知识，以中文说明和英文例句教学。两者只交付文案，不操作邮箱。100来源检查仅在上游启用相应门槛时执行。

## v0.5 从产品资料开始

新增用户可选的“产品证据＋逐封审核”模式，保留默认100来源手册路线。已批准原文可以通过浏览器保存为草稿，读回准确 ID 与全文后交给固定发送器；核心批准摘要与邮箱正文摘要分别校验。操作见 [完整草稿交接](docs/APPROVED_DRAFT_FLOW.zh-CN.md) 和 [写稿策略](docs/drafting-policy.md)。

2026-11-18 已验证产品资料、澳大利亚客户研究、邮箱历史排除、两封双语文案逐封批准，以及 Edge CUA 实际保存和全文读回。两封原草稿均核对成功，实际草稿总数529；v0.5阶段发送0、删除0；该阶段尚未启动发送与清理，后续现场结果以v0.6记录为准。详见 [v0.5验收记录](docs/TEST_RESULTS_V05.zh-CN.md)。

## v0.4 三浏览器入口

现有草稿控制器新增 Edge、Google Chrome、Yandex 三个独立连接入口。共用发送与截止核心，分别保存浏览器资料、运行日志和验收结果；同一邮箱仍共用账号锁。浏览器身份核验与邮箱页面核验分别报告。详见 [三浏览器连接与分开测试](docs/MULTI_BROWSER.zh-CN.md)。

Windows 可分别使用 `open-mail-edge.ps1`、`open-mail-chrome.ps1`、`open-mail-yandex.ps1` 准备专用窗口与登录。它们只连接，不自动发信。原 CUA 注入继续保留；新增浏览器身份绑定推荐使用 `browserMail.connection`。

## v0.3 浏览器会话入口

现有草稿的浏览器连接器、固定发送执行器、工作时长截止、发送回执核对和原草稿清理已纳入本包。宿主明确传入已连接的邮箱标签页后，通过 `sales_browser_mail_*` 工具执行。当前按用户工作时长指令设置截止，默认不设时间截止；数量默认50封、固定最短间隔72秒，可按本次目标配置；不接邮箱 API。准备不会发送，计时从首次 start 开始。

操作说明见 [浏览器会话](docs/browser-mail-session.md)，技能入口见 [现有草稿发送](skills/browser-mail-session/SKILL.md)，测试步骤见 [整包验收](docs/FULL_ACCEPTANCE.zh-CN.md)。企业邮箱与Gmail分别使用对应的已实测中文页面配置；其他企业邮箱需要各自的页面适配。

原研究、学习、逐客写稿和人工审批入口保留。两条发送路线共用账号锁；现有草稿路线不会伪造研究、学习或审批记录。`windows/start.ps1` 仍启动专用模拟浏览器；真实 Edge 标签页由 CUA 宿主显式注入，当前不是双击即可独立后台运行的桌面安装程序。

## v0.2 本地模拟入口（保留）

在云端制作，供你之后在 Windows 本地安装；本次没有安装或控制你的电脑。先看 [Windows 安装与启动](docs/LOCAL_WINDOWS.zh-CN.md)。`windows/install.ps1` 安装依赖，`windows/start.ps1` 打开**专用浏览器及模拟控制台**，不会接管你日常 Chrome/Edge 资料。

当前支持独立浏览器资料目录、暂停和人工接管、模拟邮箱兼容性检查、固定程序执行获批邮件，以及原生 Harness 研究工具。**该模拟入口不连接真实邮箱；真实页面使用上方 v0.3 会话入口。** 旧版云端浏览器启动和 Windows 启动脚本的验收范围见 [v0.2 测试记录](docs/TEST_RESULTS_V02.zh-CN.md)。

已有 Harness 用户可用 `examples/create-local-patch.js` 生成启用本地浏览器工具的补丁；Harness 运行时需单独安装。不要让模拟控制台和 Harness 同时占用同一专用 profile。下文 v0.1研究/学习/队列能力继续保留。

**主线是通用行业客户研究。** 配置行业、产品、采购者和地区 → 全历史排重和官方商务邮箱证据 → 合格客户表 → 按已选写稿策略准备依据 → 逐客撰写中英文稿 → 人工批准 → 固定程序执行获批邮件。新行业模板显式选择产品资料加逐封审核；已有配置不改默认行为，100来源路线仍可显式选择。

从 `examples/config.industry-template.json` 开始（示例是商用家具，不含任何已验证品牌承诺），再按下方“通用行业研究：主工作流”操作。模板中的模型和邮箱均是待替换占位，不会自动调用未配置服务。`examples/config.mock.json` 仅配合 `npm run demo`，由 demo 显式注入 MockDraftAdapter/MockMailbox，不用于真实管线。

这是 **Cordis/Harness 原生工具插件**，不是另起一个网页应用。使用官方 `ctx.tools.register`、`ctx.tools.guard` 和 `ctx.llm.stream`。目标版本：`@deepseek-ai/dsh 0.2.1-rc.2`。

## 当前做到哪里

- CSV / XLSX 导入、中文列映射、按客户编号合并独立证据表；保留原始字段和所有来源。
- 公司、域名、集团、邮箱历史排重；已筛查但不合格身份也保留。历史不完整只允许准备草稿，不允许首封发信审批。
- 逐客英文开发信和中文审核稿；支持显式导入询盘原文、threadId / replyToMessageId 的回复模式。
- 起草由配置的 Harness 模型完成。发送由固定程序执行已批准的收件人、主题和原文。旧 `sendModel` 配置可移除。
- 人工确认精确收件人和不可变版本后入队；改稿撤销批准；默认批准 24 小时后失效。
- 支持指定开始时间、固定最短间隔、分组暂停，以及暂停、恢复和取消。单邮箱串行处理，状态写入磁盘。结果不确定时先核对回执。
- 子代理通过只读兼容性工具检查对应路线的页面控件；现有草稿路线用 `sales_browser_mail_compatibility`，原路线用 `sales_mailbox_compatibility`。真实发送由固定程序执行，并核对已发送回执。

原始两个 Codex 对话正文尚未取得。因此本版依据本次描述、FSARCAN 手册及技能重建，不声称完整迁移既有对话。

## 环境与快速检查

Node.js >= 22。XLSX 额外需要 `python3` 和 `openpyxl`；CSV 不需要 Python。没有硬编码 Windows 路径。

```bash
npm test
npm run demo
npm run check
```

全部示例只使用 `.test` 域名和模拟数据。`mode: mock` 的 `sent` 是模拟状态，不能计入真实客户联系数，更不代表投递成功。

## 装入已有 Harness

本包默认导出 Cordis `{ name, inject, apply }`，依赖已加载的 `tools` 与 `llm` 服务。没有 API key 也可装载和跑模拟测试；真实模型生成必须由用户另外配置已授权 provider。独立验收使用真实 Cordis Context、官方 ToolRuntime / LlmRuntime，而非仿造 ctx。

在已有 Harness 的宿主插件/配置入口导入本模块并安装：

```js
import sales from '/absolute/path/to/fsarcan-sales-plugin/src/plugin.js';
import {MockDraftAdapter, MockMailbox} from '/absolute/path/to/fsarcan-sales-plugin/src/mock.js';
await ctx.plugin(sales, {
  directory: '/your/cloud-data/sales-state',
  importDirectory: '/your/cloud-data/imports',
  config: {
    brand: { name: '你的品牌', products: ['你的产品'], verifiedFacts: [], unknowns: [] },
    accountId: 'mock@example.test',
    draftModel: { provider: 'configured-provider', model: 'exact-provider-model-id' },
    minimumIntervalSeconds: 180
  },
  // 以下两项仅模拟验收；真实起草删除 draftAdapter 即走 ctx.llm.stream。
  draftAdapter: new MockDraftAdapter(),
  mailAdapter: new MockMailbox(),
  workbookMapping: {/* 见 examples/workbook-mapping.fsarcan.json */}
});
```

`MockDraftAdapter` 和 `MockMailbox` 用于模拟验收。原获批数据包路线缺少 `mailAdapter` 时保持停用；v0.3 现有草稿路线独立使用 `browserMail.tab`。起草模型使用服务商可用的模型 ID，按对应服务商的订阅与计费执行。

### 从表格到队列的操作顺序

1. 云端研究工具先输出证据表；该插件负责接收，不替代研究。通过可信宿主 `workflow.importHistory(rows)` 先载入历史全部筛查/已交付/已联系身份，不仅是最终入选客户。
2. Harness 对话调用 `sales_import_xlsx({filename:"today.xlsx"})`，文件必须位于 importDirectory。或 `sales_import_csv({csv:"..."})`。`examples/workbook-mapping.fsarcan.json` 对应「客户清单 / 研究依据」列名。
3. `sales_status({})` 获取 leadId，`sales_prepare_draft({leadId})` 查看依据；`sales_generate_draft({leadId})` 用配置模型起草。也可用 `sales_set_draft` 保存独立写好的双语文案。导入不等于来源已经在线重新核验。
4. **人工审核**：v1 使用下面的交互式审核台。模型工具没有 approve；不得让模型冒充人工审核。先停止/卸载插件，释放状态锁；在你信任的终端运行：
   ```bash
   node src/review.js /your/cloud-data/sales-state /your/config.json LEAD_ID
   ```
   屏幕展示客户证据、完整主题、英文、中文与 hash；人工输入审核人、精确邮箱和 `APPROVE <hash>`。不可管道输入。取消不会批准；审核本身不会发信。随后重新启动插件，默认仍暂停。
5. Harness 调用 `sales_enqueue({leadId})`。明确下达执行指令后调用 `sales_start_queue({notBefore:"2026-12-01T09:00:00+08:00"})`，`notBefore` 是可选的带时区 ISO 时间，表示最早开始时间。省略时按现有队列的限制尽早开始。固定程序只处理本次启动时已经入队的批准版本，遵守单封间隔和分组暂停。用 `sales_queue_runner_status` 查看进度。进程重启保持暂停，恢复时仍应用已保存的最早时间。
6. `sales_pause` 立即暂停并请求取消当前操作；不能保证撤回已被邮箱接受的信。`sales_cancel({sendId})` 只能取消未执行项。未知结果用 `sales_reconcile({sendId})`；确认没发过之后仍需显式重新入队。
7. 已发送回执先写入台账。支持清理的适配器只将已绑定并核实过的原草稿移入废纸篓。邮箱已自动移除时记录草稿已不存在。清理结果不明时保留已发送状态，等待复核。
8. 明确退订或硬退信用 `sales_suppress({recipient,reason})`。新人工回复或含糊拒绝触发发送前 hold，不能继续盲发。

### 表格字段

每条有效线索必须有 `company, website, email, need, sourceUrl, sourceDate, evidence`。email 必须是完整单邮箱并出现在 evidence 中；这是结构检查，不是 SMTP 投递验证。证据日期 ISO `YYYY-MM-DD`。新客户 `newness` 默认为 provisional；仅经完整历史核验的可信输入可写 verified。插件不会自行把中文“部分排重”转换成 verified。

`inference`、`unknowns` 与事实分开。中文常见列已支持；XLSX 的 `columns` / `evidenceColumns` 可按产品、国家和表格结构配置。多条来源保存于 `raw.sourceUrlAll/sourceDateAll/joinedEvidenceRows`，展示主来源取首条，不把多个 URL 拼成伪链接。

回复模式显式提供 `purpose:"reply", inboundContext, threadId, replyToMessageId, threadOwnershipVerified:true`；归属必须人工或可信连接器核实。不得用它绕过陌生首封历史审核。尚无自动 inbox 读取。

### 发送适配器契约

见 [发送适配器契约](docs/adapter-contract.md)。子代理按 [邮箱兼容性只读验收](skills/mailbox-compatibility/SKILL.md) 调用 `sales_mailbox_compatibility({})`，本地模拟控制台也可用 `GET /api/compatibility`。模拟浏览器需先处于可用状态。结果含兼容性、状态、模式、检查时间及可用的检查项。正在执行时可待空闲后重查。程序按控件标识定位，按钮仅换位置仍可识别。控件缺失或含义不明确时，队列在执行前暂停。修复后重新检查，通过后由操作者显式恢复。

### 状态恢复与边界

状态目录应由可信宿主独占，不能给不受信任模型任意文件写权限；TTY 和 host-only API 是操作边界，不是对恶意本地进程的密码学安全边界。没有凭据写入本包。

正常退出移除锁，重启强制暂停。进程崩溃可能留下 `state.lock` 或共享账号锁：先确认原 PID 已退出、没有邮箱操作在进行，人工备份状态，再删除对应陈旧锁；不可自动删除并盲重试。状态中 sending 会转为 unknown。不同工作目录的同账号使用同一 accountLockDirectory（默认同机器临时目录）；跨机器部署需要外部共享锁，不在 v1 支持范围。

`minimumIntervalSeconds` 默认 180 秒，审批有效期默认 24 小时。载入旧 `pacing` 配置时，用原 `maxSeconds` 作为固定间隔，只有 `minSeconds` 时用该值。上线参数应符合接入服务的额度与排程规则。

## 每日研究技能

`skills/research/SKILL.md` 提供产品通用的官方邮箱核验和全历史排重流程。`sales_research_brief({countries:"..."})` 返回研究指令、配置品牌和标准导入字段；可选 `config.researchModel` 仅标记研究路由，工具本身不联网/不调用研究模型。用宿主已有搜索/浏览器执行研究，再导入；不能把 brief 当成完成研究。

## 分批和发送间隔

可调用 `sales_set_batch_plan` 设置明确组合：

```json
{"plan":[{"count":5,"pauseSeconds":120},{"count":3,"pauseSeconds":360},{"count":7,"pauseSeconds":600},{"count":1,"pauseSeconds":480},{"count":23,"pauseSeconds":0}]}
```

每组只使用已批准的原文，达到组内数量后应用该组的暂停时间，最后一组完成时暂停。组内间隔可另配 `batchInterMessageSeconds`。组间和组内配置都只能延长 `minimumIntervalSeconds`。更改计划会暂停，需显式恢复。发送结果不明确时先核对回执。

正式 CLI 插件入口示例：编辑 `examples/plugin.patch.yml` 绝对路径与配置后，用 `dsh web --patch /absolute/path/plugin.patch.yml`。该入口已在官方运行时独立验收启动；具体模型和真实邮箱仍需另行配置与验证。

用户后续已明确研究、学习与发送步骤，因此原对话导出不是开发的前置阻碍；历史原文仍标为未取得，不能声称已经逐句复刻。

XLSX 可在插件顶层配置 `pythonExecutable` 指向已安装 Python 可执行文件；默认 Windows 用 `python`，其他平台用 `python3`。通过无 shell 的参数数组执行，不插入 shell 命令。`openpyxl` 是额外前提，并非 Harness 保证自带。

## 先学 100 个来源，再按客户表写信

本节仅适用于上游选择 `hundred-source-playbook` 的学习路线；新行业模板使用 `product-evidence-review`，见 [写稿策略](docs/drafting-policy.md)。不预填虚假的“已学习100篇”。学习台账接收真实读过的文章/视频来源、阅读证据、摘要和提炼原则，去重 URL；仅 URL 清单不计作读完。选择学习路线时，先审核100个不同来源及可追溯 playbook，再由人工批准；该路线的正式 `generate_draft / set_draft` 在此之前停止。

经过批准的 playbook 与客户的需求事实、痛点推断、未知项、来源和原询盘共同进入起草提示词。开发信批准后，固定程序按批准版本执行。具备只读权限的子代理负责检查程序和界面兼容性、报告异常。

安装配置也可跨平台生成：

```bash
node examples/create-patch.js plugin.patch.yml /path/state /path/imports /path/config.json
```

输出 JSON 形式的 YAML（YAML 1.2 子集），能正确转义 Windows 路径；实际依赖安装位置仍由用户提供。

## 通用行业研究：主工作流

在 `config.research` 设置 `industry, products, buyerTypes, regions, exclusions`。可以是家具、服装、工业零件或其他产品，不限仿真花。

1. `sales_research_brief({})` 获取明确行业/地区/采购者/排除条件。
2. `sales_research_history({identityJson: "{...}"})` 逐条载入全部历史身份；支持 company、website/domains、aliases、group/groups、reason、batch。随后停宿主，在审核台运行 `node src/review.js STATE_DIR CONFIG_JSON HISTORY`；只有确实完整时人工确认。索引不完整时筛查结果只能 provisional。
3. 用宿主搜索/浏览器进行实际研究，`sales_research_record({recordJson:"{...}"})` 录入。要求 `relevant:true, emailVerification:"published"`，并有 `officialSources` 数组分别包含邮箱及需求证据：每项 `kind:"email"|"need", url, date, official:true, ownershipEvidence, readEvidence, text`。这些是结构化阅读记录，不是自动验证网页。
4. `sales_research_status` 看 qualified/provisional/rejected；所有筛查身份进入历史索引，未入选者不重新计为新客户。`sales_research_export` 返回 csv/json；`sales_research_export_xlsx({filename:"today.xlsx"})` 在配置的 exportDirectory 输出并重新打开验证6表工作簿。
5. `sales_research_handoff({})` 将合格/待补历史的线索交给写信流程；重复或导入失败明确标为 handoff_blocked，不伪称已移交。入选数量不等于已联系数量。

详见 `docs/research-workflow.md`。人工确认完整历史后，旧 provisional 不会自动升级；需补证与重新审核，而不能将历史不全抹掉。

### 学习来源的真实录入与审批

- `sales_learning_record({sourceJson:"{...}"})`：字段含 url、title、type（article/video）。读完填 `status:"verified-read", readDate, readEvidence, summary, principles`；视频额外 `transcriptOrViewingEvidence`。未读记录保留为 unreviewed。
- `sales_learning_update({url,reviewJson:"{...}"})` 补入阅读证据，不重复计数。
- `sales_learning_compile({})` 给出发现数、实际记录为读完数、缺口和逐条可追溯原则。
- 达到100后，停宿主，在审核台执行 `node src/review.js STATE_DIR CONFIG_JSON PLAYBOOK`，人工核对真实来源和摘要并批准 hash。通过后重启再写信。

初始学习台账为0。测试里的100条合成记录只能证明计数/审核逻辑，不能算真实学习成果。
