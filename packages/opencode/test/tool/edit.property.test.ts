import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fc from "fast-check"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { EditTool, replace } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-property"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
  ),
)

const run = Effect.fn("EditPropertyTest.run")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const info = yield* EditTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

// Code-like text: identifiers, punctuation, indentation, LF and CRLF line breaks, and
// backslashes (which the escape-normalizing fallback matcher reinterprets). It never
// contains MARKER, so any search text that includes MARKER can't occur in it.
const MARKER = "Z"
const codeUnit = fc.constantFrom("a", "b", "c", "x", "(", ")", "{", "}", ";", "=", " ", "  ", "\t", "\\")
const codeLine = fc.array(codeUnit, { maxLength: 12 }).map((units) => units.join(""))
const codeText = fc
  .tuple(fc.array(codeLine, { maxLength: 8 }), fc.constantFrom("\n", "\r\n"))
  .map(([lines, ending]) => lines.join(ending))

// Every line of the search text carries MARKER. The fuzzy matchers compare lines after
// trimming whitespace, and the block-anchor matcher accepts a block whose first and last
// lines match and whose middle lines are only similar, so one marker-free line could
// still be matched. One to four lines covers both single-line and block-anchor searches.
const unmatchableSearch = fc
  .array(
    fc.tuple(codeLine, codeLine).map(([before, after]) => before + MARKER + after),
    { minLength: 1, maxLength: 4 },
  )
  .map((lines) => lines.join("\n"))

// The interviewees' other failure case: the search text appears twice and the AI didn't
// say which one it meant. Letters only, on one line, so no fuzzy matcher can widen or
// shift the span into a unique match and the edit is rejected as ambiguous.
const ambiguousEdit = fc
  .tuple(
    fc.stringMatching(/^[a-c]{1,6}$/),
    fc.array(fc.constantFrom("a", "b", "c", "\n", ";"), { maxLength: 10 }).map((units) => units.join("")),
    fc.array(fc.constantFrom("a", "b", "c", "\n", ";"), { maxLength: 10 }).map((units) => units.join("")),
    fc.array(fc.constantFrom("a", "b", "c", "\n", ";"), { maxLength: 10 }).map((units) => units.join("")),
  )
  .map(([target, head, middle, tail]) => ({
    content: head + "\n" + target + "\n" + middle + "\n" + target + "\n" + tail,
    oldString: target,
    newString: target + "x",
  }))

const notFoundEdit = fc
  .record({ content: codeText, oldString: unmatchableSearch, newString: codeText })
  .filter((edit) => edit.newString !== edit.oldString)

// A file of indented lines (none, 2 or 4 spaces, or a tab) with A spliced in. A and B mix
// code, indentation and newlines, so they range from one character to several lines and
// often start or end in whitespace, which interviewees expected to survive the round trip.
// The whole edit is then converted to LF or CRLF together. About three in four generated
// cases meet R2's "each matches exactly once" condition; the rest are skipped by fc.pre.
const indentation = fc.constantFrom("", "  ", "    ", "\t")
const indentedText = fc
  .array(
    fc.tuple(indentation, codeLine).map(([indent, line]) => indent + line),
    { maxLength: 6 },
  )
  .map((lines) => lines.join("\n"))
const spanText = fc
  .array(fc.oneof(codeUnit, fc.constant("\n"), indentation), { minLength: 1, maxLength: 12 })
  .map((units) => units.join(""))
  .filter((text) => text !== "")
const roundTripEdit = fc
  .record({
    before: indentedText,
    after: indentedText,
    a: spanText,
    b: spanText,
    ending: fc.constantFrom("\n", "\r\n"),
  })
  .map((edit) => ({
    file: (edit.before + edit.a + edit.after).replaceAll("\n", edit.ending),
    a: edit.a.replaceAll("\n", edit.ending),
    b: edit.b.replaceAll("\n", edit.ending),
  }))

function occursOnce(text: string, search: string) {
  const index = text.indexOf(search)
  return index !== -1 && index === text.lastIndexOf(search)
}

