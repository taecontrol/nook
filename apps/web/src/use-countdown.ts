import { useEffect, useState } from 'react';

/** A browser-clock deadline, without polling the server. */
export function useCountdown(deadline: string | undefined): number {
  const [, tick] = useState(0);
  const left = deadline ? Math.max(0, Date.parse(deadline) - Date.now()) : 0;
  useEffect(() => {
    // A new deadline can have the same time left as the previous render.
    if (!deadline || left === 0) return;
    const timer = setTimeout(
      () => tick((value) => value + 1),
      Math.min(left, 1000),
    );
    return () => clearTimeout(timer);
  }, [deadline, left]);
  return left;
}
