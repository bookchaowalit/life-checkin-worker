---
title: SPEC-003 — Apple Health daily ingest (iOS Shortcut → health cell)
tags: [spec, sdd, tdd, health, apple-health, ios-shortcut]
created: 2026-10-28
updated: 2026-10-28
status: approved
---

# SPEC-003 — Apple Health daily ingest

Standard: ADR-0004 — TDD + SDD (architecture-docs `docs/architecture/decisions/ADR-0004-tdd-sdd-standard.md`).

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-003 / 1.0 |
| Status | **approved** by the owner 2026-10-28 ("ทำเลย" to the proposal: iOS Shortcut sends daily values over HTTPS into the health cell); deploy and live E2E pending |
| Repository / path | bookchaowalit/life-checkin-worker / `specs/003-apple-health-ingest/spec.md` |
| Owner (maker) | Claude Code |
| Approver | Owner (bookchaowalit). Decisions in §6 have proposed defaults the owner may change before G11 |
| Requirement links | solo-empire `repository-catalog/registries/data-sources.yaml` source `health-devices` (not-captured → captured); PRJ-LIFE-01 follow-on "Strava/Apple Health import" (`01-initiation.md`) |
| Main-only | yes (ADR-0004 rule 2, v1.1): red and green commits on `main`, red run local |
| Created / approved | 2026-10-28 / 2026-10-28 |

## 1. Problem and intent

- **Problem:** The health cell gets values only from the owner's typed 21:30 check-in. Apple Health already records steps, sleep, heart rate, active energy and workouts on the owner's iPhone/Watch, but nothing sends them to the platform. HealthKit has no cloud API: the data can leave only from the phone.
- **Outcome:** A personal iOS Shortcut, run by a daily Personal Automation, reads yesterday's totals from Health and POSTs one JSON body to `POST /apple-health` on this Worker. The Worker validates the values and writes one health-metric per value with `source = "apple-health"`. The morning brief, which already reads the health cell, shows them with no change.

## 2. Scope

| In scope | Out of scope (non-goals) |
|---|---|
| `POST /apple-health` with its own bearer secret `APPLE_HEALTH_TOKEN` (Worker secret, Infisical `/apple-health`) | A native iOS app or HealthKit background delivery |
| A fixed allowlist of daily metrics with units and ranges (§4) | Per-sample data (minute heart rate, sleep stages, GPS routes) |
| One record per metric per day, idempotency key `apple-health:<date>:<metric>` | Correcting a value already written (the cell has no DELETE; a corrected value needs PATCH by hand, see KE-11) |
| The Shortcut setup guide `docs/apple-health-shortcut.md` | Strava, Garmin or Google Fit (separate sources in the registry) |
| A JSON answer the Shortcut can show: counts and a Thai one-line message, never echoing values back to logs | Telegram messages for each ingest (the morning brief already reports the day) |

## 3. Request

```http
POST /apple-health
Authorization: Bearer <APPLE_HEALTH_TOKEN>
Content-Type: application/json

{"date":"2026-10-27","metrics":{"steps":8412,"sleep_hours":"7,25","resting_heart_rate":57,"active_energy":512.4,"exercise_minutes":34,"weight":71.4}}
```

