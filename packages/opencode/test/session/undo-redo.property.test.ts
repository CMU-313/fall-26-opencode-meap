// Property-based tests for /undo and /redo (SessionRevert.revert / unrevert).
// Requirements and traceability: traceability/evali.md (R1–R5).
//
// Each property drives the real SessionRevert service against a real git-backed
// worktree: it records an "agent turn" exactly like the session processor does
// (step-start snapshot -> file edits -> step-finish snapshot + patch part), then
// runs undo/redo and compares the files on disk against an in-memory model.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { getRevertDiffFiles } from "@opencode-ai/tui/util/revert-diff"
import { Effect } from "effect"
import fc from "fast-check"
import fs from "fs/promises"
import path from "path"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { Storage } from "@/storage/storage"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionRevert.node,
      Snapshot.node,
      Storage.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

// Every run spawns a handful of git processes, so keep the run count modest to
// stay inside the CI unit-test budget while still covering the generators well.
const NUM_RUNS = 15
const TIMEOUT = 180_000

// Fixed seed so mutation-testing runs (hand-written mutants and Stryker) are
// reproducible: a mutant's result can't flip between runs because fast-check
// drew different inputs. Recorded in traceability/evali.md.
fc.configureGlobal({ seed: 42 })

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A small, fixed pool of paths (rather than random strings) so that generated
// edits frequently collide on the same file: edit-then-delete, delete-then-
// recreate, and edits to files the project already has. The pool deliberately
// includes the path shapes interviewees and the snapshot code care about:
// nested directories that undo must recreate, a dotfile, a space, and
// non-ASCII characters (git quotes these unless core.quotepath=false). A
// backslash is quoted by git even with core.quotepath=false, and on macOS/Linux
// it is a filename character, not a path separator (found from a Stryker survivor).
const PATHS = [
  "a.ts",
  "b.ts",
  "src/index.ts",
  "src/lib/util.ts",
  "deep/nested/dir/config.json",
  "docs/with space.md",
  "ünïcødé.txt",
  ".env.local",
  "back\\slash.txt",
] as const
const filePath = fc.constantFrom(...PATHS)

// File contents are bytes, because R2/R3 require byte-for-byte equality. The
// mix covers the boundaries that break naive restore logic: empty files,
// a one-character change (x=1 -> x=2 from the P3 acceptance criteria), CRLF
// line endings, missing trailing newline, whitespace-only files, arbitrary
// unicode, and raw binary that is not valid UTF-8.
const encoder = new TextEncoder()
const content = fc
  .oneof(
    { weight: 3, arbitrary: fc.constantFrom("", "x=1\n", "x=2\n", "a\r\nb\r\n", "no trailing newline", " \n\t\n") },
    { weight: 2, arbitrary: fc.string({ maxLength: 40 }) },
    { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 20 }) },
  )
  .map((text) => encoder.encode(text))
const bytes = fc.oneof({ weight: 5, arbitrary: content }, { weight: 1, arbitrary: fc.uint8Array({ maxLength: 32 }) })

// The project as it exists before the user sends the message: some subset of
// the pool, so edits hit both existing and brand-new files.
const project = fc.dictionary(filePath, bytes, { maxKeys: PATHS.length })

// One file operation the agent (or the user) performs. Deletes matter as much
// as writes: undo has to bring deleted files back and redo has to remove them.
const edit = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("write" as const), file: filePath, data: bytes }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("delete" as const), file: filePath }) },
)
const edits = fc.array(edit, { minLength: 1, maxLength: 8 })

// Number of extra brand-new files the agent creates in the same message (R4).
// Biased toward the interesting sizes: none, a few, R5's old ">10 files"
// threshold, and just across Snapshot.revert's internal 100-file batch size.
const bulk = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 99, max: 105 }))

// ---------------------------------------------------------------------------
// Model of the worktree: relative path -> file bytes (as latin1, which maps
// every byte 1:1 to a character so equality is byte-for-byte and diffs from
// fast-check stay readable for ASCII content).
// ---------------------------------------------------------------------------

type Tree = Record<string, string>
type Edit = { kind: "write"; file: string; data: Uint8Array } | { kind: "delete"; file: string }

const latin1 = (data: Uint8Array) => Buffer.from(data).toString("latin1")

const modelOf = (files: Record<string, Uint8Array>) =>
  Object.fromEntries(Object.entries(files).map(([file, data]) => [file, latin1(data)])) as Tree

const applyModel = (tree: Tree, list: Edit[]) =>
  list.reduce<Tree>((acc, op) => {
    if (op.kind === "write") return { ...acc, [op.file]: latin1(op.data) }
    return Object.fromEntries(Object.entries(acc).filter(([file]) => file !== op.file))
  }, tree)

