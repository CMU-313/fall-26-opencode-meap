import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Memory } from "@opencode-ai/core/memory"
import { MemoryContext } from "@opencode-ai/core/memory-context"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const memoryLayer = (config: string) =>
  AppNodeBuilder.build(LayerNode.group([Memory.node]), [[Global.node, Global.layerWith({ config })]])

// Each call is an independent session over the same config directory, so it sees
// only what an earlier session durably wrote.
const sessionContext = (config: string) =>
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) => registry.load()),
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([SystemContextRegistry.node, MemoryContext.node]), [
        [Global.node, Global.layerWith({ config })],
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
})
