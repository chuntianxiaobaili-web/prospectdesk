---
name: prospectdesk-review
display_name: ProspectDesk 客户开发审阅
display_name_en: ProspectDesk Outreach Review
description: 研究 B2B 客户、撰写个性化双语开发信审阅稿，并在已连接的只读工具中检查邮箱兼容性。
description_zh: 客户研究、双语审阅稿和只读邮箱核对。
description_en: Research business prospects, draft bilingual outreach for review, and check mailbox compatibility.
examples_zh:
  - "按我提供的行业与产品资料研究这 5 家公司"
  - "给这些候选客户写中英文首封开发信审阅稿"
  - "只读检查 ProspectDesk 邮箱连接是否可用"
examples_en:
  - "Research five prospects using my product brief"
  - "Draft bilingual first-contact messages for review"
  - "Check the read-only ProspectDesk mailbox connection"
version: 0.6.3
author: ProspectDesk
---

# ProspectDesk 客户开发审阅

## 客户研究与写稿

1. 读取用户给定的行业、产品或服务资料、目标市场与历史联系记录，记录资料覆盖范围。每家公司以已核实的事实为依据，注明具体证据链接和采集日期。对外联络字段只用经核实的公开业务联系方式。
2. 同一公司、域名、联系方式和已有联系记录进行排重。事实、身份或历史记录不齐时，标注缺项。拒绝、退订或有既有往来的公司保留记录，并排除出首封队列。
3. 每家只选一个可核实事实和一个相符的供货或服务建议。主题、正文和结尾各有明确用途。结尾只留一个容易回复的问题。交付完整英文稿和事实一致的中文审阅稿，分列写作依据、来源和审核状态。
4. 逐封核对客户事实、卖方承诺和中英文含义。把公司名换成同行仍然通用时，重新选择依据；纠正前保留在待审核区。

## 邮箱只读核对

先用 `sales_browser_mail_status` 核对接入。用户要求检查已配置邮箱时，再调用 `sales_browser_mail_compatibility`。首次可能打开专用 Chrome 窗口，在浏览器内由用户登录邮箱。

如果客户端已明确启用了 `sales_browser_mail_inspect_draft`，并且用户要核对一封已知草稿，使用准确的草稿 ID、已知收件人及主题核对。该工具返回核对摘要，不返回正文。遇到身份不符、邮件内容变化或连接故障，记录问题并停止这次邮箱检查。

此工作流交付研究、文案和邮箱检查结果。所有文案保留为审阅稿，连接器只注册只读工具。
