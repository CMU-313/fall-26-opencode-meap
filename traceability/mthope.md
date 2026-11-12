# Traceability: Mira Thope (mthope)

**Target feature:** opencode's permission rules, in `packages/opencode/src/permission/` and `packages/opencode/src/util/wildcard.ts`

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | S-1, S-3, C-7, C-8, O-4 | A command whose last matching rule (for the relevant permission and pattern) has action `deny` is rejected immediately, before any approval is requested. | For any ruleset where the last matching rule for a given permission and pattern has action `deny`, `evaluate(permission, pattern, ...rulesets)` returns a rule with action `deny`, and `ask()` rejects with a `DeniedError` on that same input, without waiting for a reply. | Yes | Invariant | `R1: a deny rule placed last always wins, no matter what precedes it` | H1 |
| R2 | S-6, S-11, S-12, S-13, C-11, C-12, O-6 | When more than one rule matches a command, `evaluate()` always picks the last matching rule in the order the rulesets were given, and reordering the rules changes the result in exactly that predictable way. | For any list of rules that match the same permission and pattern, `evaluate()` returns the one that comes last in the array. Swapping two rules' positions changes which one `evaluate()` returns, matching the new order every time. | Yes | Metamorphic | `R2: swapping two matching rules swaps which one wins` | H1 |
| R3 | S-14, S-15, C-13, C-14, O-7 | `evaluate()` always returns the specific rule (not just the action) that decided a permission check, so a caller can trace a decision back to the rule that caused it. | For any ruleset and input, the rule object returned by `evaluate()` is the actual rule from the input rulesets that matched (or the default `{action: "ask", pattern: "*"}` if none did), not just a bare action string. | Yes | Invariant | `R3: with no matching rule, evaluate() returns the exact default rule object` | H5 |
| R4 | S-6, C-13, C-14 | During a session, `list()` returns every permission request that is still pending a reply, so the user can see what's waiting on them. | For any sequence of `ask()` calls that are still awaiting a reply, `list()` returns exactly those requests, and a request no longer appears after it's been replied to. | Yes | | | none written |
| R5 | C-3, C-4, C-6 | Replying "always" to a request adds allow rules for exactly the patterns in that request's `always` list, and no other pattern is affected. | After `reply()` is called with `"always"` on a request with a given `always` list, `evaluate()` returns `"allow"` for every pattern in that list, and returns the same result as before for any pattern not in that list. | Yes | Invariant | `R5: an 'always allow' grant covers exactly its own patterns, nothing more` | H1, H2, H3 |
| R6 | S-16, C-15, C-16 | A rule change takes effect on the very next `evaluate()` call, and removing it restores the exact earlier result, with nothing left over. | For any ruleset and any new rule added to it, `evaluate()` with the new rule may return a different result, but `evaluate()` with the rule removed again always returns the same result as before it was added. | Yes | Round-trip | `R6: adding then removing a rule returns to the original decision` | none of H1-H5 |
| R7 | O-8, S-2 | A session's current rules can be inspected at any time (see R4), so a user can check whether a protection (like `rm *` deny) is still in place before trusting the agent, instead of relying on a confirmation step that doesn't currently exist. | N/A this round, no property written. See `Requirement changes` for why. | Yes | | | none written |

