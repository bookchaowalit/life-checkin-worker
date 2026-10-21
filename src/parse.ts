export interface Metric { type: 'sleep_hours' | 'weight' | 'exercise_minutes' | 'water'; value: number; unit: string; activity?: string }
export interface TimeLog { domain: 'work' | 'learning' | 'personal'; activity: string; minutes: number }
export interface Rejected { line: string; reason: string }
export interface Parsed { date: string; recordedAt: string; metrics: Metric[]; timeLogs: TimeLog[]; diary: string | null; mood: number | null; energy: number | null; rejected: Rejected[] }

export function parseCheckin(_text: string, _now: Date): Parsed {
  return { date: '', recordedAt: '', metrics: [], timeLogs: [], diary: null, mood: null, energy: null, rejected: [] };
}
