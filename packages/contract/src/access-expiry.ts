/** Relative access lifetime, shared by the CLI and web. Never zero minutes. */
export function untilText(iso: string, now: number) {
  const remaining = Date.parse(iso) - now;
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  const [amount, unit] =
    minutes < 60
      ? [minutes, 'minute']
      : remaining < 86_400_000
        ? [Math.ceil(minutes / 60), 'hour']
        : [Math.ceil(minutes / 1440), 'day'];
  return `in ${amount} ${unit}${amount === 1 ? '' : 's'}`;
}
