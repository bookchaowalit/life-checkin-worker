---
title: SPEC-004 — Apple Notes ingest (iOS Shortcut → knowledge store)
tags: [spec, sdd, tdd, apple-notes, ios-shortcut, knowledge-store]
created: 2026-11-19
updated: 2026-11-19
status: draft
---

# SPEC-004 — Apple Notes ingest

Standard: ADR-0004 — TDD + SDD (architecture-docs `docs/architecture/decisions/ADR-0004-tdd-sdd-standard.md`).

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-004 / 0.1 |
| Status | **draft**. The owner asked for it on 2026-11-19 ("เขียน spec เลย", after the proposal to send notes from an iOS Shortcut). It needs the owner's approval of §7 before the red commit |
| Repository / path | bookchaowalit/life-checkin-worker / `specs/004-apple-notes-ingest/spec.md` |
| Owner (maker) | Claude Code |
| Approver | Owner (bookchaowalit) |
| Requirement links | the owner's question of 2026-11-19 (can Apple Notes sync with our system); hosted document store (platform-knowledge-api SPEC-002); the pattern from SPEC-003 (Apple Health) |
| Depends on | platform-knowledge-api `PUT/GET /api/v1/store/document` (SPEC-002 v1.2); a new writer key that the API trusts (D-11) |
| Created | 2026-11-19 |

## 1. Problem and intent

- **Problem:** The owner writes notes in Apple Notes on the iPhone, and nothing in the platform can see them. They are not in the knowledge store, so the knowledge MCP, Knowledge Hub `/private` and the agents cannot search them. Apple offers no API for iCloud Notes. The only supported reader is the phone itself, through Shortcuts.
- **Outcome:** An iOS Shortcut runs as a daily Personal Automation and can also be run from the Share Sheet. It finds the notes changed in the chosen folders and sends **one note per request** to `POST /apple-notes` on this Worker. The Worker checks the note and stores it as Markdown with front matter in the knowledge store at `knowledge-base:apple-notes/<note_id>.md`. The store keeps every version. Agents and Knowledge Hub then read the notes like any other private document.
- **Direction:** one way only, from the phone to the store. Apple Notes is the source of truth.

## 2. Scope

| In scope | Out of scope (non-goals) |
|---|---|
| `POST /apple-notes` with its own bearer secret `APPLE_NOTES_TOKEN` (Worker secret, Infisical `/apple-notes`) | Writing back into Apple Notes, or two-way sync |
| A folder allowlist enforced twice: by the Shortcut's filter and by the Worker var `APPLE_NOTES_FOLDERS` | A Mac reader (`NoteStore.sqlite`, AppleScript) or calls to iCloud.com's private API |
| Text and Markdown bodies (Shortcuts "Make Markdown from Rich Text") | Images, drawings, scans, PDFs, audio and other attachments (KE-15) |
| Create, update and skip-if-unchanged, with `if_version` against the store | Deleting from the store when a note is deleted on the phone (KE-13, a later spec) |
| A refusal of bodies that look like secrets (§5 AC-43) | Locked notes (Shortcuts cannot read them, KE-16) |
| The Shortcut setup guide `docs/apple-notes-shortcut.md` | A Telegram message for each note |

## 3. Request

```http
POST /apple-notes
Authorization: Bearer <APPLE_NOTES_TOKEN>
Content-Type: application/json

{"created_at":"2026-11-18T09:41:07+07:00","modified_at":"2026-11-19T06:12:55+07:00","folder":"Sync","title":"Ideas for Q1","body":"# Ideas for Q1\n\n- …","pinned":false}
```

| Field | Rule |
|---|---|
| `created_at` | required. ISO 8601 with an offset (Shortcuts "Format Date → ISO 8601"). Not after `modified_at` + 60 s |
| `modified_at` | required. ISO 8601 with an offset. Not more than 5 minutes after the Worker's clock |
| `folder` | required. 1–100 characters, compared with `APPLE_NOTES_FOLDERS` after Unicode NFC and trimming |
| `title` | optional. At most 200 characters. When it is missing, the first non-empty body line is used, cut to 200 |
| `body` | required. A UTF-8 string, at most 1 MiB once encoded. It must not be empty after trimming |
| `pinned` | optional boolean, `false` by default |

The whole request body is at most 1.1 MiB. Keys other than these are ignored and never stored.

## 4. Stored document

- **note_id:** the first 16 hex characters of `sha256("apple-notes:" + created_at converted to UTC, to the second, as YYYY-MM-DDTHH:MM:SSZ)`. Shortcuts gives no stable note identifier. The creation time stays the same through renames, edits and folder moves (KE-14 covers collisions).
- **Path:** space `knowledge-base`, path `apple-notes/<note_id>.md`, visibility `private`, media type `text/markdown; charset=utf-8`.
- **Content:**

```markdown
---
title: "Ideas for Q1"
folder: "Sync"
created: "2026-11-18T02:41:07Z"
modified: "2026-11-18T23:12:55Z"
pinned: false
source: apple-notes
via: ios-shortcut
note_id: 3f9a…
---

<body as sent>
```

