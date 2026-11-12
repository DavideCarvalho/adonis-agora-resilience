import { describePolicy, tagDescription } from '../describe.js';
import { type Operation, type Policy, type PolicyContext, rootContext } from '../policy.js';

export function wrap(...policies: Policy[]): Policy {
  const policy: Policy = {
    execute<T>(op: Operation<T>, parent: PolicyContext = rootContext()): Promise<T> {
      const composed = policies.reduceRight<Operation<T>>(
        (innerOp, policy) => (ctx) => policy.execute(innerOp, ctx),
        op,
      );
      return composed(parent);
    },
  };
  return tagDescription(
    policy,
    policies.flatMap((p) => describePolicy(p)),
  );
}
