---
name: browser-mail-session
description: Operate a user-duration or unbounded browser session for existing mailbox drafts, with sent-history checks, exact sent receipts and verified original-draft cleanup. Use when the user asks to test or send existing drafts through a connected browser.
---

# 现有草稿浏览器会话

通过包内固定程序执行已选定草稿。研究、文案和人工批准数据包仍走原流程；此入口不生成、修改或补造这些记录。

## 准备

1. 读取 [会话接口](../../docs/browser-mail-session.md) 和 [三浏览器说明](../../docs/MULTI_BROWSER.zh-CN.md)。明确用户选择 Edge、Chrome 或 Yandex，使用对应连接入口并固定实际浏览器/目标身份；宿主把 connection 与固定 config.accountId 传入。原 tab 注入可保留，但 legacy_unverified 不算某一浏览器已通过身份验收。缺少连接时报告连接条件。
2. 调用 `sales_browser_mail_compatibility({})`。子代理只检查脱敏兼容性结果和测试结果；它不点击发送、不改收件人，也不负责正常发件排程。
3. 明确本次原草稿范围与用户发送指令。优先使用核对后的 `preparedRefsJson`；未提供时只扫描当前可见候选，默认最多 50 封，不宣称已遍历全箱。历史已发、相关往来或检查不完整的条目按程序结果跳过或停止，不为凑数扩大范围。
4. 调用 `sales_browser_mail_prepare`，按用户命令设定可选工作时长、目标和固定最短间隔。workDuration可为“1小时”“5小时”；不填时长或durationMs:null表示无时间截止，绝不默认加一小时。默认数量50、间隔72000毫秒，提前只读准备60000毫秒；显式数量优先，达到目标或队列耗尽结束本批。准备只读、不发邮件、不启动计时。
5. 残留草稿删除在当前页面是永久删除。只有用户对本次具体原草稿范围明确确认后才传 `approvedPermanentDraftIdsJson`，默认空数组。旧任务确认不自动延续；邮箱已自动消耗的原草稿只读核实即可。

## 执行与报告

1. 已有本次发送指令且准备完成后调用一次 `sales_browser_mail_start({})`。重复 start 不延长窗口。
2. 在活跃的宿主调用中明确等待 `sales_browser_mail_step({})`，每次最多一封；按 status 的 waitMs 等待后继续。不要发起后台 Promise 后退出工具调用，不并行操作标签页，不用旧 `sales_start_queue` 驱动新会话。
3. 程序每封重读原草稿和历史，在实际发送前再次核对正文、账号和控件，保存意图后点击。只把新的、精确匹配的已发送回执计为成功。结果不明停止，保留原草稿，不重发。
4. 回执落盘后核对并清理对应原草稿。清理失败保持“已发送”，不把它重新加入发送队列。到点后不再开始发送或删除；截止前已发起的操作可继续只读核实。
5. 用户暂停用 `sales_browser_mail_stop` 或全局 `sales_pause`。停止后等待在途操作结算。结束时调用 `sales_browser_mail_finish({})` 读取草稿总数和归档结果，再报告实际发送、清理、剩余待发送、待清理、结果不明、邮箱最终草稿总数及统计来源。
6. 工具异常保留原日志和截止。恢复功能仅供宿主严格核对后显式使用，不以新建会话延长旧任务，不自动复用日志。

完整验收按 [测试步骤](../../docs/FULL_ACCEPTANCE.zh-CN.md)；本地模拟通过与真实完整流程通过分别报告。

## 分浏览器验收

每种浏览器单独准备、运行、归档和报告；前一任务完成 finish 并释放账号锁后才开始下一项。每轮重新查历史，已发送草稿不再次发送以凑三个浏览器的测试量。分别记录连接、页面兼容、本地合成测试、真实发送全链路状态；尚未实测的项标未测。

## 从产品资料生成的新稿

先按用户选择使用真实学习手册或产品证据模式，保存双语稿并逐封审核。只有当前人工批准、历史核对和退订条件齐全的稿件才调用 sales_browser_mail_save_approved_draft({leadId,expectedCoreHash})。该工具只保存草稿；确认新 ID 和全文读回后，调用 sales_browser_mail_prepare_approved_drafts 选择这些 leadIds，随后 start/step。不得把核心批准摘要手填到普通 preparedRefs 来代替交接证明。详见 [新稿交接](../../docs/APPROVED_DRAFT_FLOW.zh-CN.md)。

## 工作期间的提醒

不发送例行中途汇报；异常、需要用户操作及任务完成仍据实说明。连续运行8小时，宿主onRuntimeReminder应显示一次工作时长提醒并继续；若status.runtimeReminder为unconfigured且notificationId已产生，活跃代理实际提醒当前用户后调用sales_browser_mail_ack_runtime_reminder({notificationId})，不把日志事件伪称已提醒，不用另建automation。暂停／恢复重新计算连续时间，同run已通知不重复。

## 邮箱页面选择

浏览器品牌不代表邮箱提供商。企业邮箱默认使用已有页面配置；Gmail显式mailProfile:chinese-gmail-ui，使用独立Gmail adapter/writer/checker。固定本轮账号、具体原ID和准确批准版本。未知页面／不完整搜索／新回执不明时停止；不以模拟结果替代实发验收。
