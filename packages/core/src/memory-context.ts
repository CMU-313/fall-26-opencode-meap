export * as MemoryContext from "./memory-context"

import { Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import { Memory } from "./memory"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"

const key = SystemContext.Key.make("core/memory")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const memory = yield* Memory.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service

    // Configuration is read once when the location opens. Turning memory off registers no
    // source at all, so memories are never read, and an unreadable memory directory
    // cannot hold up session start either.
    if (Config.latest(yield* config.entries(), "memory")?.enabled === false) return

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
        // Global memories follow the user into every project; a project memory stays
        // with the project that recorded it.
        Effect.map((memories) =>
          memories.filter((item) => item.scope === "global" || item.project_id === location.project.id),
        ),
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
  deps: [Config.node, Memory.node, Location.node, SystemContextRegistry.node],
})

// The id gives the model a handle on each memory, so it can recognize one that is
// already recorded instead of writing a near duplicate.
function render(memories: ReadonlyArray<Memory.Info>) {
  return [
    "Here is what you have been asked to remember about this user:",
    ...memories.map((item) => `- [${item.id}] ${item.text}`),
  ].join("\n")
}
