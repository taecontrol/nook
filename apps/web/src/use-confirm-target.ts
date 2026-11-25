import { useRef, useState } from 'react';

export type FocusTarget = HTMLElement | (() => HTMLElement | null) | null;

export function focusSoon(find: () => HTMLElement | null) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => find()?.focus({ preventScroll: true })),
  );
}

/** Keeps the last value on screen while a dialog animates closed. */
export function useLastValue<T>(value: T | null) {
  const last = useRef<T | null>(null);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

function resolveFocusTarget(target: FocusTarget) {
  const element = typeof target === 'function' ? target() : target;
  return element?.isConnected ? element : null;
}

export function useReturnFocus(fallback: () => HTMLElement | null) {
  const trigger = useRef<FocusTarget>(null);
  return {
    capture: (element: FocusTarget) => {
      trigger.current = element;
    },
    restore: (event: Event, after?: () => HTMLElement | null) => {
      event.preventDefault();
      if (after) {
        focusSoon(after);
        return;
      }
      (resolveFocusTarget(trigger.current) ?? fallback())?.focus({
        preventScroll: true,
      });
    },
  };
}

export function useConfirmTarget<T>(fallback: () => HTMLElement | null) {
  const [target, setTarget] = useState<T | null>(null);
  const shown = useLastValue(target);
  const focus = useReturnFocus(fallback);
  const after = useRef<(() => HTMLElement | null) | undefined>(undefined);
  return {
    target,
    shown,
    open: (value: T, trigger: FocusTarget) => {
      after.current = undefined;
      focus.capture(trigger);
      setTarget(value);
    },
    close: () => {
      setTarget(null);
    },
    closeAndFocus: (find: () => HTMLElement | null) => {
      after.current = find;
      setTarget(null);
    },
    restoreFocus: (event: Event) => {
      focus.restore(event, after.current);
      after.current = undefined;
    },
  };
}
