import { validateSecretDescription } from '@nook/contract';
import { useRef } from 'react';
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
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { Textarea } from '@/components/ui/textarea';
import { formatDate, RESERVED } from './paths';
import {
  DESCRIPTION_MAX,
  type Secret,
  secretPath,
  validateName,
  validateValue,
} from './vault-model';
import type { Draft, SheetState } from './vault-state';

/** Keeps password managers and autofill away from secret fields. */
const noAutofill = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
  'data-form-type': 'other',
} as const;

function Path({ children }: { children: string }) {
  return (
    <span className="font-mono text-foreground wrap-anywhere">{children}</span>
  );
}

export function reachText(bucket: string, hasChildren: boolean, what = 'it') {
  if (bucket === RESERVED) return `Agents working in any bucket find ${what}.`;
  return hasChildren
    ? `Agents working in ${bucket} or a bucket inside it find ${what}.`
    : `Agents working in ${bucket} find ${what}.`;
}

export function sheetProblems(sheet: SheetState) {
  const { draft, submitted } = sheet;
  const nameProblem =
    draft.mode === 'create' && (submitted || draft.name !== '')
      ? validateName(draft.name)
      : null;
  const duplicate =
    sheet.duplicate === secretPath(draft)
      ? `${sheet.duplicate} already exists.`
      : null;
  return {
    name: nameProblem ?? duplicate,
    duplicate: !nameProblem && duplicate !== null,
    value: submitted ? validateValue(draft.value) : null,
  };
}

