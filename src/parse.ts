// Parse one evening check-in reply (Thai or English, one item per line) into cell records.
// Unknown lines are kept as diary text; values out of range are rejected with a reason.

export interface Metric { type: 'sleep_hours' | 'weight' | 'exercise_minutes' | 'water'; value: number; unit: string; activity?: string }
export interface TimeLog { domain: 'work' | 'learning' | 'personal'; activity: string; minutes: number }
export interface Rejected { line: string; reason: string }
export interface Parsed { date: string; recordedAt: string; metrics: Metric[]; timeLogs: TimeLog[]; diary: string | null; mood: number | null; energy: number | null; rejected: Rejected[] }

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
// Replies sent before 05:00 belong to the evening before.
const DAY_STARTS_AT_HOUR = 5;
// Cell writes per message: keeps one webhook call under the Workers 50-subrequest limit.
export const MAX_RECORDS = 40;
const MAX_SLEEP_HOURS = 16;

const NUM = '(\\d+(?:\\.\\d+)?)';
const SEP = '\\s*[:：=]?\\s*';
// Longest alternatives first, and a unit may not run into more letters ("1 hour" is not "1 h" + "our").
const HOURS = 'ชั่วโมง|ชม\\.?|hours?|hrs?|h';
const MINUTES = 'นาที|minutes?|mins?|m';
const UNIT_END = '(?![a-z])';
// A keyword must not run into a longer word of its own script: "งานบ้าน" is not "งาน" and "noted" is
// not "note", but "งานCuteERP" is "งาน" + "CuteERP".
const TH_END = '(?![\\u0E00-\\u0E7F])';
const EN_END = '(?![a-z])';

const DIARY = new RegExp(`^(?:(?:บันทึก|ไดอารี่|โน้ต)${TH_END}|(?:diary|note)${EN_END})\\s*[:：]?\\s*(.*)$`, 'i');
const WEIGHT = new RegExp(`^(?:น้ำหนัก|นน\\.?|weight)${SEP}${NUM}\\s*(?:kg|กก\\.?|กิโล(?:กรัม)?)?$`, 'i');
const WATER = new RegExp(`^(?:น้ำ|ดื่มน้ำ|water)${SEP}${NUM}\\s*(ลิตร|l|ml|มล\\.?)?$`, 'i');
const SLEEP = new RegExp(`^(?:นอน|หลับ|sleep)${SEP}(\\d+:\\d{2}|${NUM}\\s*(?:(?:${HOURS})${UNIT_END})?)$`, 'i');
const MOOD = new RegExp(`^(?:อารมณ์|mood)${SEP}${NUM}\\s*(?:\\/\\s*5)?$`, 'i');
const ENERGY = new RegExp(`^(?:พลังงาน|energy)${SEP}${NUM}\\s*(?:\\/\\s*5)?$`, 'i');
const EXERCISE = new RegExp(
  `^(?:ออกกำลัง(?:กาย)?|exercise|workout)${SEP}${NUM}\\s*(?:(${HOURS}|${MINUTES})${UNIT_END})?(?:\\s*(\\d+)\\s*(?:${MINUTES})${UNIT_END})?\\s*(.*)$`,
  'i',
);
const ACTIVITY_FIRST = new RegExp(
  `^(วิ่ง|เดิน|ยิม|ว่ายน้ำ|ปั่นจักรยาน|ปั่น|โยคะ|เวท|run|walk|gym|swim|bike|cycling|yoga|weights?)\\s*${NUM}\\s*(?:(${HOURS}|${MINUTES})${UNIT_END})?$`,
  'i',
);
const TIME = new RegExp(
  `^(?:(งาน|ทำงาน|เรียน|ส่วนตัว)${TH_END}|(work|learn(?:ing)?|study|personal)${EN_END})\\s*[:：]?\\s*(.*)$`,
  'i',
);
const COMPOUND = new RegExp(`^(.*?)\\s*${NUM}\\s*(?:${HOURS})\\s*(\\d+)\\s*(?:${MINUTES})${UNIT_END}$`, 'i');
const DURATION = new RegExp(`^(.*?)\\s*(?:(\\d+):(\\d{2})|${NUM}\\s*(?:(${HOURS}|${MINUTES})${UNIT_END})?)$`, 'i');
// A label that still ends in a number + unit means the duration was written in a form we don't read.
const TRAILING_DURATION = new RegExp(`\\d\\s*(?:${HOURS}|${MINUTES})$`, 'i');