// A 2–5 line block, nested up to three levels deep in the file's indent unit (2 or 4
// spaces, or a tab), spliced in on its own lines. The search text keeps each line's code
// but may swap its leading indentation. Either every line switches to another indent unit
// (the interview's 2-space vs 4-space case), or each line independently keeps or changes
// its indentation, which covers the AI getting just one line wrong.
const reindentEdit = fc
  .record({
    before: indentedText,
    after: indentedText,
    lines: fc.array(
      fc.tuple(
        fc.integer({ min: 1, max: 3 }),
        codeLine.map((line) => line.trim()).filter((line) => line !== ""),
      ),
      { minLength: 2, maxLength: 5 },
    ),
    fileUnit: fc.constantFrom("  ", "    ", "\t"),
    searchIndents: fc.oneof(
      indentation.map((unit) => ({ unit, perLine: [] })),
      fc.array(fc.option(indentation, { freq: 2 }), { minLength: 5, maxLength: 5 }).map((perLine) => ({
        unit: undefined,
        perLine,
      })),
    ),
    newString: spanText,
  })
  .map((edit) => {
    const block = edit.lines.map(([depth, code]) => edit.fileUnit.repeat(depth) + code)
    const search = edit.lines.map(([depth, code], i) => {
      if (edit.searchIndents.unit !== undefined) return edit.searchIndents.unit.repeat(depth) + code
      return (edit.searchIndents.perLine[i] ?? edit.fileUnit.repeat(depth)) + code
    })
    return {
      file: edit.before + "\n" + block.join("\n") + "\n" + edit.after,
      exact: block.join("\n"),
      search: search.join("\n"),
      newString: edit.newString,
    }
  })

// R4's "no other block matches when indentation is ignored": the block's trimmed lines
// appear as consecutive file lines exactly once.
function matchesOnceIgnoringIndentation(file: string, block: string) {
  const fileLines = file.split("\n").map((line) => line.trim())
  const blockLines = block.split("\n").map((line) => line.trim())
  return (
    fileLines.filter((_, start) => blockLines.every((line, offset) => fileLines[start + offset] === line)).length === 1
  )
}

// A tiny alphabet so the old text overlaps itself ("aa" in "aaa"), sits next to itself, and
// joins with neighbors or the new text to form the old text again. It also has `$`, `&`, `'`
// and backticks, which code uses (shell, regex, template strings) and which JavaScript treats
// as patterns in replacement strings. The file is filler joined by the old text, so the old
// text always appears at least once, as R5's "appears in the file exactly" requires. The new
// text may be empty, which makes the replace-all a deletion.
const replaceAllUnit = fc.constantFrom("a", "b", "$", "&", "'", "`", " ", "\n")
const replaceAllEdit = fc
  .record({
    filler: fc.array(
      fc.array(replaceAllUnit, { maxLength: 6 }).map((units) => units.join("")),
      { minLength: 2, maxLength: 5 },
    ),
    oldString: fc.array(replaceAllUnit, { minLength: 1, maxLength: 3 }).map((units) => units.join("")),
    newString: fc.array(replaceAllUnit, { maxLength: 4 }).map((units) => units.join("")),
  })
  .map((edit) => ({
    content: edit.filler.join(edit.oldString),
    oldString: edit.oldString,
    newString: edit.newString,
  }))

