export * as MemoryContext from "./memory-context"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { Memory } from "./memory"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"

const key = SystemContext.Key.make("core/memory")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const registry = yield* SystemContextRegistry.Service

    const source = (value: ReadonlyArray<Memory.Info> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Schema.Array(Memory.Info)),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These memories replace everything previously remembered about this user.\n\n${render(current)}`,
        removed: () => "Previously remembered notes about this user no longer apply.",
      })

    yield* registry.register({
      key,
      // No memories removes the source outright, so deleting the last one emits the
      // removal text rather than an empty list. A failed observation is Unavailable,
      // never empty, so a transient read failure cannot masquerade as deletion.
      load: memory.observe().pipe(
        Effect.map((memories) => (memories.length === 0 ? SystemContext.empty : source(memories))),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "memory-context",
  layer,
  deps: [Memory.node, SystemContextRegistry.node],
})

// The id gives the model a handle on each memory, so it can recognize one that is
// already recorded instead of writing a near duplicate.
function render(memories: ReadonlyArray<Memory.Info>) {
  return [
    "Here is what you have been asked to remember about this user:",
    ...memories.map((item) => `- [${item.id}] ${item.text}`),
  ].join("\n")
}
