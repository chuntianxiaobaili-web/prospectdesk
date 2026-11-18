# 浏览器连接与固定会话

v0.4 新增三浏览器连接对象与独立启动入口，见 [三浏览器连接与分开测试](MULTI_BROWSER.zh-CN.md)。下文 v0.3 的原 CUA 注入保留；新路径推荐 browserMail.connection，并独立报告浏览器身份和邮箱页面检查。

v0.3 将原独立浏览器控制器纳入包内 `src/browser-mail/`，默认插件入口真实注册会话工具，并导出 `@fsarcan/harness-sales-workflow/browser-mail`。不调用邮箱 API，不存放密码或登录令牌。

## 两条路线

| 路线 | 入口 | 数据 |
|---|---|---|
| 研究、学习、逐客写稿、人工审批、获批包发送 | 原 sales_research_* / sales_learning_* / sales_enqueue / sales_start_queue | 原核心严格检查的批准快照 |
| 邮箱已有草稿的浏览器测试与发送 | sales_browser_mail_* | 本次明确选定的真实原草稿、发送前快照、历史与回执 |

两条路线共用单机账号锁，保持互斥。新 BrowserMailAdapter 不实现原 mailAdapter 契约，不应直接塞入旧核心。原核心没有自动把内存草稿写进邮箱的功能；新写稿转成真实邮箱草稿仍需宿主真实保存并核对，不能只伪造一个 ID 来交接。

## 宿主接入

由支持 CUA 的宿主明确注入已连接的标签页对象：

```js
import sales from '@fsarcan/harness-sales-workflow';
await ctx.plugin(sales, {
  directory: '/absolute/path/to/private-state',
  config: configuredSalesConfig,
  browserMail: { tab: selectedConnectedTab }
});
```

`config.accountId` 为本次精确账号。浏览器对象是运行中的对象，不能放进静态 JSON 配置。宿主必须提供适配器使用的 getAXState、click、reload、typeText、pressKey 等方法；确切检查结果以兼容性工具返回为准。没有注入时工具报告未连接，不自动选择其他浏览器或账户。原 Windows 模拟启动器保留。

| 工具 | 用途 |
|---|---|
| sales_browser_mail_compatibility | 当前页面只读兼容性；脱敏结果 |
| sales_browser_mail_prepare | 固定候选与全新日志，不发送、不计时 |
| sales_browser_mail_start | 首次启动一次性工作窗口 |
| sales_browser_mail_step | 在活跃宿主调用内等待执行，最多处理一封 |
| sales_browser_mail_status | 查看状态与统计，不操作页面 |
| sales_browser_mail_stop | 请求中止，保留已发生的结果 |
| sales_browser_mail_finish | 若仍运行则先停止，再只读核对总数并归档、释放账号锁 |

prepare参数：`target`、`workDuration`或`durationMs`、`intervalMs`、`prepareAheadMs`，以及JSON字符串 `preparedRefsJson`、`excludeDraftIdsJson`、`approvedPermanentDraftIdsJson`。数量默认50、固定间隔默认72000毫秒、提前只读准备默认60000毫秒；数量范围1–10000且受本轮确切引用限制。工作时长默认null，即无时间截止；明确“1小时”则3600000毫秒，“5小时”则18000000毫秒。workDuration只接受单一时长字段，不把“8小时后提醒”当工作时长；若同时给durationMs，两者必须一致。草稿引用包含 accountId、draftId、recipient、subject 和实际页面识别的属性；原文与版本每封发送前重新读取。所有示例只用合成数据，真实引用从当前页面获得。

参数下发应对应用户本次具体范围。旧会话必须停止并完成 finish 后才能准备新会话。每次新日志独占创建，不覆盖旧日志，永久删除授权默认重新置空。

## 执行宿主与截止

CUA 操作必须处于被明确 await 的活跃工具调用中。start按本次可选时长启动截止计时器，不会创建脱离宿主的后台发件服务。宿主按 status.waitMs 等待，然后明确 await 每次 step；不得把 Promise 留在后台后退出调用。同一标签页由本次会话独占。

显式工作窗口从首次start开始；未设时限则没有截止计时器。数量目标和本次固定草稿队列仍各自生效。重复启动不延长截止，提前准备只节省只读步骤耗时，不缩短发送最短间隔。落后不集中补发。目标 50 是上限和努力目标，重复、等待、异常或耗时可导致实际少于 50。

服务在 prepare 前获取与旧核心相同的账号锁，串行管理准备、兼容性、step、finish；stop 只请求停止，会话仍保留账号锁；待在途工作结算后调用 finish，才会释放自己持有的锁；卸载会主动等待在途工作结算后释放。到点后不开始新发送或删除。截止前已开始动作可以只读核实结果，待清理草稿留存。进程关闭不会自动重启旧任务。

