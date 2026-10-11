import { useRef, useState } from 'react';

/** Keeps the last value on screen while a dialog animates closed. */
export function useLastValue<T>(value: T | null) {
  const last = useRef<T | null>(null);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

/** Returns focus to whatever opened a dialog, or to `fallback` once it is gone. */
export function useReturnFocus(fallback: () => HTMLElement | null) {
  const trigger = useRef<HTMLElement | null>(null);
  return {
    capture: (element: HTMLElement | null) => {
      trigger.current = element;
    },
    restore: (event: Event) => {
      event.preventDefault();
      if (trigger.current?.isConnected) trigger.current.focus();
      else fallback()?.focus();
    },
  };
}

/** The item a confirmation dialog asks about, from the trigger that opened it. */
export function useConfirmTarget<T>(fallback: () => HTMLElement | null) {
  const [target, setTarget] = useState<T | null>(null);
  const shown = useLastValue(target);
  const focus = useReturnFocus(fallback);
  return {
    target,
    shown,
    open: (value: T, trigger: HTMLElement | null) => {
      focus.capture(trigger);
      setTarget(value);
    },
    close: () => setTarget(null),
    restoreFocus: focus.restore,
  };
}