Properties written or suggested by opencode or another AI tool: R1, R2, R5, R6 — drafted by Claude based on the real evaluate()/merge() code, reviewed and run by me. All four passed on the first run.

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R1 | A command that matches a deny rule never runs and never offers an approve option. | A command whose last matching rule has action `deny` is rejected immediately, before any approval is requested. | The original acceptance criteria checked this by running the real agent and watching a file, which isn't practical to check against hundreds of generated inputs. `evaluate()` and `ask()` are pure/testable functions that implement this directly, so the requirement now points at them. |
| R2 | When more than one rule matches a command, the tool uses one fixed, documented precedence rule, the same way every time. | `evaluate()` always picks the last matching rule in ruleset order, and reordering the rules changes the result predictably. | Reading `permission/index.ts` showed the real rule: `.findLast()` on the flattened rulesets, last match wins. The original criteria asked to check "what the docs say," which code can't verify; the revision checks the actual behavior. |
| R3 | Every permission decision shows the user what was decided (allow, ask, or deny) and which rule caused it. | `evaluate()` always returns the specific rule that decided a check, not just the action. | There's no on-screen UI for this in the code I can see, only a log line. The original criteria ("in the session or a log... without reading source files or running tests") isn't checkable by an automated test. I scaled it down to what the code actually guarantees: the full rule is returned, not just allow/ask/deny. |
| R4 | During a session, the user can open a list of all active permission rules. | `list()` returns every pending permission request, so the user can see what's waiting on them. | `list()` in the real code only returns requests still waiting for a reply, not the full set of active rules from the config. "All active rules" isn't implemented anywhere I can see, so I revised the requirement to match what the code does. |
| R5 | Before the user confirms "always allow", the tool shows exactly what it will cover, and the new rule appears in the active rule list afterward. | Replying "always" adds allow rules for exactly the patterns in that request, and nothing else is affected. | The confirmation screen isn't in this file. The backend part is implemented and testable: `reply()` only adds rules for the patterns in `info.always`. I kept the scope-exactness idea and dropped the UI claim. |
| R6 | A rule change takes effect on the next command after it's saved, and reverting it restores the exact earlier behavior with no leftover state. | A rule change takes effect on the next `evaluate()` call, and removing it restores the exact earlier result. | Same idea, just stated at the function level instead of "save a config file and run three commands," which is a much larger test to automate reliably. |
| R7 | When a change would loosen a protection (deny to ask or allow), the tool asks the user to confirm first. | A session's current rules can be inspected at any time, so a user can check a protection is still in place, instead of a confirmation step that doesn't exist. | There's no code path anywhere in `permission/index.ts` for asking the user to confirm a rule change; rules only change through `reply()` adding allow rules, or by hand-editing the config file, which the program doesn't react to with any prompt. This is a real gap (S-2 and O-8 both point at it), but building a confirmation UI is a new feature, not something I can test with a property this round, so I'm not writing a property for R7 in Step 2. |

## Hand-written mutants

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R2 | `permission/index.ts`: `evaluate()`'s `.findLast(...)` changed to `.find(...)`, so the first matching rule wins instead of the last | "R2: swapping two matching rules swaps which one wins" (R2); likely R1 too | Killed: failed R1, R2, and R5. With `.find()`, an earlier rule can shadow the deny rule (R1) or an "always allow" grant appended last (R5), since first match wins instead of last |
| H2 | R1 | `permission/index.ts`: `evaluate()`'s match predicate changed from `&&` to `\|\|`, so a rule matches if either the permission or the pattern matches, not both | None — every property places its real rule last with an exact match on both fields, so last-wins semantics should still return it regardless of what else spuriously matches earlier | Killed: failed R5 (survived R1, R2, R6). Every rule in these tests uses `permission: "bash"` exactly matching the query, so `\|\|` makes any "bash" rule match every pattern, not just its own — R5's empty-base-plus-one-grant case exposed it. My prediction was wrong; I hadn't accounted for exact-match permissions triggering the same widening as a wildcard would |
| H3 | R5 | `permission/index.ts`: `merge()` changed to `rulesets.slice(0, -1).flat()`, dropping the last ruleset passed in | R5 — `merge(base, grants)` passes `grants` last, so it would get silently dropped | Killed: failed R5 exactly as predicted. The grant never gets added, so `evaluate()` still returns `"ask"` where it should return `"allow"` |
| H4 | R1 | `permission/index.ts`: `ask()`'s deny check changed to `if (rule.action === "deny" && pattern === "*")`, so a deny rule only blocks when the pattern is literally `"*"` | None — R1/R2/R5/R6 all test `evaluate()` directly; none of them ever call `ask()`, so a bug in `ask()`'s control flow is invisible to the whole suite | Survived exactly as predicted. All 4 tests still pass since none of them touch `ask()` |
| H5 | R3 | `permission/index.ts`: `evaluate()`'s default fallback changed `pattern: "*"` to `pattern` (echoes the queried pattern instead of the hardcoded wildcard) | None — R3 has no property written, so nothing checks the shape of the default fallback object | Survived exactly as predicted, since R3 isn't exercised by any property |

## Stryker comparison

Config: `stryker.mthope.config.json`, scoped to `src/permission/index.ts:28-38` (`evaluate()`) and `src/permission/index.ts:200-202` (`merge()`), running only `test/permission/permission.property.test.ts`. Seed fixed at 42 (`fc.configureGlobal({ seed: 42 })` at the top of the test file).

