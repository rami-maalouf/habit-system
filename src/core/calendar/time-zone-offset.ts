// the reader owns one formatter, so a transaction can reuse it across probes.
export function createOffsetSecondsReader(timeZoneId: string): (utcMs: number) => number {
  if (typeof timeZoneId !== 'string' || timeZoneId.length === 0 || /^[+-]/.test(timeZoneId)) {
    throw new RangeError('unsupported time zone');
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZoneId, timeZoneName: 'longOffset', numberingSystem: 'latn',
  });
  return (instant) => {
    // hermes splits longoffset into several parts; the complete suffix is stable.
    const match = /\bGMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(formatter.format(instant));
    if (!match) throw new RangeError('unsupported time zone offset format');
    if (!match[1]) return 0;
    const hour = Number(match[2]), minute = Number(match[3]), second = Number(match[4] ?? 0);
    if (hour >= 24 || minute >= 60 || second >= 60) throw new RangeError('invalid time zone offset');
    return (match[1] === '-' ? -1 : 1) * (hour * 3600 + minute * 60 + second);
  };
}
