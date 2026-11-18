# 三浏览器连接与分开测试

v0.4 使用同一套发送、截止、回执和清理核心，提供 Edge、Google Chrome、Yandex 三个独立连接入口。Google 按 Google Chrome 处理。浏览器身份与邮箱页面配置分别验证。

| 浏览器 | 专用启动方式 | 配置 | Windows 入口 |
|---|---|---|---|
| Edge | 已安装 Microsoft Edge，固定品牌 | examples/browser-edge.json | windows/open-mail-edge.ps1 |
| Chrome | 已安装 Google Chrome，固定品牌 | examples/browser-chrome.json | windows/open-mail-chrome.ps1 |
| Yandex | 明确的 Yandex browser.exe，本机控制连接 | examples/browser-yandex.json | windows/open-mail-yandex.ps1 |

三个入口固定自己的浏览器，身份不符就停止，不改选另一个浏览器。Yandex 单独处理连接方式，发送核心共用。

## 连接现有标签页或打开专用窗口

v0.3 的 CUA 标签页注入继续保留，状态标明 legacy_unverified；它不自动取得某个浏览器品牌的验收结果。推荐通过新连接对象绑定实际浏览器及标签页：

```js
import {connectChrome} from '@fsarcan/harness-sales-workflow/browser-mail/chrome';
const connection = await connectChrome({
  mode: 'launch',
  dataDirectory: 'C:/BusinessMailController',
  headless: false
});
// 由用户在此专用窗口登录；宿主将 connection 传给插件。
await ctx.plugin(sales, {...salesOptions, browserMail: {connection}});
```

Edge 用 connectEdge；Yandex 用 connectYandex 并提供已安装程序的绝对 executablePath。默认不复制日常浏览器资料。专用窗口首次使用需登录，后续保留本程序专属资料。

已有 CUA 标签页使用 mode:cua、tab、metadata、verifyIdentity。核验回调必须来自宿主当前实际浏览器清单，返回 identityVerified:true、browserId、targetId、browserVersion；仅手填浏览器名称不算核验。核验时比对原浏览器和原目标，页面换账号另由邮箱检查拦截。关闭连接不关闭外部 CUA 标签页。

专用启动通过已安装浏览器与公开浏览器控制协议操作页面，不接邮箱发送 API。Edge/Chrome 使用 Playwright 固定通道或明确指定的本品牌程序路径；Yandex 使用独立进程和只在本机监听的控制端口。端口从本程序拥有的专用资料目录读取，关闭时仅处理本次启动的进程。

## 三个启动命令

Node.js 与包依赖安装完成后，先检查三个示例配置里的程序路径和专用数据目录，再分别运行：

```text
npm run browser:edge -- --config examples/browser-edge.json
npm run browser:chrome -- --config examples/browser-chrome.json
npm run browser:yandex -- --config examples/browser-yandex.json
```

也可运行对应 Windows 脚本。脚本的 DataDirectory、NodeExecutable、Url 和 BrowserExecutable 可单独指定；三个脚本只查找各自品牌的常见安装位置，随后再次核验实际浏览器身份。三者打开独立资料目录下的窗口，关闭页面或按 Ctrl+C 结束。这些 open 命令只准备连接与人工登录，不发送、删除或启动一小时任务。

只读检查使用 `node src/browser-mail/desktop-cli.mjs probe --config examples/browser-edge.json`；先把示例里的路径改为实际路径。可加 --account 与 --url 检查指定邮箱的页面兼容性。未指定账号时只检查连接与页面可读，不宣称邮箱已验收。

发送仍通过包内 sales_browser_mail_prepare/start/step/finish 顺序。旧 CUA 路线需要活跃工具调用；专用浏览器连接可由持有该连接的 Node 宿主等待执行。open 命令本身不是邮件发送任务。

## 隔离与共用状态

- 浏览器资料分别保存在 dataDirectory/profiles/edge、chrome、yandex，彼此不共用登录资料。
- 运行日志按 browserId 分目录，每个任务记录浏览器、版本、连接方式和目标标识。
- 账号锁仍按邮箱账号共用。同一账号即使在不同浏览器里，也只允许一条发送任务运行。
- 退订记录仍沿用原台账；永久删除授权每个任务重新明确，不跨浏览器或运行继承。
- 页面操作使用当前快照引用。导航或快照刷新后旧引用失效；发送等待后重新检查身份、原文和控件。
- 最终输入前再次检查截止；若此前已有发送意图而最终动作被拦截，保守记录未知并核对，绝不自动补发。

## 分开测试顺序

1. Edge：连接身份 → 本地合成页面读取/输入/点击 → 邮箱只读检查 → 本次草稿发送/回执/清理/截止。
2. Chrome：独立日志，重复相同检查步骤，重新筛选未发送草稿。
3. Yandex：独立日志，重复相同检查步骤，重新筛选未发送草稿。

每次测试结束、在途动作结算并 finish 归档释放账号锁后，再进行下一浏览器测试。不要将同一批已经发送的客户邮件在三个浏览器里各发一次。下一轮根据当前历史筛选，并分别记录实际发送、清理、未发送、待清理与邮箱剩余总数。

连接层通过不等于邮箱完整链路通过。当前邮箱解析仍针对已观察到的中文页面布局，其他邮箱、语言或编辑器结构需要单独验证。unsupported/未完成的页面证据停止处理，不推测原草稿或成功回执。

## 参考接口

实现依据 [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)、[Chrome/Edge 通道](https://playwright.dev/docs/browsers) 与 [Chromium Accessibility 协议](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)。Yandex 的兼容性以本机分开测试结果为准，不将 Chromium 系浏览器视为自动兼容所有页面。