First run: 10 mutants, 7 killed, 3 survived. Mutation score **70%**.

All 3 survivors were in the same spot: the default fallback object `evaluate()` returns when no rule matches (R3). One wiped the whole object to `{}`, one swapped the default `pattern: "*"` for `pattern: ""`, one swapped `action: "ask"` for `action: ""`. This is the exact gap my own traceability table already flagged: R3 had no property written for it in P4.

I added one new property for R3 (`R3: with no matching rule, evaluate() returns the exact default rule object`, see Hand-written mutants and Requirements table above) that checks the full returned object, not just the action, when `evaluate()` is called with no rulesets at all. Re-ran Stryker after adding it: all 10 mutants now killed. Mutation score **100%**, no equivalents to exclude since every surviving mutant turned out to be a real, killable gap, not a behavior-preserving change.

As a bonus, this same property also killed H5, my hand-written mutant that targeted the same default object (it had survived on its first run since R3 had no property yet). Confirmed by reapplying `mutants/mthope/H5.patch` and rerunning the test file: R3 now fails on it (counterexample `["",""]`).

**Which of my hand-written mutants did Stryker never generate?**
H3 (`merge()` dropping its last argument via `rulesets.slice(0, -1).flat()`) and H4 (`ask()`'s deny check becoming conditional on `pattern === "*"`). H4 is outside my mutate range entirely since `ask()` isn't covered by any of my properties, so Stryker never even looked there. H3 is inside the mutate range, but Stryker's built-in mutators don't do "drop an argument from a spread/rest parameter" — that kind of off-by-one on an argument list needs someone to actually think about what `merge(base, grants)` is being used for, which is a human thing to notice, not a generic code mutation. H1 (swapping `.findLast` for `.find`) also wasn't something Stryker generated — Stryker doesn't have a mutator that swaps one array method for a different, semantically related one like that.

**Which Stryker survivors would I never have thought of? Are any of them bugs a real developer might plausibly write?**
I wouldn't have split the default object into three separate mutants the way Stryker did (wiping the whole object vs. just the `pattern` field vs. just the `action` field) — I only thought to touch the `pattern` field by hand (H5). Of the three, the `action: ""` one is the most realistic bug a real developer could actually write without really trying: a quick refactor of that object literal, a bad find-and-replace, or a merge conflict resolved wrong could easily leave the action field blank instead of `"ask"`, and nothing downstream would complain about a non-`"ask"`/`"allow"`/`"deny"` string unless something specifically checked it.

**What does each approach find that the other doesn't?**
Stryker is exhaustive about every literal and operator in the lines I pointed it at, so it caught all three ways the same default object could quietly break, something I only partially covered by hand. But Stryker can only swap a literal for a generic placeholder value (empty string, `{}`); it has no idea that `pattern` (the function's own parameter) was sitting right there as a plausible typo for `"*"` — that's exactly what my hand-written H5 mutant did, and it's a kind of mistake that needs understanding what the code is doing, not just pattern-matching on syntax. Hand-written mutants are better at targeting a specific requirement with a bug shaped like something I could imagine a teammate actually writing (an off-by-one on an argument list, a condition that's too narrow); Stryker is better at finding every small thing in the exact lines I gave it that nothing currently checks, even ones I wouldn't have thought to try.

## Agent failure case

**Transcript excerpt** (from the Project 4 session where I asked Claude to write my first property tests, Step 2 of that assignment):

My prompt: "ok do step 2: [Step 2 instructions — write fast-check properties for at least 4 requirements]"

Claude's response (relevant excerpt):
> Here's the property test file. Since I don't know your exact import convention... I've written it with a placeholder import...
>
> ```ts
> // R1: A command whose last matching rule has action deny is rejected
> // immediately, before any approval is requested.
> // Kind: invariant
> test("R1: a deny rule placed last always wins, no matter what precedes it", () => {
>   fc.assert(
>     fc.property(rulesetArb, commandArb, (prefix, command) => {
>       const denyRule = { permission: "bash", pattern: command, action: "deny" as const }
>       const result = Permission.evaluate("bash", command, [...prefix, denyRule])
>       expect(result.action).toBe("deny")
>     }),
>   )
> })
> ```
>
> **4. Once it's passing**, update `traceability/mthope.md`... Fill in the "Properties written or suggested by opencode" line: `R1, R2, R5, R6 — drafted by Claude from the real evaluate()/merge() code, reviewed and run by me.`

I reviewed this, ran it, and kept it (it's still the R1 property in my test file today, just with the import path fixed).

**The mutant it let survive:** H4 — `ask()`'s deny check changed from `if (rule.action === "deny")` to `if (rule.action === "deny" && pattern === "*")`, so a deny rule only actually blocks a command when the pattern being checked is the literal wildcard `"*"`. Everything else with a matching deny rule would silently fall through to `needsAsk = true` instead of rejecting.

**Why the property was too weak:** R1's own acceptance criteria says the requirement covers two things: `evaluate()` returning `"deny"`, *and* `ask()` actually rejecting with a `DeniedError` on that same input. The property Claude wrote only checks the first half — it calls `Permission.evaluate()` directly and never calls `ask()` at all. So a bug that corrupts `ask()`'s own deny-enforcement, while leaving `evaluate()` completely untouched, is invisible to this property no matter how many inputs fast-check throws at it. This is a generator/oracle gap: the oracle (the assertion) just never reaches the function the bug lives in.

**Strengthened property:** new file `test/permission/permission.ask.property.test.ts` (kept separate from my original property file so I don't touch what's already graded), reusing the existing Effect test harness from `test/permission/next.test.ts`. It calls the real `ask()` across 20 randomly generated command strings, each with a deny rule matching exactly that command, and asserts `ask()` rejects with a `PermissionV1.DeniedError` every time — not just for the literal `"*"` pattern.

**Evidence it kills H4:** Ran bun test test/permission/permission.ask.property.test.ts on real code first — passed clean, 1 test, 20 expect() calls (20 randomly generated commands). Applied mutants/mthope/H4.patch and ran it again — failed: ask() never resolved for the generated command (something other than the literal "*"), hit the 1-second timeout, and the test got a plain Error back instead of PermissionV1.DeniedError, so the assertion failed. H4 killed.

## Red team

My feature was claimed by Tiffany Liu (tiffany4, Team Jarvis). She studied my PR #40 at commit `52afff417ea1ae9f1e16921eb0800c7da7b726eb` and sent 3 mutants as a PR comment.

| Received mutant | Requirement targeted | Change | Result against my original properties | Fix |
|---|---|---|---|---|
| Tiffany-1 | R2 | `evaluate()`: added `.toReversed()` before flattening the rulesets, so an earlier ruleset *argument* wins over a later one, even though `.findLast()` still makes a later rule within the same array win | Survived — my original R2 property always puts both rules inside one combined array, never across separate ruleset arguments (the way `ask()` actually calls `evaluate(permission, pattern, ruleset, approved)`) | Added a new R2 property that passes two separate ruleset arguments and checks the later argument wins. Confirmed it kills this mutant |
| Tiffany-2 | R5 | `reply()`: stores `pattern.split(" ")[0] + " *"` instead of the real pattern when granting an "always allow," silently broadening a specific grant (e.g. `git status`) into a whole command family (`git *`) | Survived — my original R5 property builds grant objects itself and calls `merge()` directly, never the real `reply()`, so it can't see a bug inside `reply()`'s own implementation | Added a new R5 property that calls the real `ask()`/`reply()` through the Effect service: grants "always" for one command, then confirms a *different* command in the same family is still properly denied. Confirmed it kills this mutant |
| Tiffany-3 | R6 | `evaluate()`: adds a `WeakMap` cache keyed by the ruleset array's identity, never invalidated after an in-place `push()`, so a rule added to the same array isn't picked up until a new array is passed in | Survived — my original R6 property evaluates once before pushing and once after popping, but never evaluates the *same* array twice in a row right after a push, so a stale-but-still-correct-after-pop cache goes unnoticed | Added a new R6 property that evaluates an array once, pushes a new rule onto that same array, and evaluates it again immediately, checking the new rule takes effect right away. Confirmed it kills this mutant |

All 3 were genuine bugs, not equivalent mutants — each one changes real, observable behavior (reversed precedence across sources, a silently broadened permission grant, and a stale permission decision), so no equivalence argument applies to any of them.