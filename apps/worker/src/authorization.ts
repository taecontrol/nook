export type BucketGrant = 'all' | ReadonlyArray<string>;
function inside(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}
export function canRead(grant: BucketGrant, path: string): boolean {
  return (
    grant === 'all' ||
    path === 'me' ||
    grant.some((root) => inside(path, root) || inside(root, path))
  );
}
export function canWrite(grant: BucketGrant, path: string): boolean {
  return grant === 'all' || grant.some((root) => inside(path, root));
}
