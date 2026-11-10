import { describe, expect, it, vi } from 'vitest';
import { failover } from './failover';

describe('failover', () => {
  it('returns the first target that succeeds', async () => {
    const result = await failover({
      targets: ['a', 'b', 'c'],
      run: async (t) => {
        if (t === 'a') throw new Error('a down');
        return `sent via ${t}`;
      },
    });
    expect(result).toBe('sent via b');
  });

  it('throws the last error when all fail, and calls onFailover per failure', async () => {
    const onFailover = vi.fn();
    await expect(
      failover({
        targets: ['a', 'b'],
        run: async (t) => {
          throw new Error(`${t} down`);
        },
        onFailover,
      }),
    ).rejects.toThrow('b down');
    expect(onFailover).toHaveBeenCalledTimes(2);
  });

  it('throws synchronously-rejecting on empty targets', async () => {
    await expect(failover({ targets: [], run: async () => 'x' })).rejects.toThrow(/at least one/i);
  });

  it('applies a per-target policy', async () => {
    const policy = vi.fn(() => ({
      execute: <_T>(op: any) => op({ signal: new AbortController().signal, attempt: 0 }),
    }));
    await failover({ targets: ['a'], run: async () => 'ok', policy });
    expect(policy).toHaveBeenCalledWith('a');
  });
});
