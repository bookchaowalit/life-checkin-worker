// SPEC-002: daily heartbeat with webhook check (AC-23, AC-24, AC-26), version on log lines (AC-27),
// Workers Logs config (AC-29). AC-28 (exceptions) lives in errors.test.ts because it mocks the parser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/worker';
import toml from '../wrangler.toml?raw';

const PUBLIC = 'https://solo-empire-checkin.bookchaowalit.workers.dev';
const MONITOR = 'https://monitor.test';
const env: Env = {
  TELEGRAM_BOT_TOKEN: 'bot-token-SENTINEL',
  TELEGRAM_CHAT_ID: '1001',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  EMPIRE_CHECKIN_TOKEN: 'cell-token',
  HEALTH_ORIGIN: 'https://health.test',
  TIME_ORIGIN: 'https://time.test',
  DIARY_ORIGIN: 'https://diary.test',
  PUBLIC_ORIGIN: PUBLIC,
  MONITOR_ORIGIN: MONITOR,
  HEARTBEAT_TOKEN: 'hb-token-SENTINEL',
  CF_VERSION_METADATA: { id: 'v-123' },
};

const RUN = Date.parse('2026-10-23T14:30:00Z');
const HEALTHY = {
  ok: true,
  result: { url: `${PUBLIC}/telegram`, allowed_updates: ['message', 'edited_message'], pending_update_count: 0 },
};

type Call = { url: string; init: RequestInit };
let calls: Call[];
let logs: string[];
let sendStatus: number;
let sendThrows: boolean;
let webhookInfo: () => Response;
let monitor: () => Response;

beforeEach(() => {
  calls = [];
  logs = [];
  sendStatus = 200;
  sendThrows = false;
  webhookInfo = () => Response.json(HEALTHY);
  monitor = () => Response.json({ recorded: true });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/sendMessage')) {
      if (sendThrows) throw new TypeError('network');
      return new Response('{}', { status: sendStatus });
    }
    if (url.endsWith('/getWebhookInfo')) return webhookInfo();
    if (url.startsWith(MONITOR)) return monitor();
    return new Response('{"id":1}', { status: 201 });
  }));
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const run = (e: Env = env) => worker.scheduled({ cron: '30 14 * * *', scheduledTime: RUN } as ScheduledController, e, ctx);
const heartbeats = () => calls.filter((c) => c.url === `${MONITOR}/heartbeat/checkin-daily`);
const heartbeatBody = () => JSON.parse(String(heartbeats()[0].init.body));
const info = (result: Record<string, unknown>) => () => Response.json({ ok: true, result: { ...HEALTHY.result, ...result } });
const SENTINELS = ['SENTINEL', 'hook-secret', 'cell-token', '1001'];
const noSecretsIn = (texts: string[]) => {
  for (const text of texts) for (const s of SENTINELS) expect(text).not.toContain(s);
};

describe('SPEC-002 daily heartbeat', () => {
  it('AC-23 the daily run reports a healthy heartbeat', async () => {
    await run();
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['sendMessage', 'getWebhookInfo', 'checkin-daily']);
    const hb = heartbeats()[0];
    const headers = new Headers(hb.init.headers);
    expect(hb.init.method).toBe('POST');
    expect(headers.get('authorization')).toBe('Bearer hb-token-SENTINEL');
    expect(headers.get('content-type')).toBe('application/json');
    expect(String(hb.init.body)).toBe('{"ok":true,"failed":[]}');
  });

  it.each([
    ['prompt send answers 500', () => { sendStatus = 500; }, ['prompt-not-sent']],
    ['prompt send network error', () => { sendThrows = true; }, ['prompt-not-sent']],
    ['getWebhookInfo answers 502', () => { webhookInfo = () => new Response('bad', { status: 502 }); }, ['webhook-info-unavailable']],
    ['getWebhookInfo ok:false', () => { webhookInfo = () => Response.json({ ok: false }); }, ['webhook-info-unavailable']],
    ['getWebhookInfo invalid JSON', () => { webhookInfo = () => new Response('not json'); }, ['webhook-info-unavailable']],
    ['url empty', () => { webhookInfo = info({ url: '' }); }, ['webhook-url-mismatch']],
    ['url elsewhere', () => { webhookInfo = info({ url: 'https://evil.example/SENTINEL-URL' }); }, ['webhook-url-mismatch']],
    ['allowed_updates only message (DEF-15)', () => { webhookInfo = info({ allowed_updates: ['message'] }); }, ['webhook-updates-missing']],
    ['recent error', () => { webhookInfo = info({ last_error_date: (RUN - 3_600_000) / 1000, last_error_message: 'SENTINEL-MSG' }); }, ['webhook-recent-error']],
    ['backlog of 10', () => { webhookInfo = info({ pending_update_count: 10 }); }, ['webhook-pending-backlog']],
    ['prompt and url together', () => { sendStatus = 500; webhookInfo = info({ url: 'https://evil.example/x' }); }, ['prompt-not-sent', 'webhook-url-mismatch']],
    ['every webhook reason at once, in the fixed order', () => {
      sendStatus = 500;
      webhookInfo = info({ url: 'https://evil.example/x', allowed_updates: ['message'], last_error_date: (RUN - 60_000) / 1000, pending_update_count: 50 });
    }, ['prompt-not-sent', 'webhook-url-mismatch', 'webhook-updates-missing', 'webhook-recent-error', 'webhook-pending-backlog']],
  ])('AC-24 the daily run reports each failure reason and nothing else: %s', async (_name, setup, failed) => {
    setup();
    await run();
    expect(heartbeatBody()).toEqual({ ok: false, failed });
    noSecretsIn([String(heartbeats()[0].init.body), ...logs]);
  });

  it.each([
    ['absent allowed_updates (Telegram default)', info({ allowed_updates: undefined })],
    ['empty allowed_updates', info({ allowed_updates: [] })],
    ['error older than 24 h', info({ last_error_date: (RUN - 25 * 3_600_000) / 1000 })],
    ['backlog of 9', info({ pending_update_count: 9 })],
  ])('AC-24 is not a failure: %s', async (_name, response) => {
    webhookInfo = response;
    await run();
    expect(heartbeatBody()).toEqual({ ok: true, failed: [] });
  });

  it('AC-24 a getWebhookInfo timeout counts as unavailable', async () => {
    webhookInfo = () => { throw new DOMException('timed out', 'TimeoutError'); };
    await run();
    expect(heartbeatBody()).toEqual({ ok: false, failed: ['webhook-info-unavailable'] });
  });
});

