import type { Machine } from '@nook/contract';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { runApi } from './api-client';
import { createWriteGate } from './write-gate';

const machinesOptions = queryOptions({
  queryKey: ['machines'],
  queryFn: async ({ signal }) => [
    ...(await runApi((api) => api.machines.list(), signal)).machines,
  ],
  retry: false,
  staleTime: 30_000,
  refetchOnWindowFocus: 'always',
});
const revokeKey = ['machines', 'revoke'] as const;
const gate = createWriteGate(revokeKey, { disableWhileBusy: true });
export type MachineRevoke = {
  id: number;
  machine: Machine;
  status: 'idle' | 'pending' | 'success' | 'error';
  error: Error | null;
};
export function preloadMachines(queries: QueryClient) {
  gate.preload(queries, machinesOptions);
}
function useMachineState() {
  const observed = gate.useWrites<MachineRevoke>((mutation) => ({
    id: mutation.mutationId,
    machine: mutation.state.variables as Machine,
    status: mutation.state.status,
    error: mutation.state.error,
  }));
  const { writes, busy } = observed;
  const pendingIds = new Set(
    writes
      .filter((write) => write.status === 'pending')
      .map((write) => write.machine.id),
  );
  const machines = useQuery({
    ...gate.queryOptions(machinesOptions, busy),
    select: (data) => data.filter((machine) => !pendingIds.has(machine.id)),
  });
  return { ...observed, machines };
}
export function useMachineList() {
  return useMachineState().machines;
}
export function useMachines() {
  const queries = useQueryClient();
  const { machines, busy, write } = useMachineState();
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
    write,
    revoke: (machine: Machine) =>
      gate.start(queries, () => revoke.mutate(machine)),
  };
}
