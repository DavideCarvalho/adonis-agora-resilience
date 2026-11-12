import { afterEach, describe, expect, it } from 'vitest';
import { tenantSuffix } from './context.js';

const TENANCY = Symbol.for('@agora/context:tenancy');
const ACCESSOR = Symbol.for('@agora/context:accessor');
const slots = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete slots[TENANCY];
  delete slots[ACCESSOR];
});

describe('tenantSuffix', () => {
  it('is undefined without @adonis-agora/context', () => {
    expect(tenantSuffix()).toBeUndefined();
  });

  it('reads the context tenantId', () => {
    slots[ACCESSOR] = { get: () => ({ tenantId: 'acme' }) };
    expect(tenantSuffix()).toBe('acme');
  });

  it('prefers the active tenant of the tenancy contract', () => {
    slots[ACCESSOR] = { get: () => ({ tenantId: 'legacy' }) };
    slots[TENANCY] = { version: 1, tenant: () => ({ id: 'org_42', kind: 'organization' }) };
    expect(tenantSuffix()).toBe('org_42');
  });

  it('falls back when there is no active tenant or the slot is another version', () => {
    slots[ACCESSOR] = { get: () => ({ tenantId: 'acme' }) };
    slots[TENANCY] = { version: 1, tenant: () => undefined };
    expect(tenantSuffix()).toBe('acme');
    slots[TENANCY] = { version: 2, tenant: () => ({ id: 'x' }) };
    expect(tenantSuffix()).toBe('acme');
  });
});
