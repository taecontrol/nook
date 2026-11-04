import { cn } from 'cn';
import { Fragment } from 'react';

/** Wrap at separators; a segment wider than the field scrolls in place. */
export function SlashPath({ children }: { children: string }) {
  const parts = children.split('/');
  return (
    <span className="inline-block max-w-full overflow-x-auto align-bottom font-mono wrap-normal break-normal">
      {parts.map((part, index) => (
        <Fragment key={parts.slice(0, index + 1).join('/')}>
          <span className="whitespace-nowrap">
            {part}
            {index < parts.length - 1 ? '/' : ''}
          </span>
          {index < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  );
}

/** A bucket or secret path, in mono. */
export function Path({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span className={cn('font-mono wrap-anywhere', className)}>{children}</span>
  );
}

/** "work, team and me", each path in mono. */
export function PathList({
  paths,
  className,
}: {
  paths: readonly string[];
  className?: string;
}) {
  return paths.map((path, index) => (
    <span key={path}>
      {index > 0 && (index === paths.length - 1 ? ' and ' : ', ')}
      <Path className={className}>{path}</Path>
    </span>
  ));
}
