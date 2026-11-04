import { test, expect } from "bun:test"
import fc from "fast-check"
import { evaluate, merge } from "../../src/permission"

// Commands we exercise. These mirror what came up in interviews: a safe
// read (ls), a git command the TA wanted gated (S-6), and two rm variants
// every interviewee worried about (S-1, C-8, O-4).
const COMMANDS = ["ls", "git status", "git push origin main", "rm test.txt", "rm -rf /tmp/build"] as const

const actionArb = fc.constantFrom("allow", "ask", "deny") as fc.Arbitrary<"allow" | "ask" | "deny">

// A rule whose permission/pattern are either an exact command from COMMANDS
// or the "*" wildcard. That keeps whether it matches a given command
// unambiguous, without re-implementing Wildcard.match ourselves — we're
// testing evaluate()'s precedence logic, not the wildcard matcher.
const ruleArb = fc.record({
  permission: fc.constantFrom("bash", "*"),
  pattern: fc.oneof(fc.constantFrom(...COMMANDS), fc.constant("*")),
  action: actionArb,
})

const rulesetArb = fc.array(ruleArb, { maxLength: 8 })
const commandArb = fc.constantFrom(...COMMANDS)

// R1: A command whose last matching rule has action deny is rejected
// immediately, before any approval is requested.
// Kind: invariant
test("R1: a deny rule placed last always wins, no matter what precedes it", () => {
  fc.assert(
    fc.property(rulesetArb, commandArb, (prefix, command) => {
      const denyRule = { permission: "bash", pattern: command, action: "deny" as const }
      const result = evaluate("bash", command, [...prefix, denyRule])
      expect(result.action).toBe("deny")
    }),
  )
})

// R2: evaluate() always picks the last matching rule in ruleset order, and
// reordering the rules changes the result in exactly that predictable way.
// Kind: metamorphic
test("R2: swapping two matching rules swaps which one wins", () => {
  fc.assert(
    fc.property(commandArb, actionArb, actionArb, (command, actionA, actionB) => {
      fc.pre(actionA !== actionB)
      const ruleA = { permission: "bash", pattern: command, action: actionA }
      const ruleB = { permission: "bash", pattern: command, action: actionB }

      const forward = evaluate("bash", command, [ruleA, ruleB])
      const swapped = evaluate("bash", command, [ruleB, ruleA])

      expect(forward.action).toBe(actionB)
      expect(swapped.action).toBe(actionA)
    }),
  )
})

// R6: A rule change takes effect on the very next evaluate() call, and
// removing it restores the exact earlier result, with nothing left over.
// Kind: round-trip
test("R6: adding then removing a rule returns to the original decision", () => {
  fc.assert(
    fc.property(rulesetArb, ruleArb, commandArb, (base, newRule, command) => {
      const live = [...base]
      const before = evaluate("bash", command, live)

      live.push(newRule)
      evaluate("bash", command, live) // the rule is live here, result may differ

      live.pop()
      const after = evaluate("bash", command, live)

      expect(after).toEqual(before)
    }),
  )
})

// R5: Replying "always" to a request adds allow rules for exactly the
// patterns in that request's always list, and no other pattern is affected.
// Kind: invariant
test("R5: an 'always allow' grant covers exactly its own patterns, nothing more", () => {
  fc.assert(
    fc.property(rulesetArb, fc.uniqueArray(commandArb, { minLength: 1, maxLength: 3 }), (base, alwaysPatterns) => {
      // Mirrors what reply() does in permission/index.ts (~lines 145-151):
      // for each pattern in the request's `always` list, push a new allow rule.
      const grants = alwaysPatterns.map((pattern) => ({
        permission: "bash" as const,
        pattern,
        action: "allow" as const,
      }))
      const after = merge(base, grants)

      for (const pattern of alwaysPatterns) {
        expect(evaluate("bash", pattern, after).action).toBe("allow")
      }

      for (const command of COMMANDS) {
        if (alwaysPatterns.includes(command)) continue
        expect(evaluate("bash", command, after)).toEqual(evaluate("bash", command, base))
      }
    }),
  )
})