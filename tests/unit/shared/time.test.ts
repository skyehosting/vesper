import { describe, expect, it } from 'vitest'
import { fixedZone, formatAbsolute, formatNow, formatOffset, formatStamp, ianaZone, relativeAge, stripImitatedStamp, turnHeader, zoneOf } from '@shared/time'

const NY = ianaZone('America/New_York')
const at = (iso: string): number => Date.parse(iso)

describe('time', () => {
  it('formats absolute times from parts (no ICU "Sept")', () => {
    expect(formatAbsolute(NY.partsAt(at('2026-09-13T01:14:00Z')))).toBe('Sat 12 Sep 2026 21:14')
    expect(formatAbsolute(NY.partsAt(at('2026-09-13T01:14:00Z')), '12h')).toBe('Sat 12 Sep 2026 9:14 PM')
    expect(formatAbsolute(fixedZone(0).partsAt(at('2026-10-05T00:05:00Z')), '12h')).toBe('Mon 5 Oct 2026 12:05 AM')
  })

  it('reports DST-aware offsets', () => {
    expect(NY.partsAt(at('2026-07-01T12:00:00Z')).offsetMin).toBe(-240)
    expect(NY.partsAt(at('2026-12-01T12:00:00Z')).offsetMin).toBe(-300)
    expect(formatOffset(-240)).toBe('UTC−04:00')
    expect(formatOffset(330)).toBe('UTC+05:30')
    expect(formatNow(at('2026-10-05T18:03:00Z'), NY)).toBe('Mon 5 Oct 2026 14:03 (UTC−04:00, America/New_York)')
  })

  it('computes relative ages as calendar days in the zone (across DST)', () => {
    const now = at('2026-11-02T12:45:00Z') // Mon 2 Nov 07:45 EST
    expect(relativeAge(at('2026-11-02T12:00:00Z'), now, NY)).toBe('45 minutes ago')
    expect(relativeAge(at('2026-11-01T04:30:00Z'), now, NY)).toBe('yesterday') // Sun 1 Nov 00:30 EDT
    expect(relativeAge(at('2026-10-25T12:30:00Z'), now, NY)).toBe('8 days ago')
    expect(relativeAge(at('2026-09-13T01:14:00Z'), now, NY)).toBe('7 weeks ago')
    expect(relativeAge(at('2026-03-01T12:00:00Z'), now, NY)).toBe('about 8 months ago')
    expect(relativeAge(at('2023-11-01T12:00:00Z'), now, NY)).toBe('about 3 years ago')
    expect(relativeAge(now + 5000, now, NY)).toBe('just now')
  })

  it('writes the turn header once, with a gap note after 6 hours', () => {
    const now = at('2026-10-05T18:03:00Z')
    expect(turnHeader(now, NY, null)).toBe('[Now: Mon 5 Oct 2026 14:03 (UTC−04:00, America/New_York)]')
    expect(turnHeader(now, NY, now - 60_000)).toBe('[Now: Mon 5 Oct 2026 14:03 (UTC−04:00, America/New_York)]')
    expect(turnHeader(now, NY, at('2026-09-12T01:14:00Z'))).toBe('[Now: Mon 5 Oct 2026 14:03 (UTC−04:00, America/New_York) · 3 weeks since the previous message]')
    expect(turnHeader(now, fixedZone(-240), now - 7 * 3600_000)).toBe('[Now: Mon 5 Oct 2026 14:03 (UTC−04:00) · 7 hours since the previous message]')
    expect(formatStamp(now, NY)).toBe('Mon 5 Oct 2026 14:03 (UTC−04:00)')
  })

  it('falls back to a fixed offset for unknown zone names', () => {
    expect(zoneOf('Not/AZone', 60).partsAt(at('2026-10-05T10:00:00Z')).hour).toBe(11)
    expect(zoneOf('Europe/Berlin', 0).name).toBe('Europe/Berlin')
  })

  it('strips a timestamp the model imitated', () => {
    expect(stripImitatedStamp('[Mon 5 Oct 2026 14:03] Hi there')).toBe('Hi there')
    expect(stripImitatedStamp('[Now: Mon 5 Oct 2026 14:03 (UTC−04:00)] Hi')).toBe('Hi')
    expect(stripImitatedStamp('Hi [Mon 5 Oct 2026 14:03]')).toBe('Hi [Mon 5 Oct 2026 14:03]')
  })
})