function BucketField({
  draft,
  buckets,
  parents,
  onDraft,
}: {
  draft: Draft;
  buckets: readonly string[];
  parents: Set<string>;
  onDraft: (patch: Partial<Draft>) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor="secret-bucket">Bucket</FieldLabel>
      <Select
        value={draft.bucket}
        onValueChange={(bucket) => onDraft({ bucket })}
      >
        <SelectTrigger id="secret-bucket" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {buckets.map((bucket) => (
            <SelectItem key={bucket} value={bucket}>
              <span className="font-mono">{bucket}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {reachText(draft.bucket, parents.has(draft.bucket))}
      </FieldDescription>
    </Field>
  );
}

function NameField({
  draft,
  problem,
  duplicate,
  inputRef,
  onDraft,
}: {
  draft: Draft;
  problem: string | null | undefined;
  duplicate: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDraft: (patch: Partial<Draft>) => void;
}) {
  const valid = draft.name !== '' && !problem;
  return (
    <Field data-invalid={problem ? true : undefined}>
      <FieldLabel htmlFor="secret-name">Name</FieldLabel>
      <Input
        id="secret-name"
        ref={inputRef}
        value={draft.name}
        placeholder="STRIPE_KEY"
        aria-invalid={problem ? true : undefined}
        aria-describedby="secret-name-feedback"
        {...noAutofill}
        onChange={(event) => onDraft({ name: event.target.value })}
      />
      <div id="secret-name-feedback" aria-live="polite">
        {problem ? (
          <div className="flex flex-col gap-1">
            <FieldError className="wrap-anywhere">{problem}</FieldError>
            {duplicate && (
              <FieldDescription>
                Choose another name, or close this and replace its value from
                the list.
              </FieldDescription>
            )}
          </div>
        ) : valid ? (
          <FieldDescription>
            Agents find it as <Path>{secretPath(draft)}</Path>
          </FieldDescription>
        ) : (
          <FieldDescription>
            Uppercase letters, digits, and underscores, like{' '}
            <span className="font-mono">GH_TOKEN</span>.
          </FieldDescription>
        )}
      </div>
    </Field>
  );
}

function ValueField({
  draft,
  problem,
  valueRef,
  onDraft,
}: {
  draft: Draft;
  problem: string | null | undefined;
  valueRef: React.RefObject<HTMLTextAreaElement | null>;
  onDraft: (patch: Partial<Draft>) => void;
}) {
  const replacing = draft.mode === 'replace';
  return (
    <Field data-invalid={problem ? true : undefined}>
      <FieldLabel htmlFor="secret-value">
        {replacing ? 'New value' : 'Value'}
      </FieldLabel>
      <Textarea
        id="secret-value"
        ref={valueRef}
        value={draft.value}
        rows={5}
        className="max-h-64 min-h-28 break-all"
        aria-invalid={problem ? true : undefined}
        aria-describedby="secret-value-feedback"
        {...noAutofill}
        onChange={(event) => onDraft({ value: event.target.value })}
      />
      <div id="secret-value-feedback" aria-live="polite">
        {problem ? (
          <FieldError>{problem}</FieldError>
        ) : (
          <FieldDescription>
            {replacing
              ? 'Overwrites the current value. '
              : 'Up to 64 KiB, several lines are fine. '}
            Once saved, it is encrypted; reveal it from the list when you need
            it.
          </FieldDescription>
        )}
      </div>
    </Field>
  );
}

function ReplaceConfirmation({
  draft,
  onBack,
  onConfirm,
}: {
  draft: Draft;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onBack()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">
            Replace the value of <Path>{secretPath(draft)}</Path>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The current value is overwritten and can't be recovered. Agents that
            find <span className="font-mono">{draft.name}</span> get the new
            value from now on.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Back</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Replace value
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DescriptionField({
  draft,
  onDraft,
}: {
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
}) {
  const problem = validateSecretDescription(draft.description);
  return (
    <Field data-invalid={problem ? true : undefined}>
      <FieldLabel htmlFor="secret-description">Description</FieldLabel>
      <Input
        id="secret-description"
        value={draft.description}
        placeholder="What it is for"
        autoComplete="off"
        aria-invalid={problem ? true : undefined}
        onChange={(event) => onDraft({ description: event.target.value })}
      />
      {problem ? (
        <FieldError>{problem}</FieldError>
      ) : (
        <FieldDescription>
          Optional. One line, up to {DESCRIPTION_MAX} characters.
        </FieldDescription>
      )}
    </Field>
  );
}
function SheetIntro({
  draft,
  replacing,
}: {
  draft: Draft;
  replacing: Secret | null;
}) {
  const create = draft.mode === 'create';
  return (
    <SheetDescription>
      {create ? (
        'Store a value your agents find by name. It is encrypted once saved.'
      ) : (
        <>
          <Path>{secretPath(draft)}</Path>
          {replacing && <> · Updated {formatDate(replacing.updatedAt)}</>}
        </>
      )}
    </SheetDescription>
  );
}

export function SecretSheet({
  sheet,
  buckets,
  parents,
  replacing,
  onChange,
  onClose,
  onSubmit,
  onConfirmReplace,
  onBack,
}: {
  sheet: SheetState | null;
  buckets: readonly string[];
  parents: Set<string>;
  /** The stored secret a replace draft targets. */
  replacing: Secret | null;
  onChange: (sheet: SheetState) => void;
  onClose: () => void;
  onSubmit: () => void;
  onConfirmReplace: () => void;
  onBack: () => void;
}) {
  // Keep the last sheet on screen while it slides out.
  const last = useRef<SheetState | null>(null);
  if (sheet) last.current = { ...sheet, draft: { ...sheet.draft, value: '' } };
  const shown = sheet ?? last.current;
  const nameRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLTextAreaElement>(null);
  if (!shown) return null;
  const { draft } = shown;
  const create = draft.mode === 'create';
  const problems = sheetProblems(shown);
  const onDraft = (patch: Partial<Draft>) =>
    sheet && onChange({ ...sheet, draft: { ...sheet.draft, ...patch } });
  return (
    <Sheet open={sheet !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (create) nameRef.current?.focus();
          else valueRef.current?.focus();
        }}
      >
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <SheetHeader>
            <SheetTitle>{create ? 'New secret' : 'Replace value'}</SheetTitle>
            <SheetIntro draft={draft} replacing={replacing} />
          </SheetHeader>
          <Separator />
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <FieldGroup>
              {create && (
                <>
                  <BucketField
                    draft={draft}
                    buckets={buckets}
                    parents={parents}
                    onDraft={onDraft}
                  />
                  <NameField
                    draft={draft}
                    problem={problems.name}
                    duplicate={problems.duplicate}
                    inputRef={nameRef}
                    onDraft={onDraft}
                  />
                </>
              )}
              <DescriptionField draft={draft} onDraft={onDraft} />
              <ValueField
                draft={draft}
                problem={problems.value}
                valueRef={valueRef}
                onDraft={onDraft}
              />
            </FieldGroup>
          </div>
          <Separator />
          <SheetFooter className="flex-row justify-end">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              {create ? 'Save secret' : 'Replace value…'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
      {sheet?.confirming && (
        <ReplaceConfirmation
          draft={draft}
          onBack={onBack}
          onConfirm={onConfirmReplace}
        />
      )}
    </Sheet>
  );
}
