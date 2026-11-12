/**
 * The global slots `@adonis-agora/context` publishes. Read structurally so resilience never imports
 * `@adonis-agora/context` — it degrades to `undefined` when context is absent.
 */
const CONTEXT_TENANCY = Symbol.for('@agora/context:tenancy');
const CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');

interface TenancySlot {
  readonly version: number;
  tenant(): { id?: string } | undefined;
}

interface ContextAccessor {
  get(): { tenantId?: string } | undefined;
}

/**
 * The current tenant id from `@adonis-agora/context`, else `undefined`: the active tenant of the
 * tenancy contract (`Symbol.for('@agora/context:tenancy')`, version 1) when there is one, else the
 * context's `tenantId`.
 */
export function tenantSuffix(): string | undefined {
  const slots = globalThis as Record<symbol, unknown>;
  const tenancy = slots[CONTEXT_TENANCY] as TenancySlot | undefined;
  if (tenancy?.version === 1 && typeof tenancy.tenant === 'function') {
    const id = tenancy.tenant()?.id;
    if (typeof id === 'string' && id !== '') return id;
  }
  const accessor = slots[CONTEXT_ACCESSOR] as ContextAccessor | undefined;
  return accessor?.get?.()?.tenantId;
}
