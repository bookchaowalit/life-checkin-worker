// solo-empire-checkin: the 21:30 evening check-in over book_noti_bot.
// Cron sends the prompt; POST /telegram (the bot webhook) parses the owner's reply and writes it to
// the health, time and diary cells with the `evening-checkin` automation token. Values are never logged.

import { parseCheckin, type Metric, type Parsed, type TimeLog } from './parse';

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  EMPIRE_CHECKIN_TOKEN: string;
  HEALTH_ORIGIN: string;
  TIME_ORIGIN: string;
  DIARY_ORIGIN: string;
}

const SERVICE = 'solo-empire-checkin';
const SOURCE = 'telegram-checkin';
const REQUEST_TIMEOUT_MS = 8_000;
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const THAI_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์'];

interface TelegramMessage { date: number; text?: string; chat: { id: number } }
interface TelegramUpdate { update_id: number; message?: TelegramMessage }
interface WriteResult { label: string; ok: boolean; status?: number }

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

async function sendMessage(env: Env, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return { label, ok: res.ok, status: res.status };
  } catch {
    return { label, ok: false };
  }
}

async function writeCheckin(env: Env, p: Parsed, updateId: number): Promise<WriteResult[]> {
  const key = (kind: string, i: number) => `checkin:${updateId}:${kind}:${i}`;
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

async function handleTelegram(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) return json({ ok: false }, 401);

  let update: TelegramUpdate;
  try { update = await request.json(); } catch { return json({ ok: false }, 400); }

  const message = update.message;
  if (!message || String(message.chat?.id) !== env.TELEGRAM_CHAT_ID) return json({ ok: true });
  const text = message.text?.trim();
  if (!text) return json({ ok: true });

  if (text.startsWith('/')) {
    const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
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
  const results = await writeCheckin(env, parsed, update.update_id);
  // Always 200 after the secret check: a Telegram retry would only repeat what the reply already reports.
  await sendMessage(env, summary(parsed, results));
  console.log(JSON.stringify({ event: 'checkin', written: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.status ?? 0), rejected: parsed.rejected.length }));
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health' && request.method === 'GET') return json({ ok: true, service: SERVICE });
    if (pathname === '/telegram' && request.method === 'POST') return handleTelegram(request, env);
    return json({ ok: false }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await sendMessage(env, promptText(parseCheckin('', new Date(event.scheduledTime)).date));
  },
};
