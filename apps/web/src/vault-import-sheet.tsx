import { secretLimits, validateSecretDescription } from '@nook/contract';
import { cn } from 'cn';
import type { Redacted } from 'effect';
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  Clock,
  RotateCw,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { reachText } from '@/bucket-format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { noAutofill } from '@/no-autofill';
import { Path } from '@/path-text';
import { type ParsedEnv as Parsed, parseEnv } from './env-parse';
import {
  type ImportOutcome as Outcome,
  type ImportRun as Run,
  type ImportKey as RunItem,
  retryable,
  type useVaultImport,
} from './vault-import';
import {
  type ImportRow,
  IMPORT_KEYS_MAX as KEYS_MAX,
  needsFix,
  review,
  rowsFrom,
  type RowStatus as Status,
} from './vault-import-model';
import { plural, type Secret } from './vault-model';

type Group = 'fix' | 'ready' | 'skip';
type Row = ImportRow & { group: Group };
type Skipped = Run['skipped'][number];
type Step = 'paste' | 'review' | 'run';
const NAME_MAX = secretLimits.name;
const DESCRIPTION_MAX = secretLimits.description;

export const sectionLabel =
  'text-xs font-medium tracking-wider text-muted-foreground uppercase';

function pending(run: Run | null) {
  return run !== null && !run.settled;
}

/* ---------- shared pieces ---------- */

