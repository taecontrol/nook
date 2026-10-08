import type { Machine } from '@nook/contract';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { runApi } from './api-client';

export const machinesOptions = queryOptions({
  queryKey: ['machines'],
  queryFn: async ({ signal }) => [
    ...(await runApi((api) => api.machines.list(), signal)).machines,
  ],
  retry: false,
  staleTime: 30_000,
  refetchOnWindowFocus: 'always',
});
const revokeKey = ['machines', 'revoke'] as const;
export type MachineRevoke = {
  id: number;
  machine: Machine;
  status: 'idle' | 'pending' | 'success' | 'error';
  error: Error | null;
};
function isRevoking(queries: QueryClient) {
  return queries.isMutating({ mutationKey: revokeKey }) > 0;
}
export function preloadMachines(queries: QueryClient) {
  if (!isRevoking(queries)) void queries.prefetchQuery(machinesOptions);
}
export function useMachines() {
  const queries = useQueryClient();
  const writes = useMutationState<MachineRevoke>({
    filters: { mutationKey: revokeKey },
    select: (mutation) => ({
      id: mutation.mutationId,
      machine: mutation.state.variables as Machine,
      status: mutation.state.status,
      error: mutation.state.error,
    }),
  });
  const busy = writes.some((write) => write.status === 'pending');
  const pendingIds = new Set(
    writes
      .filter((write) => write.status === 'pending')
      .map((write) => write.machine.id),
  );
  const machines = useQuery({
    ...machinesOptions,
    staleTime: busy ? Infinity : machinesOptions.staleTime,
    refetchOnWindowFocus: busy ? false : machinesOptions.refetchOnWindowFocus,
    select: (data) => data.filter((machine) => !pendingIds.has(machine.id)),
  });
  const revoke = useMutation({
    mutationKey: revokeKey,
    mutationFn: (machine: Machine) =>
      runApi((api) => api.machines.revoke({ params: { id: machine.id } })),
    onMutate: async (machine) => {
      await queries.cancelQueries({ queryKey: machinesOptions.queryKey });
      queries.setQueryData(machinesOptions.queryKey, (current = []) =>
        current.filter((entry) => entry.id !== machine.id),
      );
    },
    onError: (_error, machine) => {
      queries.setQueryData(machinesOptions.queryKey, (current = []) => [
        ...current.filter((entry) => entry.id !== machine.id),
        machine,
      ]);
    },
    onSettled: () => {
      // Feedback follows the HTTP result; recovery need not delay confirmation.
      void queries.invalidateQueries({ queryKey: machinesOptions.queryKey });
    },
  });
  return {
    machines,
    busy,
    write: writes.at(-1),
    revoke: (machine: Machine) => {
      if (isRevoking(queries)) return false;
      revoke.mutate(machine);
      return true;
    },
  };
}
