---
title: SPEC-001 — Evening Telegram check-in
tags: [spec, sdd, tdd, telegram, health, time, diary]
created: 2026-10-21
updated: 2026-10-21
status: approved
---

# SPEC-001 — Evening Telegram check-in

Standard: ADR-0004 — TDD + SDD (architecture-docs `docs/architecture/decisions/ADR-0004-tdd-sdd-standard.md`).

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-001 / 1.1 |
| Status | **implemented** |
| Repository / path | bookchaowalit/life-checkin-worker / `specs/001-evening-checkin/spec.md` |
| Owner (maker) | Claude Code |
| Reviewer (checker) | A fresh Claude reviewer subagent with no maker context |
| Approver | Owner (bookchaowalit). The owner asked for this behaviour on 2026-10-21: "21:30 bot asks about health, hours worked and diary, my reply gets logged automatically" |
| Requirement links | Owner request 2026-10-21 (Claude Code session, daily productivity brief) |
| Related docs | platform-empire `contracts/automations/v1/automations.json` (automation `evening-checkin`), `deployments.json`; platform-uptime-worker (bot and alert pattern) |
| Main-only | yes. Work is committed straight to `main`, so the red run is local (ADR-0004 rule 2, v1.1) |
| Created / approved | 2026-10-21 / 2026-10-21 |

## 1. Problem and intent

- **Problem:** The owner has health, time and diary cells, but nothing has been written to them. The last health row is from 2026-06-28. There are no time logs in October. The automatic diary stopped after 2026-10-18. Opening an app or a CSV file to log each item takes too much effort, so it doesn't happen.
- **Outcome:** Every evening at 21:30 Asia/Bangkok, book_noti_bot asks one question. The owner answers in one Telegram message written in short Thai or English lines. Each value lands in the right cell, and the bot replies with what it logged and anything it could not read.
- **Why now:** The daily morning brief (started 2026-10-21) reported these gaps. The owner chose this as the first system to build.

## 2. Scope

| In scope | Out of scope (non-goals) |
|---|---|
| A 21:30 prompt sent by a Cloudflare cron trigger | Free-form AI parsing. There is no LLM key in Infisical, so a later spec can add Workers AI or Claude |
| A Telegram webhook that accepts only the owner's chat | Editing or deleting earlier entries. Cells have no DELETE, so a correction is a new message |
| Parsing sleep, weight, exercise, water, mood, energy, work time and diary lines | Leantime time entries (a client system) |
| Writing to the health (`/v1/health-metrics`), time (`/v1/time-logs`) and diary (`/v1/journal-entries`) cells with the `evening-checkin` automation token | Strava or Apple Health import (Infisical has `/strava` and `/apple`; that is a later spec) |
| A summary reply, and a `/checkin` command that sends the prompt on demand | Habits (the habits cell has its own publisher and model) |

## 3. Behaviour — scenarios

### AC-01 — A full reply is parsed into metrics, time and diary

- **Given** the reply text
  `นอน 7` / `น้ำหนัก 71.5` / `ออกกำลัง 30 วิ่ง` / `น้ำ 2` / `อารมณ์ 4` / `พลังงาน 3` / `งาน CuteERP 5, freelance 1.5` / `บันทึก วันนี้เหนื่อยแต่จบงาน`
  received at 2026-10-22 21:40 +07:00
- **When** `parseCheckin` runs
- **Then** the date is `2026-10-22`
- **And** the metrics are sleep_hours 7 h, weight 71.5 kg, exercise_minutes 30 min (activity วิ่ง) and water 2 L
- **And** the time logs are work/CuteERP 300 min and work/freelance 90 min
- **And** the diary is `วันนี้เหนื่อยแต่จบงาน`, with mood 4 and energy 3
- **Test:** `test/parse.test.ts > "AC-01 parses a full reply"` · level: unit

### AC-02 — Keyword collisions and units

- **Given** lines `น้ำหนัก 72` and `น้ำ 1500`, English lines `sleep 6.5h`, `weight 70kg`, `water 1.2`, and an exercise line written as an activity first (`วิ่ง 45`)
- **When** parsed
- **Then** `น้ำหนัก` is weight, not water
- **And** water above 20 is read as millilitres (1500 → 1.5 L)
- **And** an exercise line can start with the activity word
- **And** the English keywords work the same way as the Thai ones
- **Test:** `test/parse.test.ts > "AC-02 handles collisions and units"` · level: unit

