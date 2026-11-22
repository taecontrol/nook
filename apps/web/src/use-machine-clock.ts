import type { Machine } from '@nook/contract';
import { useEffect, useState } from 'react';
import { timeoutDelay } from './time';

export function useMachineClock(machines: readonly Machine[] | undefined) {
  const [, tick] = useState(0);
  const now = Date.now();
  useEffect(() => {
    const advance = () => tick((value) => value + 1);
    // Keep relative labels and last-use groups current on an idle page.
    const interval = setInterval(advance, 60_000);
    const next = Math.min(
      ...(machines ?? [])
        .map((machine) =>
          machine.expiresAt === null ? Infinity : Date.parse(machine.expiresAt),
        )
        .filter((at) => at > now),
    );
    const timer = Number.isFinite(next)
      ? setTimeout(advance, timeoutDelay(next - now))
      : undefined;
    return () => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [machines, now]);
  return now;
}
