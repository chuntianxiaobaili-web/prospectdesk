# Local dedicated-browser edition v0.2

> v0.3 路线说明：本文保留原专用模拟浏览器流程。接入现有 Edge 邮箱标签页、1 小时截止与真实草稿测试，请使用 [浏览器会话入口](browser-mail-session.md)。

## Scope and evidence

The v0.1 native Harness research/learning/drafting/approval/queue tools remain intact. Five additional native tools control a dedicated browser lifecycle. A separate loopback companion provides a **synthetic mock-mailbox demonstration**, not a replacement Harness runtime and not a Gmail/Zoho/Outlook adapter.

Playwright is pinned to 1.64.1 in package-lock.json. Browser lifecycle uses `chromium.launchPersistentContext(derivedProfile, options)` with `chromiumSandbox:true` and no custom launch args, external CDP endpoint or default-profile attachment. `chromium`, installed `chrome` and installed `msedge` are supported selection values; browser selection is not a compatibility guarantee for every machine or mailbox.

Official references consulted 2026-10-23:
- [Persistent contexts and user-data restrictions](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
- [Browser channels and installation](https://playwright.dev/docs/browsers)
- [Microsoft Edge Playwright documentation](https://learn.microsoft.com/en-us/microsoft-edge/playwright/)

## State and profile

`DATA_DIR/browser-profiles/<channel>` is derived, never an arbitrary user-supplied browser profile. Known default-profile trees, mixed Windows separators/case, symlink/junction ancestry, unowned preexisting profile directories and duplicate controller locks are rejected. Windows scripts validate before creating directories/downloading. Profile/session files remain local; they are not packed or uploaded.

Launch starts paused. `resumeAutomation` is host-controlled in the mock UI, not exposed as a native model tool. Each `runAutomation` owns one abort signal and no parallel browser actions. Pause aborts actions and pauses queue. Manual takeover waits for the action to settle; it does not auto-resume. Close or unexpected context loss pauses the owner; the lock is retained until outstanding actions settle. Restart is paused. Stale locks are not automatically removed.

## Loopback companion

The companion binds only `127.0.0.1` with an ephemeral HTTP port. This is a local application UI port, **not a browser debugging port**. Mutations require exact Host, same Origin, JSON, per-process random token, and reject cross-site fetch metadata. No CORS wildcard; responses deny framing and disable caching. Token lives only in process/served UI, not a CLI argument or delivered example file.

The UI may create synthetic `.test` prospects, display exact drafts, require the operator to type recipient/hash/reviewer, enqueue, run, pause or take over. A read-only `GET /api/compatibility` checks the owned mock mailbox when the dedicated browser is ready and returns a sanitized result for an audit subagent. The fixed queue executor dispatches approved packets. The adapter checks mailbox identity and uniquely identified controls before filling or clicking, then reconciles against persisted mock receipts. Native generic research and learning remain in Harness with the 100-source playbook gate.

Generate an optional real Harness patch with `examples/create-local-patch.js`; do not run companion and Harness against the same profile simultaneously. The dedicated profile lock prevents it. Neither mode includes a live mailbox adapter.

## Validation limits

Cloud Chromium startup was denied by the environment at `socket(): Operation not permitted`; it was not retried using sandbox/security downgrades. Tests use an explicitly injected fake Playwright driver and synthetic DOM fixture. They prove lifecycle contracts, packet preservation and failure handling, **not a successful real browser session**. Windows scripts were reviewed statically; no Windows computer was controlled or used for testing. Real browser/Windows/provider end-to-end verification remains pending.
