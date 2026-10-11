import { bucketLineage, type CreatedBucket } from '@nook/contract';
import { CircleAlert, CircleCheck, CornerDownLeft, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import { ApiError, describeFailure } from './api-client';
import { useBuckets } from './buckets-api';
import { DismissibleAlert, LoadFailure } from './failure';
import {
  buildOutline,
  Outline,
  type OutlineActions,
  OutlineSkeleton,
  type OutlineState,
} from './outline';
import { Path, PathList } from './path-text';
import { type CreatePlan, planCreate, validatePath } from './paths';
import { useConfirmTarget } from './use-confirm-target';

type Failure = { title: string; description: string };
type Feedback =
  | { kind: 'idle' }
  | { kind: 'problem'; message: string; suggestion?: string }
  | { kind: 'continue'; parent: string }
  | { kind: 'plan'; plan: CreatePlan }
  | { kind: 'loading' };

function quote(path: string) {
  return <Path className="text-foreground">{path}</Path>;
}

function createdStatus(result: CreatedBucket) {
  if (!result.created)
    return <>{quote(result.path)} already exists. Nothing changed.</>;
  return result.createdAncestors.length === 0 ? (
    <>Created {quote(result.path)}.</>
  ) : (
    <>
      Created {quote(result.path)} with{' '}
      <PathList paths={result.createdAncestors} className="text-foreground" />.
    </>
  );
}

function writeFailure(
  write: NonNullable<ReturnType<typeof useBuckets>['write']>,
): Failure {
  const unknown = write.error instanceof ApiError && write.error.outcomeUnknown;
  if (write.operation === 'create')
    return {
      title: unknown
        ? `Couldn't confirm creation of ${write.path}`
        : `Couldn't create ${write.path}`,
      description: unknown
        ? "Nook couldn't confirm whether the bucket was created. The path is back in the field; press Enter to try again."
        : describeFailure(
            write.error,
            'change buckets',
            'The path is back in the field; press Enter to try again.',
          ),
    };
  return {
    title: unknown
      ? `Couldn't confirm deletion of ${write.path}`
      : `Couldn't delete ${write.path}`,
    description: deleteFailure(write.error),
  };
}

function deleteFailure(error: Error | null) {
  if (error instanceof ApiError) {
    if (error.outcomeUnknown)
      return "Nook couldn't confirm whether the bucket was deleted. Check the outline before trying again.";
    if (['BucketHasSecrets', 'BucketHasMemories'].includes(error.tag ?? ''))
      return error.message;
    if (error.tag === 'BucketNotFound')
      return 'Nook reports that this bucket no longer exists. Check the outline before trying again.';
    if (error.status === 409)
      return 'Nook reports that it has child buckets, so the tree changed since you loaded it. Delete its child buckets first. Check the outline before trying again.';
  }
  return describeFailure(
    error,
    'change buckets',
    'Check the outline before trying again.',
  );
}

function PlanPreview({ plan }: { plan: CreatePlan }) {
  if (plan.missing.length === 0)
    return (
      <FieldDescription className="flex items-start">
        <CircleCheck className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {quote(plan.path)} already exists. Creating it changes nothing.
        </span>
      </FieldDescription>
    );
  const count = plan.missing.length;
  return (
    <div className="flex flex-col gap-2">
      <FieldDescription>
        Creates {count === 1 ? '1 bucket' : `${count} buckets`}{' '}
        {plan.landsIn ? (
          <>inside {quote(plan.landsIn)}</>
        ) : count > 1 ? (
          'starting at the top level'
        ) : (
          'at the top level'
        )}
        :
      </FieldDescription>
      <ul className="flex flex-wrap" aria-label="Buckets to create">
        {plan.missing.map((path) => (
          <li key={path} className="min-w-0 max-w-full">
            <Badge
              variant={path === plan.path ? 'default' : 'secondary'}
              className="h-auto max-w-full whitespace-normal wrap-anywhere"
            >
              <Plus />
              {path}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function continuingPath(value: string, submitted: boolean, trimmed: string) {
  return (
    !submitted &&
    value.endsWith('/') &&
    Boolean(trimmed) &&
    !validatePath(trimmed)
  );
}
function feedbackFor(
  value: string,
  submitted: boolean,
  loaded: boolean,
  existing: Set<string>,
): Feedback {
  if (value === '') {
    return submitted
      ? { kind: 'problem', message: 'Enter a bucket path.' }
      : { kind: 'idle' };
  }
  const problem = validatePath(value);
  if (problem) {
    const trimmed = value.slice(0, -1);
    if (continuingPath(value, submitted, trimmed))
      return { kind: 'continue', parent: trimmed };
    return {
      kind: 'problem',
      message: problem.message,
      suggestion: problem.kind === 'uppercase' ? problem.suggestion : undefined,
    };
  }
  if (!loaded) return { kind: 'loading' };
  return { kind: 'plan', plan: planCreate(value, existing) };
}

function previewState(feedback: Feedback) {
  const plan = feedback.kind === 'plan' ? feedback.plan : null;
  const ghosts = plan?.missing ?? [];
  const existingMatch = plan && plan.missing.length === 0 ? plan.path : null;
  const previewPath =
    plan?.path ?? (feedback.kind === 'continue' ? feedback.parent : null);
  return { plan, ghosts, existingMatch, previewPath };
}

function useBucketsPage() {
  const { buckets, create, remove, busy, write, pending } = useBuckets();

  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [focused, setFocused] = useState(false);
  const [status, setStatus] = useState<ReactNode>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState<{
    path: string;
    at: number;
  } | null>(null);
  const deletion = useConfirmTarget<string>(() =>
    document.querySelector<HTMLButtonElement>('[aria-label="Actions for me"]'),
  );
  const handledWrite = useRef(
    write?.status === 'success' ? write.id : undefined,
  );

  const loaded = buckets.data !== undefined;
  const all = buckets.data ?? [];
  const existing = useMemo(
    () => new Set(all.map((bucket) => bucket.path)),
    [all],
  );

  const feedback = useMemo(
    () => feedbackFor(value, submitted, loaded, existing),
    [value, submitted, loaded, existing],
  );

  const { plan, ghosts, existingMatch, previewPath } = previewState(feedback);

  // Preview and reveal open the branches on the way to the path.
  const visibleCollapsed = useMemo(() => {
    const reveal = [previewPath, highlighted?.path].filter(
      (path): path is string => !!path,
    );
    if (reveal.length === 0) return collapsed;
    const next = new Set(collapsed);
    for (const path of reveal)
      for (const prefix of bucketLineage(path)) next.delete(prefix);
    return next;
  }, [collapsed, previewPath, highlighted]);

  const nodes = useMemo(() => buildOutline(all, ghosts), [all, ghosts]);

  useEffect(() => {
    if (!highlighted) return;
    const row = document.querySelector(
      `[data-path="${CSS.escape(highlighted.path)}"]`,
    );
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = setTimeout(() => setHighlighted(null), 2400);
    return () => clearTimeout(timer);
  }, [highlighted]);

  useEffect(() => {
    if (!plan) return;
    const target = plan.missing[0] ?? plan?.path;
    const row = document.querySelector(`[data-path="${CSS.escape(target)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [plan?.path, plan?.missing.length, plan?.missing[0], plan]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.key !== '/' ||
        target.closest('input, textarea, [role="dialog"], [role="menu"]')
      )
        return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reveal = (path: string) => setHighlighted({ path, at: Date.now() });

  useEffect(() => {
    if (
      !write ||
      write.status === 'pending' ||
      handledWrite.current === write.id
    )
      return;
    handledWrite.current = write.id;
    if (write.status === 'error') {
      setStatus(null);
      setFailure(writeFailure(write));
      if (write.operation === 'create') {
        setHighlighted(null);
        setValue(write.path);
        inputRef.current?.focus();
      } else {
        setCollapsed(
          (current) =>
            new Set([...current].filter((path) => path !== write.path)),
        );
        setHighlighted({ path: write.path, at: Date.now() });
      }
    } else if (write.result) setStatus(createdStatus(write.result));
  }, [write]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const path = value;
    if (validatePath(path) || !loaded) {
      inputRef.current?.focus();
      return;
    }
    const { missing } = planCreate(path, existing);
    if (!create(path)) return;
    setFailure(null);
    setSubmitted(false);
    setValue('');
    setStatus(
      createdStatus({
        path,
        created: missing.length > 0,
        createdAncestors: missing.slice(0, -1),
      }),
    );
    reveal(path);
  };

  const confirmDelete = () => {
    const path = deletion.target;
    if (!path || !remove(path)) return;
    deletion.close();
    setFailure(null);
    setStatus(<>Deleted {quote(path)}.</>);
  };

  const actions: OutlineActions = {
    toggle: (path, open) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (open) next.delete(path);
        else next.add(path);
        return next;
      }),
    createInside: (path) => {
      setValue(`${path}/`);
      setSubmitted(false);
      setStatus(null);
    },
    focusField: () => inputRef.current?.focus(),
    requestDelete: (path, trigger) => {
      if (busy) return;
      deletion.open(path, trigger);
    },
  };

  const outlineState: OutlineState = {
    collapsed: visibleCollapsed,
    highlighted: highlighted?.path ?? null,
    existingMatch,
    pending,
    busy,
  };

  const branches = all.filter((bucket) =>
    all.some((other) => other.path.startsWith(`${bucket.path}/`)),
  );
  const problem = feedback.kind === 'problem';

  return {
    inputRef,
    value,
    setValue,
    setSubmitted,
    focused,
    setFocused,
    status: status ?? (busy && write ? <>Saving {quote(write.path)}…</> : null),
    failure,
    setFailure,
    setStatus,
    collapsed,
    setCollapsed,
    deletion,
    loaded,
    all,
    feedback,
    plan,
    nodes,
    submit,
    confirmDelete,
    actions,
    outlineState,
    branches,
    problem,
    buckets,
    busy,
  };
}

type PageState = ReturnType<typeof useBucketsPage>;

function BucketFeedback({ state }: { state: PageState }) {
  const { feedback, status, setValue, inputRef } = state;
  return (
    <>
      {' '}
      {feedback.kind === 'problem' ? (
        <FieldError>
          {feedback.suggestion ? (
            <>
              Use lowercase letters:{' '}
              <Button
                type="button"
                variant="link"
                className="h-auto"
                onClick={() => {
                  setValue(feedback.suggestion ?? '');
                  inputRef.current?.focus();
                }}
              >
                {feedback.suggestion}
              </Button>
            </>
          ) : (
            feedback.message
          )}
        </FieldError>
      ) : feedback.kind === 'continue' ? (
        <FieldDescription>
          Type the next level inside {quote(feedback.parent)}.
        </FieldDescription>
      ) : feedback.kind === 'plan' ? (
        <PlanPreview plan={feedback.plan} />
      ) : feedback.kind === 'loading' ? (
        <FieldDescription>Waiting for the outline to load…</FieldDescription>
      ) : status ? (
        <FieldDescription className="flex items-start">
          <CircleCheck className="mt-0.5 size-3.5 shrink-0" />
          <span>{status}</span>
        </FieldDescription>
      ) : (
        <FieldDescription>
          Type a path like {quote('work/acme')}. Missing parent buckets are
          created with it.
        </FieldDescription>
      )}
    </>
  );
}

function BucketComposer({ state }: { state: PageState }) {
  const {
    submit,
    problem,
    inputRef,
    value,
    setValue,
    focused,
    setFocused,
    loaded,
    setSubmitted,
    failure,
    setFailure,
    setStatus,
    busy,
  } = state;
  return (
    <div className="sticky top-16 z-10 -mx-1 bg-background px-1 pt-2 pb-3">
      <form noValidate onSubmit={submit}>
        <Field data-invalid={problem || undefined}>
          <FieldLabel htmlFor="bucket-path" className="sr-only">
            New bucket path
          </FieldLabel>
          <InputGroup className="h-10">
            <InputGroupAddon>
              <Plus />
            </InputGroupAddon>
            <InputGroupInput
              id="bucket-path"
              ref={inputRef}
              value={value}
              placeholder="New bucket path"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              disabled={busy}
              aria-invalid={problem || undefined}
              aria-describedby="bucket-path-feedback"
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => {
                setValue(event.target.value);
                setSubmitted(false);
                setStatus(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && value) {
                  event.preventDefault();
                  setValue('');
                  setSubmitted(false);
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              {!focused && !value && (
                <Kbd className="hidden sm:inline-flex">/</Kbd>
              )}
              <InputGroupButton
                type="submit"
                variant="default"
                size="sm"
                disabled={!loaded || busy}
              >
                Create
                <CornerDownLeft className="hidden sm:block" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <div id="bucket-path-feedback" aria-live="polite" className="min-h-5">
            <BucketFeedback state={state} />
          </div>
        </Field>
      </form>
      {failure && (
        <div className="mt-3">
          <DismissibleAlert
            destructive
            icon={<CircleAlert />}
            title={failure.title}
            onDismiss={() => setFailure(null)}
          >
            {failure.description}
          </DismissibleAlert>
        </div>
      )}
    </div>
  );
}

function BucketLoadFailure({ state }: { state: PageState }) {
  const { buckets, loaded, busy } = state;
  const problem = describeFailure(buckets.error, 'view buckets');
  return (
    <LoadFailure
      title={loaded ? "Couldn't refresh buckets" : "Couldn't load buckets"}
      description={
        loaded ? `Showing the last loaded outline. ${problem}` : problem
      }
      cached={loaded}
      retrying={buckets.isFetching}
      disabled={busy}
      onRetry={() => buckets.refetch()}
      className={loaded ? 'my-3' : undefined}
    />
  );
}

function BucketOutline({ state }: { state: PageState }) {
  const {
    loaded,
    branches,
    setCollapsed,
    buckets,
    nodes,
    outlineState,
    actions,
  } = state;
  return (
    <section aria-label="Bucket outline">
      <div className="mb-1 flex h-8 items-center border-b pr-1">
        <h2 className="mr-auto text-xs font-medium tracking-wider text-muted-foreground uppercase">
          All buckets
        </h2>
        {loaded && branches.length > 0 && (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setCollapsed(new Set())}
            >
              Expand all
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() =>
                setCollapsed(new Set(branches.map((bucket) => bucket.path)))
              }
            >
              Collapse all
            </Button>
          </div>
        )}
        {(loaded || !buckets.isError) && (
          <>
            <span className="hidden w-28 pr-2 text-right text-xs text-muted-foreground sm:block">
              Created
            </span>
            <span className="hidden w-7 sm:block" />
          </>
        )}
      </div>
      {buckets.isPending ? (
        <OutlineSkeleton />
      ) : !loaded ? (
        <BucketLoadFailure state={state} />
      ) : (
        <>
          {buckets.isError && <BucketLoadFailure state={state} />}
          <Outline nodes={nodes} state={outlineState} actions={actions} />
        </>
      )}
    </section>
  );
}

function DeleteConfirmation({ state }: { state: PageState }) {
  const { deletion, confirmDelete } = state;
  return (
    <AlertDialog
      open={deletion.target !== null}
      onOpenChange={(open) => !open && deletion.close()}
    >
      <AlertDialogContent onCloseAutoFocus={deletion.restoreFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">
            Delete {deletion.shown}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The bucket is empty and will be removed. You can create it again
            later with the same path.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirmDelete}>
            Delete bucket
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
export function BucketsPage() {
  const state = useBucketsPage();
  return (
    <div className="w-full max-w-4xl px-4 pb-24 sm:px-6 md:px-12">
      <h1 className="pt-6 pb-2 text-xl font-semibold tracking-tight md:pt-8">
        Buckets
      </h1>
      <BucketComposer state={state} />
      <BucketOutline state={state} />
      <DeleteConfirmation state={state} />
    </div>
  );
}
