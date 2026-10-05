import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Policy } from "@opencode-ai/core/policy"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const configLayer = (directory: string) =>
  AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ],
    [Global.node, Global.layerWith({ config: path.join(directory, "global") })],
  ])

// Both engines read opencode.json: the current one through Config.Info, the legacy one
// (which the TUI runs on) through ConfigV1.Info. The section has to be valid in each.
const schemas: ReadonlyArray<readonly [string, Schema.Decoder<{ readonly memory?: unknown }, never>]> = [
  ["Config.Info", Config.Info],
  ["ConfigV1.Info", ConfigV1.Info],
]

const decodeFailure = (schema: Schema.Decoder<unknown, never>, input: unknown) => {
  const exit = Schema.decodeUnknownExit(schema)(input)
  return Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : undefined
}

describe("memory configuration", () => {
  for (const [name, schema] of schemas) {
    it.effect(`accepts a memory section in ${name}`, () =>
      Effect.sync(() => {
        const input = { memory: { enabled: false, scope: "project", max_entries: 20 } }
        expect(decodeFailure(schema, input)).toBeUndefined()
        expect(Schema.decodeUnknownSync(schema)(input).memory).toMatchObject(input.memory)
      }),
    )

    it.effect(`rejects a max_entries that is not a positive whole number in ${name}, naming the key`, () =>
      Effect.sync(() => {
        for (const max_entries of [0, -3, 2.5, "ten"]) {
          const failure = decodeFailure(schema, { memory: { max_entries } })
          expect(failure).toBeDefined()
          expect(failure).toContain("max_entries")
        }
      }),
    )
  }

  it.live("keeps the memory section when an older-format settings file is converted", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          // `permission` marks this as an older-format file, so it is converted on load.
          // Most real settings files carry at least one such key.
          const file = { permission: { bash: "ask" }, memory: { enabled: false, scope: "project", max_entries: 20 } }
          expect(ConfigMigrateV1.isV1(file)).toBe(true)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify(file)))

          const entries = yield* Config.Service.pipe(
            Effect.flatMap((config) => config.entries()),
            Effect.provide(configLayer(tmp.path)),
          )
          expect(Config.latest(entries, "memory")).toMatchObject(file.memory)
        }),
      ),
    ),
  )
})
