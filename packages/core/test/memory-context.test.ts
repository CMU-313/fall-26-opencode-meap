import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Memory } from "@opencode-ai/core/memory"
import { MemoryContext } from "@opencode-ai/core/memory-context"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const memoryLayer = (config: string) =>
  AppNodeBuilder.build(LayerNode.group([Memory.node]), [[Global.node, Global.layerWith({ config })]])

// The location fixture pins every project to Project.ID.global, so a session in a
// distinct project overrides it.
const session = (directory: string, projectID = ProjectID.global) =>
  Layer.succeed(
    Location.Service,
    Location.Service.of({
      ...location({ directory: AbsolutePath.make(directory) }),
      project: { id: projectID, directory: AbsolutePath.make(directory) },
    }),
  )

// Each call is an independent session over the same config directory, so it sees
// only what an earlier session durably wrote.
const sessionContext = (
  config: string,
  locationLayer = session("/repo"),
  filesystemLayer?: Layer.Layer<FSUtil.Service>,
) =>
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) => registry.load()),
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([SystemContextRegistry.node, MemoryContext.node]), [
        [Global.node, Global.layerWith({ config })],
        [Location.node, locationLayer],
        ...(filesystemLayer ? [[FSUtil.node, filesystemLayer] as const] : []),
      ]),
    ),
  )

