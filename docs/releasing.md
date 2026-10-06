# Releasing the CLI

`apps/cli/package.json` holds the only CLI version. `nook version` prints it as `{"version":"X.Y.Z"}`, and `nook --version` prints `nook vX.Y.Z`.

To release, merge a pull request that sets the new version, wait for **Verify** to pass on `main`, and run **Actions → Release → Run workflow** on `main` with that version. Never create tags, releases, or assets by hand.

The workflow runs these jobs in order:

1. `validate` requires `main`, both release secrets, an `X.Y.Z` version equal to the package version, `main` still at the dispatched commit, no existing tag or release, and a green Verify run for that commit.
2. `binary` builds a Node single executable natively on `ubuntu-22.04`, `ubuntu-22.04-arm`, `macos-15-intel`, and `macos-15`, signs it ad hoc on macOS, and runs `nook version` with `env -i PATH=/usr/bin:/bin`. Each archive `nook-X.Y.Z-<platform>-<arch>.tar.gz` holds one `nook` executable.
3. `source` builds `nook-X.Y.Z.tar.gz` with `git archive` twice and compares the copies. It then audits the formula rendered from `packaging/nook.rb.template` with `brew audit --strict`, installs it against that local archive with `--build-from-source`, and runs `brew test`.
4. `publish` checks every checksum, attests the binary archives, pushes tag `vX.Y.Z` with the release deploy key, and publishes the release. A failure deletes whatever it created.
5. `mise` verifies each archive's checksum and attestation, installs the release with `mise x github:taecontrol/nook@X.Y.Z` on all four runners, compares `nook version`, and checks that the installed binary equals the archived one. If any platform fails, `unpublish` deletes the release and its tag.
6. `homebrew` opens `nook X.Y.Z` against `taecontrol/homebrew-tap` with auto-merge. The tap's `formula` check audits, installs, and compares `nook version` with the formula version.

| Fails at | Tag | Release | Tap PR | Next step |
| --- | --- | --- | --- | --- |
| `validate`, `binary`, or `source` | none | none | none | Fix and dispatch the same version. |
| `publish` or `mise` | deleted | deleted | none | Fix and dispatch the same version. |
| `homebrew` or the tap's check | stays | stays | none or open | Fix and release the next patch version. |

The repository needs these settings, which only the owner can create:

- `RELEASE_TAG_DEPLOY_KEY`: the private half of the write deploy key **release tags**. The **release tags** ruleset blocks creating, updating, or deleting `v*` tags for everyone except deploy keys.
- `HOMEBREW_TAP_TOKEN`: a fine-grained personal access token for `taecontrol/homebrew-tap` with **Contents** and **Pull requests** read and write.

The workflow passes tokens to Git only through environment configuration, never in arguments, remote URLs, or `.git/config`.