// Files whose existence or bytes differ between two trees.
const changed = (a: Tree, b: Tree) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((file) => a[file] !== b[file]).toSorted()

const pick = (tree: Tree, files: string[]) =>
  Object.fromEntries(files.filter((file) => file in tree).map((file) => [file, tree[file]]))

const bulkFiles = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    kind: "write" as const,
    file: `generated/file-${String(i).padStart(3, "0")}.txt`,
    data: encoder.encode(`generated ${i}\n`),
  }))

// ---------------------------------------------------------------------------
// Real worktree helpers
// ---------------------------------------------------------------------------

const readTree = (dir: string) =>
  Effect.promise(async () => {
    const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, dot: true, onlyFiles: true }))
    const entries = await Promise.all(
      files
        .map((file) => file.split(path.sep).join("/"))
        .filter((file) => !file.startsWith(".git/"))
        .map(async (file) => [file, latin1(await Bun.file(path.join(dir, file)).bytes())] as const),
    )
    return Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b))) as Tree
  })

// Puts the worktree back to exactly `files` so runs don't leak into each other.
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
    }
  })

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

// Records one user message plus the agent's response, persisting the same
// text-or-tool / step-start / step-finish / patch parts the session processor
// writes when an agent edits files. Returns the user message ID (what a
// whole-message /undo targets) and the assistant message, lead part and
// step-start part IDs (what a partial undo from inside the response targets).
const agentTurn = Effect.fn("test.agentTurn")(function* (
  sessionID: SessionID,
  dir: string,
  list: Edit[],
  lead: "text" | "tool" = "text",
) {
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
  // The agent says something (or calls a read-only tool) before it starts
  // editing, so a partial undo from the step-start keeps this part and undoes
  // only what follows it.
  const leadPart = yield* session.updatePart(
    lead === "text"
      ? { id: PartID.ascending(), messageID: assistant.id, sessionID, type: "text", text: "I'll make those edits." }
      : {
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID,
          type: "tool",
          callID: "call-read",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
  )
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
  return { user: user.id, assistant: assistant.id, lead: leadPart.id, stepStart: stepStart.id }
})

// Runs fast-check inside an Effect test, executing each generated case as an
// Effect against the same services and test instance.
// `examples` are shrunk counterexamples from earlier failures, replayed on
// every run as regression cases before the random ones.
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

describe("undo/redo properties", () => {
  // R1: /undo changes only files the agent edited in the undone message. Every
  // other file in the project — including files the user edited by hand after
  // the agent finished, and files an earlier message in the same session
  // changed — is left exactly as it was.
  // Kind: invariant
  it.live(
    "R1: undo leaves every file outside the agent's changes untouched",
    provideTmpdirInstance(
      (dir) =>
        property(
          fc.record({
            base: project,
            // An earlier agent turn in the same session that is not undone. Without it every session has one
            // message, so undo could revert every patch in the session and still pass (mutant H1).
            earlier: fc.array(edit, { maxLength: 4 }),
            agent: edits,
            manual: fc.array(edit, { maxLength: 4 }),
          }),
          (input) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const revert = yield* SessionRevert.Service
              yield* resetTree(dir, input.base)
              const base = applyModel(modelOf(input.base), input.earlier)
              const sessionID = (yield* sessions.create({})).id
              yield* agentTurn(sessionID, dir, input.earlier)
              const messageID = (yield* agentTurn(sessionID, dir, input.agent)).user
              const agentFiles = changed(base, applyModel(base, input.agent))
              // The user then hand-edits files the agent did not touch.
              yield* applyEdits(
                dir,
                input.manual.filter((op) => !agentFiles.includes(op.file)),
              )
              const beforeUndo = yield* readTree(dir)
              yield* revert.revert({ sessionID, messageID })
              const afterUndo = yield* readTree(dir)
              const others = [...new Set([...Object.keys(beforeUndo), ...Object.keys(afterUndo)])].filter(
                (file) => !agentFiles.includes(file),
              )
              expect(pick(afterUndo, others)).toEqual(pick(beforeUndo, others))
            }),
        ),
      { git: true },
    ),
    TIMEOUT,
  )

  // R2: After running /undo, every file the agent edited is byte-for-byte
  // identical to its contents before the undone message was sent (files the
  // agent created are gone again, files it deleted are back).
  // Kind: model / oracle — the oracle is an in-memory map of the project that
  // the edits are also applied to; the real worktree must match it after every
  // agent turn, and must match the original map after undo.
  it.live(
    "R2: after undo the project matches the model of the project before the message",
    provideTmpdirInstance(
      (dir) =>
        property(
          // later: more agent turns after the undone message. Undoing a message undoes everything after it, so a
          // file edited in several turns must go back to its bytes before the *first* one, not an in-between version.
          fc.record({ base: project, agent: edits, later: fc.array(edits, { maxLength: 2 }) }),
          (input) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const revert = yield* SessionRevert.Service
              yield* resetTree(dir, input.base)
              const base = modelOf(input.base)
              const sessionID = (yield* sessions.create({})).id
              const messageID = (yield* agentTurn(sessionID, dir, input.agent)).user
              const turns = [input.agent, ...input.later]
              expect(yield* readTree(dir)).toEqual(applyModel(base, input.agent))
              for (const [i, list] of input.later.entries()) {
                yield* agentTurn(sessionID, dir, list)
                expect(yield* readTree(dir)).toEqual(applyModel(base, turns.slice(0, i + 2).flat()))
              }
              yield* revert.revert({ sessionID, messageID })
              expect(yield* readTree(dir)).toEqual(base)
            }),
          [
            // Batched revert dropped a non-ASCII path: git ls-tree quoted it, so it looked absent and was deleted.
            {
              base: { "ünïcødé.txt": empty },
              agent: [
                { kind: "delete", file: "ünïcødé.txt" },
                { kind: "write", file: "a.ts", data: empty },
              ],
              later: [],
            },
            // git quotes a backslash path even with core.quotepath=false, so the patch recorded a path that doesn't
            // exist and undo left the created file behind.
            { base: {}, agent: [{ kind: "write", file: "back\\slash.txt", data: empty }], later: [] },
          ],
        ),
      { git: true },
    ),
    TIMEOUT,
  )

  // R3: Running /undo and then /redo returns every file exactly to the state it
  // was in before /undo.
  // Kind: round-trip
  it.live(
    "R3: undo then redo restores the project byte-for-byte",
    provideTmpdirInstance(
      (dir) =>
        property(
          fc.record({ base: project, agent: edits }),
          (input) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const revert = yield* SessionRevert.Service
              yield* resetTree(dir, input.base)
              const sessionID = (yield* sessions.create({})).id
              const turn = yield* agentTurn(sessionID, dir, input.agent)
              const beforeUndo = yield* readTree(dir)
              // Every input is round-tripped both ways: undoing the whole message, and undoing from the assistant's
              // step-start part (keeping the text before it). For the second, redo has to find the undone files
              // from the assistant message itself (mutant H3). Checking both on every input, rather than picking
              // one at random, keeps the kill from depending on which inputs the seed draws.
              const targets = [
                { sessionID, messageID: turn.user },
                { sessionID, messageID: turn.assistant, partID: turn.stepStart },
              ]
              for (const target of targets) {
                yield* revert.revert(target)
                // A round trip alone passes when undo silently does nothing, so check undo reached the project
                // before the message (Stryker: a partial undo whose part never matched survived).
                expect(yield* readTree(dir)).toEqual(modelOf(input.base))
                yield* revert.unrevert({ sessionID })
                expect(yield* readTree(dir)).toEqual(beforeUndo)
              }
            }),
          // Redo left behind a file the agent had deleted (restore never removed files missing from the snapshot).
          [{ base: { "a.ts": empty }, agent: [{ kind: "delete", file: "a.ts" }] }],
        ),
      { git: true },
    ),
    TIMEOUT,
  )

  // R4: A single undo reverts all files the agent changed in that message,
  // whether it changed one file or many.
  // Kind: metamorphic — adding more changed files to the same message (extra
  // pool files plus up to ~105 brand-new files) must not change what undo does
  // to the files that were already in it, and must still revert the extras.
  it.live(
    "R4: changing more files in the message does not change how undo treats the others",
    provideTmpdirInstance(
      (dir) =>
        property(
          fc.record({ base: project, agent: edits, extra: edits, bulk }),
          (input) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const revert = yield* SessionRevert.Service
              const base = modelOf(input.base)
              const small = input.agent
              const smallFiles = changed(base, applyModel(base, small))
              // Extra edits only touch files the small message didn't, so the
              // small message's files have the same final state in both runs.
              const large = [
                ...small,
                ...input.extra.filter((op) => !small.some((item) => item.file === op.file)),
                ...bulkFiles(input.bulk),
              ]

              const undoWith = (list: Edit[]) =>
                Effect.gen(function* () {
                  yield* resetTree(dir, input.base)
                  const sessionID = (yield* sessions.create({})).id
                  const messageID = (yield* agentTurn(sessionID, dir, list)).user
                  yield* revert.revert({ sessionID, messageID })
                  return yield* readTree(dir)
                })

              const afterSmall = yield* undoWith(small)
              const afterLarge = yield* undoWith(large)
              expect(pick(afterLarge, smallFiles)).toEqual(pick(afterSmall, smallFiles))
              expect(afterLarge).toEqual(base)
            }),
          [
            // Delete + identical create was detected as a rename, so the patch only listed b.ts and undo never
            // brought a.ts back.
            {
              base: { "a.ts": empty },
              agent: [
                { kind: "delete", file: "a.ts" },
                { kind: "write", file: "b.ts", data: empty },
              ],
              extra: [{ kind: "write", file: "a.ts", data: empty }],
              bulk: 0,
            },
          ],
        ),
      { git: true },
    ),
    TIMEOUT,
  )

  // R5 (revised in P4): After /undo, opencode shows the user the complete list
  // of files the undo changed — every file it reverted is listed, and no file
  // it did not change is — so a large undo can be reviewed and redone.
  // Kind: invariant — for every generated message, the file list the TUI
  // derives from the session's revert diff equals the set of files whose bytes
  // actually changed on disk.
  it.live(
    "R5: undo reports exactly the files it changed",
    provideTmpdirInstance(
      (dir) =>
        property(
          // earlier: a turn before the undone one. The summary must count only the undone message's files, not the
          // whole session's (Stryker: computing the diff from the first message survived).
          fc.record({ base: project, earlier: fc.array(edit, { maxLength: 4 }), agent: edits, bulk }),
          (input) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const revert = yield* SessionRevert.Service
              const storage = yield* Storage.Service
              yield* resetTree(dir, input.base)
              const sessionID = (yield* sessions.create({})).id
              yield* agentTurn(sessionID, dir, input.earlier)
              const messageID = (yield* agentTurn(sessionID, dir, [...input.agent, ...bulkFiles(input.bulk)])).user
              const beforeUndo = yield* readTree(dir)
              const info = yield* revert.revert({ sessionID, messageID })
              const afterUndo = yield* readTree(dir)
              const listed = getRevertDiffFiles(info.revert?.diff ?? "")
                .map((item) => item.filename)
                .toSorted()
              expect(listed).toEqual(changed(beforeUndo, afterUndo))
              // The session summary's file count is what the user sees next to the undo, so it must agree with the
              // list too, including files with no line changes (empty or binary) (mutant H5).
              expect(info.summary?.files).toBe(listed.length)
              // The session's diff view reads the same diffs back from storage.
              const stored = yield* storage.read<unknown[]>(["session_diff", sessionID])
              expect(stored.length).toBe(listed.length)
            }),
          // An empty new file has no ---/+++ lines in git's diff, so the TUI's parser dropped it from the list.
          [{ base: {}, earlier: [], agent: [{ kind: "write", file: "a.ts", data: empty }], bulk: 1 }],
        ),
      { git: true },
    ),
    TIMEOUT,
  )

  // R6 (added in P5): /undo removes from the conversation exactly what it
  // undid. Earlier messages stay, and an undo from inside a reply keeps the
  // part of the reply before that point.
  // Kind: model / oracle — the expected conversation after undo is computed
  // from the message and part IDs before undo; every input is checked in all
  // three ways an undo can be targeted.
  it.live(
    "R6: undo removes exactly the undone messages and parts from the conversation",
    provideTmpdirInstance(
      (dir) =>
        property(
          fc.record({
            base: project,
            earlier: fc.array(edit, { maxLength: 3 }),
            agent: edits,
            lead: fc.constantFrom("text" as const, "tool" as const),
          }),
          (input) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const revert = yield* SessionRevert.Service
              const conversation = (sessionID: SessionID) =>
                sessions
                  .messages({ sessionID })
                  .pipe(Effect.map((all) => all.map((msg) => [msg.info.id, msg.parts.map((part) => part.id)] as const)))

              const modes = ["whole", "first-part", "step-start"] as const
              for (const mode of modes) {
                yield* resetTree(dir, input.base)
                const sessionID = (yield* sessions.create({})).id
                yield* agentTurn(sessionID, dir, input.earlier)
                const turn = yield* agentTurn(sessionID, dir, input.agent, input.lead)
                const before = yield* conversation(sessionID)
                const userIndex = before.findIndex(([id]) => id === turn.user)
                // Undoing the whole message, or from the first part of the reply (nothing before it is kept), removes
                // the user message and everything after it. Undoing from the step-start keeps the user message and
                // the reply's lead part.
                const expected =
                  mode === "step-start"
                    ? before.map(([id, parts]) =>
                        id === turn.assistant
                          ? ([id, parts.slice(0, parts.indexOf(turn.stepStart))] as const)
                          : ([id, parts] as const),
                      )
                    : before.slice(0, userIndex)
                const target =
                  mode === "whole"
                    ? { sessionID, messageID: turn.user }
                    : {
                        sessionID,
                        messageID: turn.assistant,
                        partID: mode === "first-part" ? turn.lead : turn.stepStart,
                      }
                const info = yield* revert.revert(target)
                yield* revert.cleanup(info)
                expect({ mode, conversation: yield* conversation(sessionID) }).toEqual({ mode, conversation: expected })
              }
            }),
        ),
      { git: true },
    ),
    TIMEOUT,
  )
})