### AC-03 — Work time formats

- **Given** the work lines `งาน 6`, `work: Cute 2h, admin 30 นาที`, `งาน CuteERP 1:30` and `เรียน TypeScript 45m`
- **When** parsed
- **Then** they give work/งาน 360, work/Cute 120, work/admin 30, work/CuteERP 90 and learning/TypeScript 45 (minutes)
- **Test:** `test/parse.test.ts > "AC-03 reads work time formats"` · level: unit

### AC-04 — Unknown lines become diary; out-of-range values are rejected

- **Given** the lines `นอน 30`, `อารมณ์ 9` and the free-text line `ไปกินข้าวกับที่บ้าน`, with no `บันทึก` line
- **When** parsed
- **Then** `นอน 30` and `อารมณ์ 9` are not stored, and each appears in `rejected` with a reason
- **And** the free-text line becomes the diary text
- **Test:** `test/parse.test.ts > "AC-04 rejects out-of-range values and keeps free text as diary"` · level: unit

### AC-05 — After-midnight replies count for the previous day

- **Given** a reply received at 2026-10-23 01:15 +07:00
- **When** parsed
- **Then** the date is `2026-10-22`, and `recorded_at` is `2026-10-22T23:59:00+07:00`
- **And** a reply at 05:00 or later counts for that day
- **Test:** `test/parse.test.ts > "AC-05 assigns after-midnight replies to the previous day"` · level: unit

### AC-06 — Only Telegram with the secret, from the owner's chat, is accepted

- **Given** a POST to `/telegram`
- **When** the `X-Telegram-Bot-Api-Secret-Token` header is missing or wrong
- **Then** the response is 401, and nothing is written or sent
- **And** when the header is right but the message comes from another chat, the response is 200 and nothing is written or sent
- **Test:** `test/worker.test.ts > "AC-06 rejects bad secrets and other chats"` · level: integration (fetch mocked)

### AC-07 — An accepted reply is written to the cells and confirmed

- **Given** a valid update from the owner's chat with the AC-01 text
- **When** the webhook handles it
- **Then** it POSTs 4 health metrics, 2 time logs and 1 journal entry to the configured cell origins
- **And** each request has `Authorization: Bearer <EMPIRE_CHECKIN_TOKEN>`, `X-Empire-Channel: workflow` and an `Idempotency-Key` that includes the update id
- **And** the bot replies in the same chat with a Thai summary listing every stored value
- **And** the response is 200
- **Test:** `test/worker.test.ts > "AC-07 writes every record and replies with a summary"` · level: integration

### AC-08 — A failed write is reported, not hidden

- **Given** the health cell answers 403 to one POST
- **When** the webhook handles a valid reply
- **Then** the other records are still written
- **And** the summary reply names the failed item with its HTTP status
- **And** the response is 200, so Telegram doesn't retry and create duplicates
- **Test:** `test/worker.test.ts > "AC-08 reports a failed write in the reply"` · level: integration

### AC-09 — 21:30 prompt and the `/checkin` command

- **Given** the cron trigger `30 14 * * *` (21:30 +07:00) fires, or the owner sends `/checkin`
- **When** the Worker handles it
- **Then** it sends one prompt message to the owner's chat, with the date and an example reply
- **And** `/checkin` writes nothing to any cell
- **Test:** `test/worker.test.ts > "AC-09 sends the prompt on cron and on /checkin"` · level: integration

### AC-10 — Nothing recognisable

- **Given** a message from the owner with no text (a sticker), or another bot command such as `/start`
- **When** the webhook handles it
- **Then** nothing is written. A non-text message is ignored, and `/start` and `/help` get the help text
- **Test:** `test/worker.test.ts > "AC-10 ignores non-text and answers help"` · level: integration

### AC-11 — Health endpoint

- **Given** `GET /health`
- **Then** it returns 200 with `{"ok":true,"service":"solo-empire-checkin"}`, including no configuration values
- **And** any other path returns 404
- **Test:** `test/worker.test.ts > "AC-11 health endpoint"` · level: integration

### AC-12 — Keywords need a word boundary (v1.1, review R-01 #1)

