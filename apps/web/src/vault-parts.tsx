import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { reachText } from './bucket-format';
import { sectionLabel } from './vault-styles';

export function BucketSelect({
  id,
  bucket,
  buckets,
  parents,
  onBucket,
  layout = 'vertical',
  what,
}: {
  id: string;
  bucket: string;
  buckets: readonly string[];
  parents: ReadonlySet<string>;
  onBucket: (bucket: string) => void;
  layout?: 'vertical' | 'horizontal' | 'compact';
  what?: string;
}) {
  const horizontal = layout !== 'vertical';
  const compact = layout === 'compact';
  const content = (
    <>
      <FieldLabel htmlFor={id} className={horizontal ? 'flex-none' : undefined}>
        Bucket
      </FieldLabel>
      <Select value={bucket} onValueChange={onBucket}>
        <SelectTrigger
          id={id}
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
        {reachText(bucket, parents.has(bucket), what)}
      </FieldDescription>
    </>
  );
  return (
    <Field orientation={horizontal ? 'horizontal' : 'vertical'}>
      {horizontal ? (
        <div
          className={
            compact
              ? 'flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3'
              : 'flex w-full flex-col gap-3'
          }
        >
          {content}
        </div>
      ) : (
        content
      )}
    </Field>
  );
}

export function SectionHeader({
  title,
  id,
  count,
  hint,
  trailing,
  className,
}: {
  title: string;
  id?: string;
  count?: number;
  hint?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2 border-b', className)}>
      <h3 id={id} className={sectionLabel}>
        {title}
      </h3>
      {count !== undefined && <Badge variant="secondary">{count}</Badge>}
      {hint && (
        <span className="ml-auto text-right text-xs text-muted-foreground">
          {hint}
        </span>
      )}
      {trailing}
    </div>
  );
}
