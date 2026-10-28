// solo-empire-checkin: the 21:30 evening check-in over book_noti_bot.
// Cron sends the prompt; POST /telegram (the bot webhook) parses the owner's reply and writes it to
// the health, time and diary cells with the `evening-checkin` automation token. Values are never logged.

import { parseAppleHealth } from './apple-health';
import { parseCheckin, type Metric, type Parsed, type TimeLog } from './parse';

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  EMPIRE_CHECKIN_TOKEN: string;
  HEALTH_ORIGIN: string;
  TIME_ORIGIN: string;
  DIARY_ORIGIN: string;
  // SPEC-002: daily heartbeat and webhook check (vars + secret), version metadata binding
  PUBLIC_ORIGIN?: string;
  MONITOR_ORIGIN?: string;
  HEARTBEAT_TOKEN?: string;
  CF_VERSION_METADATA?: { id: string };
  // SPEC-003: the iOS Shortcut's bearer secret for POST /apple-health
  APPLE_HEALTH_TOKEN?: string;
}

const SERVICE = 'solo-empire-checkin';
const SOURCE = 'telegram-checkin';
// SPEC-003
const APPLE_SOURCE = 'apple-health';
const APPLE_MAX_BYTES = 16 * 1024;
// Cells sleep when idle and take up to ~4 s to wake, so writes get 12 s (in parallel), then Telegram 5 s.
// Telegram waits far longer than that for a webhook answer.
const CELL_TIMEOUT_MS = 12_000;
const TELEGRAM_TIMEOUT_MS = 5_000;
const TELEGRAM_TEXT_LIMIT = 4000; // Telegram's hard limit is 4096
const BOT_USERNAME = 'book_noti_bot';
// SPEC-002: the cron reports one heartbeat after checking the webhook registration.
const MONITOR_TIMEOUT_MS = 5_000;
const HEARTBEAT_JOB = 'checkin-daily';
const RECENT_ERROR_MS = 24 * 3_600_000;
const PENDING_BACKLOG = 10; // D-3
// Reason codes in the order they are reported; nothing else ever reaches the monitor or Telegram.
const REASONS = ['prompt-not-sent', 'webhook-info-unavailable', 'webhook-url-mismatch', 'webhook-updates-missing',
  'webhook-recent-error', 'webhook-pending-backlog', 'exception'] as const;
type Reason = (typeof REASONS)[number];
const ERROR_NOTICE = '⚠️ ระบบขัดข้องระหว่างประมวลผลข้อความนี้ บางรายการอาจบันทึกแล้ว ตรวจสรุปพรุ่งนี้เช้าก่อนส่งซ้ำ';
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const THAI_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์'];

interface TelegramMessage { message_id: number; date: number; text?: string; chat: { id: number; type?: string }; from?: { id: number } }
interface TelegramUpdate { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage }
interface WriteResult { label: string; ok: boolean; status?: number }

/** Every log line goes through here so it names the deployed version (SPEC-002 AC-27). */
function log(env: Env, event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields, version: env.CF_VERSION_METADATA?.id ?? 'unknown' }));
}

/** The error's name only, and only a plain identifier: messages and stacks may carry user text (SPEC-002 AC-28). */
const errorName = (error: unknown) =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : 'unknown';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function thaiDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `${THAI_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${THAI_MONTHS[d.getUTCMonth()]}`;
}

function hoursText(minutes: number): string {
  return minutes < 60 ? `${minutes} นาที` : `${Math.round((minutes / 60) * 100) / 100} ชม.`;
}

function metricText(m: Metric): string {
  switch (m.type) {
    case 'sleep_hours': return `นอน ${m.value} ชม.`;
    case 'weight': return `น้ำหนัก ${m.value} kg`;
    case 'water': return `น้ำ ${m.value} ลิตร`;
    case 'exercise_minutes': return `ออกกำลัง ${m.value} นาที${m.activity ? ` (${m.activity})` : ''}`;
  }
}

const DOMAIN_TEXT: Record<TimeLog['domain'], string> = { work: 'งาน', learning: 'เรียน', personal: 'ส่วนตัว' };
const timeText = (t: TimeLog) => `${DOMAIN_TEXT[t.domain]} ${t.activity === DOMAIN_TEXT[t.domain] ? '' : `${t.activity} `}${hoursText(t.minutes)}`;