Every string value in the front matter is written as a JSON string. JSON strings are valid YAML, so a title holding `---`, `:` or a newline cannot break the block. Times are stored in UTC.

## 5. Behaviour — scenarios

### AC-40 — Only the Shortcut's secret is accepted

- **Given** no `Authorization` header, a wrong bearer value, or a Worker with `APPLE_NOTES_TOKEN` unset
- **When** `POST /apple-notes` is called
- **Then** it answers 401 `{"ok":false}` and makes no store call. The compare is constant-time, using the same `safeEqual` as SPEC-003.
- **Test:** `test/apple-notes.test.ts > "AC-40 rejects missing or wrong secrets"` · level: integration

### AC-41 — Bad input is rejected with a reason, never stored

- **Given** each case, one assertion per case:
  1. invalid JSON, a body that is not an object, or a field of the wrong type → 400 `{"ok":false,"error":"invalid-body"}`
  2. `created_at` or `modified_at` missing, not ISO 8601 with an offset, `created_at` after `modified_at` + 60 s, or `modified_at` more than 5 minutes in the future → 400 `invalid-date`
  3. a request body over 1.1 MiB, or a `body` over 1 MiB → 413 `too-large`
  4. a `body` that is empty after trimming (a locked note sends an empty body) → 422 `empty`
  5. a `folder` that is not in `APPLE_NOTES_FOLDERS`, or the var unset or empty → 403 `folder-not-allowed`
- **And** none of these cases makes a store call
- **Test:** `test/apple-notes.test.ts > "AC-41 …"` (one `it` per case) · level: unit + integration

### AC-42 — A new or changed note is stored, an unchanged one is skipped

- **Given** a valid note
- **When** it is posted with the right secret
- **Then** the Worker GETs `apple-notes/<note_id>.md`:
  - **404** → PUT with `if_version: 0` → 200 `{"ok":true,"status":"created","note_id":"…","version":1}`
  - **found, and its front-matter `modified` ≥ the request's `modified_at`** → no PUT → 200 `status:"unchanged"` with the stored version
  - **found and older** → PUT with `if_version` = the stored version → 200 `status:"updated"` with the new version
- **And** each store call carries a writer JWT (D-11) with scope `knowledge:write` for the PUT and `knowledge:read` for the GET
- **And** a 409 from the PUT leads to one fresh GET and one more try. If the second try also fails, the answer is 409 `{"ok":false,"error":"conflict"}`
- **Test:** `test/apple-notes.test.ts > "AC-42 creates, updates and skips"` · level: integration

### AC-43 — A body that looks like a secret is refused

- **Given** a body or title holding any of these: a PEM header `-----BEGIN … PRIVATE KEY-----`, `ghp_`/`gho_`/`github_pat_` tokens, `sk-` keys of 20 or more characters, `AKIA` followed by 16 upper-case letters or digits, `xox[abpr]-` Slack tokens, or a JWT (`eyJ…` with three dot-separated parts)
- **When** it is posted
- **Then** the answer is 422 `{"ok":false,"error":"secret-like","message":"⚠️ โน้ตนี้มีข้อความคล้าย secret จึงไม่ถูกเก็บ ให้ย้ายไปไว้ใน Infisical หรือ password manager"}`. Nothing is stored, and the pattern that matched is not logged.
- **Test:** `test/apple-notes.test.ts > "AC-43 refuses secret-like bodies"` (one case per pattern, plus near-misses that are allowed) · level: unit

### AC-44 — A failed store call is reported

- **Given** the store answers 401, 403, 5xx or times out (10 s) on the GET or the PUT
- **Then** the answer is 502 `{"ok":false,"error":"store","status":<code or 0>,"message":"⚠️ …"}`, and the Shortcut shows the message
- **Test:** `test/apple-notes.test.ts > "AC-44 reports store failures"` · level: integration

### AC-45 — No note text, title, folder or secret reaches the logs

- **Given** a request with sentinel strings in `title`, `body`, `folder` and the secret
- **Then** the one log line `apple_notes` holds only `status`, `error`, the store status code, the body size bucket (`<1k`, `<10k`, `<100k`, `<1M`) and the version. No sentinel appears in `console.log` output.
- **Test:** `test/apple-notes.test.ts > "AC-45 logs no content"` · level: integration

## 6. Shortcut behaviour (covered by the guide, checked by TC-E2E-04)

- **Daily run:** a Personal Automation "Time of Day" at 06:30, set to Run Immediately. It runs **Find Notes** where Folder is one of the allowed folders and Last Modified Date is in the last 2 days, then **Repeat with Each** note: Make Markdown from Rich Text, then POST. At the end it shows one notification with the counts (created / updated / unchanged / failed).
- **Share Sheet run:** the same Shortcut accepts Notes as input, so the owner can send one note at once. The folder rule still applies.
- **Catch-up:** if the phone missed runs, a run by hand asks "how many days back?" (default 2). Notes that did not change come back `unchanged`, so re-sending them costs nothing.

