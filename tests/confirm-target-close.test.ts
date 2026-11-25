import type { ComponentProps } from 'react';
import { expectTypeOf, it } from 'vitest';
import type { Button } from '../apps/web/src/components/ui/button.tsx';
import type { AccessSheet } from '../apps/web/src/machine-access-sheet.tsx';
import type { useConfirmTarget } from '../apps/web/src/use-confirm-target.ts';

type Confirm = ReturnType<typeof useConfirmTarget<unknown>>;

it('closing a confirmation leaves no parameter for a handler argument to land in as a focus finder', () => {
  expectTypeOf<Parameters<Confirm['close']>>().toEqualTypeOf<[]>();
  expectTypeOf<Confirm['closeAndFocus']>().not.toExtend<
    ComponentProps<typeof AccessSheet>['onClose']
  >();
  expectTypeOf<Confirm['closeAndFocus']>().not.toExtend<
    ComponentProps<typeof Button>['onClick']
  >();
});
