# 01 — Business process (As-Is / To-Be)

life-checkin-worker คือ Cloudflare Worker `solo-empire-checkin` ที่ส่งข้อความเช็กอินตอนเย็นทาง Telegram bot ถึง owner คนเดียว รับคำตอบทีละบรรทัด (หรือยอดรายวันจาก iOS Shortcut ของ Apple Health) แล้วเขียนลง cell สุขภาพ เวลา และไดอารี่ พร้อมรายงานผลกลับในแชทและส่ง heartbeat รายวันให้ uptime monitor

Last reviewed: 2026-11-27 · commit `810a29c`

## As-Is (จากโค้ดวันนี้)

```mermaid
flowchart TD
  CRON["Cron 30 14 * * * UTC = 21:30 Bangkok"] --> PROMPT["sendMessage: prompt to owner chat"]
  PROMPT --> WH["getWebhookInfo check (url, allowed_updates, last error, backlog)"]
  WH --> HB["POST heartbeat checkin-daily to monitor: ok or reason codes"]
  HB --> MON["platform-uptime-worker job checkin-daily, maxAgeHours 25 (in its code per SPEC-002 AC-25; production deploy [ต้องยืนยัน])"]
  OWNER["Owner reply in Telegram"] --> TG["POST /telegram"]
  TG --> SEC{"secret header matches AND chat is owner private chat?"}
  SEC -->|"header wrong"| R401["401"]
  SEC -->|"not owner"| IGN["200, ignored"]
  SEC -->|yes| CMD{"command or text?"}
  CMD -->|"/checkin or /help"| REPLYHELP["send prompt or help"]
  CMD -->|"edited message"| EDITHINT["send hint: edits are not re-stored"]
  CMD -->|text| PARSE["parseCheckin: metrics, time logs, diary, mood, energy, rejected lines"]
  PARSE --> WRITE["writeCheckin in parallel, 12 s timeout each"]
  WRITE --> HEALTH["health cell POST /v1/health-metrics"]
  WRITE --> TIME["time cell POST /v1/time-logs"]
  WRITE --> DIARY["diary cell POST /v1/journal-entries"]
  HEALTH --> SUM["send summary: stored, failed with HTTP status, unreadable"]
  TIME --> SUM
  DIARY --> SUM
  SHORTCUT["iOS Shortcut"] --> AH["POST /apple-health, Bearer token, max 16 KB"]
  AH --> AHP["parseAppleHealth then write to health cell as source apple-health"]
  AHP --> HEALTH
  AHP --> AHRES["HTTP JSON back to the Shortcut: 200, 502 or 422 with message; no Telegram message"]
```

Cell writes go through the edge gateway (`gateway.bookchaowalit.com/v1/<system>`) with the `evening-checkin` automation token. An unexpected exception after the secret check logs `{event, where, name}` only and sends the owner a short notice; logs never carry values. `GET /health` is the uptime target. Idempotency keys are derived from the Telegram chat and message id (check-in) or the day and metric (Apple Health), so a re-delivered update or a re-run Shortcut does not store a saved item again; typing the same text as a new Telegram message gets a new message id and is stored twice (cells have no delete). [ต้องยืนยัน] ว่า production deploy ล่าสุดตรงกับ commit นี้และ `HEARTBEAT_TOKEN`, `APPLE_HEALTH_TOKEN` ถูกตั้งแล้ว (ดูจากโค้ดไม่ได้)

Sources: `src/worker.ts` (`scheduled`, `fetch`, `handleTelegram`, `handleAppleHealth`, `writeCheckin`, `checkWebhook`, `reportHeartbeat`), `src/parse.ts`, `src/apple-health.ts`, `wrangler.toml`, `README.md`, `PRODUCT.md`

## To-Be (SPEC-002 และ SPEC-003 ใน `specs/`)

```mermaid
flowchart TD
  CRON["Cron 21:30 Bangkok"] --> PROMPT["sendMessage: prompt to owner chat"]
  PROMPT --> WH["getWebhookInfo check"]
  WH --> HB["POST heartbeat checkin-daily to monitor"]
  HB --> MON["Monitor job watches heartbeat: alert on ok false at once, never reported at the next shard-0 run, silence after 25 h"]
  OWNER["Owner reply in Telegram"] --> TG["POST /telegram"]
  TG --> SEC{"secret header matches AND chat is owner private chat?"}
  SEC -->|yes| PARSE["parseCheckin"]
  PARSE --> WRITE["writeCheckin in parallel"]
  WRITE --> HEALTH["health cell"]
  WRITE --> TIME["time cell"]
  WRITE --> DIARY["diary cell"]
  HEALTH --> SUM["send summary"]
  TIME --> SUM
  DIARY --> SUM
  SHORTCUT["iOS Shortcut runs daily"] --> AH["POST /apple-health"]
  AH --> HEALTH
  AH --> AHRES["HTTP JSON result back to the Shortcut, not the chat"]
```

Sources: `specs/002-checkin-observability/spec.md` (AC-25), `specs/003-apple-health-ingest/spec.md`, `specs/README.md`

## Gap

| ID | As-Is → To-Be | Status | Owner | Evidence |
|---|---|---|---|---|
| G1 | monitor job `checkin-daily` (`maxAgeHours: 25`) อยู่ใน platform-uptime-worker แล้วตาม spec (ทดสอบผ่าน) แต่ยังไม่ยืนยันว่า production รันเวอร์ชันนั้นและรับ heartbeat จริง → ตรวจ production; ถ้ายังไม่เคยมี heartbeat monitor แจ้ง `never reported` ที่รอบ shard 0 ถัดไป ไม่รอ 25 ชม. | todo | claude | `specs/002-checkin-observability/spec.md` AC-25 และ §6 (green `f82e052`); repo platform-uptime-worker [ต้องยืนยัน] |
| G2 | SPEC-002 (heartbeat, version บน log, error notice) อยู่ใน code แต่สถานะ spec ยังเป็น "approved (in progress)" ว่า deploy แล้วหรือไม่ยังไม่ยืนยัน → deploy และปิด spec | todo | claude | `specs/README.md`; `specs/002-checkin-observability/spec.md` §Document control |
| G3 | `POST /apple-health` อยู่ใน code แต่ live E2E (TC-E2E-03, owner รัน Shortcut หนึ่งครั้ง) ยังไม่มีหลักฐาน → ยืนยัน E2E บน production | todo | owner | `specs/003-apple-health-ingest/spec.md` §Document control ("deploy and live E2E pending"); `docs/apple-health-shortcut.md` |

## Open questions

- Production รันเวอร์ชันไหน และ SPEC-002/003 deploy แล้วหรือยัง (เอกสารใน repo ระบุว่า pending; ไม่มี deploy log ใน repo)
