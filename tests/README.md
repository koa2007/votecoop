# Tests

Regression tests for the rules that decide a vote. They boot a **real PocketBase**
with the repo's **real `pb_hooks`**, import the production collection schema, and
drive it over HTTP.

Nothing is mocked on purpose. Every defect these guard against lived in the seam
between PocketBase and the JS hooks — how a `json` field reaches the hook, when an
update rule is evaluated. A mock would have reproduced the same wrong assumption
that let those defects ship.

## Running

```bash
node --test tests/*.test.mjs
```

You need the PocketBase binary — the same version production runs
(`ssh <server> '/opt/pocketbase/pocketbase --version'`). Put it in `tests/.bin/`
(gitignored) or point `PB_BIN` at it:

```bash
PB_BIN=/path/to/pocketbase node --test tests/*.test.mjs
```

Each run uses a throwaway data directory under the system temp dir; nothing
touches production.

## Checking that a test can actually fail

A test that is always green is not a test. To run the suite against an older copy
of the hooks:

```bash
mkdir -p /tmp/oldhooks
git show <commit>:pb_hooks/main.pb.js > /tmp/oldhooks/main.pb.js
git show <commit>:pb_hooks/lib.js     > /tmp/oldhooks/lib.js
PB_HOOKS_DIR=/tmp/oldhooks node --test tests/*.test.mjs
```

Against `d7cc3d5` (the state before the 2026-08-26 audit) 10 of 11 integrity tests
and 7 of 9 governance tests fail; against `6e29c47` (before round two) all 10 tests
in `decision-execution.test.mjs` fail — which is what makes them worth keeping.

## Looking at a change in a browser

Point `PB_PUBLIC_DIR` at the repo root and the same throwaway instance also serves
the real app, so a change can be looked at against the real hooks instead of only
asserted over HTTP:

```bash
PB_BIN=tests/.bin/pocketbase.exe PB_PUBLIC_DIR="$PWD" node --test tests/decision-execution.test.mjs
```

## Files

- `harness.mjs` — boots PocketBase, imports the schema, small HTTP helpers.
- `fixtures/collections.json` — the production collection schema, exported from the
  live database. This is the only copy in version control; the server's own schema
  lives in `pb_data/data.db`. Re-export it after any change made in `/_/`.
- `voting-integrity.test.mjs` — who may vote, what the quorum denominator is,
  what a cancelled voting may turn into, record ownership, the "dead souls" flow.
- `governance.test.mjs` — a ballot stays in its group, the admin can be replaced,
  losing the right to vote leaves a trace, deadlines, the expiry sweep, group edit.
- `decision-execution.test.mjs` — the second audit round: a decision the system
  cannot carry out is journalled instead of passing as "прийнято"; the frozen roll
  is the sole answer to who may vote; ballots after the deadline are refused; a
  removal needs a real neighbour on the other side and keeps their name; a proposal
  to exclude nobody excludes nobody; a secret ballot stays secret after it closes.
