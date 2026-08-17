import { z } from 'zod';

export type ValidationPath = ReadonlyArray<string | number>;

const formatPath = (path: ValidationPath): string => path.map(String).join('.');

export class ValidationError extends Error {
  readonly path: string;

  constructor(message: string, path: ValidationPath = [], options?: ErrorOptions) {
    const formattedPath = formatPath(path);
    super(formattedPath ? `${formattedPath}: ${message}` : message, options);
    this.name = 'ValidationError';
    this.path = formattedPath;
  }

  static fromZodError(error: z.ZodError, prefix: ValidationPath = []): ValidationError {
    const issue = error.issues[0];
    return new ValidationError(
      issue?.message ?? 'Response validation failed',
      [...prefix, ...(issue?.path ?? [])],
      { cause: error },
    );
  }
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`HTTP ${status}${statusText ? `: ${statusText}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const parseApiResponse = <Output>(
  schema: z.ZodType<Output>,
  value: unknown,
  path: ValidationPath = [],
): Output => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ValidationError.fromZodError(result.error, path);
  }
  return result.data;
};
