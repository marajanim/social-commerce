import type { AuditChainer } from '@sc/db';

/** Chains new audit rows every `intervalMs` and verifies every chain once a day. */
export function startAuditLoop(options: {
  chainer: AuditChainer;
  intervalMs?: number;
  verifyEveryMs?: number;
  onError?: (err: unknown) => void;
  onBroken?: (info: { tenantId: string | null; id: string; reason: string }) => void;
}): { stop(): void } {
  const chain = setInterval(() => {
    options.chainer.chainOnce().catch((e: unknown) => options.onError?.(e));
  }, options.intervalMs ?? 10_000);

  const verify = () =>
    options.chainer
      .verifyAll()
      .then((results) => {
        for (const r of results) if (!r.ok) options.onBroken?.({ ...r.brokenAt });
      })
      .catch((e: unknown) => options.onError?.(e));
  const nightly = setInterval(() => void verify(), options.verifyEveryMs ?? 24 * 60 * 60 * 1000);
  void verify();

  return {
    stop() {
      clearInterval(chain);
      clearInterval(nightly);
    },
  };
}
