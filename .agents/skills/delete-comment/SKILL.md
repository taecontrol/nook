---
name: delete-comment
description: Audit the code comments the ratchet still allows, delete them by category, file issues for the workarounds they excuse, move decisions into ADRs, and lower the baseline.
disable-model-invocation: true
---

# Delete comments

Nook code carries no comments. `pnpm verify:comments` runs the `nook/no-comments` oxlint rule (`scripts/lint/no-comments.ts`). It fails a file with more comments than the lower of its entries in `scripts/lint/comment-baseline.json` on this branch and on `origin/main`, fails a file with fewer comments until its entry is lowered, and fails on an entry whose file no longer exists. The baseline is the inventory: every key is a file that still holds comments, and its value is how many.

The argument, when given, narrows the pass to a path prefix. Without one, take every file in the baseline.

## 1. Classify every comment

Read each comment in its file, with enough of the surrounding code, callers, ADRs in `docs/adrs/`, and `git log -S` to judge it. Give each exactly one category:

- **Tautology**: repeats what the names, types, call, or test title already say.
- **Stale**: describes code, behaviour, issue numbers, or states that no longer match the code. Confirm it against the code before calling it stale.
- **Excuse**: justifies a hack, workaround, duplication, test-only seam in production code, magic constant, sleep, or known gap that has a real fix.
- **Decision**: records a why the code does not show. Sub-classify it:
  - **covered**: an existing ADR or maintained document, such as `docs/verification/README.md`, already owns the rationale.
  - **ADR**: consequential (security, data integrity, compatibility, operations, architecture), costly to reverse, and in no ADR. Group related comments by topic.
  - **local**: a real why too small for an ADR, such as a platform gotcha, a race, or a test scenario's intent.

Be strict with **ADR**: most decisions are **local**. More than about 150 comments is enough to fan out to subagents by directory; give each the definitions above and collect one category per comment, so deletion stays a mechanical step you run yourself.

Completion criterion: every comment in scope has one category, and every stale, excuse, and covered call names its evidence.

## 2. Act on each category

- **Tautology, stale, covered**: delete the comment.
- **Excuse**: delete the comment and file one issue per workaround with the `issue` skill. The issue names the file and line, what is hacky, and what a fix must achieve, and leaves the solution open.
- **ADR**: write one ADR per topic with the `adr` skill, following the format of `docs/adrs/`, then delete the comments it now owns. A topic that changes an accepted ADR's decision gets a new ADR that supersedes it.
- **Local**: when a name, a type, or a test can carry the why, make that change and delete the comment. Otherwise leave it; the ratchet holds it.

Delete from the parser's comment locations, never by pattern: a `//` inside a string or URL is code. Remove a comment's whole line when nothing else is on it, keep the code beside a trailing comment, and run `pnpm exec biome check --write` on the touched files.

Completion criterion: every tautology, stale, covered, excuse, and ADR comment in scope is gone; every excuse has an issue and every ADR topic has a record.

## 3. Lower the baseline

Run `pnpm verify:comments`. For each "Tighten the ratchet" message, set the file's entry to the count it names, or remove the entry at zero; remove the entries it lists for deleted files. A "Comments are banned" message means a comment remains that step 2 should have removed. Run it again until it passes.

Completion criterion: `pnpm verify:comments` passes and no entry in the baseline grew.

## 4. Verify and report

Run `pnpm verify`. Report the count per category, the comments and lines deleted, the issues filed, the ADRs written, and the comments the baseline still holds.
