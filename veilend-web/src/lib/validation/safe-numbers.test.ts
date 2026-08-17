import { describe, expect, it } from 'vitest';

import { ValidationError } from './api-schemas';
import { toSafeBigInt, toSafeNumber } from './safe-numbers';

describe('safe numeric conversions', () => {
  it('converts integer strings with asset decimals', () => {
    expect(toSafeNumber('1234567', 7, ['positions', 0, 'depositedRaw'])).toBe(0.1234567);
    expect(toSafeBigInt('-42', ['amount'])).toBe(BigInt(-42));
  });

  it.each(['notANumber', '1.2', '', Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsafe integer input %s',
    (value) => {
      expect(() => toSafeBigInt(value, ['positions', 0, 'depositedRaw'])).toThrow(
        expect.objectContaining<Partial<ValidationError>>({
          name: 'ValidationError',
          path: 'positions.0.depositedRaw',
        }),
      );
    },
  );

  it('rejects values whose decimal conversion is not finite', () => {
    expect(() => toSafeNumber('1', 400, ['amount'])).toThrow(ValidationError);
  });
});
