import {
  type AgentSessionClaim,
  type AuditEntry,
  agentLabel,
  isFileAuditEntry,
} from '@nook/contract';
import { Link } from '@tanstack/react-router';
import { History, SearchX, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import type { AuditFilters } from './audit-api';

export function claimOf(entry: AuditEntry) {
  return isFileAuditEntry(entry) || entry.outcome === 'revealed'
    ? null
    : entry.agentSession;
}
export function sessionAgent(entries: readonly AuditEntry[], session?: string) {
  const agents = new Set(
    entries.flatMap((entry) => {
      const claim = claimOf(entry);
      return claim && claim.session === session ? [claim.agent] : [];
    }),
  );
  return agents.size === 1 ? agentLabel([...agents][0]) : undefined;
}
export function AgentSessionFact({
  claim,
}: {
  claim: AgentSessionClaim | null;
}) {
  if (!claim) return null;
  return (
    <div className="min-w-0 sm:col-span-2 lg:col-span-3">
      <dt className="mb-1 text-xs text-muted-foreground">
        Agent session (as reported)
      </dt>
      <dd className="text-sm wrap-anywhere">
        {agentLabel(claim.agent)}
        <span className="mt-0.5 block font-mono text-xs break-all">
          {claim.session}
        </span>
        {claim.thread && (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Thread <span className="font-mono break-all">{claim.thread}</span>
          </span>
        )}
        <span className="mt-1.5 block text-xs text-muted-foreground">
          Reported by the agent’s environment. Nook doesn’t verify it.
        </span>
      </dd>
    </div>
  );
}
type SessionFilterProps = {
  session?: string;
  agent?: string;
};
export function SessionFilterValue({ session, agent }: SessionFilterProps) {
  if (!session) return null;
  return (
    <p className="-mt-2 mb-4 text-xs text-muted-foreground sm:hidden">
      Only activity reported as {agent ?? 'agent'} session{' '}
      <span className="font-mono wrap-anywhere text-foreground">{session}</span>
      .
    </p>
  );
}
// Keep the phone's pinned bar to one line; its full value scrolls below it.
export function SessionFilterNote({
  session,
  agent,
  clear,
  empty,
}: SessionFilterProps & { clear: AuditFilters; empty: boolean }) {
  if (!session) return null;
  return (
    <div className="mt-2 flex items-center justify-between gap-2 sm:items-start sm:justify-start">
      <p className="min-w-0 truncate pt-0.5 text-xs text-muted-foreground sm:hidden">
        {agent ?? 'Agent'} session{' '}
        {!empty && <span className="font-mono text-foreground">{session}</span>}
      </p>
      <p className="hidden min-w-0 pt-0.5 text-xs text-muted-foreground sm:block">
        Only activity reported as {agent ?? 'agent'} session{' '}
        <span className="font-mono wrap-anywhere text-foreground">
          {session}
        </span>
        .
      </p>
      <Button variant="ghost" size="xs" asChild className="shrink-0">
        <Link to="/audit" search={clear}>
          <X />
          Clear session
        </Link>
      </Button>
    </div>
  );
}
export function AgentSourceLine({
  entry,
  executable,
  phone = false,
}: {
  entry: AuditEntry;
  executable: string;
  phone?: boolean;
}) {
  const claim = claimOf(entry);
  const agent = claim ? agentLabel(claim.agent) : '';
  return phone ? (
    <>
      {executable && ` · ${executable}`}
      {agent && ` · ${agent}`}
    </>
  ) : (
    <p
      className="truncate text-xs text-muted-foreground"
      title={[executable, agent].filter(Boolean).join(' · ')}
    >
      <span className="font-mono">{executable}</span>
      {agent && `${executable ? ' · ' : ''}${agent}`}
    </p>
  );
}
export function AgentSessionActivity({ entry }: { entry: AuditEntry }) {
  const claim = claimOf(entry);
  if (!claim) return null;
  return (
    <Button size="sm" variant="ghost" asChild>
      <Link to="/audit" search={{ session: claim.session }}>
        Activity in this session
      </Link>
    </Button>
  );
}
function emptyCopy(filters: AuditFilters) {
  const bucketOrSecret = Boolean(filters.bucket || filters.secret);
  const filtered = Boolean(bucketOrSecret || filters.session);
  if (filters.session && !bucketOrSecret)
    return {
      title: 'No activity reported for this session',
      description:
        'No entry reports this agent session. Only uses and creations recorded by a recent nook CLI report one; older entries and reveals never do.',
      action: 'Return to all activity',
    };
  if (!filtered)
    return {
      title: 'No secret activity yet',
      description:
        'When a machine uses a secret through nook run or stores one through nook vault create, or you reveal a value in the web app, it appears here. Denied uses appear here too.',
      action: null,
    };
  return {
    title: 'No activity matches these filters',
    description: filters.session
      ? 'Nothing this session reported matches the bucket or secret. Try another bucket or secret, or clear the session.'
      : 'Try another bucket or secret, or return to all activity.',
    action: 'Clear filters',
  };
}
export function NoAuditEntries({ filters }: { filters: AuditFilters }) {
  const { title, description, action } = emptyCopy(filters);
  return (
    <div className="rounded-lg border border-dashed">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {action ? <SearchX /> : <History />}
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {action && (
          <EmptyContent>
            <Button variant="outline" size="sm" asChild>
              <Link to="/audit" search={{}}>
                {action}
              </Link>
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </div>
  );
}
