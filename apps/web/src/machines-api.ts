import type { BucketGrant, Machine } from '@nook/contract';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, runApi } from './api-client';
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
const gate = createWriteGate(['machines'], { disableWhileBusy: true });
const revokeGate = createWriteGate(revokeKey, { disableWhileBusy: true });
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
  const queries = useQueryClient();
  const observed = revokeGate.useWrites<MachineRevoke>((mutation) => ({
    id: mutation.mutationId,
    machine: mutation.state.variables as Machine,
    status: mutation.state.status,
    error: mutation.state.error,
  }));
  const { writes } = observed;
  const busy = gate.useBusy();
  const pendingIds = new Set(
    writes
      .filter((write) => write.status === 'pending')
      .map((write) => write.machine.id),
  );
  const machines = useQuery({
    ...gate.queryOptions(machinesOptions, busy, queries),
    select: (data) => data.filter((machine) => !pendingIds.has(machine.id)),
  });
  return { ...observed, busy, machines };
}
async function refreshMachines(queries: QueryClient) {
  const filters = { queryKey: machinesOptions.queryKey };
  await queries.invalidateQueries({ ...filters, refetchType: 'none' });
  if (queries.getQueryCache().find(filters)?.getObserversCount())
    await queries.prefetchQuery(machinesOptions);
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
      void refreshMachines(queries);
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

export type AccessSave = { machine: Machine; grant: BucketGrant };
export function useSaveAccess() {
  const queries = useQueryClient();
  const busy = gate.useBusy();
  const put = (id: string, machine: Machine | null) =>
    queries.setQueryData(machinesOptions.queryKey, (current = []) =>
      machine === null
        ? current.filter((entry) => entry.id !== id)
        : current.map((entry) => (entry.id === id ? machine : entry)),
    );
  const save = useMutation({
    mutationKey: ['machines', 'access'],
    mutationFn: ({ machine, grant }: AccessSave) =>
      runApi((api) =>
        api.machines.saveGrant({
          params: { id: machine.id },
          payload: { grant, previous: machine.grant },
        }),
      ),
    onMutate: async ({ machine, grant }) => {
      await queries.cancelQueries({ queryKey: machinesOptions.queryKey });
      const previous =
        queries
          .getQueryData(machinesOptions.queryKey)
          ?.find((entry) => entry.id === machine.id) ?? machine;
      put(machine.id, { ...previous, grant });
      return { previous };
    },
    onSuccess: (machine) => put(machine.id, machine),
    onError: (error, { machine }, context) => {
      if (error instanceof ApiError && error.tag === 'NotFound') {
        put(machine.id, null);
        return;
      }
      const previous = context?.previous ?? machine;
      put(
        machine.id,
        error instanceof ApiError && error.current
          ? { ...previous, grant: error.current }
          : previous,
      );
    },
    onSettled: () => {
      // A confirmed response settles the editor even if recovery is delayed.
      void refreshMachines(queries);
    },
  });
  return {
    ...save,
    busy,
    start: (
      request: AccessSave,
      callbacks: Parameters<typeof save.mutate>[1],
    ) => gate.start(queries, () => save.mutate(request, callbacks)),
  };
}