const DOMAINS: Record<string, TimeLog['domain']> = {
  งาน: 'work', ทำงาน: 'work', work: 'work',
  เรียน: 'learning', learn: 'learning', learning: 'learning', study: 'learning',
  ส่วนตัว: 'personal', personal: 'personal',
};

const isMinutes = (unit: string | undefined) => !!unit && new RegExp(`^(?:${MINUTES})$`, 'i').test(unit);
const isHours = (unit: string | undefined) => !!unit && new RegExp(`^(?:${HOURS})$`, 'i').test(unit);
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

function normalise(line: string): string {
  return line
    .replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50))
    .replace(/^\s*(?:[-•*·]|\d+[.)])\s+/, '')
    .trim();
}

function localParts(now: Date) {
  const local = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  return { local, hour: local.getUTCHours() };
}

function checkinDate(now: Date): { date: string; recordedAt: string } {
  const { local, hour } = localParts(now);
  if (hour < DAY_STARTS_AT_HOUR) {
    const previous = new Date(local.getTime() - 86_400_000).toISOString().slice(0, 10);
    return { date: previous, recordedAt: `${previous}T23:59:00+07:00` };
  }
  const iso = local.toISOString();
  return { date: iso.slice(0, 10), recordedAt: `${iso.slice(0, 10)}T${iso.slice(11, 16)}:00+07:00` };
}

function inRange(value: number, min: number, max: number) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function parseScore(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && inRange(value, 1, 5) ? value : null;
}

/** One work item such as "CuteERP 5", "admin 30 นาที", "1:30", "1h30m".
 * null: not a duration at all (the line is a sentence); 'invalid': a duration we can't accept. */
function parseWorkItem(item: string, keyword: string): TimeLog | 'invalid' | null {
  const text = item.trim();
  let label: string;
  let minutes: number;
  const compound = COMPOUND.exec(text);
  const m = compound ? null : DURATION.exec(text);
  if (compound) {
    label = compound[1];
    minutes = Number(compound[2]) * 60 + Number(compound[3]);
  } else if (m) {
    const [, l, hh, mm, num, unit] = m;
    label = l;
    if (hh !== undefined) {
      if (Number(mm) >= 60) return 'invalid';
      minutes = Number(hh) * 60 + Number(mm);
    } else if (isMinutes(unit)) minutes = Number(num);
    else minutes = Number(num) * 60;
  } else return null;
  if (TRAILING_DURATION.test(label.trim())) return 'invalid';
  minutes = Math.round(minutes);
  if (!inRange(minutes, 1, 1440)) return 'invalid';
  return { domain: DOMAINS[keyword.toLowerCase()], activity: label.trim() || keyword, minutes };
}

