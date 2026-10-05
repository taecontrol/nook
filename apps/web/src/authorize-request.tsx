import {
  type AuthorizationRequest,
  formatUserCode,
  machineNameError,
} from '@nook/contract';
import { CircleCheck, KeyRound, Terminal } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Cmd, ConnectionFailure, Mark } from './authorize-parts';

function relativeTime(timestamp: string, future = false) {
  const minutes = Math.max(
    1,
    Math.ceil(Math.abs(Date.parse(timestamp) - Date.now()) / 60_000),
  );
  const duration = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return future ? `in ${duration}` : `${duration} ago`;
}
function RequestDetails({ request }: { request: AuthorizationRequest }) {
  const rows = [
    ['Client', request.client],
    ['Requested', relativeTime(request.requestedAt)],
    ['Expires', relativeTime(request.expiresAt, true)],
  ];
  return (
    <dl className="flex flex-col gap-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-6">
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-right break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function MachineNameField({
  input,
  name,
  onName,
  busy,
  error,
}: {
  input: RefObject<HTMLInputElement | null>;
  name: string;
  onName: (value: string) => void;
  busy: boolean;
  error?: string;
}) {
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor="machine-name">Machine name</FieldLabel>
      <Input
        id="machine-name"
        ref={input}
        value={name}
        maxLength={64}
        onChange={(event) => onName(event.target.value)}
        disabled={busy}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'machine-name-error' : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {name.length > 32 && (
        <FieldDescription>
          <span className="break-all">{name}</span>
        </FieldDescription>
      )}
      {error && <FieldError id="machine-name-error">{error}</FieldError>}
    </Field>
  );
}
function decisionLabel(
  action: 'approve' | 'deny',
  phase: 'request' | 'approving' | 'denying',
  failed: boolean,
  attemptedAction: 'approve' | 'deny',
) {
  if (action === 'approve' && phase === 'approving') return 'Approving…';
  if (failed && attemptedAction === action) return 'Try again';
  return { approve: 'Approve', deny: 'Deny' }[action];
}
export function RequestStep({
  code,
  request,
  name,
  onName,
  phase,
  failed,
  decide,
  changeCode,
}: {
  code: string;
  request: AuthorizationRequest;
  name: string;
  onName: (value: string) => void;
  phase: 'request' | 'approving' | 'denying';
  failed: boolean;
  decide: (action: 'approve' | 'deny') => void;
  changeCode: () => void;
}) {
  const busy = phase !== 'request';
  const input = useRef<HTMLInputElement>(null);
  const [nameError, setNameError] = useState<string>();
  const [attemptedAction, setAttemptedAction] = useState<'approve' | 'deny'>(
    'approve',
  );
  useEffect(() => {
    if (phase === 'request') {
      input.current?.focus();
      input.current?.select();
    }
  }, [phase]);
  const choose = (action: 'approve' | 'deny') => {
    setAttemptedAction(action);
    decide(action);
  };
  const approve = () => {
    const message = machineNameError(name);
    setNameError(message);
    if (!message) choose('approve');
  };
  return (
    <Card
      className="gap-0 py-0 shadow-none"
      aria-live="polite"
      aria-busy={busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) approve();
        }}
      >
        <CardHeader className="gap-3 p-6">
          <div className="flex items-center gap-3">
            <Mark icon={Terminal} />
            <CardTitle role="heading" aria-level={1}>
              Approve this machine?
            </CardTitle>
          </div>
          <CardDescription>
            Approve only if you just ran <Cmd>nook login</Cmd> and this is the
            machine you meant.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 px-6 pb-6">
          <Item variant="muted" size="sm">
            <ItemMedia variant="icon">
              <CircleCheck />
            </ItemMedia>
            <ItemContent>
              <ItemDescription>Code you entered</ItemDescription>
              <ItemTitle>
                <code className="font-mono tracking-widest">
                  {formatUserCode(code)}
                </code>
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={changeCode}
                disabled={busy}
              >
                Change
              </Button>
            </ItemActions>
          </Item>
          <Alert>
            <KeyRound />
            <AlertTitle>Access to all buckets</AlertTitle>
            <AlertDescription>
              <p>
                Approving gives this machine access to every bucket in this
                Nook.
              </p>
            </AlertDescription>
          </Alert>
          <MachineNameField
            input={input}
            name={name}
            onName={(value) => {
              onName(value);
              setNameError(undefined);
            }}
            busy={busy}
            error={nameError}
          />
          <RequestDetails request={request} />
          {failed && !busy && <ConnectionFailure />}
        </CardContent>
        <Separator />
        <CardFooter className="flex-col-reverse gap-3 p-6 md:flex-row md:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => choose('deny')}
            disabled={busy}
            className="w-full md:w-auto"
          >
            {phase === 'denying' && <Spinner />}
            {decisionLabel('deny', phase, failed, attemptedAction)}
          </Button>
          <Button type="submit" disabled={busy} className="w-full md:w-auto">
            {phase === 'approving' && <Spinner />}
            {decisionLabel('approve', phase, failed, attemptedAction)}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
