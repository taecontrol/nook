export function tagChanges(
  before: readonly string[],
  after: readonly string[],
) {
  return {
    added: after.filter((tag) => !before.includes(tag)),
    removed: before.filter((tag) => !after.includes(tag)),
  };
}