function journalText(p: Parsed): string {
  const parts = [p.diary ? 'บันทึก diary' : 'บันทึกประจำวัน'];
  if (p.mood !== null) parts.push(`อารมณ์ ${p.mood}`);
  if (p.energy !== null) parts.push(`พลังงาน ${p.energy}`);
  return parts.join(' · ');
}

export function promptText(isoDate: string): string {
  return [
    `🌙 เช็คอินตอนค่ำ · ${thaiDate(isoDate)}`,
    'ตอบข้อความนี้ทีละบรรทัด ไม่ต้องตอบครบทุกข้อ เช่น',
    '',
    'นอน 7',
    'น้ำหนัก 71.5',
    'ออกกำลัง 30 วิ่ง',
    'น้ำ 2',
    'อารมณ์ 4   (1–5)',
    'พลังงาน 3   (1–5)',
    'งาน CuteERP 5, admin 1',
    'บันทึก วันนี้…',
    '',
    'บรรทัดที่ไม่ตรงรูปแบบจะเก็บเป็น diary ให้',
  ].join('\n');
}

const HELP = [
  'ส่งเช็คอินได้ตลอด ทีละบรรทัด เช่น',
  'นอน 7 · น้ำหนัก 71.5 · ออกกำลัง 30 วิ่ง · น้ำ 2',
  'อารมณ์ 4 · พลังงาน 3 (1–5)',
  'งาน CuteERP 5, admin 30 นาที · เรียน TypeScript 1:30',
  'บันทึก ข้อความ diary',
  '',
  '/checkin ส่งคำถามเช็คอินอีกรอบ',
].join('\n');

/** Never throws: after the secret check the webhook must answer 200, or Telegram retries. True when Telegram accepted it. */
async function sendMessage(env: Env, text: string): Promise<boolean> {
  const body = text.length > TELEGRAM_TEXT_LIMIT ? `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…` : text;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: body, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (!res.ok) log(env, 'telegram_send_failed', { status: res.status });
    return res.ok;
  } catch {
    log(env, 'telegram_send_failed', { status: 0 });
    return false;
  }
}

