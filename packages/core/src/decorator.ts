import { wrap } from './policies/wrap.js';
import type { Policy } from './policy.js';

/**
 * Any async method — the only shape `@withResilience` can faithfully wrap,
 * since policies are promise-based.
 */
// biome-ignore lint/suspicious/noExplicitAny: decorator must accept any async method shape
type AsyncMethod = (...args: any[]) => Promise<any>;

/**
 * A TC39 stage-3 method decorator that runs the decorated method through a
 * composed resilience pipeline built from the given policies.
 *
 * It is the declarative, ergonomic counterpart to calling
 * `service.execute(wrap(...policies))` by hand: the policies are applied in
 * the exact same **outer→inner** order as {@link wrap}, so the first argument
 * is the outermost policy and the last is the closest to the method body.
 *
 * ```ts
 * class PaymentClient {
 *   ⁣@withResilience(
 *     timeout(1000),                       // outermost
 *     retry({ attempts: 3 }),              // retries the timed-out call
 *     circuitBreaker({ key: 'pay', store }) // innermost, closest to the body
 *   )
 *   async charge(amount: number): Promise<Receipt> {
 *     return this.http.post('/charge', { amount })
 *   }
 * }
 * ```
 *
 * The decorator preserves `this`, all arguments, and the return type. Because
 * there is no per-request container at decoration time, any
 * {@link circuitBreaker} policy must be given an explicit `store`.
 *
 * Timeout caveat: the method body is invoked as `target.apply(this, args)`, which
 * does not forward `ctx.signal`. So a `timeout` policy here rejects the returned
 * promise when it fires, but the underlying method keeps running to completion in
 * the background — the abort is not propagated into the method body.
 *
 * Stacking note: prefer a single `@withResilience(...)` with the policies in
 * order. If you stack multiple decorators, remember that decorators apply
 * bottom-up — the closest decorator to the method is applied first and ends up
 * innermost — so to match the outer→inner reading order, list the outermost
 * policy in the topmost decorator.
 */
export function withResilience(...policies: Policy[]) {
  const composed = wrap(...policies);
  return function decorate<This, M extends AsyncMethod>(
    target: M,
    _context: ClassMethodDecoratorContext<This, M>,
  ): M {
    function replacement(this: This, ...args: Parameters<M>): ReturnType<M> {
      return composed.execute(() => target.apply(this, args)) as ReturnType<M>;
    }
    return replacement as unknown as M;
  };
}
