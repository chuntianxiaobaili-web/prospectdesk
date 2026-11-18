const unlimited = /^(?:不限时|无时间限制|一直运行|unlimited|until\s+stopped)$/i;
const exactDuration = /^(\d+(?:\.\d+)?|\.\d+)\s*(小时|分钟|天|h|hours?|m|minutes?|days?)$/i;
const unitMilliseconds = {小时:3600000n, h:3600000n, hour:3600000n, hours:3600000n,
  分钟:60000n, m:60000n, minute:60000n, minutes:60000n,
  天:86400000n, day:86400000n, days:86400000n};

/** Parse only the user's dedicated work-duration field, never a whole command.
 * Decimal arithmetic is exact so valid whole milliseconds do not fail because
 * of floating-point multiplication. Numeric millisecond inputs use durationMs.
 */
export function parseWorkDuration(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw new TypeError('WORK_DURATION_MUST_BE_TEXT_OR_NULL');
  const value = input.trim();
  if (!value || unlimited.test(value)) return null;
  const match = value.match(exactDuration);
  if (!match) throw new TypeError('WORK_DURATION_MUST_BE_AN_EXACT_POSITIVE_NUMBER_WITH_UNIT');
  const [whole, fraction = ''] = match[1].split('.');
  const decimals = fraction.replace(/0+$/, '');
  const numerator = BigInt((whole || '0') + decimals) * unitMilliseconds[match[2].toLowerCase()];
  const denominator = 10n ** BigInt(decimals.length);
  if (numerator <= 0n || numerator % denominator !== 0n) {
    throw new RangeError('WORK_DURATION_MUST_RESOLVE_TO_POSITIVE_SAFE_INTEGER_MILLISECONDS');
  }
  const milliseconds = numerator / denominator;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('WORK_DURATION_MUST_RESOLVE_TO_POSITIVE_SAFE_INTEGER_MILLISECONDS');
  }
  return Number(milliseconds);
}
