# 测试结果与可用边界

测试日期：2026-10-23。环境：dot 云端 Linux、Node.js 24.19.0、官方 `@deepseek-ai/dsh@0.2.1-rc.2`、Python/openpyxl。

## 已通过

- **34 项模块测试全部通过**：历史公司/域名/集团/别名排重、完整邮箱证据、XLSX 导入导出、审批与有效期、暂停、取消、丢失回执核对、账户互斥、运行中关闭等待等。
- **官方 CLI 加载**：通过 `dsh web --patch <本地补丁>` 加载实际插件，创建状态文件，认证后的两次 HTTP 请求均为 200；不是只测试模拟 Context。
- **26 个工具注册**：使用真实 Cordis、官方 Tools 与 LlmRuntime。实际草稿适配器经合成 LlmAdapter 流调用一次；未配置学习手册时拒绝生产草稿且不调用模型。
- **研究/学习工具集成**：119 次真实工具分发。学习计数初始为 0；未读链接不计数，规范化 URL 去重；100 条合成阅读证据验证门槛，重启后状态保留。已拒绝的研究企业、历史别名不能通过直接 CSV 导入重新计入。合格研究记录可以正常交接。
- **Excel**：六个工作表可重新打开，合格/暂定/拒绝记录与证据、历史分别保存；规范导出可以重新导入。
- **自动队列**：正式 `sales_start_queue` 工具可启动 QueueRunner；测试用可控计时器和模拟邮箱，队列结束自动停止。
- **分批节奏**：5 封后等 120 秒、3 封后等 360 秒、再 2 封完成；等待边界和两次重启恢复通过，10 封模拟邮件无重复。

## 明确未完成的生产验收

- 测试中的 100 条来源是明确标记的**合成测试数据**，不是已经阅读了 100 篇真实文章/视频；真实学习进度不得据此增加。生产初始进度为 0。
- 尚未安装、验证真实邮箱的浏览器发送适配器；不代表任何邮箱都已兼容。全部发送回执均为 `mode: mock`，真实客户邮件发送数为 0。
- 未调用付费模型，未验证特定供应商或 `5.6sol` 路由可用性。执行模型字段交给邮箱适配器使用，不等于已经实际调用该模型。
- 行业研究模块生成研究要求并管理证据，不会自行证明网页内容真实或邮箱可投递；仍需授权搜索/浏览工具完成实际资料核实。
- 已验证的是同一执行环境的 CLI/HTTP 前端，不是完整 CUA 图形界面验收。云端不同执行会话可处于不同网络命名空间，跨会话 localhost 拒绝连接不等于 Harness 本身启动失败。
- 本版是本地源码插件，不是已经发布到公共 npm 或插件商店的产品。

## 复现

常规模块测试：

```sh
npm test
```

附带的 `verification/` 是可选官方运行时集成验证，不会随 `npm test` 自动运行。需要自行安装上述官方 Harness 版本；XLSX 测试需要 Python/openpyxl。以下路径请替换为实际安装目录，勿把示例当成真实已配置的模型或邮箱：

```sh
export HARNESS_NODE_MODULES="/absolute/path/to/harness/node_modules"
node verification/plugin-llm-integration.mjs
node verification/research-tools-integration.mjs
node verification/plugin-runner-integration.mjs
node verification/batch-cadence.mjs
node verification/workflow-regression.mjs
python3 verification/cli-smoke.py
```

`HARNESS_NODE_MODULES` 指向含 `@deepseek-ai` 的 node_modules；也可让 Node 从常规依赖路径解析。CLI 检查可用 `DSH_BIN` 指定 `dsh` 可执行文件。脚本以临时目录运行并清理测试状态；不会携带或加载生产凭据，不调用真实模型或邮箱。上述可复现命令在 Linux 云端通过，Windows 命令行环境未单独验收。