- `date`: the day the values belong to, `YYYY-MM-DD`, Bangkok calendar. Accepted from 31 days before today (Bangkok) up to today.
- `metrics`: an object. A value may be a number or a numeric string with `.` or `,` as the decimal mark (Shortcuts formats numbers by the phone's locale). `null`, `""` and absent keys are skipped silently (Health had no data that day).

## 4. Metric allowlist

| Key (= `metric_type`) | Unit | Range (inclusive) | Health source in the Shortcut |
|---|---|---|---|
| `steps` | `count` | 0–100 000, whole number | Steps, sum for the day |
| `sleep_hours` | `h` | 0–16 | Sleep Analysis "Asleep", total for the night ending that morning |
| `resting_heart_rate` | `bpm` | 25–150 | Resting Heart Rate, latest of the day |
| `heart_rate_avg` | `bpm` | 25–220 | Heart Rate, average for the day |
| `hrv` | `ms` | 1–300 | Heart Rate Variability, average for the day |
| `active_energy` | `kcal` | 0–10 000 | Active Energy, sum for the day |
| `exercise_minutes` | `min` | 0–1 440 | Exercise Minutes (Apple exercise ring), sum |
| `walking_distance` | `km` | 0–200 | Walking + Running Distance, sum |
| `weight` | `kg` | 20–300 | Weight, latest of the day |

Values are rounded to 2 decimal places before writing. `sleep_hours`, `exercise_minutes` and `weight` share `metric_type` with the Telegram check-in; the `source` tells them apart.

## 5. Behaviour — scenarios

### AC-30 — Only the Shortcut's secret is accepted

- **Given** no `Authorization` header, a wrong bearer value, or a Worker with `APPLE_HEALTH_TOKEN` unset
- **When** `POST /apple-health` is called
- **Then** it answers 401 `{"ok":false}` and makes no cell call. The compare is constant-time.
- **Test:** `test/apple-health.test.ts > "AC-30 rejects missing or wrong secrets"` · level: integration

### AC-31 — Valid values are written to the health cell

- **Given** a valid body for yesterday with all nine metrics
- **When** it is posted with the right secret
- **Then** the Worker POSTs nine records to `<HEALTH_ORIGIN>/v1/health-metrics`, each with `source:"apple-health"`, `metric_type` = key, `value`, `unit` from §4, `recorded_at: "<date>T23:59:00+07:00"`, `metadata: "{\"date\":\"<date>\",\"via\":\"ios-shortcut\"}"`, the `evening-checkin` token, `X-Empire-Channel: workflow` and `Idempotency-Key: apple-health:<date>:<key>`
- **And** answers 200 `{"ok":true,"date":"<date>","written":[keys in §4 order],"failed":[],"rejected":[],"message":"✅ บันทึก Apple Health 9 ค่า · <Thai date>"}`
- **Test:** `test/apple-health.test.ts > "AC-31 writes each metric once with its unit"` · level: integration

### AC-32 — Bad input is rejected with a reason, never written

- **Given** each case, one assertion per case:
  1. invalid JSON, a body that is not an object, or `metrics` not an object → 400 `{"ok":false,"error":"invalid-body"}`
  2. `date` missing, not `YYYY-MM-DD`, not a real day, after today (Bangkok) or more than 31 days before → 400 `{"ok":false,"error":"invalid-date"}`
  3. a body over 16 KiB → 413 `{"ok":false,"error":"too-large"}`
  4. an unknown key → listed in `rejected` as `{"metric":"<key>","reason":"unknown"}` (at most 20 entries, keys cut to 40 characters)
  5. a non-numeric value, a fractional `steps`, or a value outside §4 → `{"metric":"<key>","reason":"out-of-range"}`
  6. `null`, `""` or an absent key → skipped, not in `rejected`
  7. `"7,25"` is read as 7.25; `"1,234"` for `steps` is out of range (fraction), not 1234
- **And** a body whose metrics are all skipped or rejected answers 422 with `written: []` and makes no cell call
- **Test:** `test/apple-health.test.ts > "AC-32 …"` (one `it` per case group) · level: unit + integration

### AC-33 — A failed cell write is reported

- **Given** the health cell answers 403 for `steps` and the network fails for `weight`
- **Then** the answer is 502 with `ok:false`, the other metrics in `written`, and `failed: [{"metric":"steps","status":403},{"metric":"weight","status":0}]`; `message` starts with `⚠️`
- **Test:** `test/apple-health.test.ts > "AC-33 reports failed writes"` · level: integration

### AC-34 — No value, date or secret reaches the logs

- **Given** a request with sentinel values (secret, weight)
- **Then** the one log line `apple_health` holds only counts (`written`, `failed` statuses, `rejected`) and the version; no sentinel appears in `console.log` output
- **Test:** `test/apple-health.test.ts > "AC-34 logs counts only"` · level: integration

## 6. Decisions (proposed defaults, owner may change)

| # | Question | Default |
|---|---|---|
| D-4 | Separate secret or reuse the cell token on the phone? | Separate `APPLE_HEALTH_TOKEN`: the phone never holds the platform token, and the secret opens one route only |
| D-5 | Which day does the Shortcut send? | Yesterday, at 07:00 every morning, so the day's totals and last night's sleep are complete |
| D-6 | A second run on the same day | Idempotency keeps the first write (KE-11). Re-run only after a failure |

## 7. Interfaces

| Interface | Change | Contract |
|---|---|---|
| `POST /apple-health` | new | §3, §5 |
| health cell `POST /v1/health-metrics` | caller | as AC-31; the cell takes `source` and `metric_type` as free strings (openapi checked 2026-10-28) |
| Worker secret `APPLE_HEALTH_TOKEN` | new | Infisical `/apple-health` `APPLE_HEALTH_TOKEN`; 32+ random bytes; the same value goes into the Shortcut |

## 8. Known errors

- **KE-11:** A value corrected in Health after the Shortcut ran is not updated: the idempotency key replays the first write. Fix by hand with `PATCH /v1/health-metrics/{id}`.
- **KE-12:** Personal Automations of type "Time of Day" run only when the phone is unlocked or recently used; a skipped day is sent next run only if the Shortcut sends more than one day (it does not, by D-5). The morning brief shows the gap.

## 9. Verification

- Unit + integration tests above, `fetch` mocked; CI coverage gate stays ≥ 96 %.
- After deploy: `curl` the route with the secret and a test date, check 200 and the rows in the cell, then the owner runs the Shortcut once (TC-E2E-03). Neon empire-platform is over quota until 2026-11-01, so live writes answer 503 until then.
