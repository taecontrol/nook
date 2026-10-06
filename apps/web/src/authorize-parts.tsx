import {
  type BucketGrant,
  formatUserCode,
  normalizeUserCode,
} from '@nook/contract';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  Ban,
  Box,
  CircleAlert,
  CircleCheck,
  Clock3,
  History,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { GrantDetails, GrantRoots } from './grant-summary';

export function Cmd({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}
export function Mark({ icon: Icon }: { icon: typeof Terminal }) {
  return (
    <Avatar className="size-10 rounded-lg">
      <AvatarFallback className="rounded-lg">
        <Icon className="size-5" />
      </AvatarFallback>
    </Avatar>
  );
}
export function AuthorizationLayout({
  step,
  children,
}: {
  step?: 1 | 2;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-6 md:py-12">
      <header className="mb-8 flex items-center justify-between md:mb-10">
        <Button variant="ghost" size="lg" asChild className="-ml-2">
          <Link to="/">
            <Avatar className="size-9 rounded-lg">
              <AvatarFallback className="rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Box className="size-5" />
              </AvatarFallback>
            </Avatar>
            <span className="text-lg font-semibold tracking-tight">Nook</span>
          </Link>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">Back to Nook</Link>
        </Button>
      </header>
      <main>
        <div className="mb-4 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Connect a machine{step ? ` · Step ${step} of 2` : ''}
        </div>
        {children}
      </main>
    </div>
  );
}
export function ConnectionFailure() {
  return (
    <Alert variant="destructive">
      <ShieldAlert />
      <AlertTitle>Couldn't reach Nook</AlertTitle>
      <AlertDescription>
        <p>We couldn't confirm the result. Check your terminal or try again.</p>
      </AlertDescription>
    </Alert>
  );
}
export function CodeStep({
  code,
  change,
  submit,
  checking,
  failure,
}: {
  code: string;
  change: (value: string) => void;
  submit: () => void;
  checking: boolean;
  failure?: 'unknown' | 'network';
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!checking) input.current?.focus();
  }, [checking]);
  return (
    <Card className="gap-0 py-0 shadow-none">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (code.length === 8 && !checking) submit();
        }}
      >
        <CardHeader className="gap-3 p-6">
          <div className="flex items-center gap-3">
            <Mark icon={Terminal} />
            <CardTitle role="heading" aria-level={1}>
              Enter the code from your terminal
            </CardTitle>
          </div>
          <CardDescription>
            Run <Cmd>nook login</Cmd> on the machine you want to connect. It
            prints an 8-letter code. Nothing about the request is shown until
            the code matches.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 px-6 pb-6">
          <Field data-invalid={failure === 'unknown'}>
            <FieldLabel htmlFor="authorization-code">
              Code from your terminal
            </FieldLabel>
            <Input
              id="authorization-code"
              ref={input}
              value={formatUserCode(code)}
              onChange={(event) =>
                change(normalizeUserCode(event.target.value))
              }
              placeholder="XXXX-XXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={checking}
              aria-invalid={failure === 'unknown'}
              aria-describedby={
                failure === 'unknown' ? 'code-error' : undefined
              }
            />
          </Field>
          {failure === 'unknown' && (
            <Alert variant="destructive" id="code-error">
              <CircleAlert />
              <AlertTitle>No matching request</AlertTitle>
              <AlertDescription>
                <p>
                  The code you entered doesn't match a pending request. Check
                  the code in your terminal and try again. If the request is
                  more than 10 minutes old, run <Cmd>nook login</Cmd> again.
                </p>
              </AlertDescription>
            </Alert>
          )}
          {failure === 'network' && <ConnectionFailure />}
        </CardContent>
        <Separator />
        <CardFooter className="flex-col items-stretch gap-4 p-6 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-muted-foreground">
            Only continue if you started this login yourself.
          </p>
          <Button type="submit" disabled={code.length !== 8 || checking}>
            {checking ? <Spinner /> : null}Continue
            {checking ? null : <ArrowRight />}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
const results = {
  approved: {
    icon: CircleCheck,
    title: 'Machine approved',
    body: (
      <>
        Return to your terminal. <Cmd>nook login</Cmd> will finish on its own.
      </>
    ),
  },
  denied: {
    icon: Ban,
    title: 'Request denied',
    body: (
      <>
        The machine did not get access, and <Cmd>nook login</Cmd> has stopped in
        your terminal.
      </>
    ),
  },
  expired: {
    icon: Clock3,
    title: 'This request expired',
    body: (
      <>
        Requests last 10 minutes. Run <Cmd>nook login</Cmd> again to get a new
        code.
      </>
    ),
  },
  used: {
    icon: History,
    title: 'This request was already handled',
    body: (
      <>
        It was approved or denied earlier, so there is nothing left to do here.
        To connect another machine, run <Cmd>nook login</Cmd> there.
      </>
    ),
  },
};
export function ResultStep({
  kind,
  code,
  name,
  grant,
}: {
  kind: keyof typeof results;
  code: string;
  name: string;
  grant: BucketGrant;
}) {
  const { icon, title, body } = results[kind];
  return (
    <Card className="gap-0 py-0 shadow-none" aria-live="polite">
      <CardHeader className="gap-3 p-6">
        <div className="flex items-center gap-3">
          <Mark icon={icon} />
          <CardTitle role="heading" aria-level={1}>
            {title}
          </CardTitle>
        </div>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
      {kind === 'approved' && (
        <CardContent className="px-6 pb-6">
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between gap-6">
              <dt className="shrink-0 text-muted-foreground">Machine</dt>
              <dd className="min-w-0 text-right break-all">{name}</dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="shrink-0 text-muted-foreground">Access</dt>
              <dd className="min-w-0 text-right wrap-anywhere">
                <GrantRoots grant={grant} />
              </dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="shrink-0 text-muted-foreground">Code</dt>
              <dd className="font-mono tracking-widest">
                {formatUserCode(code)}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-col gap-3 text-xs leading-5 text-muted-foreground">
            <p>
              <GrantDetails grant={grant} />
            </p>
            <p>To change access later, revoke this machine and log in again.</p>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
