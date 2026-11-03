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
})
