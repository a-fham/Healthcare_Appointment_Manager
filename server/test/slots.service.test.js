import { describe, it, expect } from 'vitest';
import { computeSlots } from '../src/services/slots.service.js';

const MONDAY = '2026-08-24'; // a Monday
const SUNDAY = '2026-08-30';
const FUTURE_NOW = '2000-01-01 00:00'; // nothing is past

const doctor = {
  workingDays: [1, 2, 3, 4, 5],
  startsAt: '09:00',
  endsAt: '11:00',
  slotMinutes: 20,
};

describe('computeSlots (pure core)', () => {
  it('tiles working hours by slotMinutes', () => {
    const slots = computeSlots(doctor, MONDAY, new Map(), new Set(), FUTURE_NOW);
    expect(slots.map((s) => s.startsAt)).toEqual([
      '09:00', '09:20', '09:40', '10:00', '10:20', '10:40',
    ]);
    expect(slots.every((s) => s.status === 'open')).toBe(true);
  });

  it('never emits a slot that would end after endsAt', () => {
    const d = { ...doctor, startsAt: '10:50', endsAt: '11:00' };
    expect(computeSlots(d, MONDAY, new Map(), new Set(), FUTURE_NOW)).toEqual([]);
    const fitsExactly = { ...doctor, startsAt: '10:40', endsAt: '11:00' };
    const slots = computeSlots(fitsExactly, MONDAY, new Map(), new Set(), FUTURE_NOW);
    expect(slots.map((s) => s.startsAt)).toEqual(['10:40']);
  });

  it('excludes non-working days', () => {
    expect(computeSlots(doctor, SUNDAY, new Map(), new Set(), FUTURE_NOW)).toEqual([]);
  });

  it('suppresses every slot on a leave date', () => {
    const slots = computeSlots(doctor, MONDAY, new Map(), new Set([MONDAY]), FUTURE_NOW);
    expect(slots).toEqual([]);
  });

  it('marks past times as past (same-day comparison)', () => {
    const slots = computeSlots(doctor, MONDAY, new Map(), new Set(), `${MONDAY} 09:30`);
    expect(slots.map((s) => `${s.startsAt}:${s.status}`)).toEqual([
      '09:00:past', '09:20:past', '09:40:open',
      '10:00:open', '10:20:open', '10:40:open',
    ]);
  });

  it('reflects taken times with their kind (booked / held)', () => {
    const taken = new Map([
      ['09:20', 'booked'],
      ['10:00', 'held'],
    ]);
    const slots = computeSlots(doctor, MONDAY, taken, new Set(), FUTURE_NOW);
    const byTime = Object.fromEntries(slots.map((s) => [s.startsAt, s.status]));
    expect(byTime['09:20']).toBe('booked');
    expect(byTime['10:00']).toBe('held');
    expect(byTime['09:40']).toBe('open');
  });

  it('handles fractional schedules (15-minute slots)', () => {
    const d = { ...doctor, slotMinutes: 15 };
    const slots = computeSlots(d, MONDAY, new Map(), new Set(), FUTURE_NOW);
    expect(slots).toHaveLength(8);
    expect(slots.at(-1).startsAt).toBe('10:45');
  });

  it('returns [] for malformed inputs rather than throwing', () => {
    expect(computeSlots({ ...doctor, slotMinutes: 0 }, MONDAY, new Map(), new Set(), FUTURE_NOW)).toEqual([]);
    expect(computeSlots(doctor, 'not-a-date', new Map(), new Set(), FUTURE_NOW)).toEqual([]);
  });
});
