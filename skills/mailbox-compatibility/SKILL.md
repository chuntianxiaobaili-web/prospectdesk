---
name: mailbox-compatibility
description: Run read-only mailbox compatibility checks after browser, mailbox or adapter changes; report sanitized findings without controlling sending.
---

# 邮箱兼容性只读验收

子代理核对程序依赖的页面控件及版本变化。输入为适配器版本、执行环境和脱敏结果，正常发件由固定程序负责。

1. 现有草稿浏览器路线调用 `sales_browser_mail_compatibility({})`；原获批数据包路线调用 `sales_mailbox_compatibility({})`。本地模拟控制台另有 `GET /api/compatibility`，其结果只代表模拟页面。
2. 新路线只读取所选标签页，核对连接接口、账号、草稿/已发送/搜索控件；若未打开编辑页，发送和正文控件标为尚未完整检查，实际每封 preflight 和发送前重读继续验证。
3. 报告 compatible、status、mode、checkedAt 和 checks，不返回页面原文、邮箱正文或客户名单。忙碌时等待同账号操作结算后重查。
4. 控件缺失、重复、账号改变或页面未就绪时记录原因，交给操作者处理。修复完成后按相同入口再检查；只读验收不会启动或恢复队列。
5. 子代理只负责验收与报告。发送、删除、改稿、队列启停和恢复由操作者授权的固定程序执行。

新接口见 [浏览器会话](../../docs/browser-mail-session.md)，原接口见 [数据包适配器](../../docs/adapter-contract.md)。

新连接路径另核对 connectionChecks 与 mailboxChecks：浏览器/目标/版本身份通过，不代表草稿、编辑页和回执全部通过。三浏览器分别记录结果；legacy_unverified 不算 Edge、Chrome 或 Yandex 的身份通过。
