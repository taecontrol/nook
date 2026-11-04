import { type AskFirstMark, coveringMark } from '@nook/contract';
import {
  type Mutation,
  type MutationStatus,
  queryOptions,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { runApi } from './api-client';
import { createWriteGate } from './write-gate';

type StoredMark = AskFirstMark & { exists: boolean };
type Toggle = { mark: AskFirstMark; on: boolean };
type Write = {
  input: Toggle;
  status: MutationStatus;
  error: Error | null;
  revision: number;
  id: number;
};
export type Coverage = { mark: AskFirstMark; inherited: boolean } | null;
const options = queryOptions({
  queryKey: ['ask-first'],
  queryFn: async ({ signal }) => [
    ...(await runApi((api) => api.askFirst.list(), signal)).marks,
  ],
  staleTime: 30_000,
  retry: false,
  gcTime: Infinity,
  structuralSharing: false,
  refetchOnWindowFocus: 'always',
});
const writeKey = ['ask-first', 'toggle'];
const gate = createWriteGate(writeKey, { disableWhileBusy: false });
function same(a: AskFirstMark, b: AskFirstMark) {
  return a.kind === b.kind && a.path === b.path;
}
function project(
  marks: readonly StoredMark[],
  writes: readonly Write[],
  revision: number,
) {
  let visible = [...marks];
  for (const write of writes) {
    if (
      write.status !== 'pending' &&
      !(write.status === 'success' && revision <= write.revision)
    )
      continue;
    const previous = visible.find((mark) => same(mark, write.input.mark));
    visible = visible.filter((mark) => !same(mark, write.input.mark));
    if (write.input.on)
      visible.push({ ...write.input.mark, exists: previous?.exists ?? true });
  }
  return visible;
}
function observed(mutation: Mutation): Write {
  return {
    input: mutation.state.variables as Toggle,
    status: mutation.state.status,
    error: mutation.state.error,
    revision:
      (mutation.state.context as { revision: number } | undefined)?.revision ??
      0,
    id: mutation.mutationId,
  };
}
export function useAskFirst() {
  const queries = useQueryClient();
  const list = useQuery(options);
  const { writes } = gate.useWrites(observed);
  const [dismissed, dismiss] = useState<number>();
  const revision =
    queries.getQueryState(options.queryKey)?.dataUpdateCount ?? 0;
  const marks = project(list.data ?? [], writes, revision);
  const failure = writes.findLast(
    (write) => write.status === 'error' && write.id !== dismissed,
  );
  function toggle(mark: AskFirstMark, on: boolean) {
    const key = [...writeKey, mark.kind, mark.path];
    const mutation = queries
      .getMutationCache()
      .build<void, Error, Toggle, { revision: number }>(queries, {
        mutationKey: key,
        scope: { id: `ask-first:${mark.kind}:${mark.path}` },
        gcTime: Infinity,
        onMutate: () => ({ revision }),
        mutationFn: ({ mark, on }) =>
          runApi((api) =>
            on
              ? api.askFirst.put({ params: mark })
              : api.askFirst.remove({ params: mark }),
          ),
        onSuccess: (_result, _input, context) => {
          context.revision =
            queries.getQueryState(options.queryKey)?.dataUpdateCount ?? 0;
        },
        onSettled: () => {
          // The final write for this path reconciles with the server. Pending
          // intents on other paths still overlay any list that lands meanwhile.
          if (queries.isMutating({ mutationKey: key }) === 1)
            return queries.invalidateQueries({ queryKey: options.queryKey });
        },
      });
    void mutation.execute({ mark, on }).catch(() => {});
  }
  return {
    coverage(kind: 'bucket' | 'secret', path: string): Coverage {
      const mark = coveringMark(marks, kind === 'bucket' ? `${path}/` : path);
      return mark
        ? { mark, inherited: mark.kind !== kind || mark.path !== path }
        : null;
    },
    orphans: marks.filter((mark) => !mark.exists),
    toggle,
    list,
    failure: failure?.error,
    dismiss: () => dismiss(failure?.id),
  };
}
