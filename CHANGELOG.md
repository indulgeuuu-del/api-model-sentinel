# Changelog

## 1.0.1 — 2026-11-23

- Keep randomized comparisons out of fixed-original statistics, including records from earlier releases.
- Count interrupted and internal-error attempts in their active configuration and prevent late cancellations from inflating availability.
- Show provider-reported reasoning/output parameter mismatches as warnings while preserving answer correctness.
- Add opt-in live acceptance with report preflight, per-response durable saves and bounded batches without retries or budget increases.
- Record ten passing live requests for one authorized gpt-6-sol gateway, including its failure to honor requested token/reasoning limits.
- Resolve distribution verification paths from the package version so later releases are checked correctly.

## 1.0.0 — 2026-11-23

- Extracted the original local prototype into a standalone, MIT-licensed project with no runtime packages.
- Added multiple profiles, independent backend schedules, bounded concurrency and crash recovery without replaying uncertain requests.
- Preserved the original candy prompt and answer21; added seeded variants across five dimensions and same-question comparisons.
- Kept16-token/no-reasoning defaults, separated cost warnings from correctness and continued schedules after timeout/provider errors.
- Prevented late cancelled answers from activating desktop protection; made partial/unknown protection outcomes visible.
- Added encrypted atomic state, previous-state backup, write-only provider keys, loopback authentication and safer CSV/JSON exports.
- Added a responsive dashboard, demo mode, Windows launchers, CLI/supervisor, documentation, test matrix and checksummed distribution.
- Marked Codex Desktop interruption experimental. Current inspected Desktop26.1117.4957 lacks the legacy control pipe; capability checks reject enabling it on that build.