function SectionHeader({
  title,
  count,
  hint,
}: {
  title: string;
  count?: number;
  hint?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex min-h-8 items-center gap-2 border-b">
      <h3 className={sectionLabel}>{title}</h3>
      {count !== undefined && <Badge variant="secondary">{count}</Badge>}
      {hint && (
        <span className="ml-auto text-right text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}

function BucketField({
  bucket,
  buckets,
  parents,
  onBucket,
  compact = false,
}: {
  bucket: string;
  buckets: readonly string[];
  parents: ReadonlySet<string>;
  onBucket: (bucket: string) => void;
  compact?: boolean;
}) {
  return (
    <Field orientation="horizontal">
      <div
        className={
          compact
            ? 'flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3'
            : 'flex w-full flex-col gap-3'
        }
      >
        <FieldLabel htmlFor="import-bucket" className="flex-none">
          Bucket
        </FieldLabel>
        <Select value={bucket} onValueChange={onBucket}>
          <SelectTrigger
            id="import-bucket"
            className={compact ? 'w-full sm:w-auto' : 'w-full'}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {buckets.map((path) => (
              <SelectItem key={path} value={path}>
                <span className="font-mono">{path}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          {reachText(bucket, parents.has(bucket), 'them')}
        </FieldDescription>
      </div>
    </Field>
  );
}

function UnreadLines({ lines }: { lines: readonly number[] }) {
  if (lines.length === 0) return null;
  const list =
    lines.length === 1
      ? `Line ${lines[0]} isn’t`
      : `Lines ${lines.slice(0, -1).join(', ')} and ${lines.at(-1)} aren’t`;
  return (
    <section className="mt-8">
      <SectionHeader title="Not read" count={lines.length} />
      <p className="text-sm text-muted-foreground">
        {list} a <span className="font-mono">KEY=value</span> line, so{' '}
        {lines.length === 1 ? 'it was' : 'they were'} left out.
      </p>
    </section>
  );
}

/* ---------- step 1: paste ---------- */

function PasteStep({
  text,
  parsed,
  textRef,
  onText,
}: {
  text: string;
  parsed: Parsed;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  onText: (text: string) => void;
}) {
  const count = parsed.entries.length;
  const over = count > KEYS_MAX;
  return (
    <FieldGroup>
      <Field data-invalid={over ? true : undefined}>
        <FieldLabel htmlFor="import-text">.env contents</FieldLabel>
        <Textarea
          id="import-text"
          ref={textRef}
          variant="secret"
          value={text}
          placeholder={'NODE_ENV=…\nAPI_KEY=…'}
          wrap="off"
          className="field-sizing-fixed h-72 resize-none sm:h-96"
          aria-invalid={over ? true : undefined}
          aria-describedby="import-text-feedback"
          {...noAutofill}
          onChange={(event) => onText(event.target.value)}
        />
        <div id="import-text-feedback" aria-live="polite">
          {over ? (
            <div className="flex flex-col gap-1">
              <FieldError>
                This paste has {count} keys. Nook imports up to {KEYS_MAX} at a
                time, so nothing can be created from it.
              </FieldError>
              <FieldDescription>
                Remove some lines, or split the file and import it in parts.
              </FieldDescription>
            </div>
          ) : (
            <FieldDescription>
              <span className="font-mono">KEY=value</span> lines, as in a .env
              file. Comments and blank lines are skipped. Values stay in this
              box; the review shows names only.
            </FieldDescription>
          )}
        </div>
      </Field>
    </FieldGroup>
  );
}

/* ---------- step 2: review ---------- */

type Reason = { text: React.ReactNode; tone: 'error' | 'muted' | 'ok' };
function invalidNameReason(row: Row): Reason {
  return {
    tone: 'error',
    text:
      row.name.length > NAME_MAX
        ? `Invalid name. Up to ${NAME_MAX} characters.`
        : 'Invalid name. Use uppercase letters, digits, and underscores, like GH_TOKEN.',
  };
}
function duplicateReason(row: Row, rows: readonly Row[]): Reason {
  const lines = rows
    .filter((other) => other.id !== row.id && other.name === row.name)
    .map((other) => other.line);
  return {
    tone: row.included ? 'error' : 'muted',
    text: row.included
      ? `Duplicate. ${row.name} is also on line ${lines.join(', ')}. Rename it, or uncheck all but one.`
      : `Unchecked. Same name as line ${lines.join(', ')}.`,
  };
}
function readyReason(row: Row): Reason | null {
  if (row.group === 'ready') return null;
  return { tone: 'ok', text: row.included ? 'Ready.' : 'Ready, unchecked.' };
}
function reasonFor(
  status: Status,
  row: Row,
  rows: readonly Row[],
  bucket: string,
): Reason | null {
  if (status === 'invalid-name') return invalidNameReason(row);
  if (status === 'invalid-description')
    return { tone: 'error', text: validateSecretDescription(row.description) };
  if (status === 'duplicate') return duplicateReason(row, rows);
  if (status === 'ready') return readyReason(row);
  const skipped = {
    empty: 'Empty value. Skipped.',
    'too-long': 'Value is over 64 KiB. Skipped.',
    exists: (
      <>
        Already in <Path>{bucket}</Path>. Skipped; the stored value stays as it
        is.
      </>
    ),
  };
  return { tone: 'muted', text: skipped[status] };
}
function ReviewCheckbox({
  row,
  status,
  onRow,
}: {
  row: Row;
  status: Status;
  onRow: (patch: Partial<Row>) => void;
}) {
  if (status === 'invalid-name')
    return (
      <Checkbox
        disabled
        checked={false}
        aria-label={`${row.name} can’t be included until its name is fixed`}
      />
    );
  if (['ready', 'duplicate', 'invalid-description'].includes(status))
    return (
      <Checkbox
        checked={row.included}
        aria-label={`Include ${row.name}`}
        onCheckedChange={(checked) => onRow({ included: checked === true })}
      />
    );
  return null;
}
function RowReason({ reason }: { reason: Reason | null }) {
  if (!reason) return null;
  return (
    <p
      className={cn(
        'mt-1.5 flex items-start gap-1 pl-7 text-xs',
        reason.tone === 'error' && 'text-destructive',
        reason.tone === 'muted' && 'text-muted-foreground',
        reason.tone === 'ok' && 'text-foreground',
      )}
    >
      {reason.tone === 'ok' && <Check className="mt-px size-3.5 shrink-0" />}
      <span className="wrap-anywhere">{reason.text}</span>
    </p>
  );
}

function ReviewRow({
  row,
  rows,
  status,
  bucket,
  onRow,
}: {
  row: Row;
  rows: readonly Row[];
  status: Status;
  bucket: string;
  onRow: (patch: Partial<Row>) => void;
}) {
  const reason = reasonFor(status, row, rows, bucket);
  const blocked = needsFix(status, row.included);
  const nameId = `${row.id}-name`;
  return (
    <li className="px-3 py-2.5 sm:px-4" data-row={row.name}>
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-4 shrink-0 items-center">
          <ReviewCheckbox row={row} status={status} onRow={onRow} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
          <div className="min-w-0 font-mono sm:w-64 sm:shrink-0">
            <Input
              id={nameId}
              value={row.name}
              aria-label={`Name from line ${row.line}`}
              aria-invalid={blocked ? true : undefined}
              className="h-8"
              {...noAutofill}
              onChange={(event) => onRow({ name: event.target.value })}
            />
          </div>
          <Input
            value={row.description}
            maxLength={DESCRIPTION_MAX}
            placeholder="Description (optional)"
            aria-label={`Description for ${row.name}`}
            aria-invalid={status === 'invalid-description' || undefined}
            autoComplete="off"
            className="h-8"
            onChange={(event) =>
              onRow({ description: event.target.value.replace(/\n/g, ' ') })
            }
          />
        </div>
      </div>
      <RowReason reason={reason} />
    </li>
  );
}

function ReviewSection({
  title,
  hint,
  rows,
  all,
  status,
  bucket,
  muted,
  onRow,
}: {
  title: string;
  hint: React.ReactNode;
  rows: Row[];
  all: readonly Row[];
  status: ReadonlyMap<string, Status>;
  bucket: string;
  muted?: boolean;
  onRow: (id: string, patch: Partial<Row>) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-8 first:mt-0">
      <SectionHeader title={title} count={rows.length} hint={hint} />
      <ul
        className={cn(
          'divide-y overflow-hidden rounded-lg border',
          muted && 'bg-muted/30',
        )}
      >
        {rows.map((row) => (
          <ReviewRow
            key={row.id}
            row={row}
            rows={all}
            status={status.get(row.id) as Status}
            bucket={bucket}
            onRow={(patch) => onRow(row.id, patch)}
          />
        ))}
      </ul>
    </section>
  );
}

function ReviewStep({
  bucket,
  rows,
  unread,
  status,
  onRow,
}: {
  bucket: string;
  rows: Row[];
  unread: readonly number[];
  status: ReadonlyMap<string, Status>;
  onRow: (id: string, patch: Partial<Row>) => void;
}) {
  const inGroup = (group: Row['group']) =>
    rows.filter((row) => row.group === group);
  const fix = inGroup('fix');
  const ready = inGroup('ready');
  const blocked = fix.filter((row) => {
    const s = status.get(row.id);
    return needsFix(s as Status, row.included);
  }).length;
  const checked = ready.filter(
    (row) => row.included && status.get(row.id) === 'ready',
  ).length;
  return (
    <div className="mt-8">
      <ReviewSection
        title="Needs a fix"
        hint={blocked === 0 ? 'All fixed' : 'Not created until fixed'}
        rows={fix}
        all={rows}
        status={status}
        bucket={bucket}
        onRow={onRow}
      />
      <ReviewSection
        title="Ready"
        hint={`${checked} of ${ready.length} checked`}
        rows={ready}
        all={rows}
        status={status}
        bucket={bucket}
        onRow={onRow}
      />
      <ReviewSection
        title="Skipped"
        hint="Not created"
        rows={inGroup('skip')}
        all={rows}
        status={status}
        bucket={bucket}
        muted
        onRow={onRow}
      />
      <UnreadLines lines={unread} />
    </div>
  );
}

/* ---------- creating and results ---------- */

const outcomeLabel: Record<Outcome, string> = {
  queued: 'Waiting',
  creating: 'Creating…',
  created: 'Created',
  exists: 'Already exists',
  failed: 'Failed',
  unconfirmed: 'Not confirmed',
};

function OutcomeIcon({ outcome }: { outcome: Outcome }) {
  const className = 'mt-0.5 size-4 shrink-0';
  if (outcome === 'creating') return <Spinner className={className} />;
  if (outcome === 'queued')
    return <Clock className={cn(className, 'text-muted-foreground')} />;
  if (outcome === 'created') return <CircleCheck className={className} />;
  if (outcome === 'failed')
    return <CircleAlert className={cn(className, 'text-destructive')} />;
  if (outcome === 'unconfirmed')
    return <CircleDashed className={cn(className, 'text-destructive')} />;
  return <CircleMinus className={cn(className, 'text-muted-foreground')} />;
}

function RunRow({ item }: { item: RunItem }) {
  const problem = item.outcome === 'failed' || item.outcome === 'unconfirmed';
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-run={item.name}>
      <OutcomeIcon outcome={item.outcome} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm font-medium wrap-anywhere">
          {item.name}
        </div>
        {item.description && (
          <div className="text-sm text-muted-foreground wrap-break-word">
            {item.description}
          </div>
        )}
        {item.reason && (
          <div
            className={cn(
              'mt-0.5 text-xs',
              problem ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {item.reason}
          </div>
        )}
      </div>
      <span
        className={cn(
          'shrink-0 pt-0.5 text-xs',
          problem ? 'text-destructive' : 'text-muted-foreground',
          item.outcome === 'created' && 'text-foreground',
        )}
      >
        {outcomeLabel[item.outcome]}
      </span>
    </li>
  );
}

function RunList({
  title,
  hint,
  items,
}: {
  title: string;
  hint?: string;
  items: readonly RunItem[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="mt-8 first:mt-0">
      <SectionHeader title={title} count={items.length} hint={hint} />
      <ul className="divide-y overflow-hidden rounded-lg border">
        {items.map((item) => (
          <RunRow key={item.path} item={item} />
        ))}
      </ul>
    </section>
  );
}

function SkippedList({ skipped }: { skipped: readonly Skipped[] }) {
  if (skipped.length === 0) return null;
  return (
    <section className="mt-8">
      <SectionHeader
        title="Skipped"
        count={skipped.length}
        hint="Not created"
      />
      <ul className="divide-y overflow-hidden rounded-lg border bg-muted/30">
        {skipped.map((item) => (
          <li key={item.id} className="flex items-start gap-3 px-4 py-2.5">
            <CircleMinus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-sm wrap-anywhere">{item.name}</div>
              <div className="text-xs text-muted-foreground">{item.why}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunStep({ run }: { run: Run }) {
  const total = run.keys.length;
  const created = run.keys.filter((item) => item.outcome === 'created').length;
  const running = pending(run);
  const retry = run.keys.filter(retryable);
  const settled = run.keys.filter((item) => !retryable(item));
  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium">
            {created} of {total} created
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {Math.round((created / total) * 100)}%
          </span>
        </div>
        <Progress
          value={(created / total) * 100}
          aria-label="Import progress"
        />
        {running && (
          <p className="text-sm text-muted-foreground">
            Closing this or opening another page doesn’t stop the import. New
            secret, Replace and Delete are paused until it finishes.
          </p>
        )}
      </div>
      <div className="mt-8">
        <RunList
          title="Needs another try"
          hint="Retry sends only these"
          items={retry}
        />
        <RunList title={running ? 'Secrets' : 'Created'} items={settled} />
        <SkippedList skipped={run.skipped} />
        <UnreadLines lines={run.unreadable} />
      </div>
    </>
  );
}

/* ---------- the sheet ---------- */

export type ImportSheetProps = {
  open: boolean;
  step: Step;
  bucket: string;
  text: string;
  parsed: Parsed;
  rows: Row[];
  unread: readonly number[];
  status: ReadonlyMap<string, Status>;
  selected: number;
  toFix: number;
  buckets: readonly string[];
  parents: ReadonlySet<string>;
  run: Run | null;
  onClose: () => void;
  onBucket: (bucket: string) => void;
  onText: (text: string) => void;
  onReview: () => void;
  onBack: () => void;
  onRow: (id: string, patch: Partial<Row>) => void;
  onCreate: () => void;
  onRetry: () => void;
};

function runHeader(run: Run) {
  if (!run.settled)
    return {
      title: 'Importing…',
      description: (
        <>
          Creating secrets in{' '}
          <Path className="text-foreground">{run.bucket}</Path>. Each key is its
          own request, so one problem doesn’t stop the rest.
        </>
      ),
    };
  const failed = run.keys.filter(retryable).length;
  const created = run.keys.filter((item) => item.outcome === 'created').length;
  return {
    title: failed ? 'Import finished with problems' : 'Import finished',
    description: (
      <>
        {plural(created, 'secret')} created in{' '}
        <Path className="text-foreground">{run.bucket}</Path>.
        {failed > 0 && ` ${failed} need another try.`}
      </>
    ),
  };
}
function header({ step, run }: ImportSheetProps) {
  if (run) return runHeader(run);
  return {
    title: 'Import .env',
    description:
      step === 'paste'
        ? 'Step 1 of 2. Paste a .env file; you review every key before anything is stored.'
        : 'Step 2 of 2. Check the names and add descriptions. Values stay hidden, and existing secrets are never overwritten.',
  };
}

function PasteFooter(props: ImportSheetProps) {
  const count = props.parsed.entries.length;
  return (
    <>
      <span className="mr-auto hidden text-sm text-muted-foreground sm:block">
        {count > 0 && `${plural(count, 'key')} found`}
      </span>
      <Button type="button" variant="outline" onClick={props.onClose}>
        Cancel
      </Button>
      <Button
        type="button"
        disabled={count === 0 || count > KEYS_MAX}
        onClick={props.onReview}
      >
        Review keys
      </Button>
    </>
  );
}
function ReviewFooter(props: ImportSheetProps) {
  const blocked = props.toFix;
  return (
    <>
      <span className="mr-auto hidden text-sm text-muted-foreground sm:block">
        {blocked > 0 &&
          `${plural(blocked, 'key')} still need${blocked === 1 ? 's' : ''} a fix`}
      </span>
      <Button type="button" variant="outline" onClick={props.onBack}>
        Back
      </Button>
      <Button
        type="button"
        disabled={props.selected === 0}
        onClick={props.onCreate}
      >
        Create {plural(props.selected, 'secret')}
      </Button>
    </>
  );
}
function RunFooter(props: ImportSheetProps) {
  const running = pending(props.run);
  const retry = props.run?.keys.some(retryable) ?? false;
  return (
    <>
      <Button
        type="button"
        variant={running || retry ? 'outline' : 'default'}
        onClick={props.onClose}
      >
        {running ? 'Close' : 'Done'}
      </Button>
      {!running && retry && (
        <Button type="button" onClick={props.onRetry}>
          <RotateCw />
          Retry failed
        </Button>
      )}
    </>
  );
}
function Footer(props: ImportSheetProps) {
  if (props.step === 'paste') return <PasteFooter {...props} />;
  if (props.step === 'review') return <ReviewFooter {...props} />;
  return <RunFooter {...props} />;
}

function ImportSheet(props: ImportSheetProps) {
  const { open, step } = props;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { title, description } = header(props);
  return (
    <Sheet open={open} onOpenChange={(value) => !value && props.onClose()}>
      <SheetContent
        className="w-full sm:max-w-2xl"
        layout="stacked"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (step === 'paste') textRef.current?.focus();
        }}
      >
        <SheetHeader>
          <div className="flex flex-col gap-1.5 pr-8">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </div>
        </SheetHeader>
        <Separator />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {step !== 'run' && (
            <BucketField
              bucket={props.bucket}
              buckets={props.buckets}
              parents={props.parents}
              onBucket={props.onBucket}
              compact={step === 'review'}
            />
          )}
          {step === 'paste' && (
            <div className="mt-7">
              <PasteStep
                text={props.text}
                parsed={props.parsed}
                textRef={textRef}
                onText={props.onText}
              />
            </div>
          )}
          {step === 'review' && (
            <ReviewStep
              bucket={props.bucket}
              rows={props.rows}
              unread={props.unread}
              status={props.status}
              onRow={props.onRow}
            />
          )}
          {step === 'run' && props.run && <RunStep run={props.run} />}
        </div>
        <Separator />
        <SheetFooter className="flex-row items-center justify-end">
          <Footer {...props} />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function groupOf(status: Status): Group {
  if (status === 'ready') return 'ready';
  return needsFix(status, true) ? 'fix' : 'skip';
}
function grouped(
  rows: readonly ImportRow[],
  status: ReadonlyMap<string, Status>,
): Row[] {
  return rows.map((row) => ({
    ...row,
    group: groupOf(status.get(row.id) as Status),
  }));
}
function namesIn(secrets: readonly Secret[], bucket: string) {
  return new Set(
    secrets
      .filter((secret) => secret.bucket === bucket)
      .map((secret) => secret.name),
  );
}
const skipWhy: Record<Status, (bucket: string) => string> = {
  exists: (bucket) => `Already in ${bucket}; not changed.`,
  'invalid-name': () => 'Invalid name; not created.',
  'invalid-description': () => 'Invalid description; not created.',
  duplicate: () => 'Duplicate name; not created.',
  empty: () => 'Empty value; not created.',
  'too-long': () => 'Value over 64 KiB; not created.',
  ready: () => 'Unchecked; not created.',
};
type SheetProps = {
  open: boolean;
  initialBucket: string;
  buckets: readonly string[];
  parents: ReadonlySet<string>;
  secrets: readonly Secret[];
  importer: ReturnType<typeof useVaultImport>;
  onClose: () => void;
  onStarted: (bucket: string) => void;
};
function useDraft(initialBucket: string, secrets: readonly Secret[]) {
  const [text, setText] = useState('');
  const [bucket, setBucket] = useState(initialBucket);
  const [rows, setRows] = useState<Row[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const values = useRef(new Map<string, Redacted.Redacted<string>>());
  const parsed = useMemo(() => parseEnv(text), [text]);
  const checked = review(rows, values.current, namesIn(secrets, bucket));
  const onReview = () => {
    const result = rowsFrom(parsed);
    if ('tooMany' in result) return;
    values.current = new Map(
      result.rows.map((row, index) => [row.id, parsed.entries[index].value]),
    );
    setRows(
      grouped(
        result.rows,
        review(result.rows, values.current, namesIn(secrets, bucket)).status,
      ),
    );
    setReviewing(true);
  };
  const onBucket = (next: string) => {
    setBucket(next);
    setRows(
      grouped(
        rows,
        review(rows, values.current, namesIn(secrets, next)).status,
      ),
    );
  };
  const reset = () => {
    values.current.clear();
    setText('');
    setRows([]);
    setReviewing(false);
  };
  const skipped = () => {
    const selected = new Set(checked.selection.map(({ row }) => row.id));
    return rows
      .filter((row) => !selected.has(row.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        why: skipWhy[checked.status.get(row.id) as Status](bucket),
      }));
  };
  return {
    bucket,
    text,
    parsed,
    rows,
    reviewing,
    checked,
    onReview,
    onBucket,
    reset,
    skipped,
    onText: setText,
    onBack: () => setReviewing(false),
    onRow: (id: string, patch: Partial<Row>) =>
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      ),
  };
}
export default function VaultImportSheet(props: SheetProps) {
  const { importer } = props;
  const draft = useDraft(props.initialBucket, props.secrets);
  const onCreate = () => {
    const started = importer.start(draft.bucket, draft.checked.selection, {
      skipped: draft.skipped(),
      unreadable: draft.parsed.unreadable,
    });
    if (started) {
      draft.reset();
      props.onStarted(draft.bucket);
    }
  };
  const onClose = () => {
    if (importer.run?.settled) importer.dismiss();
    draft.reset();
    props.onClose();
  };
  return (
    <ImportSheet
      {...draft}
      open={props.open}
      buckets={props.buckets}
      parents={props.parents}
      step={importer.run ? 'run' : draft.reviewing ? 'review' : 'paste'}
      run={importer.run}
      status={draft.checked.status}
      selected={draft.checked.selection.length}
      toFix={draft.checked.toFix}
      unread={draft.parsed.unreadable}
      onClose={onClose}
      onCreate={onCreate}
      onRetry={importer.retryFailed}
    />
  );
}
