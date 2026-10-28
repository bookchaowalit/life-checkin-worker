// SPEC-003: validate one day of Apple Health totals sent by the owner's iOS Shortcut.
// Only the allowlisted metrics are kept; anything else is reported back, never written.

export interface HealthValue { type: string; value: number; unit: string }
export interface Rejection { metric: string; reason: 'unknown' | 'out-of-range' }
export interface AppleHealthDay { date: string; metrics: HealthValue[]; rejected: Rejection[] }
export type ParseError = { error: 'invalid-body' | 'invalid-date' };

interface Rule { unit: string; min: number; max: number; integer?: boolean }

// The order here is the order of writes and of the answer (spec §4).
const RULES: Record<string, Rule> = {
  steps: { unit: 'count', min: 0, max: 100_000, integer: true },
  sleep_hours: { unit: 'h', min: 0, max: 16 },
  resting_heart_rate: { unit: 'bpm', min: 25, max: 150 },
  heart_rate_avg: { unit: 'bpm', min: 25, max: 220 },
  hrv: { unit: 'ms', min: 1, max: 300 },
  active_energy: { unit: 'kcal', min: 0, max: 10_000 },
  exercise_minutes: { unit: 'min', min: 0, max: 1_440 },
  walking_distance: { unit: 'km', min: 0, max: 200 },
  weight: { unit: 'kg', min: 20, max: 300 },
};

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const MAX_AGE_DAYS = 31;
const MAX_REJECTED = 20;
const MAX_KEY_LENGTH = 40;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const round = (n: number) => Math.round(n * 100) / 100;

/** Shortcuts formats numbers by the phone's locale, so "7,25" means 7.25. */
function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(',', '.');
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

function validDate(raw: unknown, now: Date): raw is string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(day) || new Date(day).toISOString().slice(0, 10) !== raw) return false;
  const today = Date.parse(`${new Date(now.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10)}T00:00:00Z`);
  return day <= today && day >= today - MAX_AGE_DAYS * DAY_MS;
}

export function parseAppleHealth(body: unknown, now: Date): AppleHealthDay | ParseError {
  if (!isObject(body) || !isObject(body.metrics)) return { error: 'invalid-body' };
  if (!validDate(body.date, now)) return { error: 'invalid-date' };
  const input = body.metrics;
  const metrics: HealthValue[] = [];
  const rejected: Rejection[] = [];
  for (const [type, rule] of Object.entries(RULES)) {
    const raw = input[type];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = toNumber(raw);
    if (value === null || value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value))) {
      rejected.push({ metric: type, reason: 'out-of-range' });
    } else {
      metrics.push({ type, value: round(value), unit: rule.unit });
    }
  }
  for (const key of Object.keys(input)) {
    if (!(key in RULES)) rejected.push({ metric: key.slice(0, MAX_KEY_LENGTH), reason: 'unknown' });
  }
  return { date: body.date, metrics, rejected: rejected.slice(0, MAX_REJECTED) };
}
