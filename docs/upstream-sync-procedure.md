# Upstream sync procedure

For an agent that starts with this page only and has to bring the rewrite up to date with upstream
(`n00bcodr/Jellyfin-Enhanced`). Codebase rules: [AGENTS.md](../AGENTS.md). Lab, test loop and gates: the je12 skill;
`je12` below is `/home/jake/projects/je12-skill-v232/je12/scripts/je12` (or a newer tagged worktree beside it), and
`je12/SKILL.md` sits beside that `scripts/` folder. Never push and never contact upstream: the main line is published
automatically when it moves, so land only what passed the gate. Servers only as labs from `je12 up`, one at a time,
never a live Jellyfin, Seerr, Sonarr or Radarr; nothing heavy while `/home/jake/projects/.lenovo-quiet` exists.

## The run

1. Worktree, never the main checkout: `git -C /home/jake/projects/jellyfin-enhanced-v12-rewrite worktree add -b
   sync/auto-<date> /home/jake/projects/je-upstream-auto restructure/integration`, then `npm ci` there. If that
   worktree is left from an unfinished run, continue on its branch (rebase it onto the main line) instead.
2. `python3 scripts/upstream_sync.py update --fetch` appends every upstream commit the ledger
   [`upstream-sync.json`](upstream-sync.json) lacks as `pending`, however many runs were missed, and prints the work
   list, oldest first, with a `how:` line each. `nothing to do`: no step log, nothing lands, go to step 7.
3. Take each `pending` entry in order: read `git show <sha>`, correct its guessed `class` and `features`, give it a
   status. Commits that are one behaviour (a fix and its test update) go together: `"with": "<lead sha>"`.
4. One commit per entry or group, ledger entry included, `je12 regen` first: `feat(<feature>): …` or
   `fix(<feature>): …`, one trailer `Upstream: <full sha>` per commit covered, no AI attribution. Then
   `upstream_sync.py resolve` and commit the ledger; `upstream_sync.py check` must pass.
5. `je12 gate final` on the committed tree. It can wait a long time for the machine's gate lock: leave the checkout
   untouched and keep calling `je12 wait`.
6. Land: `git -C /home/jake/projects/jellyfin-enhanced-v12-rewrite merge --ff-only sync/auto-<date>`. If the main
   line moved, rebase, `je12 regen`, gate again. If the main checkout has uncommitted changes, do not land.
7. Whatever happened: `je12 down`; the step log (`artifacts/restructure-plan/step-logs/upstream-sync-<date>.md`:
   the gap, each entry's status, evidence, gate result) and its evidence files are part of what lands (`git add -f`,
   the folder is ignored); after landing, or with nothing to do, remove the worktree and its branch, otherwise
   leave both for the next run; remove `/home/jake/projects/.je-upstream-sync-running`; report what landed, or
   what stopped it.

## Status: nothing stays `pending`

| Status | When | The entry must say |
|---|---|---|
| `ported` | Re-implemented here and proved, or applied as is. | `notes`: every difference from upstream. |
| `already-present` | The rewrite already behaves this way (a test or lab run shows it). | `evidence`. |
| `not-applicable` | No meaning here: Jellyfin 10.11 support, a file this tree generates or lacks. | `reason`. |
| `deferred` | It applies but cannot be landed in this run. | `reason`, and `needs`. A later run leaves it until `needs` is met. |

Housekeeping is ported, not parked. CI, dependency, translation and docs commits apply as is
(`git show <sha> | git apply --3way`; give workflows only this tree has the same pins; client sources live in
`client/`). A release is one last `chore(release)` commit: the version in `JellyfinEnhanced.csproj` (`git grep` the
old one for the rest) and `manifest.json` copied from upstream, covering the version commit and the bot's manifest
commit.

## A port

- **Behaviour, not text.** Code goes where AGENTS.md puts it. If upstream's change has a bug or a weaker pattern
  than AGENTS.md allows (a cached-output version it did not bump, say), port the intent correctly, say so in `notes`,
  and file it with `je12 found-bug`.
- **What transfers.** C# files were moved, not rewritten: a hunk often applies after
  `sed 's#<old path>#<new path>#g'`. Upstream's tests load the built `js/` files by the same names. Client code is
  always re-implemented. A new setting needs its line in the What's New index and
  `tests/fixtures/admin-config-baseline.json` (`docs/rewrite/admin-config.md`).
- **Proof.** Tests first, failing before the port. For a change a user can see, also run one `je12 browse` or
  `je12 api` command against both builds on a lab from `je12 up`:
  `JE12=<path to je12> python3 scripts/upstream_lab_deploy.py <upstream sha>` (needs that lab, the fetched commit
  and dotnet) installs upstream's build: run the command with `--keep before`; `je12 deploy` restores the rewrite:
  run it again with `--keep after`. Save both outputs beside the step log. Skip the upstream side when nothing is
  user-visible or the helper fails (it uses je12 internals): say so and rely on the tests. Box sets:
  `je12 env content --collections`, never the collections API (it rescans the lab library away).
- **Contract changes** (a route, authorization or registration; the Architecture snapshot tests fail) are not
  landed unattended. Finish the port on its own branch `sync/contract-<sha>` with the additions as its last commit,
  `contract: upstream sync additions`; on the landing branch mark the entry `deferred` with the added lines in
  `needs`.