## 7. Decisions (proposed defaults, owner may change)

| # | Question | Default |
|---|---|---|
| D-7 | Where are notes stored? | **knowledge store**, space `knowledge-base`, prefix `apple-notes/`. This gives versions, the knowledge MCP and Knowledge Hub `/private`. The alternative is raw JSON in an R2 Bronze bucket (cheaper, but agents could not search it) |
| D-8 | Which folders are sent? | Only folders the owner names in `APPLE_NOTES_FOLDERS`. To start, one folder called `Sync`, so nothing is shared until the owner moves a note there on purpose |
| D-9 | When does it run? | Daily at 06:30 with a 2-day window, plus the Share Sheet |
| D-10 | A note deleted on the phone | Stays in the store in v1 (KE-13). A later spec may add a weekly list of all note ids, and archive ids that are missing from it |
| D-11 | How does the Worker write to the store? | Its own RS256 key: the Worker secret `KNOWLEDGE_WRITER_KEY` (PKCS#8, Infisical `/apple-notes`). The Worker signs a 300 s JWT through WebCrypto with the issuer, audience and owner subject the store expects. The public half is added as one more PEM block in Railway `KNOWLEDGE_API_AUTH_EXTRA_PUBLIC_KEY`, and removing that block revokes the Worker. The phone holds only `APPLE_NOTES_TOKEN`, which opens this one route |
| D-12 | Which Worker? | This one (`solo-empire-checkin`). It already hosts the SPEC-003 phone ingest and its tests, and a new Worker would add a deploy and a monitor for a single route |
| D-13 | Store origin | `KNOWLEDGE_ORIGIN` var. Use the edge gateway route for knowledge if it passes a Worker-signed JWT through. If not, use the direct Railway origin. Check this before the red commit |

## 8. Interfaces

| Interface | Change | Contract |
|---|---|---|
| `POST /apple-notes` | new | §3, §5 |
| knowledge store `GET/PUT /api/v1/store/document` | caller | platform-knowledge-api SPEC-002 v1.2. The path `apple-notes/<16 hex>.md` passes its AC-06 path rules |
| Worker secret `APPLE_NOTES_TOKEN` | new | Infisical `/apple-notes`, 32 or more random bytes. The same value goes into the Shortcut |
| Worker secret `KNOWLEDGE_WRITER_KEY` | new | Infisical `/apple-notes`. Its public half is in knowledge-api `KNOWLEDGE_API_AUTH_EXTRA_PUBLIC_KEY` |
| Worker vars `APPLE_NOTES_FOLDERS`, `KNOWLEDGE_ORIGIN` | new | a JSON array of folder names; the origin in D-13 |

## 9. Known errors and limits

- **KE-13:** Deleting a note on the phone does not delete it from the store (D-10).
- **KE-14:** Two notes created in the same second get the same `note_id`, and the newer edit replaces the older note. This is rare when typing. A note made from an import or a duplicate can hit it. The store's history keeps both versions.
- **KE-15:** Images, drawings, scans and attachments are lost. Checklists and tables arrive as Markdown text, as far as "Make Markdown from Rich Text" can convert them.
- **KE-16:** Locked notes cannot be read by Shortcuts. They arrive empty and are refused with `empty` (AC-41 case 4).
- **KE-17:** An edit made in the store is replaced by the next phone edit, because the flow is one way.
- **KE-18:** Like KE-12, a Time-of-Day automation can be skipped while the phone is locked or off. The 2-day window and the catch-up run cover short gaps.

## 10. Security and privacy

- The phone holds one narrow secret, never the store key (D-11). Every document is `private` and readable only behind Cloudflare Access or with the owner's tokens.
- Two allowlists keep notes out by default (D-8). AC-43 stops the most common way secrets leak into a document store.
- No note content, title or folder is logged (AC-45). Workers invocation logs stay off, as in SPEC-002.
- This repository is public. Tests use made-up notes only.

## 11. Verification

- Unit and integration tests above, with `fetch` and WebCrypto signing mocked. The CI coverage gate stays at 96 % or more.
- **Owner items before deploy:** approve §7; create `APPLE_NOTES_TOKEN` and the writer key in Infisical `/apple-notes` (https://app.infisical.com, folder `/apple-notes`); approve adding the public key block to Railway `KNOWLEDGE_API_AUTH_EXTRA_PUBLIC_KEY` on `solo-knowledge-api` (https://railway.com/project/024d8312-5750-411b-8702-d0634153a765).
- **After deploy:** `curl` a made-up note into folder `Sync` and check `created`; send it again and check `unchanged`; edit it and check `updated` with version 2; then read it back with the knowledge MCP and on Knowledge Hub `/private`. Delete the test document with `if_version`.
- **TC-E2E-04:** the owner builds the Shortcut from `docs/apple-notes-shortcut.md`, moves one real note into `Sync`, runs the Shortcut once, and confirms the note on `/private`.

## 12. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 0.1 | 2026-11-19 | First draft | — |
