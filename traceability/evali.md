# Traceability: Eva Li (evali)

**Target feature:** Undo/redo of the last message and the agent's file changes, in [`packages/opencode/src/session/revert.ts`](../packages/opencode/src/session/revert.ts), [`packages/opencode/src/snapshot/index.ts`](../packages/opencode/src/snapshot/index.ts), and the undo summary in [`packages/tui/src/util/revert-diff.ts`](../packages/tui/src/util/revert-diff.ts)

**Property tests:** [`packages/opencode/test/session/undo-redo.property.test.ts`](../packages/opencode/test/session/undo-redo.property.test.ts)

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | C-2, S-1, O-2: "It should undo only the specific part you want" | /undo only changes files that changed during the undone message. Every other file in the project, including files the user edits by hand after the agent finishes, is left exactly as it was. | The project has `a.ts` and `b.ts`. The agent edits only `a.ts`; afterwards the user hand-edits `b.ts` and creates `notes.md`. After /undo, `b.ts` and `notes.md` are byte-for-byte what they were just before /undo. | Yes | For any project, any agent edits, and any later hand edits to files the agent didn't change, every file outside the agent's changes has the same bytes (and existence) before and after undo (invariant) | "R1: undo leaves every file outside the agent's changes untouched" | H1 |
| R2 | O-8, C-5, S-4: "you want it to have the exact same code as before" | After running /undo, every file the agent edited is byte-for-byte identical to its contents before the undone message was sent. | `a.ts` contains `x=1` and is committed. The agent changes it to `x=2`; after /undo, `a.ts` contains exactly `x=1` and `git status` reports no changes. Files the agent created are gone and files it deleted are back. | No | An in-memory map of the project has the same edits applied; the real worktree must match the map after the agent's turn, and must match the original map byte-for-byte after undo (model / oracle) | "R2: after undo the project matches the model of the project before the message" | H4 |
| R3 | C-3, S-2, O-3: "If we hit undo and redo again, there shouldn't have any changes" | Running /undo and then /redo returns every file exactly to the state it was in before /undo. | The agent changes `a.ts` from `x=1` to `x=2`. After /undo, `a.ts` is `x=1`; after /redo, `a.ts` is byte-for-byte `x=2`. A file the agent deleted is deleted again after /redo. | No | For any project and agent edits, `redo(undo(state)) === state` for every file on disk (round-trip) | "R3: undo then redo restores the project byte-for-byte" | H3 |
| R4 | C-4, S-3, O-4: "The overall behavior should be the same" | A single undo reverts all files the agent changed in that message, whether it changed one file or many. | In one message the agent edits 10 files; in another it edits 1. In both cases, after /undo every changed file is back to its contents before the message. | No | Adding more changed files to the same message (other project files plus 0–105 brand-new files, crossing the snapshot's 100-file batch size) doesn't change what undo does to the files already in it, and the extra files are reverted too (metamorphic) | "R4: changing more files in the message does not change how undo treats the others" | H4 |
| R5 | S-3: "maybe for the large file change one, send a confirmation message"; S-4: "you can compare it before and after" | After /undo, opencode shows the user the complete list of files the undo changed: every file it reverted is listed, and no file it did not change is. The user can review a large undo and /redo it if it wasn't wanted. | The agent edits 15 files, including creating an empty file and deleting one. After /undo, the undo summary lists exactly those 15 files. | Yes | For any project and agent edits (0–105 extra files), the file list the TUI builds from the session's revert diff equals the set of files whose bytes actually changed on disk (invariant) | "R5: undo reports exactly the files it changed" | H5 |
| R6 | C-2, S-1, O-2: "It should undo only the specific part you want" | /undo removes from the conversation exactly what it undid. Earlier messages stay, and an undo from inside the agent's reply keeps the part of the reply before that point. | A session has two turns. Undoing the second message leaves the first turn exactly as it was. Undoing from where the agent starts editing in the second reply keeps the user's second message and the reply's opening text. | New in P5 | For any project, earlier turn, agent edits and opening part (text or tool call), and for all three ways to target an undo (whole message, first part of the reply, start of the edits), the messages and parts left after undo equal the ones before the undo point (model / oracle) | "R6: undo removes exactly the undone messages and parts from the conversation" | Stryker mutants in `revert.ts` (see *Stryker comparison*) |

Properties written or suggested by opencode or another AI tool: R1, R2, R3, R4, R5, R6 (properties, generators and code fixes written by Claude Code and reviewed by me); R1 and R5 revisions suggested by Claude Code.

### Generator choices

- **Paths:** a fixed pool of 8 paths, not random strings, so generated edits often hit the same file (edit then delete, delete then recreate). The pool includes nested directories, a dotfile, a path with a space, and a non-ASCII name, the cases git handles specially.
- **Contents:** bytes, since R2/R3 are byte-for-byte. The mix covers empty files, the `x=1`/`x=2` one-character change from P3, CRLF, a file with no trailing newline, a whitespace-only file, arbitrary unicode, and raw binary.
- **Edits:** writes and deletes (weighted 3:1) applied to a project that is a random subset of the pool, so edits hit both existing and new files.
- **Bulk:** extra new files biased toward 0, 1–12 (around the old ">10 files" threshold), and 99–105 (just across `Snapshot.revert`'s 100-file batch size).
- **Regressions:** every shrunk counterexample below is pinned as a fast-check `example`, so it is re-checked on every run.

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R1 | /undo changes only files the agent edited in the undone message. Every other file in the project is left exactly as it was. | /undo only changes files that changed during the undone message. Every other file in the project, including files the user edits by hand after the agent finishes, is left exactly as it was. | **Not feasible as written, and conflicts with R2.** opencode snapshots the whole worktree at the start and end of each step, so it can't tell an agent's edit apart from a hand edit the user makes to the same file while the agent runs; "files the agent edited" really means "files that changed during the message". S-1 also wanted undo never to touch manual edits. For a file that both the agent and the user edited, that conflicts with R2, which says the file must go back to exactly its pre-message bytes. R2 wins for those files. The revision keeps what C-2, S-1 and O-2 asked for: undo doesn't touch anything outside the message's changes, including later hand edits to other files. |
| R5 | If an /undo command would revert more than 10 files, opencode asks the user for a confirmation before changing any file. | After /undo, opencode shows the user the complete list of files the undo changed: every file it reverted is listed, and no file it did not change is. | **Conflicts with R4, and the evidence is weak.** C-4, S-3 and O-4 all said undo should behave the same however many files changed (R4); a confirmation that appears only above 10 files is exactly that kind of difference. The only source is S-3's hedged "maybe". What S-3 (and S-4, "compare it before and after") actually needed was confidence about what a large undo did. With R3, a mistaken undo is reversible with /redo, so the user is already protected; what was missing was being able to see the change. The revised requirement keeps that need as something testable: the summary must name exactly the files undo changed. |

R2, R3 and R4 were kept as written: each one is checkable on the real files, and the snapshot system can deliver all three.

## Property failures and triage

R1 passed on its first run. Every other failure, with fast-check's shrunk counterexample:

| Property | Counterexample | Outcome | Action |
|---|---|---|---|
| R2 | Project `{"ünïcødé.txt": ""}`; the agent deletes `ünïcødé.txt` and creates an empty `a.ts`. After undo, `ünïcødé.txt` was still missing. | Code bug | When two or more files are reverted together, `Snapshot.revert` batches them and runs `git ls-tree` to see which existed. Without `-z`, git prints non-ASCII paths quoted and octal-escaped, so the lookup missed, and a file that existed was treated as new and **deleted**. Fixed by running `ls-tree -z` and splitting on NUL (`src/snapshot/index.ts`). R4 hit the same bug in its first run. |
| R3 | Project `{"a.ts": ""}`; the agent deletes `a.ts`. After undo then redo, `a.ts` still existed. | Code bug | Redo (`unrevert`) calls `Snapshot.restore`, which writes every file in the snapshot but never removes files that aren't in it. My first fix changed `restore` itself, but that broke the existing test "restore function", which requires `restore` to keep newly created files. So that change was reverted, and `unrevert` now resets the undone messages' patch files to the pre-undo snapshot after restoring; files missing from the snapshot get deleted, and unrelated new files are left alone (`src/session/revert.ts`). |
| R4 | Project `{"a.ts": ""}`; the agent deletes `a.ts` and creates an empty `b.ts`. After undo, `a.ts` was never restored. | Code bug | `Snapshot.patch` lists changed files with `git diff --name-only`, which has rename detection on. A delete plus a create with identical content is reported as a rename, so only `b.ts` was recorded and undo deleted `b.ts` without bringing `a.ts` back. In practice, undoing an agent that moved or renamed a file lost the original. Fixed with `--no-renames` (`src/snapshot/index.ts`). This only failed on some runs, because the random inputs rarely produce identical contents; it's now pinned as an example. |
| R5 | Project `{}`; the agent creates an empty `a.ts` (plus one generated file). The undo summary listed only the generated file. | Code bug | git writes no `---`/`+++` lines for an empty file (or a binary file, or a pure rename), and `parsePatch` silently drops those entries, so they never appeared in the TUI's undo summary. `getRevertDiffFiles` now splits the diff on git's `diff --git` headers, takes names from rename lines or the header when there are no `---`/`+++` lines, and lists both paths of a rename (`packages/tui/src/util/revert-diff.ts`; exported for the test in `packages/tui/package.json`). |

## Hand-written mutants

Each mutant is a patch in [`mutants/evali/`](../mutants/evali/). Apply one from the repo root with `git apply mutants/evali/H1.patch`, run `bun test test/session/undo-redo.property.test.ts` from `packages/opencode`, then `git apply -R` it. All runs use fast-check seed 42. Predictions were written down before any mutant was run (drafted with Claude Code and reviewed by me).

| ID | Requirement targeted | Change | Predicted killer | Actual result (before strengthening) | After strengthening |
|---|---|---|---|---|---|
| H1 | R1 | `revert.ts`: the `patch` part is collected before the `if (rev)` check instead of inside it, so undo also reverts patches from messages *before* the undone one. It reads like a harmless tidy-up of the nested `if`. | None. Predicted **survive**: every property records exactly one agent turn per session, so there are never earlier patches to wrongly revert. | Survived | Killed by R1 |
| H2 | R2 | `snapshot/index.ts` `patch()`: the `git diff --name-only` call uses `cfg` instead of `quote`, dropping `core.quotepath=false`. git then prints non-ASCII paths quoted and octal-escaped, so the patch records a path that doesn't exist. | R2, via the pinned `ünïcødé.txt` example and the non-ASCII path in the pool: the file is never put back. R4 may also catch it. | Killed by R2, R4 | **Equivalent** after the `-z` fix (see below) |
| H3 | R3 | `revert.ts` `unrevert()`: `all.slice(index)` becomes `all.slice(index + 1)`, an off-by-one that skips the message the undo started from. A whole-message undo starts at the user message, so the assistant's patch is still included; a partial undo from a part starts at the assistant message, so its patch is skipped and a file the agent deleted comes back on redo. | None. Predicted **survive**: the properties only ever undo from the user message, so the skipped message never has a patch. | Survived | Killed by R3 |
| H4 | R4 | `snapshot/index.ts` `patch()`: `--no-renames` removed from `git diff --name-only`, so a delete plus an identical create is reported only as the new path. | R4, via the pinned rename example (`a.ts` deleted, empty `b.ts` created). R2 might too, since empty contents are common in the generator. | Killed by R2, R4 | Killed by R2, R4 |
| H5 | R5 | `revert.ts` `revert()`: the session summary's file count only counts diffs with `additions + deletions > 0`, so empty and binary files (and pure deletes of empty files) are left out of the count the user sees. Plausible as "don't count files with no real changes". | None. Predicted **survive**: R5 checks the file list built from `revert.diff`, never `summary.files`. | Survived | Killed by R5 |

Predictions were right for all five on the original code: H2 and H4 were killed by the properties I expected, and H1, H3 and H5 survived for the reasons I expected. H2 and H4 were also killed by R2 because the non-ASCII and empty-file cases are in R2's generator, not only R4's.

**Strengthening (no example-based tests added):**
- **R1** now generates an `earlier` agent turn in the same session before the turn it undoes. Files only the earlier turn changed must be left alone. Killed H1 (shrunk: the earlier turn creates `a.ts`, the undone turn deletes `docs/with space.md`; the mutant also deleted `a.ts`).
- **R3** now round-trips every input twice: once undoing the whole message, and once undoing from the assistant's `step-start` part (keeping the text before it). Killed H3 (shrunk: the agent deletes `deep/nested/dir/config.json`; after a partial undo and redo the file was back). My first version picked the mode at random with `fc.boolean()`; after the path pool grew, seed 42 stopped drawing "partial undo + deleted file" in 15 runs and H3 survived again, so the kill was luck. Checking both modes on every input makes it deterministic.
- **R5** now also asserts that the session summary's `files` count equals the number of listed files. Killed H5 via R5's pinned empty-file regression.

**H2 became equivalent.** While strengthening against Stryker survivors I fixed a real bug by making `Snapshot.patch` read `git diff --name-only -z` (see *Stryker comparison*). With `-z`, git prints paths verbatim whatever `core.quotepath` is, so dropping `core.quotepath=false` (H2) no longer changes any output. No test can kill it now; it was killed by R2 and R4 against the code before the fix. `H2.patch` and `H4.patch` were regenerated against the fixed code so they still apply.

## Agent failure case

None of my P4 properties were written by opencode (they came from Claude Code), so I asked **opencode** to write a property for R3 on its own and ran my mutants against it.

**Transcript:** TODO_SHARE_LINK

![opencode writing the R3 property](TODO_SCREENSHOT)

**What opencode wrote** ([`opencode-r3.property.test.ts` as written](https://github.com/CMU-313/fall-26-opencode-meap/blob/034063b/packages/opencode/test/session/opencode-r3.property.test.ts)): a round-trip property. For a random project, an optional earlier turn, the agent's edits and some later hand edits, it runs undo then redo and checks the project is byte-for-byte what it was before undo. It also checks that `session.revert` is set after undo and cleared after redo. Its generator only has `write` and `delete` edits.

| Mutant | Result against opencode's property |
|---|---|
| H1 (undo also reverts earlier messages' patches) | Killed (its `earlier` turn catches it) |
| H2 | Equivalent after the `-z` fix |
| H3 (redo skips the undone assistant message) | Killed |
| **H4 (`--no-renames` removed)** | **Survived** |
| H5 (summary count drops empty files) | Survived (out of scope for R3) |

**The mutant it let survive: H4.** Without `--no-renames`, git reports a delete plus an identical create as a rename and lists only the new path. So undoing an agent that renamed `.env.local` to `a.ts` deletes `a.ts` and **never brings `.env.local` back**: real data loss in the undo.

**Why the property was too weak.** Two separate gaps, and both had to be fixed:
1. **Weak oracle.** It only checks `redo(undo(x)) == x` and never looks at the state *after undo*. Redo restores the pre-undo snapshot, so it papers over exactly the undo bugs that matter: under H4 the project is wrong after undo and right again after redo. The `session.revert` checks only say "undo did something", not that it did the right thing.
2. **Generator never reaches the bug.** H4 needs a delete and a create with identical bytes, i.e. a rename. Independent random writes and deletes almost never line up that way: with seed 42, adding the after-undo check alone still let H4 survive.

**Strengthened version** ([commit 6af0b5b](https://github.com/CMU-313/fall-26-opencode-meap/blob/6af0b5b/packages/opencode/test/session/opencode-r3.property.test.ts)):
- After undo, the project must match a model: every file the agent changed is back to its bytes before the message, and every other file is exactly as it was just before undo. The round-trip check stays.
- The generator gains a `move` edit (delete a file and write its bytes under a new path), since agents rename files all the time.

**Evidence it kills H4.** With `git apply mutants/evali/H4.patch`, the strengthened property fails with the shrunk counterexample `base: {".env.local": ""}`, agent: move `.env.local` → `a.ts`, then write `a.ts`; after undo `.env.local` is missing. With only the `move` generator and the original round-trip oracle, H4 still survives, so the after-undo check is what does the killing. The strengthened property passes on the real code.

## Stryker comparison

### Running Stryker

- **Config:** [`packages/opencode/stryker.evali.config.json`](../packages/opencode/stryker.evali.config.json). Command runner running only `bun test test/session/undo-redo.property.test.ts`; mutates only the code the requirements cover: `SessionRevert.revert`/`unrevert` (`src/session/revert.ts:38-112`), `Snapshot.patch` (`src/snapshot/index.ts:349-384`) and `Snapshot.revert` (`src/snapshot/index.ts:412-527`). `coverageAnalysis: off`, 4 runners, `timeoutMS: 60000`.
- **Seed:** fast-check `fc.configureGlobal({ seed: 42 })` at the top of the property file, so every mutant sees the same inputs.
- **Reports:** [`mutants/evali/mutation.html`](../mutants/evali/mutation.html) (final), [`mutation-before-strengthening.html`](../mutants/evali/mutation-before-strengthening.html), and [`mutation-initial.html`](../mutants/evali/mutation-initial.html) (first run, see below).

| Run | Properties | Mutants | Killed | Timeout | Survived | Score (Stryker) |
|---|---|---|---|---|---|---|
| 1 (initial) | R1–R5 after hand-written strengthening | 259 | 68 | 187 | 4 | 98.46% |
| 2 (before Stryker strengthening) | + multi-turn R2, backslash path, `-z` fix | 255 | 108 | 52 | 95 | 62.75% |
| 3 (final) | + R6, stronger R3 and R5 | 255 | 63 | 137 | 55 | **78.43%** |

**Run 1's score was not real.** Stryker counts a timeout as a kill, and 187 of 259 mutants timed out. With the default timeout (1.5× the ~31 s baseline + 5 s) and 4 runners competing for git, mutants that only make undo *slower* (see "fallback" below) ran past the limit and were scored as detected. Raising `timeoutMS` to 60 s turned most of them into survivors (run 2), which is the honest picture. Timeouts are still unreliable in run 3: R6 roughly doubled the baseline (≈61 s), and the run took 9.5 hours of wall-clock time (the laptop slept), so 63 mutants that run 2 *killed* show up as timeouts, and some equivalent mutants time out instead of surviving. The source code is identical in runs 2 and 3 (only the tests changed), so I matched every mutant across the two reports and corrected the count with what I verified:

- **Equivalent: 70** (argued below). 26 of them are counted as detected by Stryker because they timed out.
- **Not detected: 15.** The 11 final survivors that aren't equivalent, plus 4 that Stryker timed out but that I verified survive by applying them by hand against the final properties (`revert.ts:78`, `:104`, `:105`) or that no property can reach (`snapshot/index.ts:377`, below).
- **Detected: 170.**

**Mutation score (final): 78.43% as Stryker reports it; 91.89% with the 70 equivalent mutants excluded (170 detected / 185 non-equivalent).** The second number is an upper bound: an equivalent mutant that timed out in *both* runs can't be told apart from a real kill without rerunning it.

### Comparison

**Which hand-written mutants did Stryker never generate, and why not?** None of the five. Stryker's mutators make one local syntactic change at a time (flip an operator, blank a string, empty an array or block, drop a method call); my mutants came from knowing how the feature fails:
- **H1** moves a statement out of an `if` block. Stryker never moves statements; it only emptied that block or forced its condition, which breaks undo outright and was killed.
- **H2** swaps one valid identifier for another (`quote` → `cfg`). Stryker doesn't substitute variables.
- **H3** is an off-by-one (`slice(index)` → `slice(index + 1)`). Stryker has no "add one" mutator; at that spot it replaced `all.slice(index)` with `all` instead.
- **H4** removes one flag from an argument list. Stryker blanks the string (`"--no-renames"` → `""`), which makes git fail loudly and was killed; removing it makes git *silently* report renames, which is the plausible bug.
- **H5** adds a `.filter(...)`. Stryker only removes calls, never adds them.

**Which Stryker survivors would I never have thought of, and are any plausible bugs?**
- `rel: ...replaceAll("\\", "")` (run 1) is not a plausible bug itself, but asking "why can't any property see this?" led to a **real bug**: git quotes paths containing a backslash or quote even with `core.quotepath=false`, so undo left agent-created files like `back\slash.txt` behind (R2, R4 and R5 all failed on the original code). Fixed with `diff --name-only -z` and by converting only real path separators; `back\slash.txt` is now in the generator pool.
- `seen.has(file)` / `seen.add(file)` removed (run 1): plausible ("the paths are already unique"). It only matters when an undo spans several messages that edited the same file, which no property generated; R2 now undoes 1–3 turns at once and kills both.
- The `messageID: !partID && lastUser ? ...` and `remaining.some(...)` variants in `revert.ts` (run 2): plausible logic slips that change **which messages disappear from the conversation** after undo while leaving every file correct. All my requirements were about files, so nothing checked the conversation. I added **R6** (from C-2: "undo only the specific part you want").
- `run.length < 100` → `run.length >= 100` and the other batch-path survivors: plausible refactor slips that silently disable the 100-file batching, making a large undo run one git process per file. No requirement covers speed, so no property can see them (see equivalent mutants).

**What does each approach find that the other doesn't?** Hand-written mutants find **semantic** bugs from domain knowledge (git's rename detection, path quoting, partial undo) and expose **scenario gaps**: H1, H3 and H5 survived because every property used one turn, always undid from the user message, and never read the summary count. Stryker finds **unobserved code**: side effects no property reads (stored session diff, conversation state, summary), redundancy (the batched path whose failures the fallback repairs), and the edge cases above I'd never have mutated. But it buries them among equivalent mutants (logging, fallback), it can inflate the score with timeouts, and its five closest mutants to my hand-written ones were all easy kills.

### Strengthening

All survivors were attacked with properties, not example-based tests (pinned fast-check `examples` are only regression replays of shrunk counterexamples):

| Change | Kills |
|---|---|
| `back\slash.txt` added to the path pool, plus the `-z` / separator fix in `Snapshot` | `replaceAll("\\", "")` (run 1) |
| R2 undoes 1–3 agent turns at once, checking the model after every turn | `seen.has` / `seen.add` (run 1) |
| R3 also checks undo reached the pre-message project, in both undo modes | `|| part.id === input.partID` → `|| false` (a partial undo that silently does nothing passed the round trip) |
| R5 adds an earlier turn and checks the stored `session_diff` | diff range starting at the first message (`findIndex(() => true)`, `slice(index)` → `all`), `role !== "user"`, both `storage.write` key mutants |
| New R6: conversation after undo + cleanup, for whole-message, first-part and step-start undos, with a text or tool-call lead part | the 11 `lastUser` / `remaining.some(...)` / `messageID` / `role` mutants |

**Equivalent mutants (70):**
- **Logging (12):** the message string or attribute object of an `Effect.logInfo` call. Logs don't affect files, the session or anything the user sees, so no requirement-level test can observe them.
- **Batched path masked by the single-file fallback (36):** every mutant that makes the batched `git ls-tree` or `git checkout` fail, never batch, or always fall back (`args([])`, `""` arguments, `if (true)`/`if (false)` on the exit-code checks, `run.length < 100` variants, `clash` made always-true with `a !== b` or `startsWith("")`, `list = run`, `split("\0")` without `filter(Boolean)`, …). When a batched git call fails, `Snapshot.revert` reverts those files one at a time, which produces byte-identical results; when it isn't reached, nothing changes. The only difference is the number of git processes, i.e. speed, which no requirement specifies. I confirmed one directly: replacing the batched `checkout` arguments with `[]` passes all properties.
- **`cwd: state.worktree` removed (4):** every snapshot git call passes `--git-dir` and `--work-tree` explicitly with absolute paths, so the process's working directory never matters.
- **`single()` after a failed checkout (10):** the `ls-tree` lookup and its `if` only decide what to do when `git checkout <hash> -- <file>` fails. That happens exactly when the file is not in the snapshot (it was created), and then every variant deletes the file. They would differ only if checkout failed for a file that *is* in the snapshot (an I/O error), which no git-level input produces.
- **Unreachable `index < 0` branches in `revert.ts` (3):** `revert.messageID` is always a message of the session (revert just found it), so `index < 0 ? [] : …` never takes the `[]` side; mutating that side, or the condition to `false` (`slice(-1)` is never evaluated), can't change behaviour.
- **Dead check (1):** `if (!rev)` → `if (true)` in `revert.ts`: it sits right after `if (rev) { ...; continue }`, so `!rev` is always true there.
- **No-op arguments (3):** `remaining = ["Stryker was here"]` (the junk string has no `type`, so `.some()` answers the same), `if (files.length)` → `if (true)` (reverting an empty list is a no-op), `ops = ["Stryker was here"]` (the junk op has no path; its git calls fail and nothing is removed).
- **`.flatMap(... : ["Stryker was here"])` in `unrevert` (1):** adds a non-existent relative path to the redo reset; git can't check it out and there is nothing to delete.

**Survivors that are not equivalent and that I did not kill (15):**
- **Path clash checks (10)** in the batched path (`clash` → `false`, `startsWith` → `endsWith`, `some` → `every`, …), which *weaken* the clash check so conflicting paths are batched together: only matter when one reverted path is a prefix of another (`src` as a file and `src/index.ts`). The generator's pool never creates a file and a directory with the same name; adding that would need the harness to replace files with directories mid-turn.
- **`next.hash !== first.hash` → `false` (1)** and **redo resetting every patched file in the session instead of only the undone ones (`104 !==`, `105 slice → all`, 2):** both only differ when the user edits files *between* turns, or *while undone*. My requirements don't say what should happen then: R2 says undo restores "before the undone message", R1 says hand edits are left alone, and they conflict for a file the user edited between two undone turns. I'd need an interview question before writing a property.
- **`Session.Event.Diff` published with an empty payload (1):** the live UI refresh after undo. Nothing in my requirements covers it (R5 checks the stored list, which the TUI shows on load).
- **Ignored-file filter removed in `Snapshot.patch` (1):** only matters when the agent changes `.gitignore` during the turn; the generator never writes one.
