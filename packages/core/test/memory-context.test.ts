import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
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
const sessionContext = (config: string, locationLayer = session("/repo")) =>
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) => registry.load()),
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([SystemContextRegistry.node, MemoryContext.node]), [
        [Global.node, Global.layerWith({ config })],
        [Location.node, locationLayer],
      ]),
    ),
  )

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
})
