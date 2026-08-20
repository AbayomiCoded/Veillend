import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TimeoutError, withTimeout } from './withTimeout';

describe('withTimeout (issue #344)', () => {
  it('resolves with the inner value when the promise settles before the timeout', async () => {
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 5));
    const result = await withTimeout(fast, 1_000, 'fast-op');
    assert.equal(result, 'ok');
  });

  it('rejects with a TimeoutError when the promise is slower than the timeout', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('too late'), 50));
    await assert.rejects(() => withTimeout(slow, 5, 'slow-op'), (err: unknown) => {
      assert.ok(err instanceof TimeoutError);
      assert.equal(err.name, 'TimeoutError');
      assert.match(err.message, /Request timed out after 5ms: slow-op/);
      return true;
    });
  });

  it('propagates the inner promise rejection when it rejects before the timeout', async () => {
    const failing = new Promise<string>((_resolve, reject) =>
      setTimeout(() => reject(new Error('boom')), 5),
    );
    await assert.rejects(() => withTimeout(failing, 1_000, 'failing-op'), /boom/);
  });

  it('omits the trailing colon when no label is provided', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(resolve, 50));
    await assert.rejects(() => withTimeout(slow, 5), (err: unknown) => {
      assert.ok(err instanceof TimeoutError);
      assert.equal(err.message, 'Request timed out after 5ms');
      return true;
    });
  });
});
