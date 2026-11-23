---
name: delete-comment
description: Audit the comments the ratchet still allows, act on each by category, and lower the baseline.
disable-model-invocation: true
---

# Delete comments

`scripts/lint/comment-baseline.json` is the inventory: each key is a file that still holds comments, and its value is how many. The argument, when given, narrows the pass to a path prefix; without one, take every file in the inventory. Note the base commit (`git rev-parse origin/main`) before editing: issues link to the comments there, after they are gone.

## 1. Classify every comment

Judge each comment against its file, its callers, `docs/adrs/`, `docs/verification/README.md`, and `git log -S`. Give it exactly one category:

- **Tautology**: repeats what the names, types, call, or test title already say.
- **Stale**: describes code, behaviour, issue numbers, or states the code no longer has. Confirm against the code.
- **Excuse**: justifies a hack, workaround, duplication, test-only seam in production code, magic constant, sleep, or known gap that has a real fix.
- **Decision**: records a why the code does not show.
  - **covered**: an ADR or maintained document already owns the why.
  - **ADR**: consequential (security, data integrity, compatibility, operations, architecture), costly to reverse, and owned by no document.
  - **local**: a real why too small for an ADR: a platform gotcha, a race, a test scenario's intent. Most decisions are local.

Past about 150 comments, fan out to subagents by directory with these definitions and collect one category per comment by file, line, and text. Deletion stays yours.

Completion criterion: every comment in scope has one category, and every stale, excuse, and covered call names its evidence.

## 2. Act on each category

- **Tautology, stale, covered**: delete.
- **Excuse**: delete, and file one issue per workaround with the `issue` skill. Link the code at the base commit, so the reader still sees the comment.
- **ADR**: write one ADR per topic with the `adr` skill, then delete the comments it owns. A topic that changes an accepted ADR gets a new ADR that supersedes it.
- **Local**: when a name, a type, or a test can carry the why, make that change and delete the comment. Otherwise it stays, and the ratchet holds it.

Delete from the parser's comment locations, matched by file and text, because line numbers shift as you edit and a `//` inside a string or URL is code. Remove the whole line when the comment is alone on it, keep the code beside a trailing comment, and run `pnpm exec biome check --write` on the touched files. A comment that was the only content of a block leaves it empty: rewrite the code so the block reads as intended.

Completion criterion: every tautology, stale, covered, excuse, and ADR comment in scope is gone; every excuse has an issue and every ADR topic has a record.

## 3. Lower the baseline

Run `pnpm verify:comments` and follow its messages: set each "Tighten the ratchet" entry to the count it names, removing it at zero, and remove the entries it lists for deleted files. "Comments are banned" means a comment remains that step 2 should have removed. Repeat until it passes.

Completion criterion: `pnpm verify:comments` passes and no entry grew.

## 4. Verify and report

Search the tests for the text of each deleted comment: a test that reads a source file can assert on it. Then run `pnpm verify`. Report the count per category, the comments and lines deleted, the issues filed, the ADRs written, and what the baseline still holds.
