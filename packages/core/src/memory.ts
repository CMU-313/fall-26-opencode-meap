export * as Memory from "./memory"

import path from "path"
import matter from "gray-matter"
import { Context, Effect, Layer, Schema } from "effect"
import { Memory } from "@opencode-ai/schema/memory"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { ConfigMarkdown } from "./config/markdown"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"

export const ID = Memory.ID
export type ID = typeof ID.Type

export const Scope = Memory.Scope
export type Scope = typeof Scope.Type

export const Info = Memory.Info
export type Info = typeof Info.Type

export interface WriteInput {
  readonly text: string
  readonly scope: Scope
  readonly project_id?: typeof ProjectID.Type
}

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<Info>>
  readonly write: (input: WriteInput) => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Memory") {}

const decode = Schema.decodeUnknownOption(Info)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    // A subdirectory keeps memories from mixing with AGENTS.md and opencode.json,
    // which already live at the root of the config directory.
    const directory = path.join(global.config, "memory")

    const read = Effect.fn("Memory.read")(function* (file: string) {
      const content = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!content) return undefined
      const markdown = ConfigMarkdown.parseOption(content)
      if (!markdown) return undefined
      return decode({ ...markdown.data, text: markdown.content.trim() }).valueOrUndefined
    })

    return Service.of({
      write: Effect.fn("Memory.write")(function* (input: WriteInput) {
        const info = Info.make({
          id: ID.create(),
          text: input.text,
          scope: input.scope,
          ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
          created: new Date().toISOString(),
        })
        yield* fs.writeWithDirs(path.join(directory, `${info.id}.md`), serialize(info)).pipe(Effect.orDie)
        return info
      }),
      list: Effect.fn("Memory.list")(function* () {
        const files = yield* fs
          .glob("*.md", { cwd: directory, absolute: true, include: "file" })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        const loaded = yield* Effect.forEach(files.toSorted(), read, { concurrency: "unbounded" })
        return loaded.filter((item): item is Info => item !== undefined)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

function serialize(info: Info) {
  return matter.stringify(info.text, {
    id: info.id,
    scope: info.scope,
    ...(info.project_id === undefined ? {} : { project_id: info.project_id }),
    created: info.created,
  })
}
