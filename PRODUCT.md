# Product

<!-- impeccable:product-schema 1 -->

## Platform

Cloudflare Worker `solo-empire-checkin` (cron + Telegram webhook on book_noti_bot)

## Users

- The owner: a single Telegram chat (`TELEGRAM_CHAT_ID`) answers the evening check-in, and an iOS
  Shortcut posts one day of Apple Health totals.

## Product Purpose

Log health, hours worked and a diary every day without opening an app: at 21:30 Asia/Bangkok the
bot asks once, the owner replies with one item per line (Thai or English), and the Worker writes
them to the solo-empire health, time and diary cells and replies with what it stored, what failed
and what it could not read.

Success: a reply is stored in the right cells the same evening, every failure is visible in the
chat reply or the monitor, and nothing the owner wrote appears in logs.

## Positioning

The capture side of PRJ-LIFE-01 (architecture-docs `operations/life/evening-checkin/`). Specs:
`specs/001-evening-checkin` (check-in), `specs/002-checkin-observability` (heartbeat, version,
error log), `specs/003-apple-health-ingest` (`POST /apple-health`).

## Operating Context

- Runs on Cloudflare Workers at `https://solo-empire-checkin.bookchaowalit.workers.dev`; cron
  `30 14 * * *` UTC; `/health` is an uptime target and the cron posts the `checkin-daily`
  heartbeat (alert on `ok:false` at once, on silence after 25 h).
- Writes with the `evening-checkin` automation token (health-metric, time-log and journal-entry
  only), rotated by platform-empire's hosted token-rotate into the Worker secret.
- CI: shared `ci-node` (typecheck, Vitest under a coverage gate) and the shared security
  workflow, on GitHub-hosted runners (public repository). Deploys with `wrangler deploy`.

Sentry waiver: SPEC-002 decision D-1 chose Workers Logs (option a) over an error-tracking vendor (option c, a later spec); exceptions are logged as `{event:"error", where, name}` only, because messages may carry the owner's diary text (AC-28), and the daily heartbeat reports failures to the monitor.

## Capabilities and Constraints

- Only the owner's chat is answered, and `POST /telegram` needs Telegram's secret header.
- Each message is stored as sent; the cells have no delete, so a repeated item is stored twice.
- Logs carry counts and HTTP statuses only, never values.

## Measures

- Evenings with a stored reply (from the diary cell, tag `checkin`).
- `checkin-daily` heartbeats with `ok:true` (target: every day).
