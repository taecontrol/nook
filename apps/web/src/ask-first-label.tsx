import type { AskFirstMark } from '@nook/contract';
import { SlashPath } from './path-text';

export function AskFirstLabel({ mark }: { mark: AskFirstMark }) {
  return mark.kind === 'bucket' ? (
    <>
      Ask first, from <SlashPath>{mark.path}</SlashPath>
    </>
  ) : (
    'Ask first, on this secret'
  );
}
