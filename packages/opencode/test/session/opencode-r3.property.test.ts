import fc from "fast-check"

fc.configureGlobal({ seed: 42 })

import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node]),
  ),
)

const NUM_RUNS = 15
const TIMEOUT = 180_000

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const PATHS = [
  "a.ts",
  "b.ts",
  "src/index.ts",
  "src/lib/util.ts",
  "deep/nested/dir/config.json",
  "docs/with space.md",
  "ünïcødé.txt",
  ".env.local",
] as const
const filePath = fc.constantFrom(...PATHS)

const encoder = new TextEncoder()
const content = fc
  .oneof(
    { weight: 3, arbitrary: fc.constantFrom("", "x=1\n", "x=2\n", "a\r\nb\r\n", "no trailing newline", " \n\t\n") },
    { weight: 2, arbitrary: fc.string({ maxLength: 40 }) },
    { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 20 }) },
  )
  .map((text) => encoder.encode(text))
const bytes = fc.oneof({ weight: 5, arbitrary: content }, { weight: 1, arbitrary: fc.uint8Array({ maxLength: 32 }) })

const project = fc.dictionary(filePath, bytes, { maxKeys: PATHS.length })

const edit = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("write" as const), file: filePath, data: bytes }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("delete" as const), file: filePath }) },
  // Strengthened (not written by opencode): agents rename files all the time, and a rename is a delete plus a
  // create with identical bytes, which writes and deletes alone almost never line up. Mutant H4 needs exactly that.
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("move" as const), file: filePath, to: filePath }) },
)
const edits = fc.array(edit, { minLength: 1, maxLength: 8 })

type Tree = Record<string, string>
type Edit =
  | { kind: "write"; file: string; data: Uint8Array }
  | { kind: "delete"; file: string }
  | { kind: "move"; file: string; to: string }

const latin1 = (data: Uint8Array) => Buffer.from(data).toString("latin1")

const modelOf = (files: Record<string, Uint8Array>) =>
  Object.fromEntries(Object.entries(files).map(([file, data]) => [file, latin1(data)])) as Tree

const applyModel = (tree: Tree, list: Edit[]) =>
  list.reduce<Tree>((acc, op) => {
    if (op.kind === "write") return { ...acc, [op.file]: latin1(op.data) }
    if (op.kind === "move") {
      if (!(op.file in acc) || op.file === op.to) return acc
      const rest = Object.fromEntries(Object.entries(acc).filter(([file]) => file !== op.file))
      return { ...rest, [op.to]: acc[op.file]! }
    }
    return Object.fromEntries(Object.entries(acc).filter(([file]) => file !== op.file))
  }, tree)

const changed = (a: Tree, b: Tree) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((file) => a[file] !== b[file])

// ---------------------------------------------------------------------------
// Worktree helpers
// ---------------------------------------------------------------------------

const readTree = (dir: string) =>
  Effect.promise(async () => {
    const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, dot: true, onlyFiles: true }))
    const entries = await Promise.all(
      files
        .map((file) => file.replaceAll("\\", "/"))
        .filter((file) => !file.startsWith(".git/"))
        .map(async (file) => [file, latin1(await Bun.file(path.join(dir, file)).bytes())] as const),
    )
    return Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b))) as Tree
  })

const resetTree = (dir: string, files: Record<string, Uint8Array>) =>
  Effect.promise(async () => {
    const entries = await fs.readdir(dir)
    await Promise.all(
      entries.filter((entry) => entry !== ".git").map((entry) => fs.rm(path.join(dir, entry), { recursive: true })),
    )
    await Promise.all(Object.entries(files).map(([file, data]) => Bun.write(path.join(dir, file), data)))
  })

const applyEdits = (dir: string, list: Edit[]) =>
  Effect.promise(async () => {
    for (const op of list) {
      if (op.kind === "write") await Bun.write(path.join(dir, op.file), op.data)
      if (op.kind === "delete") await fs.rm(path.join(dir, op.file), { force: true })
      if (op.kind === "move" && op.file !== op.to) {
        const source = Bun.file(path.join(dir, op.file))
        if (!(await source.exists())) continue
        const data = await source.bytes()
        await fs.rm(path.join(dir, op.file))
        await Bun.write(path.join(dir, op.to), data)
      }
    }
  })

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const agentTurn = Effect.fn("test.agentTurn")(function* (sessionID: SessionID, dir: string, list: Edit[]) {
  const session = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "default",
    model,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID,
    type: "text",
    text: "please edit some files",
  })
  const assistant = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens,
    modelID: model.modelID,
    providerID: model.providerID,
    parentID: user.id,
    time: { created: Date.now() },
    finish: "end_turn",
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "I'll make those edits.",
  })
  const before = yield* snapshot.track()
  if (!before) throw new Error("expected a snapshot before the agent turn")
  const stepStart = yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "step-start",
    snapshot: before,
  })
  yield* applyEdits(dir, list)
  const after = yield* snapshot.track()
  const patch = yield* snapshot.patch(before)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "step-finish",
    reason: "stop",
    snapshot: after,
    cost: 0,
    tokens,
  })
  if (patch.files.length)
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID,
      type: "patch",
      hash: patch.hash,
      files: patch.files,
    })
  return { user: user.id, assistant: assistant.id, stepStart: stepStart.id }
})

