import type { ApprovalView } from '@nook/contract';
import { Link } from '@tanstack/react-router';
import { Hourglass, Repeat2, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { describeFailure } from './api-client';
import { durationLabel, endTime, timeLeft } from './approval-screen';
import { useApprovals } from './approvals-api';
import { LoadFailure } from './failure';
import { useDesktop } from './hooks/use-desktop';
import { SlashPath } from './path-text';
import { useCountdown } from './use-countdown';

function ApprovalPaths({ view }: { view: ApprovalView }) {
  return (
    <div className="flex flex-col text-xs">
      {view.verified.secrets.map(({ path }) => (
        <SlashPath key={path}>{path}</SlashPath>
      ))}
    </div>
  );
}
function ApprovalIcon({ remembered }: { remembered: boolean }) {
  return remembered ? <Repeat2 /> : <Hourglass />;
}
function ReviewApproval({ view }: { view: ApprovalView }) {
  if (view.state !== 'pending') return null;
  return (
    <ItemActions>
      <Button variant="outline" size="sm" asChild>
        <Link to="/approvals/$id" params={{ id: view.id }}>
          Review
        </Link>
      </Button>
    </ItemActions>
  );
}
function ApprovalRow({ view }: { view: ApprovalView }) {
  const wide = useDesktop();
  const msLeft = useCountdown(
    view.state === 'pending' ? view.expiresAt : undefined,
  );
  const approved = view.state === 'approved' ? view : undefined;
  if (view.state === 'pending' && msLeft === 0) return null;
  return (
    <Item variant="outline" className="items-start" data-approval={view.id}>
      <ItemMedia variant="icon" className="hidden sm:flex">
        <ApprovalIcon remembered={!!approved} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          {view.verified.machine.name}
          <Badge variant="secondary">
            {approved
              ? `Ends ${endTime(approved.validUntil)}`
              : timeLeft(msLeft)}
          </Badge>
        </ItemTitle>
        {approved && (
          <ItemDescription truncate={false}>
            {durationLabel[approved.remember]}
          </ItemDescription>
        )}
        <ApprovalPaths view={view} />
        {!approved && (
          <ItemDescription truncate={wide === false} className="wrap-anywhere">
            Claimed: “{view.claimed.purpose}”
          </ItemDescription>
        )}
      </ItemContent>
      <ReviewApproval view={view} />
    </Item>
  );
}
function ApprovalSection({
  title,
  description,
  views,
}: {
  title: string;
  description: string;
  views: readonly ApprovalView[];
}) {
  return (
    <section>
      <div className="mb-3 border-b pb-2">
        <h2 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
          <Badge variant="secondary">{views.length}</Badge>
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-col gap-2">
        {views.map((view) => (
          <ApprovalRow key={view.id} view={view} />
        ))}
      </div>
    </section>
  );
}
function ApprovalList({
  pending,
  remembered,
}: {
  pending: readonly ApprovalView[];
  remembered: readonly ApprovalView[];
}) {
  if (pending.length === 0 && remembered.length === 0)
    return (
      <div className="mt-4 rounded-lg border border-dashed">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheck />
            </EmptyMedia>
            <EmptyTitle>Nothing waiting for you</EmptyTitle>
            <EmptyDescription>
              When a run needs a secret marked Ask first, the agent shares a
              link and the request shows up here. Approvals you give for 1 or 12
              hours are listed here until they end.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  return (
    <div className="flex flex-col gap-10">
      <ApprovalSection
        title="Waiting for you"
        description="Each request expires 10 minutes after the run asked."
        views={pending}
      />
      <ApprovalSection
        title="Remembered"
        description="Any later run on the same machine uses these secrets without asking until the approval ends, whichever agent runs it."
        views={remembered}
      />
    </div>
  );
}
export function ApprovalsPage() {
  const list = useApprovals();
  return (
    <div className="w-full max-w-4xl px-4 pt-6 pb-24 sm:px-6 md:px-12 md:pt-8">
      <h1 className="mb-2 text-xl font-semibold tracking-tight">Approvals</h1>
      {list.data &&
        (list.data.pending.length > 0 || list.data.remembered.length > 0) && (
          <p className="mb-8 max-w-2xl text-sm text-muted-foreground">
            Runs that wait for you before they use secrets marked Ask first, and
            the approvals that let later runs skip asking.
          </p>
        )}
      {list.isError && (
        <LoadFailure
          title="Couldn’t load approvals"
          description={describeFailure(list.error, 'review approvals')}
          cached={list.data !== undefined}
          retrying={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      )}
      {list.data ? (
        <ApprovalList {...list.data} />
      ) : (
        list.isPending && <Skeleton className="mt-6 h-64 w-full" />
      )}
    </div>
  );
}
