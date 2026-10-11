import { cn } from 'cn';
import { ServerCrash, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';

/**
 * A failed load: an Alert above data that is still shown, or an Empty state
 * in its place when nothing has loaded yet.
 */
export function LoadFailure({
  title,
  description,
  cached,
  retrying,
  disabled = false,
  onRetry,
  retryLabel = 'Try again',
  className,
}: {
  title: string;
  description: ReactNode;
  cached: boolean;
  retrying: boolean;
  disabled?: boolean;
  onRetry: () => void;
  retryLabel?: string;
  className?: string;
}) {
  const retry = (
    <Button
      variant="outline"
      size="sm"
      disabled={retrying || disabled}
      onClick={onRetry}
    >
      {retrying && <Spinner />}
      {retryLabel}
    </Button>
  );
  if (cached)
    return (
      <Alert variant="destructive" className={cn('mb-4', className)}>
        <ServerCrash />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          {description}
          {retry}
        </AlertDescription>
      </Alert>
    );
  return (
    <div className={cn('rounded-lg border border-dashed', className)}>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ServerCrash />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{retry}</EmptyContent>
      </Empty>
    </div>
  );
}

/** The result of an owner action, kept until the owner dismisses it. */
export function DismissibleAlert({
  destructive = false,
  icon,
  title,
  children,
  onDismiss,
}: {
  destructive?: boolean;
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <Alert variant={destructive ? 'destructive' : 'default'}>
      {icon}
      <AlertTitle className="mr-6 wrap-anywhere">{title}</AlertTitle>
      {children && <AlertDescription>{children}</AlertDescription>}
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute top-2.5 right-2.5"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X />
        </Button>
      )}
    </Alert>
  );
}