- **Given** `งานบ้าน 1`, `งานเลี้ยง 3`, `noted ok`, `notebook ใหม่`
- **Then** no time log is created and all four lines stay in the diary unchanged
- **Test:** `test/parse.test.ts > "AC-12 keywords need a word boundary"` · level: unit

### AC-13 — Unit words don't bleed into the activity (v1.1, R-01 #2)

- **Given** `ออกกำลัง 1 hour วิ่ง`, `ออกกำลัง 45 mins วิ่ง`, `ออกกำลัง 30 minutes`, `ออกกำลัง 1 hr`, `gym 2 hours`
- **Then** they give 60 min (วิ่ง), 45 min (วิ่ง), 30 min, 60 min and 120 min (gym)
- **Test:** `test/parse.test.ts > "AC-13 long unit words do not bleed into the activity"` · level: unit

### AC-14 — Compound durations (v1.1, R-01 #3)

- **Given** `งาน 1h30m`, `งาน Cute 3 ชม. 30 นาที`, `work: api 2 hours`
- **Then** they give 90, 210 and 120 minutes, with nothing rejected
- **Test:** `test/parse.test.ts > "AC-14 compound durations"` · level: unit

### AC-15 — Clock times and ranges are validated, never silently dropped (v1.1, R-01 #4, #5)

- **Given** `นอน 23:30`, `นอน 7:75`, `งาน 1:75`, `งาน 25`, `งาน 0:00`, `นอน 7:30`
- **Then** only sleep 7.5 h is stored. Sleep is capped at 16 h, so a bedtime is rejected, and minutes must be under 60
- **And** the other five lines are each in `rejected`, and none of them goes to the diary
- **Test:** `test/parse.test.ts > "AC-15 clock times and ranges are validated, never silently dropped"` · level: unit

### AC-16 — A failed Telegram send still answers 200; long replies are cut (v1.1, R-01 #6)

- **Given** the Telegram API throws, or the summary is longer than 4,000 characters
- **Then** the webhook still returns 200, and the sent text is at most 4,000 characters
- **Test:** `test/worker.test.ts > "AC-16 a failed Telegram send still answers 200, and long replies are cut"` · level: integration

### AC-17 — At most 40 records per message (v1.1, R-01 #7)

- **Given** a message with 1 metric, 60 work items and a diary line
- **Then** 40 records are kept in total, and the other 22 are in `rejected` with a "send the rest as a new message" reason
- **Test:** `test/parse.test.ts > "AC-17 caps the records per message"` · level: unit

### AC-18 — Idempotency keys come from the message (v1.1, R-01 #8, #9)

- **Given** the same message delivered twice (with the same or a different `update_id`)
- **Then** the cell requests carry the same keys, `checkin:<chat.id>:<message_id>:<kind>:<i>`
- **And** a different `message_id` gives different keys
- **Test:** `test/worker.test.ts > "AC-18 idempotency keys come from the message and repeat on retry"` · level: integration

### AC-19 — Only the owner in a private chat; edits get a hint (v1.1, R-01 nits)

- **Given** the owner's chat id in a group, or a message whose `from.id` isn't the owner
- **Then** nothing is written or sent
- **And** when the owner edits a message (`edited_message`), nothing is written and the bot asks for a new message
- **And** `/checkin@otherbot` is ignored
- **Test:** `test/worker.test.ts > "AC-19 only the owner in a private chat; edits get a hint"`, `"AC-10 ignores non-text and answers help"` · level: integration

AC-02, AC-06, AC-07, AC-08, AC-09 and AC-10 gained further assertions in v1.1: English mood, energy and exercise lines; a non-JSON body gets 400; an unset secret gets 401; the full record bodies; the failed item is named in the reply; `/checkin` sends the prompt rather than help; `/help` works.

## 4. Interfaces and data

