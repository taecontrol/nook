import { useEffect, useState } from 'react';

/** A browser-clock deadline, without polling the server. */
export function useCountdown(deadline: string | undefined): number {
  const [, tick] = useState(0);
  const left = deadline ? Math.max(0, Date.parse(deadline) - Date.now()) : 0;
  useEffect(() => {
    if (left === 0) return;
    const timer = setTimeout(
      () => tick((value) => value + 1),
      Math.min(left, 1000),
    );
    return () => clearTimeout(timer);
  }, [left]);
  return left;
}
