import { describe, expect, it } from 'vitest';
import { MAX_RECORDS, parseCheckin } from '../src/parse';

const evening = new Date('2026-10-22T14:40:00Z'); // 21:40 +07:00

describe('parseCheckin', () => {
  it('AC-01 parses a full reply', () => {
    const text = [
      'นอน 7',
      'น้ำหนัก 71.5',
      'ออกกำลัง 30 วิ่ง',
      'น้ำ 2',
      'อารมณ์ 4',
      'พลังงาน 3',
      'งาน CuteERP 5, freelance 1.5',
      'บันทึก วันนี้เหนื่อยแต่จบงาน',
    ].join('\n');
    const p = parseCheckin(text, evening);
    expect(p.date).toBe('2026-10-22');
    expect(p.recordedAt).toBe('2026-10-22T21:40:00+07:00');
    expect(p.metrics).toEqual([
      { type: 'sleep_hours', value: 7, unit: 'h' },
      { type: 'weight', value: 71.5, unit: 'kg' },
      { type: 'exercise_minutes', value: 30, unit: 'min', activity: 'วิ่ง' },
      { type: 'water', value: 2, unit: 'L' },
    ]);
    expect(p.timeLogs).toEqual([
      { domain: 'work', activity: 'CuteERP', minutes: 300 },
      { domain: 'work', activity: 'freelance', minutes: 90 },
    ]);
    expect(p.diary).toBe('วันนี้เหนื่อยแต่จบงาน');
    expect(p.mood).toBe(4);
    expect(p.energy).toBe(3);
    expect(p.rejected).toEqual([]);
  });

  it('AC-02 handles collisions and units', () => {
    const p = parseCheckin('น้ำหนัก 72\nน้ำ 1500\nsleep 6.5h\nweight 70kg\nwater 1.2\nวิ่ง 45', evening);
    expect(p.metrics).toEqual([
      { type: 'weight', value: 72, unit: 'kg' },
      { type: 'water', value: 1.5, unit: 'L' },
      { type: 'sleep_hours', value: 6.5, unit: 'h' },
      { type: 'weight', value: 70, unit: 'kg' },
      { type: 'water', value: 1.2, unit: 'L' },
      { type: 'exercise_minutes', value: 45, unit: 'min', activity: 'วิ่ง' },
    ]);
    expect(p.diary).toBeNull();
  });

  it('AC-03 reads work time formats', () => {
    const p = parseCheckin('งาน 6\nwork: Cute 2h, admin 30 นาที\nงาน CuteERP 1:30\nเรียน TypeScript 45m', evening);
    expect(p.timeLogs).toEqual([
      { domain: 'work', activity: 'งาน', minutes: 360 },
      { domain: 'work', activity: 'Cute', minutes: 120 },
      { domain: 'work', activity: 'admin', minutes: 30 },
      { domain: 'work', activity: 'CuteERP', minutes: 90 },
      { domain: 'learning', activity: 'TypeScript', minutes: 45 },
    ]);
  });

  it('AC-04 rejects out-of-range values and keeps free text as diary', () => {
    const p = parseCheckin('นอน 30\nอารมณ์ 9\nไปกินข้าวกับที่บ้าน', evening);
    expect(p.metrics).toEqual([]);
    expect(p.mood).toBeNull();
    expect(p.rejected.map((r) => r.line)).toEqual(['นอน 30', 'อารมณ์ 9']);
    for (const r of p.rejected) expect(r.reason).not.toBe('');
    expect(p.diary).toBe('ไปกินข้าวกับที่บ้าน');
  });

  it('AC-05 assigns after-midnight replies to the previous day', () => {
    const late = parseCheckin('นอน 6', new Date('2026-10-22T18:15:00Z')); // 01:15 +07:00 on the 23rd
    expect(late.date).toBe('2026-10-22');
    expect(late.recordedAt).toBe('2026-10-22T23:59:00+07:00');
    const morning = parseCheckin('นอน 6', new Date('2026-10-22T22:00:00Z')); // 05:00 +07:00 on the 23rd
    expect(morning.date).toBe('2026-10-23');
  });
});

