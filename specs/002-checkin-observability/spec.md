---
title: SPEC-002 — Check-in observability (daily heartbeat, webhook check, version, error log)
tags: [spec, sdd, tdd, telegram, observability, heartbeat]
created: 2026-10-22
updated: 2026-10-22
status: approved
---

# SPEC-002 — Check-in observability

Standard: ADR-0004 — TDD + SDD (architecture-docs `docs/architecture/decisions/ADR-0004-tdd-sdd-standard.md`).

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-002 / 1.1 |
| Status | **approved** by the owner 2026-10-22, before any code; implemented (Worker), monitor AC-25 and deploy pending |
| Repository / path | bookchaowalit/life-checkin-worker / `specs/002-checkin-observability/spec.md` |
| Owner (maker) | Claude Code |
| Reviewer (checker) | A fresh Claude reviewer subagent with no maker context. v0.1: changes requested (3 blocking, 8 non-blocking); v0.2: changes requested (2 blocking, 2 non-blocking); all addressed in v0.3 |
| Approver | Owner (bookchaowalit). Implementation starts only after the owner approves this spec and answers the decisions in §7 (lesson DEF-12 of PRJ-LIFE-01) |
| Requirement links | PRJ-LIFE-01 tech-debt TD-005, TD-006; observability gaps OBS-GAP-02..05 (`07b-observability.md`); failure modes FM-03, FM-04, FM-09 (`07c-failure-modes.md`) in architecture-docs `operations/life/evening-checkin/` |
| Related repositories | platform-uptime-worker (one new heartbeat job, AC-25) |
| Main-only | yes (ADR-0004 rule 2, v1.1): red and green commits on `main`, red run local, checker rerun **before** the push, one push per repository |
| Created / approved | 2026-10-22 / 2026-10-22 |

## 1. Problem and intent

- **Problem:** The only automatic signal for the check-in is `GET /health`, which proves the Worker runs but not that the 21:30 prompt went out or that Telegram still delivers replies (KE-04). A failed prompt, a deleted or redirected webhook (FM-03, FM-09) or a crash would be noticed only by the owner, the next morning at best. Log lines carry no version, and Worker logs are visible only in a live `wrangler tail` (no persistence is configured).
- **Outcome:** Every evening, right after the prompt, the Worker checks its own webhook registration and reports one heartbeat to the uptime monitor. A failure alerts in book_noti_bot at once; a run that never happens alerts within about a day. Logs are kept by Cloudflare and every line names the deployed version. An unexpected exception during a reply also tells the owner in the chat.
- **What this closes:** TD-005 / OBS-GAP-02 (prompt send failure) and OBS-GAP-03 (webhook binding) fully; FM-03 and FM-04 detection from "owner only" to automatic; FM-09 **partly** (a changed webhook URL is seen; a leaked token used without `setWebhook`, or a changed `secret_token`, is not); TD-006 / OBS-GAP-04 (version) fully and OBS-GAP-05 (error tracking) **partly**, depending on decision D-1.

## 2. Scope