describe('SPEC-002 reporting never breaks the check-in', () => {
  it.each([
    ['monitor answers 500', () => { monitor = () => new Response('x', { status: 500 }); }, 500],
    ['monitor unreachable', () => { monitor = () => { throw new TypeError('network'); }; }, 0],
    ['monitor times out', () => { monitor = () => { throw new DOMException('timed out', 'TimeoutError'); }; }, 0],
  ])('AC-26 heartbeat or webhook-info failures never break the run: %s', async (_name, setup, status) => {
    setup();
    await expect(run()).resolves.toBeUndefined();
    expect(calls.filter((c) => c.url.endsWith('/sendMessage'))).toHaveLength(1);
    expect(heartbeats()).toHaveLength(1);
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.event === 'heartbeat_failed');
    expect(line).toMatchObject({ event: 'heartbeat_failed', status });
    noSecretsIn(logs);
    expect(logs.join('\n')).not.toContain(MONITOR);
    expect(logs.join('\n')).not.toContain('workers.dev');
  });

  it('AC-26 without HEARTBEAT_TOKEN or MONITOR_ORIGIN it still prompts and logs status -1', async () => {
    for (const missing of ['HEARTBEAT_TOKEN', 'MONITOR_ORIGIN'] as const) {
      calls = []; logs = [];
      await expect(run({ ...env, [missing]: undefined })).resolves.toBeUndefined();
      expect(calls.filter((c) => c.url.endsWith('/sendMessage'))).toHaveLength(1);
      expect(calls.filter((c) => c.url.startsWith(MONITOR))).toEqual([]);
      expect(logs.map((l) => JSON.parse(l)).find((l) => l.event === 'heartbeat_failed')).toMatchObject({ status: -1 });
      noSecretsIn(logs);
    }
  });

  // A deliberate guard that is already green before SPEC-002: the new calls must never reach POST /telegram.
  it('AC-26 the webhook path makes no getWebhookInfo or heartbeat call', async () => {
    const body = { update_id: 1, message: { message_id: 5, date: 1792680000, chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: 'นอน 7' } };
    const req = new Request('https://checkin.test/telegram', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' }, body: JSON.stringify(body),
    });
    expect((await worker.fetch(req, env, ctx)).status).toBe(200);
    expect(calls.filter((c) => c.url.endsWith('/getWebhookInfo') || c.url.startsWith(MONITOR))).toEqual([]);
  });
});

describe('SPEC-002 version on log lines', () => {
  const versions = () => logs.map((l) => JSON.parse(l)).map((l) => [l.event, l.version]);

  it('AC-27 log lines carry the version: checkin', async () => {
    const body = { update_id: 1, message: { message_id: 5, date: 1792680000, chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: 'นอน 7' } };
    await worker.fetch(new Request('https://checkin.test/telegram', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' }, body: JSON.stringify(body),
    }), env, ctx);
    expect(versions()).toContainEqual(['checkin', 'v-123']);
  });

  it('AC-27 log lines carry the version: telegram_send_failed and heartbeat_failed', async () => {
    sendStatus = 500;
    monitor = () => new Response('x', { status: 503 });
    await run();
    expect(versions()).toContainEqual(['telegram_send_failed', 'v-123']);
    expect(versions()).toContainEqual(['heartbeat_failed', 'v-123']);
  });

  it('AC-27 without the binding the version is "unknown"', async () => {
    sendStatus = 500;
    await run({ ...env, CF_VERSION_METADATA: undefined });
    expect(versions()).toContainEqual(['telegram_send_failed', 'unknown']);
  });
});

describe('SPEC-002 configuration', () => {
  it('AC-29 wrangler.toml keeps logs and binds the version metadata', () => {
    expect(toml).toMatch(/^\[observability\]\s*\nenabled\s*=\s*true/m);
    expect(toml).toMatch(/^\[version_metadata\]\s*\nbinding\s*=\s*"CF_VERSION_METADATA"/m);
    expect(toml).toMatch(/^PUBLIC_ORIGIN\s*=\s*"https:\/\/solo-empire-checkin\.bookchaowalit\.workers\.dev"/m);
    expect(toml).toMatch(/^MONITOR_ORIGIN\s*=\s*"https:\/\/solo-empire-monitor\.bookchaowalit\.workers\.dev"/m);
  });
});
