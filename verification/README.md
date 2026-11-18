# Optional official-runtime verification

See `../docs/TEST_RESULTS.zh-CN.md` for exact commands and limits. Synthetic fixtures only. Set `HARNESS_NODE_MODULES` to the node_modules directory containing the official Harness installation, or use normal Node dependency resolution. `DSH_BIN` may override the CLI executable for `cli-smoke.py`.

These scripts intentionally live outside `test/`: normal `npm test` does not require Harness services. No runtime home, saved workflow state, real learning corpus, authentication tokens, or customer records are included here.

## v0.2 local browser checks (no real browser launched)

Run `node verification/local-browser-qa.mjs`, `node verification/local-app-qa.mjs`, and `node verification/windows-script-qa.mjs`. The browser cases inject synthetic drivers. The local app test uses a real loopback HTTP server with a synthetic browser driver. Windows checks are text assertions only, not Windows execution. See `docs/TEST_RESULTS_V02.zh-CN.md` for the cloud Chromium startup blocker and remaining acceptance work.

## v0.3 browser-session integration

Run `npm test` for the original core plus browser adapter/runner/host/recovery, service lifecycle and registered plugin-tool integration. These checks use synthetic data and do not open a real mailbox. `npm run check` validates entrypoint syntax. See `../docs/TEST_RESULTS_V03.zh-CN.md` and `../docs/FULL_ACCEPTANCE.zh-CN.md` for the verified result and remaining live acceptance.

## v0.4 separate installed-browser checks

Run `node verification/browser-connection-smoke.mjs edge|chrome|yandex ABSOLUTE_TEST_DIRECTORY [BROWSER_EXECUTABLE]` separately for each browser. This uses only a locally generated synthetic HTML page, an application-owned profile, and no mailbox. The executable is required for Yandex and can explicitly select the verified Edge/Chrome installation. Results are saved under the supplied test directory. See `../docs/TEST_RESULTS_V04.zh-CN.md` for the actual results and `../docs/MULTI_BROWSER.zh-CN.md` for live acceptance still pending.