async function postCell(env: Env, url: string, body: unknown, key: string, label: string): Promise<WriteResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.EMPIRE_CHECKIN_TOKEN}`,
        'X-Empire-Channel': 'workflow',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CELL_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return { label, ok: res.ok, status: res.status };
  } catch {
    return { label, ok: false };
  }
}

async function writeCheckin(env: Env, p: Parsed, message: TelegramMessage): Promise<WriteResult[]> {
  // From the message, not update_id: Telegram reuses update ids after a quiet week, and a reused key
  // would replay an old record instead of storing the new one.
  const key = (kind: string, i: number) => `checkin:${message.chat.id}:${message.message_id}:${kind}:${i}`;
  const writes: Promise<WriteResult>[] = [];
  p.metrics.forEach((m, i) => writes.push(postCell(env, `${env.HEALTH_ORIGIN}/v1/health-metrics`, {
    source: SOURCE,
    metric_type: m.type,
    value: m.value,
    unit: m.unit,
    recorded_at: p.recordedAt,
    metadata: JSON.stringify({ checkin_date: p.date, ...(m.activity ? { activity: m.activity } : {}) }),
  }, key('metric', i), metricText(m))));
  p.timeLogs.forEach((t, i) => writes.push(postCell(env, `${env.TIME_ORIGIN}/v1/time-logs`, {
    log_date: p.date,
    domain: t.domain,
    activity: t.activity,
    minutes: t.minutes,
    notes: SOURCE,
  }, key('time', i), timeText(t))));
  if (p.diary !== null || p.mood !== null || p.energy !== null) {
    writes.push(postCell(env, `${env.DIARY_ORIGIN}/v1/journal-entries`, {
      entry_type: 'daily',
      title: `Check-in ${p.date}`,
      content: p.diary ?? '(เช็คอินตอนค่ำ ไม่มีข้อความ)',
      mood: p.mood,
      energy_level: p.energy,
      entry_date: p.date,
      tags: 'checkin',
    }, key('journal', 0), journalText(p)));
  }
  return Promise.all(writes);
}

function summary(p: Parsed, results: WriteResult[]): string {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const lines = [ok.length ? `✅ บันทึกแล้ว · ${thaiDate(p.date)}` : `⚠️ ยังไม่ได้บันทึก · ${thaiDate(p.date)}`];
  for (const r of ok) lines.push(`• ${r.label}`);
  if (failed.length) {
    lines.push('', 'บันทึกไม่สำเร็จ:');
    for (const r of failed) lines.push(`• ${r.label} (${r.status ? `HTTP ${r.status}` : 'เชื่อมต่อไม่ได้'})`);
  }
  if (p.rejected.length) {
    lines.push('', 'อ่านไม่ได้ ไม่ได้บันทึก:');
    for (const r of p.rejected) lines.push(`• ${r.line} — ${r.reason}`);
  }
  return lines.join('\n');
}

async function handleTelegram(request: Request, env: Env, authorised: () => void): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) return json({ ok: false }, 401);
  authorised();

  let update: TelegramUpdate;
  try { update = await request.json(); } catch { return json({ ok: false }, 400); }

  const fromOwner = (m: TelegramMessage | undefined): m is TelegramMessage =>
    !!m && m.chat?.type === 'private' && String(m.chat.id) === env.TELEGRAM_CHAT_ID && String(m.from?.id) === env.TELEGRAM_CHAT_ID;
  if (fromOwner(update.edited_message)) {
    await sendMessage(env, 'แก้ข้อความเดิมแล้วระบบไม่บันทึกซ้ำให้ ส่งค่าที่ถูกต้องเป็นข้อความใหม่ได้เลย');
    return json({ ok: true });
  }
  const message = update.message;
  if (!fromOwner(message)) return json({ ok: true });
  const text = message.text?.trim();
  if (!text) return json({ ok: true });

  if (text.startsWith('/')) {
    const [command, mention] = text.split(/\s+/)[0].toLowerCase().split('@');
    if (mention && mention !== BOT_USERNAME) return json({ ok: true });
    if (command === '/checkin') await sendMessage(env, promptText(parseCheckin('', new Date(message.date * 1000)).date));
    else await sendMessage(env, HELP);
    return json({ ok: true });
  }

  const parsed = parseCheckin(text, new Date(message.date * 1000));
  const empty = !parsed.metrics.length && !parsed.timeLogs.length && parsed.diary === null && parsed.mood === null && parsed.energy === null;
  if (empty && !parsed.rejected.length) {
    await sendMessage(env, HELP);
    return json({ ok: true });
  }
  const results = await writeCheckin(env, parsed, message);
  // Always 200 after the secret check: a Telegram retry would only repeat what the reply already reports.
  await sendMessage(env, summary(parsed, results));
  log(env, 'checkin', { written: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.status ?? 0), rejected: parsed.rejected.length });
  return json({ ok: true });
}

/** SPEC-003: one day of Apple Health totals from the owner's iOS Shortcut. Logs counts only. */
async function handleAppleHealth(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? '';
  if (!env.APPLE_HEALTH_TOKEN || !safeEqual(auth, `Bearer ${env.APPLE_HEALTH_TOKEN}`)) return json({ ok: false }, 401);

  const text = await request.text();
  if (new TextEncoder().encode(text).length > APPLE_MAX_BYTES) return json({ ok: false, error: 'too-large' }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'invalid-body' }, 400); }
  const day = parseAppleHealth(body, new Date());
  if ('error' in day) return json({ ok: false, error: day.error }, 400);

  const results = await Promise.all(day.metrics.map((m) => postCell(env, `${env.HEALTH_ORIGIN}/v1/health-metrics`, {
    source: APPLE_SOURCE,
    metric_type: m.type,
    value: m.value,
    unit: m.unit,
    recorded_at: `${day.date}T23:59:00+07:00`,
    metadata: JSON.stringify({ date: day.date, via: 'ios-shortcut' }),
  }, `${APPLE_SOURCE}:${day.date}:${m.type}`, m.type)));
  const written = results.filter((r) => r.ok).map((r) => r.label);
  const failed = results.filter((r) => !r.ok).map((r) => ({ metric: r.label, status: r.status ?? 0 }));
  log(env, 'apple_health', { written: written.length, failed: failed.map((f) => f.status), rejected: day.rejected.length });

  const ok = written.length > 0 && failed.length === 0;
  const message = ok
    ? `✅ บันทึก Apple Health ${written.length} ค่า · ${thaiDate(day.date)}`
    : `⚠️ Apple Health · ${thaiDate(day.date)}: บันทึก ${written.length}, ไม่สำเร็จ ${failed.length}, อ่านไม่ได้ ${day.rejected.length}`;
  const status = ok ? 200 : failed.length ? 502 : 422;
  return json({ ok, date: day.date, written, failed, rejected: day.rejected, message }, status);
}

interface WebhookInfo { url?: string; allowed_updates?: string[]; last_error_date?: number; pending_update_count?: number }

/** Compare the live webhook registration with what this Worker expects. Reads no field into a log. */
async function checkWebhook(env: Env, runMs: number): Promise<Reason[]> {
  let info: WebhookInfo;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, {
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return ['webhook-info-unavailable'];
    }
    const body = (await res.json()) as { ok?: boolean; result?: WebhookInfo };
    if (!body.ok || !body.result) return ['webhook-info-unavailable'];
    info = body.result;
  } catch {
    return ['webhook-info-unavailable'];
  }
  const reasons: Reason[] = [];
  if (!info.url || info.url !== `${env.PUBLIC_ORIGIN}/telegram`) reasons.push('webhook-url-mismatch');
  // Absent or empty allowed_updates is Telegram's default, which includes both types.
  const updates = info.allowed_updates;
  if (updates?.length && !(updates.includes('message') && updates.includes('edited_message'))) reasons.push('webhook-updates-missing');
  // last_error_date is Unix time in seconds.
  if (typeof info.last_error_date === 'number' && runMs - info.last_error_date * 1000 < RECENT_ERROR_MS) reasons.push('webhook-recent-error');
  if (typeof info.pending_update_count === 'number' && info.pending_update_count >= PENDING_BACKLOG) reasons.push('webhook-pending-backlog');
  return reasons;
}

/** One attempt, never throws (SPEC-002 AC-26). The body holds only reason codes. */
async function reportHeartbeat(env: Env, reasons: Set<Reason>): Promise<void> {
  if (!env.HEARTBEAT_TOKEN || !env.MONITOR_ORIGIN) {
    log(env, 'heartbeat_failed', { status: -1 });
    return;
  }
  const failed = REASONS.filter((r) => reasons.has(r));
  try {
    const res = await fetch(`${env.MONITOR_ORIGIN}/heartbeat/${HEARTBEAT_JOB}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.HEARTBEAT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: failed.length === 0, failed }),
      signal: AbortSignal.timeout(MONITOR_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (!res.ok) log(env, 'heartbeat_failed', { status: res.status });
  } catch {
    log(env, 'heartbeat_failed', { status: 0 });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    let authorised = false;
    try {
      const { pathname } = new URL(request.url);
      if (pathname === '/health' && request.method === 'GET') return json({ ok: true, service: SERVICE });
      if (pathname === '/telegram' && request.method === 'POST') return await handleTelegram(request, env, () => { authorised = true; });
      if (pathname === '/apple-health' && request.method === 'POST') return await handleAppleHealth(request, env);
      return json({ ok: false }, 404);
    } catch (error) {
      log(env, 'error', { where: authorised ? 'telegram' : 'fetch', name: errorName(error) });
      // After the secret check Telegram must get 200 (AD-06); the owner learns about it in the chat.
      if (!authorised) return json({ ok: false }, 500);
      await sendMessage(env, ERROR_NOTICE);
      return json({ ok: true });
    }
  },

  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const reasons = new Set<Reason>();
    let promptSent = false;
    try {
      promptSent = await sendMessage(env, promptText(parseCheckin('', new Date(event.scheduledTime)).date));
      if (!promptSent) reasons.add('prompt-not-sent');
      for (const reason of await checkWebhook(env, event.scheduledTime)) reasons.add(reason);
    } catch (error) {
      log(env, 'error', { where: 'scheduled', name: errorName(error) });
      if (!promptSent) reasons.add('prompt-not-sent');
      reasons.add('exception');
    }
    await reportHeartbeat(env, reasons);
  },
};