## 回执、清理、统计

发送动作前重新核对账号、唯一收件人、主题、全文和原草稿 ID/版本；查找历史相关邮件并排除重复，旧发送记录不是本次成功回执。新回执必须匹配收件人、正文及新的消息 ID，先落盘，再处理对应原草稿。原核心台账的邮箱或域名抑制记录也在新路线生效；记录退订会立即停止当前浏览器会话。

邮箱已自动消耗原草稿时，通过完整限定搜索核对缺失，记为 provider_consumed。当前中文页面的残留草稿删除实际为永久删除；按钮提示提到回收站也不能作为可恢复证据。只有本次 `approvedPermanentDraftIds` 明确包括该准确原草稿 ID 且已确认发送后才执行，随后重新核对消失，记为 permanent_draft_delete。未确认发送或版本改变的草稿保留。

发送未知不自动重试。清理失败保持已发送，另记 cleanupPending。故障恢复工具保留在包内，须严格核对原日志与证据后由宿主使用，没有模型可直接调用的自动恢复工具。

统计区分 sent、cleaned、skipped、unknown、cleanupPending、pending、remainingPlanned，以及 initialMailboxCount / finalMailboxCount。最终邮箱总数来自当前页面“文件夹详情”的“邮件总数”；读取失败标未知，不用侧栏未读数或减法代替。

## 已验证范围

当前有中文企业邮箱和中文 Gmail 两项独立页面配置；现场结果见本版本验收记录。其他企业自建邮箱需独立页面适配及相同回执、草稿绑定和删除验收。通用的是会话管理、固定排程、截止、锁与日志，不代表所有邮箱页面已兼容。

此前独立版本现场一小时结果为发送 30、确认清理 29、邮箱草稿 556→527；最后一封发送在截止前开始，清理留待处理。该记录证明当时操作结果，不代表 v0.3 整包已经完成真实 50 封验收。该条属于早期独立版记录；当前版本另行记录真实验收，工程单元测试使用合成数据。

## 连续8小时提醒

仅持续running状态满8小时产生一次提醒；暂停／恢复重新计算连续时间，已发出提醒的同一run不重复。onRuntimeReminder回调实际显示成功才记delivered。缺少回调时status.runtimeReminder保留unconfigured，活跃代理需向当前用户显示一次，再以notificationId调用sales_browser_mail_ack_runtime_reminder；同ID确认幂等。提醒不会暂停、延长deadline或新增收件人。进程关闭不等于后台持续工作，当前恢复仍只支持同一存活实例。

## Gmail页面配置

显式browserMail.mailProfile设为chinese-gmail-ui，连接固定的Chrome／Edge标签页与账号。使用Gmail独立适配器、保存器和兼容检查。原草稿由可见data-legacy-standalone-draft-id识别，打开后绑定本次实际compose token；不推算编码关系。展开可见地址栏核对真实From与收件人，逐字核对主题和完整正文。

已发送回执必须是新的可见legacy message ID，匹配实际详情里的发件人／收件人／主题及消息正文。旧消息仅用于历史排除或页面验证。原草稿缺失须全草稿列表完整查找准确稳定ID；修改主题或收件人的残稿不会被误算自动移除。发送提示本身不算回执，保留已发送邮件。

## 页面等待与原运行恢复

企业邮箱页面重新载入后，最多用30秒的新鲜页面读取等待原有完整条件；不会把等待超时当作已发送或已清理。发送结果的显式确认窗口仍为15秒。

恢复保留同一存活run、已发回执、数量、原起止及下一可发时间。resumeUnattempted只恢复没有发送意图的准备错误；reconcileCleanupAndResume只读核对已发原稿已消失；retryApprovedCleanupAndResume用于本轮明确批准后的首次残稿删除；retryPreviouslyApprovedUnattemptedCleanupAndResume仅处理已有准确授权且未产生清理意图的页面就绪故障。未知的发送结果和已派发但未知的清理不自动重试。reconcileSentAndCleanupAndResume只读重核唯一未知发送或待核对的已发原稿：新回执先记账，再查完整草稿列表中的准确稳定ID；provider_consumed缺失证据通过才恢复。该入口不发送或删除，截止后仍可只读记账但保持停止。

Gmail地址展开使用已观察的唯一可见撰写地址控件；宿主需提供文档化的语义页面点击能力。地址展开仍处于账号独占与原文批准检查内。Gmail正文输入使用明文粘贴并逐字读回，不通过折叠空行掩盖输入差异。Gmail自行附加的文字方向和Google链接跳转元数据只在该页面配置校验，实际链接地址与显示内容仍须一致。
