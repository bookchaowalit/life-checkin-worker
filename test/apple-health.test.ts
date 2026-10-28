import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAppleHealth } from '../src/apple-health';
import worker, { type Env } from '../src/worker';

const env: Env = {
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_CHAT_ID: '1001',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  EMPIRE_CHECKIN_TOKEN: 'cell-token',
  APPLE_HEALTH_TOKEN: 'phone-secret',
  HEALTH_ORIGIN: 'https://health.test',
  TIME_ORIGIN: 'https://time.test',
  DIARY_ORIGIN: 'https://diary.test',
};

// 10:00 Bangkok on Wednesday 2026-10-28.
const NOW = new Date('2026-10-28T03:00:00Z');
const DATE = '2026-10-27';

const ALL = {
  steps: 8412,
  sleep_hours: '7,25',
  resting_heart_rate: 57,
  heart_rate_avg: '71.4',
  hrv: 42,
  active_energy: 512.456,
  exercise_minutes: 34,
  walking_distance: 6.1,
  weight: 71.4,
};
const ORDER = ['steps', 'sleep_hours', 'resting_heart_rate', 'heart_rate_avg', 'hrv', 'active_energy', 'exercise_minutes', 'walking_distance', 'weight'];

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: (body: Record<string, unknown>) => Response;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  calls = [];
  respond = () => new Response('{"id":1}', { status: 201 });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return respond(JSON.parse(String(init.body)));
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function post(body: unknown, auth: string | null = 'Bearer phone-secret') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth !== null) headers.Authorization = auth;
  return new Request('https://checkin.test/apple-health', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const send = async (body: unknown, auth?: string | null, e: Env = env) => {
  const res = await worker.fetch(post(body, auth), e, ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const sentBodies = () => calls.map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);

describe('apple health ingest', () => {
  it('AC-30 rejects missing or wrong secrets', async () => {
    const body = { date: DATE, metrics: ALL };
    expect((await send(body, null)).status).toBe(401);
    expect((await send(body, 'Bearer wrong')).status).toBe(401);
    expect((await send(body, 'phone-secret')).status).toBe(401);
    const unset = await send(body, 'Bearer ', { ...env, APPLE_HEALTH_TOKEN: undefined });
    expect(unset).toEqual({ status: 401, body: { ok: false } });
    expect(calls).toEqual([]);
  });

  it('AC-31 writes each metric once with its unit', async () => {
    const res = await send({ date: DATE, metrics: ALL });
    expect(res).toEqual({
      status: 200,
      body: { ok: true, date: DATE, written: ORDER, failed: [], rejected: [], message: '✅ บันทึก Apple Health 9 ค่า · อังคาร 27 ต.ค.' },
    });
    expect(calls).toHaveLength(9);
    for (const c of calls) {
      expect(c.url).toBe('https://health.test/v1/health-metrics');
      const h = c.init.headers as Record<string, string>;
      expect(h.Authorization).toBe('Bearer cell-token');
      expect(h['X-Empire-Channel']).toBe('workflow');
    }
    expect(calls.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key'])).toEqual(ORDER.map((k) => `apple-health:${DATE}:${k}`));
    const bodies = sentBodies();
    expect(bodies.map((b) => [b.metric_type, b.value, b.unit])).toEqual([
      ['steps', 8412, 'count'],
      ['sleep_hours', 7.25, 'h'],
      ['resting_heart_rate', 57, 'bpm'],
      ['heart_rate_avg', 71.4, 'bpm'],
      ['hrv', 42, 'ms'],
      ['active_energy', 512.46, 'kcal'],
      ['exercise_minutes', 34, 'min'],
      ['walking_distance', 6.1, 'km'],
      ['weight', 71.4, 'kg'],
    ]);
    for (const b of bodies) {
      expect(b.source).toBe('apple-health');
      expect(b.recorded_at).toBe(`${DATE}T23:59:00+07:00`);
      expect(JSON.parse(String(b.metadata))).toEqual({ date: DATE, via: 'ios-shortcut' });
    }
  });

  it('AC-32 rejects bodies that are not a metrics object', async () => {
    for (const body of ['{not json', '[]', '"x"', { date: DATE }, { date: DATE, metrics: [1] }, { date: DATE, metrics: 'x' }]) {
      expect(await send(body)).toEqual({ status: 400, body: { ok: false, error: 'invalid-body' } });
    }
    expect(calls).toEqual([]);
  });

  it('AC-32 rejects dates outside the window', async () => {
    for (const date of [undefined, 27, '2026-10-27T00:00', '27/10/2026', '2026-02-30', '2026-10-29', '2026-09-26']) {
      expect(await send({ date, metrics: ALL })).toEqual({ status: 400, body: { ok: false, error: 'invalid-date' } });
    }
    // Today (Bangkok) and exactly 31 days back are allowed.
    expect((await send({ date: '2026-10-28', metrics: { steps: 1 } })).status).toBe(200);
    expect((await send({ date: '2026-09-27', metrics: { steps: 1 } })).status).toBe(200);
  });

  it('AC-32 uses the Bangkok calendar for today', async () => {
    vi.setSystemTime(new Date('2026-10-28T17:30:00Z')); // 00:30 Bangkok on 10-29
    expect((await send({ date: '2026-10-29', metrics: { steps: 1 } })).status).toBe(200);
  });

  it('AC-32 rejects bodies over 16 KiB', async () => {
    const big = JSON.stringify({ date: DATE, metrics: { steps: 1 }, pad: 'x'.repeat(16 * 1024) });
    expect(await send(big)).toEqual({ status: 413, body: { ok: false, error: 'too-large' } });
    expect(calls).toEqual([]);
  });

  it('AC-32 lists unknown and out-of-range values and skips empty ones', async () => {
    const res = await send({
      date: DATE,
      metrics: { steps: 1.5, weight: 400, hrv: 'abc', resting_heart_rate: true, sleep_hours: null, heart_rate_avg: '', mood: 4, active_energy: 300 },
    });
    expect(res.status).toBe(200);
    expect(res.body.written).toEqual(['active_energy']);
    expect(res.body.rejected).toEqual([
      { metric: 'steps', reason: 'out-of-range' },
      { metric: 'resting_heart_rate', reason: 'out-of-range' },
      { metric: 'hrv', reason: 'out-of-range' },
      { metric: 'weight', reason: 'out-of-range' },
      { metric: 'mood', reason: 'unknown' },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('AC-32 caps and cuts unknown keys', () => {
    const metrics: Record<string, number> = {};
    for (let i = 0; i < 30; i++) metrics[`k${i}_${'z'.repeat(50)}`] = 1;
    const parsed = parseAppleHealth({ date: DATE, metrics }, NOW);
    if ('error' in parsed) throw new Error('expected a parse');
    expect(parsed.rejected).toHaveLength(20);
    expect(parsed.rejected[0].metric).toHaveLength(40);
  });

  it('AC-32 reads a decimal comma but not a thousands separator', () => {
    const parsed = parseAppleHealth({ date: DATE, metrics: { sleep_hours: '7,25', steps: '1,234', weight: ' 71.4 ' } }, NOW);
    if ('error' in parsed) throw new Error('expected a parse');
    expect(parsed.metrics).toEqual([
      { type: 'sleep_hours', value: 7.25, unit: 'h' },
      { type: 'weight', value: 71.4, unit: 'kg' },
    ]);
    expect(parsed.rejected).toEqual([{ metric: 'steps', reason: 'out-of-range' }]);
  });

  it('AC-32 answers 422 when nothing can be written', async () => {
    const res = await send({ date: DATE, metrics: { steps: null, mood: 3 } });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ ok: false, written: [], rejected: [{ metric: 'mood', reason: 'unknown' }] });
    expect(String(res.body.message)).toMatch(/^⚠️/);
    expect(calls).toEqual([]);
  });

  it('AC-33 reports failed writes', async () => {
    respond = (b) => {
      if (b.metric_type === 'steps') return new Response('{}', { status: 403 });
      if (b.metric_type === 'weight') throw new TypeError('network');
      return new Response('{"id":1}', { status: 201 });
    };
    const res = await send({ date: DATE, metrics: ALL });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.written).toEqual(ORDER.filter((k) => k !== 'steps' && k !== 'weight'));
    expect(res.body.failed).toEqual([{ metric: 'steps', status: 403 }, { metric: 'weight', status: 0 }]);
    expect(String(res.body.message)).toMatch(/^⚠️/);
  });

  it('AC-34 logs counts only', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    await send({ date: DATE, metrics: { weight: 88.77, steps: 4321 } }, 'Bearer phone-secret');
    await send({ date: DATE, metrics: { weight: 88.77 } }, 'Bearer sentinel-secret');
    const out = lines.join('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ event: 'apple_health', written: 2, failed: [], rejected: 0, version: 'unknown' });
    for (const s of ['88.77', '4321', 'phone-secret', 'sentinel-secret', DATE]) expect(out).not.toContain(s);
  });
});