| In scope | Out of scope (non-goals) |
|---|---|
| After the cron prompt: read `getWebhookInfo`, compare it with the expected registration, POST one heartbeat `checkin-daily` to the monitor | Changing or re-registering the webhook automatically (a mismatch is reported, never "fixed" by the Worker) |
| One new heartbeat job `checkin-daily` (25 h window) in platform-uptime-worker | Sentry or another error-tracking vendor (D-1 option c; a later spec) |
| Workers Logs persistence (`[observability] enabled = true`) if D-1 = (a) | Per-job heartbeat tokens in the monitor (D-2 option b; a separate platform-uptime-worker spec) |
| A `version` field on every log line through one log helper | A second daily check at 21:40 for a cron that never fires (detected only by the 25 h window, see §5) |
| A top-level catch in `fetch` and `scheduled`; a short chat notice to the owner when a reply fails with an exception | Retries of the heartbeat (one attempt by design: the next run reports again, and a missing run alerts through the window) |
| `sendMessage` returns whether Telegram accepted the message (no change to the webhook path's behaviour) | Parser changes (KE-03, KE-08, KE-10: BL-08); dropping the chat id from the idempotency key (TD-002, BL-01) |

## 3. Behaviour — scenarios

Common definitions:

- **Expected URL:** `<PUBLIC_ORIGIN>/telegram`, compared as an exact string with `getWebhookInfo.url`. The registered value was checked on 2026-10-22 (E-18): `https://solo-empire-checkin.bookchaowalit.workers.dev/telegram`.
- **Run time:** `event.scheduledTime` (milliseconds since the epoch). `last_error_date` is Unix time in **seconds**, so it is multiplied by 1000 before comparing.
- **Reason codes**, always in this order when several apply: `prompt-not-sent`, `webhook-info-unavailable`, `webhook-url-mismatch`, `webhook-updates-missing`, `webhook-recent-error`, `webhook-pending-backlog`, `exception`.

### AC-23 — The daily run reports a healthy heartbeat

- **Given** the cron fires; the prompt `sendMessage` returns 2xx; `getWebhookInfo` returns `ok: true` with `url` = Expected URL, `allowed_updates` absent or containing both `message` and `edited_message`, no `last_error_date` within the 24 h before the run time, and `pending_update_count` below the threshold P (D-3, proposed 10)
- **When** `scheduled` runs
- **Then** it POSTs `<MONITOR_ORIGIN>/heartbeat/checkin-daily` with `Authorization: Bearer <HEARTBEAT_TOKEN>`, `Content-Type: application/json` and body exactly `{"ok":true,"failed":[]}`
- **And** the calls are made in this order: prompt, `getWebhookInfo`, heartbeat (3 subrequests)
- **Test:** `test/worker.test.ts > "AC-23 the daily run reports a healthy heartbeat"` · level: integration

### AC-24 — The daily run reports exactly what went wrong

- **Given** each of these cases, one test per case:
  1. the prompt send answers non-2xx or throws a network error → `prompt-not-sent`
  2. `getWebhookInfo` answers non-2xx, `ok: false`, invalid JSON, or times out → `webhook-info-unavailable` (and no other webhook reason)
  3. `url` is empty or differs from the Expected URL → `webhook-url-mismatch`
  4. `allowed_updates` is present and lacks `message` or `edited_message` (for example `["message"]`, the registration before v1.2, DEF-15) → `webhook-updates-missing`; absent or empty `allowed_updates` means Telegram's default, which includes both, and is **not** a failure
  5. `last_error_date * 1000` is within 24 h before the run time → `webhook-recent-error`; an error older than 24 h is not reported
  6. `pending_update_count` ≥ P → `webhook-pending-backlog`
  7. cases 1 and 3 together → both codes, in the fixed order
- **When** `scheduled` runs
- **Then** the heartbeat body is `{"ok":false,"failed":[...]}` with exactly the applicable codes in the fixed order
- **And** neither the heartbeat body nor any log line contains the registered URL, the bot token, `HEARTBEAT_TOKEN`, `last_error_message` text, or a chat id: the test feeds sentinel strings in those fields and asserts that none appears in the request bodies sent or in `console.log` output (the monitor relays `failed` to Telegram as `🔴 checkin-daily run failed: <codes>`)
- **Test:** `test/worker.test.ts > "AC-24 the daily run reports each failure reason and nothing else"` · level: integration

### AC-25 — The monitor watches the daily heartbeat (platform-uptime-worker)

- **Given** `HEARTBEATS` in platform-uptime-worker `src/targets.ts`
- **Then** it contains `{ job: "checkin-daily", maxAgeHours: 25 }`
- **And** with the monitor's existing behaviour: `ok:false` alerts once per report; a report older than 25 h alerts, then every 6 h; a job with **no record at all** alerts "never reported" at the monitor's next shard-0 run (≤ 5 min after the deploy) and every 6 h until the first report; and a POST for a job not in `HEARTBEATS` gets 404 and is not recorded
- **Test:** platform-uptime-worker `test/monitor.test.ts > "watches the daily check-in run (life-checkin-worker SPEC-002 AC-25)"` · level: unit

### AC-26 — Reporting never breaks the check-in

- **Given** the monitor is unreachable, times out (5 s) or answers non-2xx; or `HEARTBEAT_TOKEN` or `MONITOR_ORIGIN` is unset
- **When** `scheduled` runs
- **Then** the prompt is still sent, `scheduled` resolves without throwing, the heartbeat is attempted once (no retry) when configured, and one log line `{"event":"heartbeat_failed","status":<HTTP status, or 0 for network/timeout, or -1 when unconfigured>}` is written
- **And** that line contains no token and no URL (sentinel check as in AC-24)
- **And** `POST /telegram` makes no `getWebhookInfo` or heartbeat call (its subrequests stay ≤ 41)
- **Test:** `test/worker.test.ts > "AC-26 heartbeat or webhook-info failures never break the run"` · level: integration

### AC-27 — Every log line names the deployed version

- **Given** `Env.CF_VERSION_METADATA?: { id: string }` from wrangler `[version_metadata] binding = "CF_VERSION_METADATA"`
- **When** the Worker writes any of the events `checkin`, `telegram_send_failed`, `heartbeat_failed`, `error`, all through one helper `log(env, event, fields)`
- **Then** each line has `"version": <CF_VERSION_METADATA.id>`, or `"version": "unknown"` when the binding is absent
- **Test:** `test/worker.test.ts > "AC-27 log lines carry the version"` (one assertion per event) · level: integration

### AC-28 — An unexpected exception is logged without content

- **Given** an exception injected by the test:
  - on `POST /telegram` **after** the secret check: `parseCheckin` mocked through `vi.mock('../src/parse')` to throw an `Error` whose message is a sentinel string
  - in `scheduled`: `parseCheckin` mocked through `vi.mock('../src/parse')` to throw (the prompt's date comes from it), so the exception happens before the prompt is sent
  - a thrown non-`Error` value (`throw "x"`)
- **When** it reaches the top-level catch
- **Then** one line `{"event":"error","where":"telegram"|"fetch"|"scheduled","name":<error.name, or "unknown" for a non-Error>,"version":...}` is logged, and no message text, stack, request body or sentinel appears in any log line
- **And** `where` is `"telegram"` only after the secret check passed; such a request answers 200 (Telegram must not retry, AD-06) and the owner gets one chat message `⚠️ ระบบขัดข้องระหว่างประมวลผลข้อความนี้ บางรายการอาจบันทึกแล้ว ตรวจสรุปพรุ่งนี้เช้าก่อนส่งซ้ำ` (best effort, sent with the existing non-throwing `sendMessage`). The notice must not claim that nothing was stored: an exception can happen after some cell writes, and a resend has a new `message_id`, so it is not deduplicated (the test asserts the notice does not contain `ยังไม่ได้บันทึก`)
- **And** an exception before the secret check, or on any other route, is `where: "fetch"` and answers 500 `{"ok":false}` with no chat message
- **And** in `scheduled` the heartbeat is still attempted; with the exception before the prompt, `failed` is `["prompt-not-sent","exception"]` (fixed order)
- **Test:** `test/worker.test.ts > "AC-28 an unexpected exception is logged without content"` · level: integration

### AC-29 — Logs are kept (only if D-1 = a)

- **Given** `wrangler.toml`
- **Then** it contains `[observability] enabled = true` and `[observability.logs] enabled = true` with `invocation_logs = false` (console lines only; v1.1), and `wrangler deploy --dry-run` accepts it
- **Test:** config check in CI (`grep` step or test reading `wrangler.toml`) · level: config

## 4. Interfaces and data

| Interface | Change | Contract |
|---|---|---|
| Telegram `getWebhookInfo` | new caller (cron only) | `GET https://api.telegram.org/bot<token>/getWebhookInfo`, 5 s timeout. Fields read: `ok`, `url`, `allowed_updates`, `last_error_date` (seconds), `pending_update_count`. Nothing from it is logged or forwarded except reason codes |
| `sendMessage` (internal) | returns `Promise<boolean>` | `true` only for a 2xx from Telegram; still never throws. The webhook path ignores the result, so its behaviour is unchanged |
| Monitor `POST /heartbeat/checkin-daily` | new caller | `Authorization: Bearer <HEARTBEAT_TOKEN>`, JSON `{ok, failed}`, 5 s timeout, one attempt |
| platform-uptime-worker `HEARTBEATS` | +1 job | `checkin-daily`, 25 h |
| `wrangler.toml` | new vars, binding, observability | vars `PUBLIC_ORIGIN = "https://solo-empire-checkin.bookchaowalit.workers.dev"`, `MONITOR_ORIGIN = "https://solo-empire-monitor.bookchaowalit.workers.dev"`; `[version_metadata] binding = "CF_VERSION_METADATA"`; `[observability] enabled = true` if D-1 = a |
| Worker secret | new | `HEARTBEAT_TOKEN`, copied from Infisical `/monitoring` with `wrangler secret put` (never printed) |
| Log helper | new | `log(env, event, fields)` adds `version`; events `checkin`, `telegram_send_failed`, `heartbeat_failed`, `error` |

- **Data model / migration:** N/A, no stored data.
- **Deploy order (same evening):** (1) set `HEARTBEAT_TOKEN` and deploy the Worker (a 21:30 run before step 2 would log `heartbeat_failed` with status 404 from the monitor, which is harmless); (2) deploy the monitor with AC-25 shortly before 21:30 +07:00 (for example 21:15–21:25): it then alerts "checkin-daily has not reported (never)" once at its next shard-0 run, which is expected and noted in the release record; (3) after the 21:30 run confirm `heartbeats.checkin-daily` with `ok: true` in the monitor's authorised `/status`. Deploying the monitor days earlier would repeat the "never" alert every 6 h until the first run.
- **Rotation:** the token-rotation runbook for `HEARTBEAT_TOKEN` gains a step: update this Worker's secret too (§7 D-2).

## 5. Non-functional requirements

| NFR | Target | How it is tested |
|---|---|---|
| Subrequests | Cron run ≤ 3 (prompt, `getWebhookInfo`, heartbeat); webhook path unchanged (≤ 41, plus 1 notice only on an exception) | AC-23, AC-26, AC-28 |
| Run time | Cron worst case about 15 s (three sequential 5 s timeouts); well inside the cron limit | AC-26 |
| Privacy / secrets | No token, URL, error message, chat id or user text in logs or the heartbeat body | AC-24, AC-26, AC-28 sentinel checks |
| Reliability | Reporting failures never stop the prompt or the webhook | AC-26, AC-28 |
| Detection time: prompt send fails, webhook broken or redirected | at the 21:30 run (about a minute) | AC-23, AC-24 |
| Detection time: cron never fires | about 25 h after the previous report (≈ 22:30 +07:00 the next day); this is later than the 21:40 target of OBS-GAP-02 for this case (D-4) | AC-25 |
| Coverage | CI gate stays ≥ 96; ratchet to the new measured value rounded down | CI |

## 6. Test plan (TDD)

- **Test levels:** integration tests for the Worker with `fetch` mocked (Telegram, monitor, cells) and spies for exception injection; one unit test in platform-uptime-worker.
- **Red first:** life-checkin-worker: one red commit with AC-23..AC-29 failing on behaviour (stubs, not import errors); a checker (fresh reviewer) reruns it **before** the push; then the green commit; one push. platform-uptime-worker: its own red/green pair for AC-25, pushed and deployed at step (2) of the deploy order, on the same evening as the Worker. If D-1 ≠ (a), AC-29 and the `[observability]` line in §4 are removed from the spec before the red commit.
- **Live check after deploy (read-only):** `wrangler deployments list`; `wrangler secret list` (names only); after 21:30 the monitor's authorised `/status` shows `checkin-daily` with `ok: true`; Workers Logs show a `checkin` or `heartbeat` line with `version` (if D-1 = a).
- **Not test-first (exceptions):** the `wrangler.toml` vars and binding, checked by `wrangler deploy --dry-run` (AC-29 covers the observability block).
- **Documents after release:** update PRJ-LIFE-01 `07b` (alerts, gaps), `07c` (FM-03, FM-04, FM-09 detectability and RPN), `tech-debt-register` (TD-005, TD-006), `12` (change log, monitoring table).

### Red / green log

| Scenario | Test | Red: commit · command · failure message | Green: commit · CI run | Refactor note |
|---|---|---|---|---|
| AC-23..AC-29 | `test/observability.test.ts`, `test/errors.test.ts` | `ca815c4` · `npx vitest run` · 28 failed, e.g. AC-23 `expected [ 'sendMessage' ] to deeply equal [ 'sendMessage', …(2) ]`, AC-28 `promise rejected "Error: SENTINEL in cron" instead of resolving`; checker rerun before the push: valid red, 0 blocking. `49a2f1a` (checker notes): 3 more failing cases, 31 failed at the red code | `b9b087d` (green, 57 passed, lines 96.96%); `775cc7d` → `808e29f` invocation logs off (security review); `8610970` → `bce2deb` error-name check (code review); 59 passed. CI of each pushed tip | AC-09 (SPEC-001) now counts `sendMessage` calls only (`0a32c32`, passes before and after); the webhook-path test is an already-green guard |
| AC-25 | platform-uptime-worker `test/monitor.test.ts > "watches the daily check-in run (life-checkin-worker SPEC-002 AC-25)"` | `7866d69` · `npx vitest run` · `expected undefined to be 25`; checker rerun before the push: valid red | `f82e052`, 36 passed | — |

## 7. Decisions for the owner, risks and open questions

| # | Decision or risk | Options | Proposed |
|---|---|---|---|
| D-1 | How errors are kept (OBS-GAP-05, TD-006) | (a) turn on Workers Logs persistence (`[observability] enabled = true`; retention per the Cloudflare plan **[ต้องยืนยัน]**), plus the chat notice on a failed reply; (b) only the chat notice and the live-tail log; (c) add Sentry (new vendor, later spec) | **(a)**. OBS-GAP-05 is then closed for keeping errors, but there is no alerting on errors beyond the chat notice and the daily heartbeat; TD-006's Sentry part stays open. Invocation logs are turned off (`[observability.logs] invocation_logs = false`): they can record request headers, and Telegram sends the webhook secret in `X-Telegram-Bot-Api-Secret-Token` (automated security review of `b9b087d`, 2026-10-22); only the Worker's own console lines are kept |
| D-2 | `HEARTBEAT_TOKEN` is one token for every monitor job. Copying it into this public-facing Worker means a leak could fake or suppress heartbeats of `db-backup`, `restore-drill`, `token-rotate` | (a) accept, add the Worker to the rotation runbook; (b) first add per-job tokens to the monitor (separate spec) | **(a)**: the Worker already holds the bot token, and secrets stay in Cloudflare's secret store |
| D-3 | Backlog threshold P for `webhook-pending-backlog` | any number | **10** pending updates at 21:30 |
| D-4 | A cron that never fires is detected only after 25 h (OBS-GAP-02 asked for 21:40) | (a) accept; (b) add a second check at 21:40 from the monitor (later spec) | **(a)** for a once-a-day personal tool |
| Q-1 | Is a daily webhook check often enough? | — | Yes for a once-a-day check-in; Telegram keeps undelivered updates for a limited time **[ต้องยืนยัน]** |
| R-1 | FM-09 stays partly open: a leaked bot token used without `setWebhook`, or a changed `secret_token`, is not visible in `getWebhookInfo` | — | Recorded; rotate the bot token on suspicion |
| R-2 | `last_error_date` is not cleared after recovery, so one transient error can produce one `webhook-recent-error` report | — | Accept: at most one report, the next day is clean |
| R-3 | `CF_VERSION_METADATA` absent in tests or a runtime | — | `version: "unknown"` (AC-27) |

## 8. Change log

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-10-22 | Draft for review |
| 1.1 | 2026-10-22 | Implementation detail under D-1: invocation logs off, console logs only (security review); AC-29 test asserts it. Within the approved decision, no scope change |
| 1.0 | 2026-10-22 | Approved by the owner with D-1..D-4 as proposed; no content change from 0.3 |
| 0.3 | 2026-10-22 | Review v0.2 (2 blocking, 2 non-blocking): deploy order and monitor behaviour for unknown or never-reported jobs corrected (F1); the chat notice no longer claims nothing was stored (F2); exception injection through `vi.mock` and the `prompt-not-sent` + `exception` result (F3); AC-29 removal rule and invocation-log note (F4) |
| 0.2 | 2026-10-22 | Review v0.1 (3 blocking, 8 non-blocking): default `allowed_updates` is not a failure (B2); exception paths, `where` boundaries, injection points and content checks defined (B3); log persistence and owner chat notice as decision D-1, "closes" claims corrected (B1); seconds vs milliseconds, fixed reason order, backlog reason, `sendMessage` boolean, log helper, sentinel tests, deploy order, rotation step, no-retry by design, detection-time split, D-2..D-4 |

## Approval

| Role | Name / date | Decision |
|---|---|---|
| Reviewer (AI checker) | fresh Claude reviewer, 2026-10-22 | v0.1 and v0.2 changes requested; the reviewer stated v0.3 needs no third round if F1 and F2 are fixed as proposed, which they are |
| Owner | Owner (bookchaowalit) / 2026-10-22 | **Approved** v0.3 as written, with D-1 = (a) turn on Workers Logs, D-2 = (a) accept the shared heartbeat token, D-3 = 10, D-4 = (a). Owner's words: "อนุมัติ SPEC-002 v0.3 พร้อม D-1=(a) เปิด Workers Logs, D-2=(a) ยอมรับ token เดียว, D-3=10, D-4=(a) แล้วลงมือ build ได้" |
