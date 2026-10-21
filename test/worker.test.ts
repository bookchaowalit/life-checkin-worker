import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/worker';

const env: Env = {
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_CHAT_ID: '1001',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  EMPIRE_CHECKIN_TOKEN: 'cell-token',
  HEALTH_ORIGIN: 'https://health.test',
  TIME_ORIGIN: 'https://time.test',
  DIARY_ORIGIN: 'https://diary.test',
};

const FULL = [
  'นอน 7',
  'น้ำหนัก 71.5',
  'ออกกำลัง 30 วิ่ง',
  'น้ำ 2',
  'อารมณ์ 4',
  'พลังงาน 3',
  'งาน CuteERP 5, freelance 1.5',
  'บันทึก วันนี้เหนื่อยแต่จบงาน',
].join('\n');

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: (url: string) => Response;

beforeEach(() => {
  calls = [];
  respond = () => new Response('{"id":1}', { status: 201, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function update(text: string | undefined, chatId = 1001, updateId = 77) {
  const message: Record<string, unknown> = { message_id: 5, date: 1792680000, chat: { id: chatId, type: 'private' }, from: { id: chatId } };
  if (text !== undefined) message.text = text; else message.sticker = { file_id: 'x' };
  return { update_id: updateId, message };
}

function post(body: unknown, secret: string | null = 'hook-secret') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return new Request('https://checkin.test/telegram', { method: 'POST', headers, body: JSON.stringify(body) });
}

const cellCalls = () => calls.filter((c) => !c.url.startsWith('https://api.telegram.org'));
const telegramCalls = () => calls.filter((c) => c.url.startsWith('https://api.telegram.org'));
const sentText = (c: Call) => JSON.parse(String(c.init.body)).text as string;

describe('worker', () => {
  it('AC-06 rejects bad secrets and other chats', async () => {
    expect((await worker.fetch(post(update(FULL), null), env, ctx)).status).toBe(401);
    expect((await worker.fetch(post(update(FULL), 'wrong'), env, ctx)).status).toBe(401);
    const other = await worker.fetch(post(update(FULL, 2002)), env, ctx);
    expect(other.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('AC-07 writes every record and replies with a summary', async () => {
    const res = await worker.fetch(post(update(FULL)), env, ctx);
    expect(res.status).toBe(200);
    const cells = cellCalls();
    expect(cells.filter((c) => c.url === 'https://health.test/v1/health-metrics')).toHaveLength(4);
    expect(cells.filter((c) => c.url === 'https://time.test/v1/time-logs')).toHaveLength(2);
    expect(cells.filter((c) => c.url === 'https://diary.test/v1/journal-entries')).toHaveLength(1);
    const keys = new Set<string>();
    for (const c of cells) {
      const h = c.init.headers as Record<string, string>;
      expect(c.init.method).toBe('POST');
      expect(h.Authorization).toBe('Bearer cell-token');
      expect(h['X-Empire-Channel']).toBe('workflow');
      expect(h['Idempotency-Key']).toContain('77');
      keys.add(h['Idempotency-Key']);
    }
    expect(keys.size).toBe(cells.length);
    const metric = JSON.parse(String(cells[0].init.body));
    expect(metric).toMatchObject({ source: 'telegram-checkin', metric_type: 'sleep_hours', value: 7, unit: 'h' });
    const journal = JSON.parse(String(cells.find((c) => c.url.startsWith('https://diary.test'))!.init.body));
    expect(journal).toMatchObject({ entry_type: 'daily', entry_date: '2026-10-22', mood: 4, energy_level: 3, content: 'วันนี้เหนื่อยแต่จบงาน', tags: 'checkin' });
    const replies = telegramCalls();
    expect(replies).toHaveLength(1);
    expect(replies[0].url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    const text = sentText(replies[0]);
    for (const part of ['นอน 7', '71.5', '30', 'น้ำ 2', 'CuteERP', 'freelance', 'อารมณ์ 4']) expect(text).toContain(part);
    expect(calls.length).toBeLessThan(50);
  });

  it('AC-08 reports a failed write in the reply', async () => {
    respond = (url) => url.includes('health.test')
      ? new Response('{"detail":"forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } })
      : new Response('{"id":1}', { status: 201, headers: { 'content-type': 'application/json' } });
    const res = await worker.fetch(post(update(FULL)), env, ctx);
    expect(res.status).toBe(200);
    expect(cellCalls().filter((c) => c.url.startsWith('https://time.test'))).toHaveLength(2);
    const text = sentText(telegramCalls()[0]);
    expect(text).toContain('403');
  });

  it('AC-09 sends the prompt on cron and on /checkin', async () => {
    await worker.scheduled({ cron: '30 14 * * *', scheduledTime: Date.parse('2026-10-22T14:30:00Z') } as ScheduledController, env, ctx);
    expect(telegramCalls()).toHaveLength(1);
    const prompt = sentText(telegramCalls()[0]);
    expect(prompt).toContain('22');
    expect(prompt).toContain('นอน');
    expect(JSON.parse(String(telegramCalls()[0].init.body)).chat_id).toBe('1001');
    calls = [];
    await worker.fetch(post(update('/checkin')), env, ctx);
    expect(telegramCalls()).toHaveLength(1);
    expect(cellCalls()).toEqual([]);
  });

  it('AC-10 ignores non-text and answers help', async () => {
    await worker.fetch(post(update(undefined)), env, ctx);
    expect(calls).toEqual([]);
    await worker.fetch(post(update('/start')), env, ctx);
    expect(cellCalls()).toEqual([]);
    expect(telegramCalls()).toHaveLength(1);
  });

  it('AC-11 health endpoint', async () => {
    const res = await worker.fetch(new Request('https://checkin.test/health'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ ok: true, service: 'solo-empire-checkin' });
    for (const v of Object.values(env)) expect(body).not.toContain(v);
    expect((await worker.fetch(new Request('https://checkin.test/nope'), env, ctx)).status).toBe(404);
  });
});
