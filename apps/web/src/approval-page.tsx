import {
  type ApprovalView,
  ApprovalRemember as Remember,
} from '@nook/contract';
import { Link, useParams } from '@tanstack/react-router';
import {
  Ban,
  Box,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock3,
  History,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FieldLabel } from '@/components/ui/field';
import { Item } from '@/components/ui/item';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, describeFailure } from './api-client';
import { useApproval } from './approval-api';
import {
  approvalScope,
  type Choice,
  durationLabel,
  endsAt,
  endTime,
  type Screen,
  type Submitting,
  submittingLabel,
  timeLeft,
} from './approval-screen';
import { AskFirstLabel } from './ask-first-label';
import { Cmd, Mark } from './authorize-parts';
import { LoadFailure } from './failure';
import { SlashPath } from './path-text';

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="shrink-0 text-muted-foreground">{name}</dt>
      <dd className="min-w-0 text-right wrap-anywhere">{children}</dd>
    </div>
  );
}
function Verified({ view }: { view: ApprovalView }) {
  const { machine, secrets } = view.verified;
  return (
    <section className="flex flex-col gap-3" aria-label="Verified by Nook">
      <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <ShieldCheck className="size-3.5" />
        Verified by Nook
      </h2>
      <dl>
        <Fact name="Machine">{machine.name}</Fact>
      </dl>
      <div>
        <p className="mb-2 text-sm text-muted-foreground">
          {secrets.length === 1 ? 'Secret' : `Secrets (${secrets.length})`}
        </p>
        <ul className="divide-y rounded-lg border">
          {secrets.map(({ path, coveredBy }) => (
            <li key={path} className="px-3 py-2 text-sm">
              <SlashPath>{path}</SlashPath>
              <p className="mt-1 text-xs text-muted-foreground">
                {coveredBy ? (
                  <AskFirstLabel mark={coveredBy} />
                ) : (
                  'Not marked Ask first'
                )}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
function ClaimedContext({ view }: { view: ApprovalView }) {
  const claim = view.claimed;
  return (
    <section className="p-5 sm:p-6">
      <h2 className="mb-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Also claimed by the agent
      </h2>
      <dl className="flex flex-col gap-3 text-sm">
        <Fact name="Executable">
          <span className="font-mono wrap-anywhere">{claim.executable}</span>
        </Fact>
        <Fact name="Working directory">
          <SlashPath>{claim.workingDirectory}</SlashPath>
        </Fact>
        <Fact name="Session">
          <span className="wrap-anywhere">
            {claim.session
              ? `${claim.session.agent} · ${claim.session.session}`
              : 'Not reported'}
          </span>
        </Fact>
        <Fact name="Client">{claim.client ?? 'Not reported'}</Fact>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        These are context, not a guarantee of what runs. An approval is not tied
        to an executable, directory, or agent session.
      </p>
    </section>
  );
}
function ApprovalScope({
  view,
  remember,
  until,
}: {
  view: ApprovalView;
  remember: Remember;
  until: number | string | null;
}) {
  return approvalScope(view, remember, until).map((part) =>
    typeof part === 'string' ? (
      part
    ) : (
      <SlashPath key={part.path}>{part.path}</SlashPath>
    ),
  );
}
function DurationChoice({
  choice,
  setChoice,
  disabled,
  view,
}: {
  choice: Remember;
  setChoice: (choice: Remember) => void;
  disabled: boolean;
  view: ApprovalView;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium" id="approve-for">
        Approve for
      </p>
      <RadioGroup
        aria-labelledby="approve-for"
        value={choice}
        onValueChange={(value) => setChoice(value as Remember)}
        disabled={disabled}
      >
        {Remember.literals.map((value) => {
          const until = endsAt(value, Date.now());
          return (
            <Item key={value} variant="outline" size="sm" asChild>
              <FieldLabel className="w-full" htmlFor={`duration-${value}`}>
                <RadioGroupItem id={`duration-${value}`} value={value} />
                <span className="flex-1 text-sm">{durationLabel[value]}</span>
                <span className="text-xs text-muted-foreground">
                  {until === null ? 'This run' : `Until ${endTime(until)}`}
                </span>
              </FieldLabel>
            </Item>
          );
        })}
      </RadioGroup>
      <p className="text-sm leading-5 text-muted-foreground wrap-anywhere">
        <ApprovalScope
          view={view}
          remember={choice}
          until={endsAt(choice, Date.now())}
        />
      </p>
    </div>
  );
}
function Decisions({
  choice,
  submitting,
  decide,
}: {
  choice: Remember;
  submitting?: Submitting;
  decide: (choice: Choice) => void;
}) {
  const denying = submitting?.choice === 'deny';
  const approving = !!submitting && !denying;
  const approve =
    choice === 'once'
      ? 'Approve this time'
      : `Approve for ${durationLabel[choice]}`;
  const busyLabel = submitting && submittingLabel(submitting);
  return (
    <div className="sticky bottom-0 z-10 flex gap-3 border-t bg-card p-5 sm:justify-end sm:p-6">
      <Button
        variant="outline"
        disabled={!!submitting}
        onClick={() => decide('deny')}
      >
        {denying && <Spinner />}
        {denying ? busyLabel : 'Deny'}
      </Button>
      <Button
        className="flex-1 sm:flex-none"
        disabled={!!submitting}
        onClick={() => decide(choice)}
      >
        {approving && <Spinner />}
        {approving ? busyLabel : approve}
      </Button>
    </div>
  );
}
function PendingCard({
  screen,
  failure,
  decide,
}: {
  screen: Screen & { kind: 'pending' | 'submitting' };
  failure?: 'network';
  decide: (choice: Choice) => void;
}) {
  const [choice, setChoice] = useState<Remember>('once');
  const { view } = screen;
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="gap-2 p-5 pb-4 sm:p-6">
        <div className="flex items-center gap-3">
          <Mark icon={KeyRound} />
          <CardTitle role="heading" aria-level={1}>
            Approve this run?
          </CardTitle>
        </div>
        <CardDescription>
          An agent on{' '}
          <span className="text-foreground wrap-anywhere">
            {view.verified.machine.name}
          </span>{' '}
          is waiting in <Cmd>nook run</Cmd>. Approve only if you expect this
          run.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5 sm:px-6 sm:pb-6">
        <Verified view={view} />
        <section className="rounded-lg border border-dashed bg-muted/20 px-4 py-3">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Purpose
            </h2>
            <Badge variant="outline">Claimed by the agent, not verified</Badge>
          </div>
          <p className="text-sm leading-5 wrap-anywhere">
            “{view.claimed.purpose}”
          </p>
        </section>
        <DurationChoice
          choice={choice}
          setChoice={setChoice}
          disabled={screen.kind === 'submitting'}
          view={view}
        />
        {failure && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Couldn't confirm your choice</AlertTitle>
            <AlertDescription>
              Nook could not confirm the result. Try the same choice again.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
      <Decisions
        choice={choice}
        submitting={screen.kind === 'submitting' ? screen : undefined}
        decide={decide}
      />
      <Separator />
      <ClaimedContext view={view} />
    </Card>
  );
}
const results = {
  denied: {
    icon: Ban,
    title: 'Run denied',
    copy: (view: ApprovalView) =>
      `nook run stopped on ${view.verified.machine.name}. Nothing was delivered.`,
  },
  withdrawn: {
    icon: CircleSlash,
    title: 'The agent cancelled this run',
    copy: () =>
      'nook run stopped before you decided. Nothing was delivered, and there is nothing left to do here.',
  },
  expired: {
    icon: Clock3,
    title: 'This request expired',
    copy: () =>
      'Requests last 10 minutes. Nothing was delivered. If the agent still needs these secrets, it runs again and sends a new link.',
  },
  settled: {
    icon: History,
    title: 'No longer needed',
    copy: () =>
      'This run got its secrets without a decision here: an approval you gave earlier covered it, or its secrets are no longer marked Ask first.',
  },
};
function approvedResult(view: Extract<ApprovalView, { state: 'approved' }>) {
  return {
    icon: CircleCheck,
    title:
      view.remember === 'once'
        ? 'Approved'
        : `Approved for ${durationLabel[view.remember]}`,
    copy: () => (
      <>
        This run got its secrets.{' '}
        <ApprovalScope
          view={view}
          remember={view.remember}
          until={view.validUntil}
        />
      </>
    ),
  };
}
function UnsavedDecision({
  screen,
}: {
  screen: Extract<Screen, { kind: 'expired' }>;
}) {
  if (!screen.unsaved) return null;
  const title =
    screen.choice === 'deny'
      ? "Your denial wasn't saved"
      : `Your ${durationLabel[screen.choice ?? 'once']} approval wasn't saved`;
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        The request expired just before your choice reached Nook.
      </AlertDescription>
    </Alert>
  );
}
type ResultScreen = Exclude<Screen, { kind: 'pending' | 'submitting' }>;
function ResultFacts({ screen }: { screen: ResultScreen }) {
  const { view } = screen;
  return (
    <dl className="flex flex-col gap-3">
      {screen.kind === 'approved' && (
        <Fact name="Approved">
          {screen.view.remember === 'once'
            ? durationLabel.once
            : `${durationLabel[screen.view.remember]}, until ${endTime(screen.view.validUntil)}`}
        </Fact>
      )}
      <Fact name="Machine">{view.verified.machine.name}</Fact>
      <Fact name={view.verified.secrets.length === 1 ? 'Secret' : 'Secrets'}>
        <div className="flex flex-col gap-1">
          {view.verified.secrets.map(({ path }) => (
            <SlashPath key={path}>{path}</SlashPath>
          ))}
        </div>
      </Fact>
    </dl>
  );
}
function ResultCard({ screen }: { screen: ResultScreen }) {
  const { view } = screen;
  const result =
    screen.kind === 'approved'
      ? approvedResult(screen.view)
      : results[screen.kind];
  return (
    <Card className="gap-0 py-0 shadow-none" aria-live="polite">
      <CardHeader className="gap-4 p-6">
        <div className="flex items-center gap-3">
          <Mark icon={result.icon} />
          <CardTitle role="heading" aria-level={1}>
            {result.title}
          </CardTitle>
        </div>
        <CardDescription className="min-w-0">
          <span className="wrap-anywhere">{result.copy(view)}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-6 pb-6">
        {screen.kind === 'expired' && <UnsavedDecision screen={screen} />}
        <ResultFacts screen={screen} />
      </CardContent>
    </Card>
  );
}
function ApprovalCard({
  screen,
  failure,
  decide,
}: {
  screen: Screen;
  failure?: 'network';
  decide: (choice: Choice) => void;
}) {
  return screen.kind === 'pending' || screen.kind === 'submitting' ? (
    <PendingCard screen={screen} failure={failure} decide={decide} />
  ) : (
    <ResultCard screen={screen} />
  );
}
export function ApprovalPage() {
  const { id = '' } = useParams({ strict: false });
  const { screen, msLeft, failure, decide, load } = useApproval(id);
  const waiting = screen?.kind === 'pending' || screen?.kind === 'submitting';
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-3 md:py-12">
      <header className="mb-4 flex items-center justify-between md:mb-10">
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
          <Link to="/approvals">All approvals</Link>
        </Button>
      </header>
      <main>
        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Approve a run
          </span>
          {waiting && (
            <Badge variant="secondary">
              <Clock3 className="size-3" />
              {timeLeft(msLeft)}
            </Badge>
          )}
        </div>
        {load.isError ? (
          <LoadFailure
            title="Couldn’t load approval"
            description={
              load.error instanceof ApiError && load.error.tag === 'NotFound'
                ? 'This approval request was not found.'
                : describeFailure(load.error, 'review approvals')
            }
            cached={false}
            retrying={load.isFetching}
            onRetry={() => void load.refetch()}
          />
        ) : screen ? (
          <ApprovalCard screen={screen} failure={failure} decide={decide} />
        ) : (
          <Skeleton className="h-96 w-full" />
        )}
      </main>
    </div>
  );
}
