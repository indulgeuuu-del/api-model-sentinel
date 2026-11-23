# Contributing

Small, reproducible changes are welcome. Include the problem, expected behavior and a redacted reproduction. Never attach credentials or your data directory.

## Local checks

```sh
npm ci
npx playwright install chromium
npm run verify
npm run package
```

`npm run format` applies formatting. Core tests use Node's test runner; browser tests use real loopback servers and Playwright. No live API key is needed. CI includes Node22/24 on Windows, Ubuntu and macOS. Keep new runtime dependencies exceptional and justify their cost.

## Behavior contracts

- Preserve the original candy prompt/version and selected answer21. Version generated probes whenever their meaning or oracle changes.
- Correctness, availability and cost are distinct. Do not turn a budget warning into a failed answer.
- No automatic retry, budget escalation, protocol fallback or extra judge-model call.
- Timeouts/errors/incomplete answers keep the schedule enabled. Only a completed wrong answer from an enabled automatic run may trigger protection.
- Cancellation and storage failure must not start more provider work. Interrupted jobs are not replayed after a crash.
- Guard changes need fake-adapter regression coverage and an explicit compatibility statement. Live interruption tests require disposable, intentionally created work.
- Keep secrets out of APIs, logs, screenshots, fixtures, issues and release archives. Package from the allowlist, never from the user's working folder wholesale.

For a new probe, supply an independent expected-answer check. For a protocol fix, add a minimized response fixture. For UI changes, check keyboard use, small screens and browser console errors.

## Release

Update package versions/lockfile and CHANGELOG, verify CI onmain, then push a matching `vX.Y.Z` tag. The release workflow re-runs validation, builds a ZIP and SHA-256, and publishes GitHub release assets. The package is intentionally private in package.json to prevent accidental npm publication; source and GitHub releases remain public under MIT.
