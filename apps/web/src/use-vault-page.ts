import { validateSecretDescription } from '@nook/contract';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from './api-client';
import { bucketsOptions } from './buckets-api';
import { RESERVED } from './paths';
import { type SecretWrite, unconfirmed, useVault } from './vault-api';
import { feedbackFor } from './vault-feedback';
import {
  countByBucket,
  type Secret,
  secretPath,
  validateName,
  validateValue,
} from './vault-model';
import {
  type Draft,
  idleUi,
  openSheet,
  type SheetState,
  type VaultUi,
} from './vault-state';

function useWide() {
  const [wide, setWide] = useState(
    () => matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(min-width: 1024px)');
    const update = () => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}
function blankDraft(bucket: string): Draft {
  return { mode: 'create', bucket, name: '', description: '', value: '' };
}
function replacement(secret: Secret): Draft {
  return {
    mode: 'replace',
    bucket: secret.bucket,
    name: secret.name,
    description: secret.description,
    expectedVersion: secret.version,
    value: '',
  };
}
function fromDraft(draft: Draft): SecretWrite {
  const writeId = crypto.randomUUID();
  return {
    op: draft.mode,
    writeId,
    expectedVersion: draft.expectedVersion ?? writeId,
    secret: {
      bucket: draft.bucket,
      name: draft.name,
      path: secretPath(draft),
      description: draft.description,
      version: writeId,
      updatedAt: new Date().toISOString(),
    },
  };
}
function invalidDraft(draft: Draft) {
  return (
    (draft.mode === 'create' && validateName(draft.name)) ||
    validateSecretDescription(draft.description) ||
    validateValue(draft.value)
  );
}
function knownDuplicate(draft: Draft, list: readonly Secret[]) {
  return (
    draft.mode === 'create' &&
    list.some((secret) => secret.path === secretPath(draft))
  );
}
function rejectedSheet(sheet: SheetState, list: readonly Secret[]) {
  const duplicate = knownDuplicate(sheet.draft, list);
  if (!invalidDraft(sheet.draft) && !duplicate) return null;
  return {
    ...sheet,
    submitted: true,
    duplicate: duplicate ? secretPath(sheet.draft) : null,
  };
}
function duplicateHandler(
  input: SecretWrite,
  draft: Draft | undefined,
  patch: (next: Partial<VaultUi>) => void,
) {
  return (error: Error) => {
    if (
      input.op !== 'create' ||
      !(error instanceof ApiError) ||
      error.tag !== 'SecretExists' ||
      error.ambiguous ||
      !draft
    )
      return;
    patch({
      sheet: {
        ...openSheet(draft),
        submitted: true,
        duplicate: input.secret.path,
      },
    });
  };
}
export function useVaultPage() {
  const search = useSearch({ strict: false }) as { bucket?: string };
  const navigate = useNavigate();
  const location = useLocation();
  const [reveal, setReveal] = useState<{ href: string; secret: Secret } | null>(
    null,
  );
  useEffect(() => {
    setReveal((current) => (current?.href === location.href ? current : null));
  }, [location.href]);
  const bucketsQuery = useQuery(bucketsOptions);
  const vault = useVault();
  const { secrets, busy } = vault;
  const [state, setUi] = useState<VaultUi>(idleUi);
  const [dismissed, setDismissed] = useState<number>();
  const patch = (next: Partial<VaultUi>) =>
    setUi((current) => ({ ...current, ...next }));
  const wide = useWide();
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const buckets = useMemo(
    () => bucketsQuery.data?.map((bucket) => bucket.path) ?? [],
    [bucketsQuery.data],
  );
  const list = secrets.data;
  const selected = search.bucket ?? RESERVED;
  const drilled = search.bucket !== undefined;
  const parents = useMemo(
    () =>
      new Set(
        buckets.filter((path) =>
          buckets.some((other) => other.startsWith(`${path}/`)),
        ),
      ),
    [buckets],
  );
  const counts = useMemo(() => (list ? countByBucket(list) : null), [list]);
  const feedback =
    vault.write?.id === dismissed ? null : feedbackFor(vault.write);
  const show = (bucket: string) =>
    navigate({ to: '/vault', search: { bucket } });
  const run = (input: SecretWrite, draft?: Draft) => {
    const safeDraft = draft ? { ...draft, value: '' } : undefined;
    const started = vault.submit(
      input,
      draft?.value ?? '',
      duplicateHandler(input, safeDraft, patch),
    );
    if (started) {
      setUi(idleUi);
      setDismissed(undefined);
    }
    return started;
  };
  const submitSheet = () => {
    const sheet = state.sheet;
    if (!sheet || !list) return;
    const { draft } = sheet;
    const rejected = rejectedSheet(sheet, list);
    if (rejected) {
      patch({ sheet: rejected });
      return;
    }
    if (draft.mode === 'replace') {
      patch({ sheet: { ...sheet, submitted: true, confirming: true } });
      return;
    }
    if (run(fromDraft(draft), draft)) void show(draft.bucket);
  };
  const confirmReplace = () => {
    if (state.sheet) run(fromDraft(state.sheet.draft), state.sheet.draft);
  };
  const openCreate = (bucket?: string) =>
    patch({
      sheet: openSheet(
        blankDraft(
          bucket ?? (buckets.includes(selected) ? selected : RESERVED),
        ),
      ),
    });
  const openReplace = (secret: Secret) =>
    patch({ sheet: openSheet(replacement(secret)) });
  const requestDelete = (secret: Secret, trigger: HTMLButtonElement | null) => {
    if (busy) return;
    deleteTrigger.current = trigger;
    patch({ deleting: secret });
  };
  const confirmDelete = () => {
    if (state.deleting)
      run({
        op: 'delete',
        secret: state.deleting,
        writeId: crypto.randomUUID(),
        expectedVersion: state.deleting.version,
      });
  };
  const retry = () => {
    const write = vault.write;
    if (!write) return;
    if (unconfirmed(write.error)) {
      void secrets.refetch();
      return;
    }
    const current = list?.find(
      (secret) => secret.path === write.input.secret.path,
    );
    if (write.input.op === 'delete') {
      if (current) patch({ deleting: current });
      return;
    }
    if (write.input.op === 'replace' && current) {
      openReplace(current);
      return;
    }
    patch({
      sheet: openSheet({
        ...blankDraft(write.input.secret.bucket),
        name: write.input.secret.name,
        description: write.input.secret.description,
      }),
    });
  };
  const highlighted =
    feedback?.kind === 'done' && feedback.op !== 'delete'
      ? feedback.path
      : null;
  useEffect(() => {
    if (highlighted)
      document
        .querySelector(`[data-secret="${CSS.escape(highlighted)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);
  return {
    revealing: reveal?.href === location.href ? reveal.secret : null,
    openReveal: (secret: Secret) => {
      if (!busy) setReveal({ href: location.href, secret });
    },
    closeReveal: () => setReveal(null),
    ui: { ...state, feedback },
    setUi,
    patch,
    wide,
    buckets,
    bucketsQuery,
    secrets,
    list,
    loaded: list !== undefined,
    busy,
    saving: new Set([...vault.saving, ...vault.confirming]),
    confirming: vault.confirming,
    drilled,
    selected,
    parents,
    counts,
    highlighted,
    heading,
    deleteTrigger,
    openCreate,
    openReplace,
    requestDelete,
    confirmDelete,
    submitSheet,
    confirmReplace,
    retry,
    dismissFeedback: () => setDismissed(vault.write?.id),
  };
}