// Overrides single filesystem operations so an unreadable memory directory can be
// observed without depending on real permissions.
const failingFilesystem = (overrides: Partial<FSUtil.Interface>) =>
  Layer.effect(
    FSUtil.Service,
    FSUtil.Service.pipe(Effect.map((fs) => FSUtil.Service.of({ ...fs, ...overrides }))),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const unreadableDirectory = failingFilesystem({
  glob: () => Effect.fail(new FSUtil.FileSystemError({ method: "glob" })),
})

const withConfig = <A, E, R>(body: (config: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => body(path.join(tmp.path, "config"))))

describe("MemoryContext", () => {
  it.live("puts a memory written in one session into the baseline of the next", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) =>
            Effect.forEach(["prefers hints over full answers", "studies in twenty five minute blocks"], (text) =>
              memory.write({ text, scope: "global" }),
            ),
          ),
          Effect.provide(memoryLayer(config)),
        )

        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))
        expect(initialized.baseline).toBe(
          [
            "Here is what you have been asked to remember about this user:",
            `- [${written[0].id}] prefers hints over full answers`,
            `- [${written[1].id}] studies in twenty five minute blocks`,
          ].join("\n"),
        )
      }),
    ),
  )

  it.live("contributes nothing when there are no memories", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))
        // No header with an empty list beneath it, and no snapshot entry to reconcile.
        expect(initialized.baseline).toBe("")
        expect(initialized.snapshot).toEqual({})
      }),
    ),
  )

  it.live("carries a global memory into a session started from a different project directory", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "prefers hints over full answers", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )
        const expected = [
          "Here is what you have been asked to remember about this user:",
          `- [${written.id}] prefers hints over full answers`,
        ].join("\n")

        const algorithms = yield* SystemContext.initialize(
          yield* sessionContext(config, session("/courses/algorithms", ProjectID.make("prj_algorithms"))),
        )
        const systems = yield* SystemContext.initialize(
          yield* sessionContext(config, session("/courses/systems", ProjectID.make("prj_systems"))),
        )
        expect(algorithms.baseline).toBe(expected)
        expect(systems.baseline).toBe(expected)
      }),
    ),
  )

  it.live("keeps a project memory inside the project that recorded it", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const [everywhere, algorithmsOnly] = yield* Memory.Service.pipe(
          Effect.flatMap((memory) =>
            Effect.all([
              memory.write({ text: "prefers hints over full answers", scope: "global" }),
              memory.write({
                text: "is preparing for the dynamic programming midterm",
                scope: "project",
                project_id: ProjectID.make("prj_algorithms"),
              }),
            ]),
          ),
          Effect.provide(memoryLayer(config)),
        )

        const algorithms = yield* SystemContext.initialize(
          yield* sessionContext(config, session("/courses/algorithms", ProjectID.make("prj_algorithms"))),
        )
        expect(algorithms.baseline).toBe(
          [
            "Here is what you have been asked to remember about this user:",
            `- [${everywhere.id}] prefers hints over full answers`,
            `- [${algorithmsOnly.id}] is preparing for the dynamic programming midterm`,
          ].join("\n"),
        )

        const systems = yield* SystemContext.initialize(
          yield* sessionContext(config, session("/courses/systems", ProjectID.make("prj_systems"))),
        )
        expect(systems.baseline).toBe(
          [
            "Here is what you have been asked to remember about this user:",
            `- [${everywhere.id}] prefers hints over full answers`,
          ].join("\n"),
        )
      }),
    ),
  )

  it.live("contributes nothing to a project whose only memories belong elsewhere", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        yield* Memory.Service.pipe(
          Effect.flatMap((memory) =>
            memory.write({
              text: "uses latex for problem sets",
              scope: "project",
              project_id: ProjectID.make("prj_a"),
            }),
          ),
          Effect.provide(memoryLayer(config)),
        )

        const other = yield* SystemContext.initialize(
          yield* sessionContext(config, session("/courses/other", ProjectID.make("prj_b"))),
        )
        expect(other.baseline).toBe("")
      }),
    ),
  )

  it.live("emits no mid-conversation system message when no memory has changed", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        // A project memory alongside a global one, so both branded ids have to survive
        // the snapshot's JSON round trip. A decode failure would make reconcile rebuild
        // the baseline rather than report no change.
        yield* Memory.Service.pipe(
          Effect.flatMap((memory) =>
            Effect.all([
              memory.write({ text: "prefers hints over full answers", scope: "global" }),
              memory.write({
                text: "is preparing for the dynamic programming midterm",
                scope: "project",
                project_id: ProjectID.make("prj_algorithms"),
              }),
            ]),
          ),
          Effect.provide(memoryLayer(config)),
        )
        const algorithms = session("/courses/algorithms", ProjectID.make("prj_algorithms"))

        const initialized = yield* SystemContext.initialize(yield* sessionContext(config, algorithms))
        expect(yield* SystemContext.reconcile(yield* sessionContext(config, algorithms), initialized.snapshot)).toEqual(
          {
            _tag: "Unchanged",
          },
        )
      }),
    ),
  )

  it.live("emits a mid-conversation system message when a memory is edited, not a rebuilt baseline", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "studies late at night", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )
        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))

        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.update(written.id, { text: "studies early in the morning" })),
          Effect.provide(memoryLayer(config)),
        )
        const reconciled = yield* SystemContext.reconcile(yield* sessionContext(config), initialized.snapshot)
        expect(reconciled).toEqual({
          _tag: "Updated",
          text: [
            "These memories replace everything previously remembered about this user.",
            "",
            "Here is what you have been asked to remember about this user:",
            `- [${written.id}] studies early in the morning`,
          ].join("\n"),
          snapshot: expect.any(Object),
        })

        // The following turn compares against the advanced snapshot and has nothing new to say.
        if (reconciled._tag !== "Updated") return
        expect(yield* SystemContext.reconcile(yield* sessionContext(config), reconciled.snapshot)).toEqual({
          _tag: "Unchanged",
        })
      }),
    ),
  )

  it.live("emits a mid-conversation system message for the first memory in a session that started with none", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))
        expect(initialized.baseline).toBe("")

        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "prefers hints over full answers", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )
        // With nothing previously admitted there is nothing to replace, so the message
        // is the plain list rather than the replacement preamble.
        expect(yield* SystemContext.reconcile(yield* sessionContext(config), initialized.snapshot)).toEqual({
          _tag: "Updated",
          text: [
            "Here is what you have been asked to remember about this user:",
            `- [${written.id}] prefers hints over full answers`,
          ].join("\n"),
          snapshot: expect.any(Object),
        })
      }),
    ),
  )

  it.live("emits the remaining memories as a mid-conversation system message when one of several is deleted", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) =>
            Effect.forEach(["keeps a paper notebook", "reviews with flashcards"], (text) =>
              memory.write({ text, scope: "global" }),
            ),
          ),
          Effect.provide(memoryLayer(config)),
        )
        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))

        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.remove(written[0].id)),
          Effect.provide(memoryLayer(config)),
        )
        // Some memories remain, so this is a replacement list, not the removal text.
        expect(yield* SystemContext.reconcile(yield* sessionContext(config), initialized.snapshot)).toEqual({
          _tag: "Updated",
          text: [
            "These memories replace everything previously remembered about this user.",
            "",
            "Here is what you have been asked to remember about this user:",
            `- [${written[1].id}] reviews with flashcards`,
          ].join("\n"),
          snapshot: expect.any(Object),
        })
      }),
    ),
  )

  it.live("emits the removal text as a mid-conversation system message when the last memory is deleted", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "prefers hints over full answers", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )
        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))

        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.remove(written.id)),
          Effect.provide(memoryLayer(config)),
        )
        expect(yield* SystemContext.reconcile(yield* sessionContext(config), initialized.snapshot)).toEqual({
          _tag: "Updated",
          text: "Previously remembered notes about this user no longer apply.",
          snapshot: {},
        })
      }),
    ),
  )

  it.live("keeps admitted memories while the memory directory cannot be read", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "prefers hints over full answers", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )
        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))

        // Were the failure read as an empty directory, this would be the removal text.
        expect(
          yield* SystemContext.reconcile(
            yield* sessionContext(config, session("/repo"), unreadableDirectory),
            initialized.snapshot,
          ),
        ).toEqual({ _tag: "Unchanged" })
      }),
    ),
  )

  it.live("keeps admitted memories while a listed memory file cannot be read", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "prefers hints over full answers", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )
        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))

        const unreadableFile = failingFilesystem({ readFileStringSafe: () => Effect.succeed(undefined) })
        expect(
          yield* SystemContext.reconcile(
            yield* sessionContext(config, session("/repo"), unreadableFile),
            initialized.snapshot,
          ),
        ).toEqual({ _tag: "Unchanged" })
      }),
    ),
  )

  it.live("picks up changes made during an outage once the directory is readable again", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "studies late at night", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )
        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))
        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.update(written.id, { text: "studies early in the morning" })),
          Effect.provide(memoryLayer(config)),
        )

        expect(
          yield* SystemContext.reconcile(
            yield* sessionContext(config, session("/repo"), unreadableDirectory),
            initialized.snapshot,
          ),
        ).toEqual({ _tag: "Unchanged" })

        // The outage left the admitted state untouched, so recovery sees exactly one
        // change against it rather than a removal followed by a re-add.
        expect(yield* SystemContext.reconcile(yield* sessionContext(config), initialized.snapshot)).toEqual({
          _tag: "Updated",
          text: [
            "These memories replace everything previously remembered about this user.",
            "",
            "Here is what you have been asked to remember about this user:",
            `- [${written.id}] studies early in the morning`,
          ].join("\n"),
          snapshot: expect.any(Object),
        })
      }),
    ),
  )

  it.live("adds nothing mid-session when memories were never admitted and cannot be read", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const initialized = yield* SystemContext.initialize(yield* sessionContext(config))
        expect(initialized.snapshot).toEqual({})

        // Unavailable context is omitted until it first loads successfully.
        expect(
          yield* SystemContext.reconcile(
            yield* sessionContext(config, session("/repo"), unreadableDirectory),
            initialized.snapshot,
          ),
        ).toEqual({ _tag: "Unchanged" })
      }),
    ),
  )

  it.live("blocks session start as a typed failure rather than crashing or starting without memories", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        // Deliberately strict: a baseline is never built while memories cannot be
        // read, so a session cannot quietly begin without what it was told to keep.
        const error = yield* SystemContext.initialize(
          yield* sessionContext(config, session("/repo"), unreadableDirectory),
        ).pipe(Effect.flip)
        expect(error).toBeInstanceOf(SystemContext.InitializationBlocked)
        expect(error.keys).toEqual([SystemContext.Key.make("core/memory")])
      }),
    ),
  )
})
