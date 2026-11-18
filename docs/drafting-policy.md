# 写稿策略与逐封审核

本包支持两种明确的写稿策略。新行业配置模板显式使用 `product-evidence-review`，先补齐实际产品资料再逐封审核。已有配置未填写策略时继续保留原来的 `hundred-source-playbook` 行为；需要切换时，设置 `config.draftingPolicy.mode = 'product-evidence-review'`，再重新保存并审核稿件。

## 产品证据模式

该模式不要求先完成100个教学来源，也不生成虚假的学习或手册批准记录。它要求品牌的实际已核对事实与来源完整，然后允许外部已经写好的稿件通过 `sales_set_draft` 保存。配置了真实模型路由时，也可用原 `generate_draft`；手动导入文案本身不调用模型。

```json
{
  "draftingPolicy": {"mode": "product-evidence-review"},
  "brand": {
    "name": "Synthetic Flowers",
    "products": ["artificial flowers"],
    "verifiedFacts": ["Offers artificial flowers and foliage"],
    "evidenceSources": [{
      "path": "C:/synthetic/product-catalog.pdf",
      "checkedAt": "2026-11-18",
      "readEvidence": "Synthetic product section read",
      "locator": "page 3"
    }],
    "unknowns": ["MOQ", "current stock", "lead time"]
  }
}
```

以上是合成格式示例。实际资料应提供绝对本地路径或公开HTTP(S)网址、非空读取证据与有效ISO日期；可用 locator 补页码、单元格或具体章节。verifiedFacts 必须为非空字符串数组。程序检查的是记录结构，不代表程序独立读过文件或核实了事实。操作者须先读实际产品资料、官网与冲突项，再填写。

每封草稿保存 `draftingPolicy.mode`、`basisHash` 和 `basis`。basis 包含当时品牌、产品、已核对事实、来源及未知项；它与文案一起进入稿件hash。审核界面可以读取完整快照，事实口径不再只依赖可能已变化的当前配置。

产品资料、来源读取日期、未知项、品牌产品或写稿策略变更后，原草稿的依据不再匹配。批准、入队、发送前以及邮箱preflight返回后都会再次核对；不匹配时停止，需重新保存文案并逐封审核。模型生成期间依据改变，同样要求重新生成，不把旧提示词的结果绑定到新事实。

此比较以本次配置中核对过的快照为准，不自动监控本地原文件或官网的后来变动。重新读取来源后应更新事实/来源记录，使新依据进入新稿版本。

## 原学习手册模式

默认策略保留100个真实阅读来源、可追溯摘要原则以及手册人工批准的要求。仅发现URL、标题、搜索摘要或存在旧素材库都不等于已完成。显式使用产品证据模式不会改变该模式的学习台账，也不能报告100来源已完成。

## 两种模式共同要求

每封文案必须有主题、英文和中文审阅稿。收件人、原文、版本hash和人工审核须一致；修改正文会撤销原批准。新客户的历史核对、回复线程归属、退订/停联、审批有效期、账号绑定和单邮箱串行要求继续生效。

产品证据模式只改变文案准备依据，不批准收件人、不填补历史覆盖缺口，也不启动发送。当前仍没有由模型直接调用的approve工具；保留原可信宿主或人工审核台入口。浏览器保存草稿、发送回执与原草稿清理仍须各自真实核对。