describe('parseCheckin v1.1 (review fixes)', () => {
  it('AC-12 keywords need a word boundary', () => {
    const p = parseCheckin('งานบ้าน 1\nงานเลี้ยง 3\nnoted ok\nnotebook ใหม่', evening);
    expect(p.timeLogs).toEqual([]);
    expect(p.diary).toBe('งานบ้าน 1\nงานเลี้ยง 3\nnoted ok\nnotebook ใหม่');
  });

  it('AC-13 long unit words do not bleed into the activity', () => {
    const p = parseCheckin('ออกกำลัง 1 hour วิ่ง\nออกกำลัง 45 mins วิ่ง\nออกกำลัง 30 minutes\nออกกำลัง 1 hr\ngym 2 hours', evening);
    expect(p.metrics).toEqual([
      { type: 'exercise_minutes', value: 60, unit: 'min', activity: 'วิ่ง' },
      { type: 'exercise_minutes', value: 45, unit: 'min', activity: 'วิ่ง' },
      { type: 'exercise_minutes', value: 30, unit: 'min' },
      { type: 'exercise_minutes', value: 60, unit: 'min' },
      { type: 'exercise_minutes', value: 120, unit: 'min', activity: 'gym' },
    ]);
  });

  it('AC-14 compound durations', () => {
    const p = parseCheckin('งาน 1h30m\nงาน Cute 3 ชม. 30 นาที\nwork: api 2 hours', evening);
    expect(p.timeLogs).toEqual([
      { domain: 'work', activity: 'งาน', minutes: 90 },
      { domain: 'work', activity: 'Cute', minutes: 210 },
      { domain: 'work', activity: 'api', minutes: 120 },
    ]);
    expect(p.rejected).toEqual([]);
  });

  it('AC-15 clock times and ranges are validated, never silently dropped', () => {
    const p = parseCheckin('นอน 23:30\nนอน 7:75\nงาน 1:75\nงาน 25\nงาน 0:00\nนอน 7:30', evening);
    expect(p.metrics).toEqual([{ type: 'sleep_hours', value: 7.5, unit: 'h' }]);
    expect(p.timeLogs).toEqual([]);
    expect(p.rejected.map((r) => r.line)).toEqual(['นอน 23:30', 'นอน 7:75', 'งาน 1:75', 'งาน 25', 'งาน 0:00']);
    expect(p.diary).toBeNull();
  });

  it('AC-17 caps the records per message', () => {
    const items = Array.from({ length: 60 }, (_, i) => `a${i} 1`).join(', ');
    const p = parseCheckin(`นอน 7\nงาน ${items}\nบันทึก ok`, evening);
    expect(p.metrics.length + p.timeLogs.length + 1).toBe(MAX_RECORDS);
    expect(p.rejected.length).toBe(60 + 2 - MAX_RECORDS);
  });

  it('AC-02b English mood, energy and exercise keywords', () => {
    const p = parseCheckin('mood 3/5\nenergy 2\nexercise 20 walk', evening);
    expect(p.mood).toBe(3);
    expect(p.energy).toBe(2);
    expect(p.metrics).toEqual([{ type: 'exercise_minutes', value: 20, unit: 'min', activity: 'walk' }]);
  });
});

describe('parseCheckin v1.2 (SDLC review fixes)', () => {
  it('AC-20 compound exercise durations', () => {
    const p = parseCheckin('ออกกำลัง 1h30m วิ่ง\nออกกำลัง 1 ชม. 15 นาที', evening);
    expect(p.metrics).toEqual([
      { type: 'exercise_minutes', value: 90, unit: 'min', activity: 'วิ่ง' },
      { type: 'exercise_minutes', value: 75, unit: 'min' },
    ]);
  });

  it('AC-21 a Thai keyword may touch a Latin word', () => {
    const p = parseCheckin('งานCuteERP 5\nเรียนTypeScript 1', evening);
    expect(p.timeLogs).toEqual([
      { domain: 'work', activity: 'CuteERP', minutes: 300 },
      { domain: 'learning', activity: 'TypeScript', minutes: 60 },
    ]);
  });
});
