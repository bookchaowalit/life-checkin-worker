// SPEC-002 AC-28: an unexpected exception is logged without content. The parser is mocked so a
// test can make it throw; every other behaviour uses the real parser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../src/parse', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/parse')>();
  return {
    ...real,
    parseCheckin: (...args: Parameters<typeof real.parseCheckin>) => {
      if (fault.value !== undefined) throw fault.value;
      return real.parseCheckin(...args);
    },
  };
});

import worker, { type Env } from '../src/worker';

const MONITOR = 'https://monitor.test';
const env: Env = {
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_CHAT_ID: '1001',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  EMPIRE_CHECKIN_TOKEN: 'cell-token',
  HEALTH_ORIGIN: 'https://health.test',
  TIME_ORIGIN: 'https://time.test',
  DIARY_ORIGIN: 'https://diary.test',
  PUBLIC_ORIGIN: 'https://solo-empire-checkin.bookchaowalit.workers.dev',
  MONITOR_ORIGIN: MONITOR,
  HEARTBEAT_TOKEN: 'hb-token',
  CF_VERSION_METADATA: { id: 'v-123' },
};

type Call = { url: string; init: RequestInit };
let calls: Call[];
let logs: string[];

beforeEach(() => {
  fault.value = undefined;
  calls = [];
  logs = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/getWebhookInfo')) {
      return Response.json({ ok: true, result: { url: `${env.PUBLIC_ORIGIN}/telegram`, allowed_updates: ['message', 'edited_message'], pending_update_count: 0 } });
    }
    return Response.json({ ok: true });
  }));
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const reply = (text: string) => new Request('https://checkin.test/telegram', {
  method: 'POST',
  headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' },
  body: JSON.stringify({ update_id: 1, message: { message_id: 5, date: 1792680000, chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text } }),
});
const errorLines = () => logs.map((l) => JSON.parse(l)).filter((l) => l.event === 'error');
const sent = () => calls.filter((c) => c.url.endsWith('/sendMessage')).map((c) => JSON.parse(String(c.init.body)).text as string);

describe('SPEC-002 exceptions', () => {
  it('AC-28 an unexpected exception is logged without content: after the secret check on /telegram', async () => {
    fault.value = new Error('SENTINEL message นอน 7');
    const res = await worker.fetch(reply('SENTINEL-TEXT นอน 7'), env, ctx);
    expect(res.status).toBe(200);
    expect(errorLines()).toEqual([{ event: 'error', where: 'telegram', name: 'Error', version: 'v-123' }]);
    expect(logs.join('\n')).not.toContain('SENTINEL');
    expect(sent()).toEqual(['⚠️ ระบบขัดข้องระหว่างประมวลผลข้อความนี้ บางรายการอาจบันทึกแล้ว ตรวจสรุปพรุ่งนี้เช้าก่อนส่งซ้ำ']);
    expect(sent()[0]).not.toContain('ยังไม่ได้บันทึก');
    expect(sent()[0]).not.toContain('SENTINEL');
  });

  it('AC-28 a thrown non-Error is named "unknown"', async () => {
    fault.value = 'SENTINEL string';
    expect((await worker.fetch(reply('นอน 7'), env, ctx)).status).toBe(200);
    expect(errorLines()).toEqual([{ event: 'error', where: 'telegram', name: 'unknown', version: 'v-123' }]);
    expect(logs.join('\n')).not.toContain('SENTINEL');
    expect(sent()).toHaveLength(1);
  });

  it('AC-28 an exception on another route answers 500 with where "fetch"', async () => {
    const broken = {
      get url(): string { throw new Error('SENTINEL url'); },
      method: 'GET',
      headers: new Headers(),
    } as unknown as Request;
    const res = await worker.fetch(broken, env, ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
    expect(errorLines()).toEqual([{ event: 'error', where: 'fetch', name: 'Error', version: 'v-123' }]);
    expect(calls).toEqual([]);
    expect(logs.join('\n')).not.toContain('SENTINEL');
  });

  it('AC-28 an exception before the secret check answers 500 and sends nothing', async () => {
    const broken = {
      url: 'https://checkin.test/telegram',
      method: 'POST',
      headers: { get: () => { throw new Error('SENTINEL header'); } },
    } as unknown as Request;
    const res = await worker.fetch(broken, env, ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
    expect(errorLines()).toEqual([{ event: 'error', where: 'fetch', name: 'Error', version: 'v-123' }]);
    expect(calls).toEqual([]);
    expect(logs.join('\n')).not.toContain('SENTINEL');
  });

  it('AC-28 an error name that is not a plain identifier is logged as "unknown"', async () => {
    const odd = new Error('SENTINEL');
    odd.name = 'SENTINEL นอน 7 user text';
    fault.value = odd;
    await worker.fetch(reply('นอน 7'), env, ctx);
    expect(errorLines()).toEqual([{ event: 'error', where: 'telegram', name: 'unknown', version: 'v-123' }]);
    expect(logs.join('\n')).not.toContain('SENTINEL');
  });

  it('AC-28 a non-Error thrown in scheduled is named "unknown" and still reported', async () => {
    fault.value = 'SENTINEL string';
    await worker.scheduled({ cron: '30 14 * * *', scheduledTime: Date.parse('2026-10-23T14:30:00Z') } as ScheduledController, env, ctx);
    expect(errorLines()).toEqual([{ event: 'error', where: 'scheduled', name: 'unknown', version: 'v-123' }]);
    const hb = calls.find((c) => c.url === `${MONITOR}/heartbeat/checkin-daily`);
    expect(JSON.parse(String(hb?.init.body))).toEqual({ ok: false, failed: ['prompt-not-sent', 'exception'] });
  });

  it('AC-28 an exception in scheduled still reports a heartbeat', async () => {
    fault.value = new Error('SENTINEL in cron');
    await expect(worker.scheduled({ cron: '30 14 * * *', scheduledTime: Date.parse('2026-10-23T14:30:00Z') } as ScheduledController, env, ctx)).resolves.toBeUndefined();
    expect(errorLines()).toEqual([{ event: 'error', where: 'scheduled', name: 'Error', version: 'v-123' }]);
    const hb = calls.find((c) => c.url === `${MONITOR}/heartbeat/checkin-daily`);
    expect(JSON.parse(String(hb?.init.body))).toEqual({ ok: false, failed: ['prompt-not-sent', 'exception'] });
    expect(logs.join('\n')).not.toContain('SENTINEL');
  });
});
