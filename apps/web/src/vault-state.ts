import type { Secret } from './vault-model';

export type Draft = {
  mode: 'create' | 'replace';
  bucket: string;
  name: string;
  description: string;
  value: string;
  expectedVersion?: string;
};
export type SheetState = {
  draft: Draft;
  submitted: boolean;
  duplicate: string | null;
  confirming: boolean;
};
export type WriteOp = 'create' | 'replace' | 'delete';
export type Feedback = {
  kind: 'saving' | 'done' | 'failed' | 'unconfirmed' | 'current';
  op: WriteOp;
  path: string;
  message: string;
};
export type VaultUi = { sheet: SheetState | null; deleting: Secret | null };
export function openSheet(draft: Draft): SheetState {
  return { draft, submitted: false, duplicate: null, confirming: false };
}
export const idleUi: VaultUi = { sheet: null, deleting: null };