describe("tool.edit properties", () => {
  // R1: "If an edit can't be applied, it is rejected with an error and the file is left
  // exactly as it was, never partially edited."
  // Kind: invariant. replace() is the matching core the tool calls before writing.
  test("R1 (invariant): replace() rejects search text that can't be found", () => {
    fc.assert(
      fc.property(notFoundEdit, (edit) => {
        expect(() => replace(edit.content, edit.oldString, edit.newString)).toThrow("Could not find oldString")
        expect(() => replace(edit.content, edit.oldString, edit.newString, true)).toThrow("Could not find oldString")
      }),
    )
  })

  // R1: "If an edit can't be applied, it is rejected with an error and the file is left
  // exactly as it was, never partially edited."
  // Kind: invariant. Runs the real edit tool against a temp file, with or without a BOM,
  // and compares raw bytes so line endings and the BOM count as part of "unchanged".
  it.instance("R1 (invariant): a rejected edit leaves the file's bytes unchanged", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const services = yield* Effect.context<Effect.Services<ReturnType<typeof run>>>()
      const filePath = path.join(test.directory, "file.txt")
      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(fc.oneof(notFoundEdit, ambiguousEdit), fc.boolean(), async (edit, bom) => {
            await Bun.write(filePath, (bom ? "﻿" : "") + edit.content)
            const before = await Bun.file(filePath).bytes()

            const exit = await Effect.runPromiseWith(services)(
              run({ filePath, oldString: edit.oldString, newString: edit.newString }).pipe(Effect.exit),
            )

            if (Exit.isSuccess(exit)) throw new Error("expected the edit to be rejected")
            expect(String(Cause.squash(exit.cause))).toMatch(/Could not find oldString|Found multiple matches/)
            expect(await Bun.file(filePath).bytes()).toEqual(before)
          }),
          // Each run goes through the full tool (stat, read, lock), so fewer runs than the
          // pure property keep the test fast.
          { numRuns: 50 },
        ),
      )
    }),
  )

  // R2: "Applying A→B and then B→A returns the original file byte for byte, including
  // whitespace when A and B each match exactly once."
  // Kind: round-trip.
  test("R2 (round-trip): replacing A with B and then B with A restores the file", () => {
    fc.assert(
      fc.property(roundTripEdit, (edit) => {
        fc.pre(edit.a !== edit.b && occursOnce(edit.file, edit.a))
        const changed = replace(edit.file, edit.a, edit.b)
        fc.pre(occursOnce(changed, edit.b))

        expect(replace(changed, edit.b, edit.a)).toBe(edit.file)
      }),
    )
  })

  // R2: "Applying A→B and then B→A returns the original file byte for byte, including
  // whitespace when A and B each match exactly once."
  // Kind: round-trip. Through the real edit tool, which also converts line endings and
  // splits off a BOM before matching, so this checks those steps put the bytes back too.
  it.instance("R2 (round-trip): two edits through the tool restore the file's bytes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const services = yield* Effect.context<Effect.Services<ReturnType<typeof run>>>()
      const filePath = path.join(test.directory, "file.txt")
      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(roundTripEdit, fc.boolean(), async (edit, bom) => {
            fc.pre(edit.a !== edit.b && occursOnce(edit.file, edit.a))
            fc.pre(occursOnce(replace(edit.file, edit.a, edit.b), edit.b))
            await Bun.write(filePath, (bom ? "﻿" : "") + edit.file)
            const before = await Bun.file(filePath).bytes()

            await Effect.runPromiseWith(services)(run({ filePath, oldString: edit.a, newString: edit.b }))
            await Effect.runPromiseWith(services)(run({ filePath, oldString: edit.b, newString: edit.a }))

            expect(await Bun.file(filePath).bytes()).toEqual(before)
          }),
          // Two full tool runs per case, so fewer runs than the pure property. The example is
          // the shrunk counterexample that found the line-ending bug: the first edit removes
          // the file's only CRLF, and the second must put it back as CRLF, not LF.
          { numRuns: 50, examples: [[{ file: "\r\n", a: "\r\n", b: "a" }, false]] },
        ),
      )
    }),
  )

  // R4: "If the AI's search text differs from a multi-line block in the file only in leading
  // indentation, no other block matches when indentation is ignored, and the search text
  // doesn't itself appear exactly in the file, the edit gives the same result as the same
  // edit with exact indentation."
  // Kind: metamorphic. Changing only the search text's indentation must not change the output.
  test("R4 (metamorphic): re-indenting the search text gives the same result", () => {
    fc.assert(
      fc.property(reindentEdit, (edit) => {
        fc.pre(edit.search !== edit.exact && edit.newString !== edit.exact && edit.newString !== edit.search)
        fc.pre(occursOnce(edit.file, edit.exact) && matchesOnceIgnoringIndentation(edit.file, edit.exact))
        // An exact match always wins. Dropping only the first line's indentation makes the
        // search text an exact match that starts partway into that line, which keeps the
        // line's indentation on purpose (counterexample `"a\n  a"` in `"      a\n  a"`).
        fc.pre(!edit.file.includes(edit.search))

        expect(replace(edit.file, edit.search, edit.newString)).toBe(replace(edit.file, edit.exact, edit.newString))
      }),
      // The P3 acceptance example: a 2-space search against a 4-space block.
      {
        examples: [
          [
            {
              file: "function f() {\n    if (x) {\n        y()\n    }\n}\n",
              exact: "    if (x) {\n        y()\n    }",
              search: "  if (x) {\n    y()\n  }",
              newString: "    if (x) {\n        z()\n    }",
            },
          ],
        ],
      },
    )
  })

  // R5: "When the old text appears in the file exactly, a replace-all gives the same file as
  // replacing every non-overlapping occurrence from left to right, i.e.
  // content.split(old).join(new)."
  // Kind: model/oracle. split/join is the obviously correct replace-all.
  test("R5 (model/oracle): replace-all matches content.split(old).join(new)", () => {
    fc.assert(
      fc.property(replaceAllEdit, (edit) => {
        fc.pre(edit.newString !== edit.oldString)

        expect(replace(edit.content, edit.oldString, edit.newString, true)).toBe(
          edit.content.split(edit.oldString).join(edit.newString),
        )
      }),
      // The P3 acceptance examples: three `total`s renamed to `sum`, and the new text
      // joining the next character to form the old text again.
      {
        examples: [
          [{ content: "let total = 0;\ntotal += x;\nreturn total;", oldString: "total", newString: "sum" }],
          [{ content: "abb", oldString: "ab", newString: "a" }],
          // Shrunk counterexample that found the bug: `$&` was read as "the matched text".
          [{ content: "a", oldString: "a", newString: "$&" }],
        ],
      },
    )
  })
})
