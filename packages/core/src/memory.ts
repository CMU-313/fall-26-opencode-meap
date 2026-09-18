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

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Memory.NotFoundError", {
  id: ID,
}) {
  override get message() {
    return `No memory with id ${this.id}`
  }
}

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<Info>>
  readonly write: (input: WriteInput) => Effect.Effect<Info>
  readonly update: (id: ID, input: { readonly text: string }) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: ID) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Memory") {}

const decode = Schema.decodeUnknownOption(Info)
const decodeID = Schema.decodeUnknownOption(ID)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    // A subdirectory keeps memories from mixing with AGENTS.md and opencode.json,
    // which already live at the root of the config directory.
    const directory = path.join(global.config, "memory")
    const filepath = (id: ID) => path.join(directory, `${id}.md`)

    // A memory the user broke by hand is skipped rather than failing the whole
    // read, but never silently: an unexplained disappearance is worse than noise.
    const read = Effect.fn("Memory.read")(function* (file: string) {
      // The file name carries the identity, so copying a file produces a genuinely
      // separate memory and update and remove always act on the file they named.
      const id = decodeID(path.basename(file, ".md")).valueOrUndefined
      if (!id) {
        yield* Effect.logWarning("skipping memory file whose name is not a memory id", { file })
        return undefined
      }
      const content = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!content) return undefined
      // Frontmatter parsing recovers from almost anything, dropping the fields it
      // cannot read, so a broken file fails at decoding rather than at parsing.
      const markdown = ConfigMarkdown.parseOption(content)
      const info = markdown && decode(fields(markdown, id)).valueOrUndefined
      if (!info) {
        yield* Effect.logWarning("skipping memory file that does not parse as a memory", { file })
        return undefined
      }
      return info
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
        yield* fs.writeWithDirs(filepath(info.id), serialize(info)).pipe(Effect.orDie)
        return info
      }),
      update: Effect.fn("Memory.update")(function* (id: ID, input: { readonly text: string }) {
        const existing = yield* read(filepath(id))
        if (!existing) return yield* new NotFoundError({ id })
        const info = Info.make({ ...existing, text: input.text })
        yield* fs.writeWithDirs(filepath(id), serialize(info)).pipe(Effect.orDie)
        return info
      }),
      // Existence rather than a successful parse, so a memory whose file has been
      // corrupted by hand can still be deleted.
      remove: Effect.fn("Memory.remove")(function* (id: ID) {
        if (!(yield* fs.existsSafe(filepath(id)))) return yield* new NotFoundError({ id })
        yield* fs.remove(filepath(id)).pipe(Effect.orDie)
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

// The id is deliberately absent: it lives in the file name, so there is only one
// place for it to be wrong.
function serialize(info: Info) {
  return matter.stringify(info.text, {
    scope: info.scope,
    ...(info.project_id === undefined ? {} : { project_id: info.project_id }),
    created: info.created,
  })
}

function fields(markdown: NonNullable<ReturnType<typeof ConfigMarkdown.parseOption>>, id: ID) {
  return {
    ...markdown.data,
    id,
    text: markdown.content.trim(),
    // YAML reads an unquoted timestamp as a date, so accept that too rather than
    // discarding a memory over a hand edit that dropped the quotes.
    ...(markdown.data.created instanceof Date ? { created: markdown.data.created.toISOString() } : {}),
  }
}