const property = <T, E, R>(arb: fc.Arbitrary<T>, body: (input: T) => Effect.Effect<void, E, R>, examples: T[] = []) =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context<R>())
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(arb, (input) => run(body(input))),
        { numRuns: NUM_RUNS, examples: examples.map((item) => [item] as [T]) },
      ),
    )
  })

const empty = new Uint8Array()

describe("R3: /undo then /redo round-trip", () => {
  // Requirement R3:
  // "Running /undo and then /redo returns every file exactly to the state it was in before /undo."
  //
  // For any initial project state, prior session turns, agent edits, and subsequent edits,
  // executing /undo (revert) and then /redo (unrevert) restores every file on disk to its
  // exact byte-for-byte state prior to the /undo command.
  it.live(
    "returns every file exactly to the state it was in before /undo",
    provideTmpdirInstance(
      (dir) =>
        property(
          fc.record({
            base: project,
            earlier: fc.array(edit, { maxLength: 3 }),
            agent: edits,
            manual: fc.array(edit, { maxLength: 3 }),
            atPart: fc.boolean(),
          }),
          (input) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const revert = yield* SessionRevert.Service
              yield* resetTree(dir, input.base)

              const sessionID = (yield* sessions.create({})).id
              if (input.earlier.length) {
                yield* agentTurn(sessionID, dir, input.earlier)
              }

              const turn = yield* agentTurn(sessionID, dir, input.agent)
              if (input.manual.length) {
                yield* applyEdits(dir, input.manual)
              }

              const beforeUndo = yield* readTree(dir)

              const undoTarget = input.atPart
                ? { sessionID, messageID: turn.assistant, partID: turn.stepStart }
                : { sessionID, messageID: turn.user }

              const sessionAfterUndo = yield* revert.revert(undoTarget)
              expect(sessionAfterUndo.revert).toBeDefined()

              // Strengthened (not written by opencode): the round trip alone can't see an undo bug that redo
              // repairs, e.g. mutant H4, where undo deletes b.ts but never brings a.ts back and redo then restores
              // the pre-undo snapshot. Check the intermediate state too: files the agent changed are back to their
              // bytes before the message, and every other file is exactly as it was just before undo.
              const afterEarlier = applyModel(modelOf(input.base), input.earlier)
              const agentFiles = changed(afterEarlier, applyModel(afterEarlier, input.agent))
              const expected = Object.fromEntries(
                [...new Set([...Object.keys(beforeUndo), ...Object.keys(afterEarlier)])].flatMap((file) => {
                  const source = agentFiles.includes(file) ? afterEarlier : beforeUndo
                  return file in source ? [[file, source[file]]] : []
                }),
              )
              expect(yield* readTree(dir)).toEqual(expected)

              const sessionAfterRedo = yield* revert.unrevert({ sessionID })
              expect(sessionAfterRedo.revert).toBeUndefined()

              const afterRedo = yield* readTree(dir)
              expect(afterRedo).toEqual(beforeUndo)
            }),
          [
            // Regression case 1: Redo restoring a file that the agent had deleted
            {
              base: { "a.ts": empty },
              earlier: [],
              agent: [{ kind: "delete", file: "a.ts" }],
              manual: [],
              atPart: false,
            },
            // Regression case 2: Partial undo at step-start part with a deleted nested file (kills mutant H3)
            {
              base: { "deep/nested/dir/config.json": empty },
              earlier: [],
              agent: [{ kind: "delete", file: "deep/nested/dir/config.json" }],
              manual: [],
              atPart: true,
            },
            // Regression case 3: Unicode file creation and edits
            {
              base: {},
              earlier: [],
              agent: [
                { kind: "write", file: "ünïcødé.txt", data: encoder.encode("content\n") },
                { kind: "write", file: "docs/with space.md", data: encoder.encode("notes\n") },
              ],
              manual: [],
              atPart: false,
            },
          ],
        ),
      { git: true },
    ),
    TIMEOUT,
  )
})