export function parseCheckin(text: string, now: Date): Parsed {
  const { date, recordedAt } = checkinDate(now);
  const metrics: Metric[] = [];
  const timeLogs: TimeLog[] = [];
  const rejected: Rejected[] = [];
  const diaryLines: string[] = [];
  let mood: number | null = null;
  let energy: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = normalise(raw);
    if (!line) continue;
    let m: RegExpExecArray | null;

    if ((m = DIARY.exec(line))) {
      if (m[1].trim()) diaryLines.push(m[1].trim());
    } else if ((m = WEIGHT.exec(line))) {
      const value = Number(m[1]);
      if (inRange(value, 20, 300)) metrics.push({ type: 'weight', value, unit: 'kg' });
      else rejected.push({ line, reason: 'น้ำหนักต้องอยู่ระหว่าง 20–300 kg' });
    } else if ((m = WATER.exec(line))) {
      let value = Number(m[1]);
      const unit = (m[2] ?? '').toLowerCase();
      if (unit === 'ml' || unit.startsWith('มล') || (!unit && value > 20)) value /= 1000;
      value = round(value);
      if (inRange(value, 0, 10)) metrics.push({ type: 'water', value, unit: 'L' });
      else rejected.push({ line, reason: 'น้ำต้องอยู่ระหว่าง 0–10 ลิตร' });
    } else if ((m = SLEEP.exec(line))) {
      const [h, mm] = m[1].includes(':') ? m[1].split(':').map(Number) : [Number(m[2]), 0];
      const value = round(h + mm / 60);
      if (mm < 60 && inRange(value, 0, MAX_SLEEP_HOURS)) metrics.push({ type: 'sleep_hours', value, unit: 'h' });
      else rejected.push({ line, reason: `ชั่วโมงนอนต้องอยู่ระหว่าง 0–${MAX_SLEEP_HOURS} (ไม่ใช่เวลาเข้านอน)` });
    } else if ((m = MOOD.exec(line))) {
      const score = parseScore(m[1]);
      if (score === null) rejected.push({ line, reason: 'อารมณ์ให้คะแนน 1–5' });
      else mood = score;
    } else if ((m = ENERGY.exec(line))) {
      const score = parseScore(m[1]);
      if (score === null) rejected.push({ line, reason: 'พลังงานให้คะแนน 1–5' });
      else energy = score;
    } else if ((m = EXERCISE.exec(line)) || (m = ACTIVITY_FIRST.exec(line))) {
      const activityFirst = !/^(?:ออกกำลัง|exercise|workout)/i.test(line);
      const [num, unit, extraMinutes, activity] = activityFirst ? [m[2], m[3], undefined, m[1]] : [m[1], m[2], m[3], m[4]];
      const value = Math.round((isHours(unit) ? Number(num) * 60 : Number(num)) + Number(extraMinutes ?? 0));
      if (!inRange(value, 1, 600)) rejected.push({ line, reason: 'ออกกำลังต้องอยู่ระหว่าง 1–600 นาที' });
      else metrics.push({ type: 'exercise_minutes', value, unit: 'min', ...(activity?.trim() ? { activity: activity.trim() } : {}) });
    } else if ((m = TIME.exec(line))) {
      const keyword = m[1] ?? m[2];
      const items = m[3].split(/[,;、]/).map((s) => s.trim()).filter(Boolean);
      const parsed = items.map((item) => parseWorkItem(item, keyword));
      if (items.length === 0 || parsed.every((p) => p === null)) {
        diaryLines.push(line); // "งาน วันนี้หนักมาก" is a sentence, not a time log
      } else {
        parsed.forEach((p, i) => {
          if (p && p !== 'invalid') timeLogs.push(p);
          else rejected.push({ line: `${keyword} ${items[i]}`, reason: 'เวลาต้องอยู่ระหว่าง 1 นาที–24 ชม. เขียนเป็น 5, 1.5, 1:30, 1h30m หรือ 45 นาที' });
        });
      }
    } else {
      diaryLines.push(line);
    }
  }

  const diary = diaryLines.length ? diaryLines.join('\n') : null;
  const journal = diary !== null || mood !== null || energy !== null ? 1 : 0;
  let room = MAX_RECORDS - journal;
  const keptMetrics = metrics.slice(0, Math.max(room, 0));
  room -= keptMetrics.length;
  const keptLogs = timeLogs.slice(0, Math.max(room, 0));
  for (const dropped of [...metrics.slice(keptMetrics.length), ...timeLogs.slice(keptLogs.length)]) {
    const label = 'type' in dropped ? `${dropped.type} ${dropped.value}` : `${dropped.activity} ${dropped.minutes} นาที`;
    rejected.push({ line: label, reason: `เกิน ${MAX_RECORDS} รายการต่อข้อความ ส่งที่เหลือเป็นข้อความใหม่` });
  }
  return { date, recordedAt, metrics: keptMetrics, timeLogs: keptLogs, diary, mood, energy, rejected };
}
