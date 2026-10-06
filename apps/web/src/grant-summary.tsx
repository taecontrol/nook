import {
  type BucketGrant,
  limitedAccessText,
  readOnlyText,
} from '@nook/contract';

export function GrantRoots({ grant }: { grant: BucketGrant }) {
  return grant === 'all' ? (
    <>All buckets</>
  ) : (
    <code className="font-mono text-xs wrap-anywhere">{grant.join(', ')}</code>
  );
}
export function GrantDetails({ grant }: { grant: BucketGrant }) {
  return grant === 'all' ? (
    <>Every current and future bucket.</>
  ) : (
    <>
      {`(${limitedAccessText}). `}
      <span>{readOnlyText(grant)}</span>. All other buckets stay hidden.
    </>
  );
}
export function MachineAccess({ grant }: { grant: BucketGrant }) {
  return (
    <span className="wrap-anywhere">
      Access: <GrantRoots grant={grant} />
      {grant !== 'all' && (
        <>
          {' '}
          <GrantDetails grant={grant} />
        </>
      )}
    </span>
  );
}