| Interface | Change | Contract |
|---|---|---|
| `POST /telegram` | new | A Telegram `Update` JSON body. It requires the header `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`. Responses are 401 (bad secret), 200 (handled or ignored) and 400 (body isn't JSON) |
| `GET /health` | new | 200 `{"ok":true,"service":"solo-empire-checkin"}` |
| Cron `30 14 * * *` | new | Sends the prompt via `sendMessage` |
| health cell `POST /v1/health-metrics` | caller | `source="telegram-checkin"`, `metric_type` ∈ {sleep_hours, weight, exercise_minutes, water}, plus `value`, `unit`, `recorded_at`, and `metadata` (a JSON string with the activity for exercise) |
| time cell `POST /v1/time-logs` | caller | `log_date`, `domain` ∈ {work, learning, personal}, `activity`, `minutes`, `notes="telegram-checkin"` |
| diary cell `POST /v1/journal-entries` | caller | `entry_type="daily"`, `title="Check-in YYYY-MM-DD"`, `content`, `mood`, `energy_level`, `entry_date`, `tags="checkin"` |

- **Data model / migration:** N/A. No schema change; the existing cell endpoints are used as they are.
- **Backward compatibility:** book_noti_bot has no webhook today (`getWebhookInfo` url empty, checked 2026-10-21), and the other users of the bot only send messages. Setting a webhook doesn't change them.

## 5. Non-functional requirements

| NFR | Target | How it is tested |
|---|---|---|
| Performance | Webhook reply within about 10 s (parallel cell writes at 5 s, plus Telegram at 5 s). At most 40 records + 1 Telegram call, under the 50-subrequest free-plan limit | AC-07, AC-17 |
| Security / privacy | Secret-header check (constant-time compare). Chat allowlist. The token has only the read/write scopes for health-metric, time-log and journal-entry. No values are logged; only counts and HTTP statuses | AC-06, AC-11; reviewer check of the scopes in platform-empire |
| Reliability / observability | Always 200 after the secret check, so Telegram doesn't retry. Idempotency keys stop duplicates if it does retry. `/health` is added to the uptime monitor | AC-07, AC-08; uptime target |
| Accessibility / UX | Replies are plain Thai text that is readable on a phone | Manual check of the first live reply |

## 6. Test plan (TDD)

- **Test levels:** unit tests for the parser; integration tests for the Worker with `fetch` mocked; one live end-to-end run after deploy (the owner replies to the first prompt).
- **Test data:** Synthetic text only. No real records in the tests.
- **Coverage:** CI gate `coverage-threshold: "96"` in `.github/workflows/ci.yml`. It was 94 at v1.0 (94.21%) and was ratcheted to 96 at v1.1 (96.2%); never lower it.
- **Not test-first (exceptions):** `wrangler.toml` and the CI workflow are pure config, checked by `wrangler deploy --dry-run` and the first CI run.

### Red / green log

| Scenario | Test | Red: commit / run + failure message | Green: commit / run | Refactor note |
|---|---|---|---|---|
| AC-01..AC-05 | `test/parse.test.ts` | `4e84b3c` · `npx vitest run` · `AssertionError: expected '' to be '2026-10-22'` (stub parser) | green commit below; CI run of the pushed tip | none |
| AC-12..AC-19 + extra v1.1 assertions | `test/parse.test.ts`, `test/worker.test.ts` | `21e0516` · `npx vitest run` · 10 failing, e.g. AC-12 `expected [ { domain: 'work', activity: 'บ้าน' … } ] to deeply equal []`, AC-18 `expected 'checkin:77:metric:0' to match /^checkin:1001:5:/` | v1.1 green commit; CI run of the pushed tip | sendMessage made non-throwing; record cap moved into parse |
| AC-06..AC-11 | `test/worker.test.ts` | `4e84b3c` · `npx vitest run` · `AssertionError: expected 501 to be 401` (stub worker) | green commit below; CI run of the pushed tip | none |

## 7. Risks and open questions

| # | Risk or question | Impact | Owner | Resolution / date |
|---|---|---|---|---|
| 1 | The owner writes lines the parser doesn't know | Values end up in the diary instead of metrics | Claude | The summary reply shows exactly what was stored; new keywords get added in a follow-up spec |
| 2 | Sending twice on one day creates duplicate metrics | Daily averages get skewed | Owner | Accepted for v1; documented in the README |
| 3 | The automation token expires (30 days) | Writes fail with 401 | platform-empire token-rotate cron | The Worker is a cloudflare target in `deployments.json`, so it rotates with the others; AC-08 shows failures in chat |

## 8. Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-21 | First approved version |
| 1.1 | 2026-10-21 | Independent review R-01 (fresh Claude reviewer): 0 blocking, 9 should-fix, all fixed via AC-12..AC-19. Coverage ratcheted from 94 to 96 |
