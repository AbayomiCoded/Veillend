import { ValidationError, type ValidationPath } from './api-schemas';

const INTEGER_PATTERN = /^-?\d+$/;

export const toSafeBigInt = (value: unknown, path: ValidationPath = []): bigint => {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError('Expected a safe integer', path);
    }
    return BigInt(value);
  }

  if (typeof value !== 'string' || !INTEGER_PATTERN.test(value)) {
    throw new ValidationError('Expected an integer string', path);
  }

  try {
    return BigInt(value);
  } catch (error) {
    throw new ValidationError('Integer is outside the supported range', path, { cause: error });
  }
};

export const toSafeNumber = (
  value: unknown,
  decimals = 0,
  path: ValidationPath = [],
): number => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
    throw new ValidationError('Decimals must be an integer between 0 and 100', path);
  }

  const integer = toSafeBigInt(value, path);
  const converted = Number(integer) / 10 ** decimals;
  if (!Number.isFinite(converted)) {
    throw new ValidationError('Numeric conversion is not finite', path);
  }
  return converted;
};
