# life-checkin-worker

Cloudflare Worker `solo-empire-checkin`: the evening check-in over **book_noti_bot**.

- **21:30 Asia/Bangkok** (cron `30 14 * * *`): the bot sends one prompt to the owner's chat.
- **Reply** with one item per line, in Thai or English. Every line is optional:

  ```
  นอน 7
  น้ำหนัก 71.5
  ออกกำลัง 30 วิ่ง      (or: วิ่ง 30 · gym 1h)
  น้ำ 2                (litres; above 20 is read as ml)
  อารมณ์ 4             (1–5)
  พลังงาน 3            (1–5)
  งาน CuteERP 5, admin 30 นาที   (hours, 1:30, or minutes)
  เรียน TypeScript 45m
  บันทึก วันนี้…
  ```

  Lines that don't match a keyword are kept as diary text. A reply sent before 05:00 counts for the evening before.
- The Worker writes to the solo-empire cells and replies with what it stored, what failed (with the HTTP status) and what it couldn't read:
  - health `POST /v1/health-metrics`: sleep_hours, weight, exercise_minutes, water
  - time `POST /v1/time-logs`: work, learning or personal minutes per activity
  - diary `POST /v1/journal-entries`: a daily entry with mood and energy
- `/checkin` sends the prompt again. `/help` shows the format.

Each message is stored as sent. Sending the same item twice on one day stores it twice; cells have no delete.

## Security

- `POST /telegram` requires Telegram's `X-Telegram-Bot-Api-Secret-Token` header to match `TELEGRAM_WEBHOOK_SECRET`. Only `TELEGRAM_CHAT_ID` is answered.
- The cell token is the `evening-checkin` automation from platform-empire `contracts/automations/v1/automations.json`. It has read/write only on health-metric, time-log and journal-entry. platform-empire's hosted token-rotate pushes a fresh token to this Worker's `EMPIRE_CHECKIN_TOKEN` secret (`deployments.json`).
- Logs carry counts and HTTP statuses only, never values.

## Deploy

```
npm ci && npm test
infisical run --projectId "$INFISICAL_PROJECT_ID" --env dev --path /cloudflare --silent -- npx wrangler deploy
```

Secrets (`wrangler secret put`): `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (Infisical `/telegram` NOTI values), `TELEGRAM_WEBHOOK_SECRET` (Infisical `/telegram` `TELEGRAM_CHECKIN_WEBHOOK_SECRET`), and `EMPIRE_CHECKIN_TOKEN` (set by token-rotate).

Webhook: `setWebhook` with `url=https://solo-empire-checkin.bookchaowalit.workers.dev/telegram`, `secret_token=<TELEGRAM_CHECKIN_WEBHOOK_SECRET>`, `allowed_updates=["message"]`.

Spec: [SPEC-001](specs/001-evening-checkin/spec.md).
