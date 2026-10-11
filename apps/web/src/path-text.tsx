import { cn } from 'cn';

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
