import type { AskFirstMark } from '@nook/contract';
import { CircleAlert, Hand } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { describeFailure } from './api-client';
import type { useAskFirst } from './ask-first-api';
import { DismissibleAlert, LoadFailure } from './failure';
import { SlashPath } from './path-text';

type Marks = ReturnType<typeof useAskFirst>;
export function AskFirstSwitch({
  marks,
  kind,
  path,
}: {
  marks: Marks;
  kind: AskFirstMark['kind'];
  path: string;
}) {
  const coverage = marks.coverage(kind, path);
  if (marks.list.data === undefined) return <Skeleton className="h-4 w-8" />;
  return (
    <Switch
      aria-label={`Ask first for ${path}`}
      checked={coverage !== null}
      disabled={!!coverage?.inherited}
      onCheckedChange={(on) => marks.toggle({ kind, path }, on)}
    />
  );
}
export function SecretMark({ marks, path }: { marks: Marks; path: string }) {
  const coverage = marks.coverage('secret', path);
  if (!coverage) return null;
  return (
    <span className="flex items-start gap-1 text-xs text-muted-foreground">
      <Hand className="mt-0.5 size-3 shrink-0" />
      <span>
        {coverage.inherited ? (
          <>
            Ask first, from <SlashPath>{coverage.mark.path}</SlashPath>
          </>
        ) : (
          'Ask first, on this secret'
        )}
      </span>
    </span>
  );
}
export function BucketAskFirstCard({
  marks,
  path,
}: {
  marks: Marks;
  path: string;
}) {
  const coverage = marks.coverage('bucket', path);
  return (
    <Card className="mb-6 gap-0 py-0 shadow-none">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-sm font-medium">
            Ask first
            {coverage?.inherited && (
              <Badge variant="secondary">
                from <SlashPath>{coverage.mark.path}</SlashPath>
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {coverage?.inherited ? (
              <>
                On because <SlashPath>{coverage.mark.path}</SlashPath> asks
                first. To turn it off, open that bucket.
              </>
            ) : (
              'Runs that need secrets in this bucket or below wait for your approval.'
            )}
          </p>
        </div>
        <AskFirstSwitch marks={marks} kind="bucket" path={path} />
      </CardContent>
    </Card>
  );
}
export function OrphanMarksAlert({ marks }: { marks: Marks }) {
  return (
    <>
      {marks.orphans.map((mark) => (
        <DismissibleAlert
          key={`${mark.kind}:${mark.path}`}
          icon={<Hand />}
          title={`Ask first is on a deleted ${mark.kind}`}
        >
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1">
              <SlashPath>{mark.path}</SlashPath> no longer exists. Its mark
              still applies if an agent creates it again.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => marks.toggle(mark, false)}
            >
              Remove mark
            </Button>
          </div>
        </DismissibleAlert>
      ))}
    </>
  );
}
export function AskFirstFeedback({ marks }: { marks: Marks }) {
  return (
    <>
      {marks.failure && (
        <DismissibleAlert
          destructive
          icon={<CircleAlert />}
          title="Couldn’t change Ask first"
          onDismiss={marks.dismiss}
        >
          {describeFailure(marks.failure, 'change Ask first marks')}
        </DismissibleAlert>
      )}
      {marks.list.isError && (
        <LoadFailure
          title="Couldn’t load Ask first marks"
          description={describeFailure(
            marks.list.error,
            'manage Ask first marks',
          )}
          cached
          retrying={marks.list.isFetching}
          onRetry={() => void marks.list.refetch()}
        />
      )}
    </>
  );
}
