import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { logLines } from "effect/testing/TestConsole"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Memory } from "@opencode-ai/core/memory"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

// Each call compiles an independent layer over the same directory, so a second
// call observes only what the first one durably wrote.
const memoryLayer = (config: string) =>
  AppNodeBuilder.build(LayerNode.group([Memory.node]), [[Global.node, Global.layerWith({ config })]])

const cappedLayer = (config: string, maxEntries: number) =>
  AppNodeBuilder.build(LayerNode.group([Memory.node]), [
    [Global.node, Global.layerWith({ config })],
    [Memory.node, Memory.nodeWith({ maxEntries })],
  ])

const withConfig = <A, E, R>(body: (config: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => body(path.join(tmp.path, "config"))))

describe("Memory", () => {
  it.live("returns every written memory when read back from a fresh layer", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const texts = [
          "prefers hints over full answers",
          "studies in twenty five minute blocks",
          "taking 15-451 this semester",
        ]

        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => Effect.forEach(texts, (text) => memory.write({ text, scope: "global" }))),
          Effect.provide(memoryLayer(config)),
        )
        expect(written.map((item) => item.text)).toEqual(texts)
        expect(written.every((item) => item.id.startsWith("mem_"))).toBe(true)

        const listed = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.list()),
          Effect.provide(memoryLayer(config)),
        )
        expect(listed.map((item) => item.text)).toEqual(texts)
        expect(listed.map((item) => item.id)).toEqual(written.map((item) => item.id))
        expect(listed.map((item) => item.scope)).toEqual(["global", "global", "global"])
        expect(listed.every((item) => !Number.isNaN(Date.parse(item.created)))).toBe(true)
      }),
    ),
  )

  it.live("writes each memory as a hand editable markdown file under the config directory", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "prefers hints over full answers", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )

        const file = path.join(config, "memory", `${written.id}.md`)
        const raw = yield* Effect.promise(() => fs.readFile(file, "utf8"))
        expect(raw.startsWith("---\n")).toBe(true)
        // The file name is the only place the identity lives, so it cannot drift
        // out of step with the frontmatter.
        expect(raw).not.toContain("\nid:")
        expect(raw).toContain("scope: global")
        expect(raw).toContain(written.created)
        // The body is the memory itself, so editing the file is editing the memory.
        expect(raw.slice(raw.indexOf("\n---\n") + 5).trim()).toBe("prefers hints over full answers")
      }),
    ),
  )

  it.live("carries project scoped memories with the project that recorded them", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) =>
            memory.write({ text: "this repo uses bun", scope: "project", project_id: ProjectID.make("prj_example") }),
          ),
          Effect.provide(memoryLayer(config)),
        )
        expect(written.scope).toBe("project")
        expect(written.project_id).toBe(ProjectID.make("prj_example"))

        const listed = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.list()),
          Effect.provide(memoryLayer(config)),
        )
        expect(listed).toEqual([written])
      }),
    ),
  )

  it.live("changes the text of a memory without disturbing its identity", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "studies late at night", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )

        const updated = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.update(written.id, { text: "studies early in the morning" })),
          Effect.provide(memoryLayer(config)),
        )
        expect(updated.text).toBe("studies early in the morning")
        expect(updated.id).toBe(written.id)
        expect(updated.created).toBe(written.created)
        expect(updated.scope).toBe(written.scope)

        const listed = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.list()),
          Effect.provide(memoryLayer(config)),
        )
        expect(listed).toEqual([updated])
      }),
    ),
  )

  it.live("removes a memory from disk so later layers no longer see it", () =>
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

        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.remove(written[0].id)),
          Effect.provide(memoryLayer(config)),
        )

        const listed = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.list()),
          Effect.provide(memoryLayer(config)),
        )
        expect(listed.map((item) => item.text)).toEqual(["reviews with flashcards"])
        expect(yield* Effect.promise(() => fs.readdir(path.join(config, "memory")))).toEqual([`${written[1].id}.md`])
      }),
    ),
  )

  it.live("reports a missing memory instead of silently succeeding", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const missing = Memory.ID.make("mem_doesnotexist")

        const updateError = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.update(missing, { text: "never recorded" })),
          Effect.provide(memoryLayer(config)),
          Effect.flip,
        )
        expect(updateError).toBeInstanceOf(Memory.NotFoundError)
        expect(updateError.id).toBe(missing)

        const removeError = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.remove(missing)),
          Effect.provide(memoryLayer(config)),
          Effect.flip,
        )
        expect(removeError).toBeInstanceOf(Memory.NotFoundError)
      }),
    ),
  )

  it.live("skips hand corrupted memory files with a warning and still loads the valid ones", () =>
    Effect.gen(function* () {
      const listed = yield* Memory.Service.pipe(
        Effect.flatMap((memory) => memory.list()),
        Effect.provide(memoryLayer(path.join(import.meta.dir, "fixtures", "memory-config"))),
      )
      expect(listed.map((item) => item.text)).toEqual(["prefers hints over full answers", "reviews with flashcards"])

      const logged = JSON.stringify(yield* logLines)
      expect(logged).toContain("WARN")
      // One file loses its fields to an unterminated quote, the other carries an
      // invalid scope. Both are named, so a vanished memory can be traced.
      expect(logged).toContain("mem_0000000000000000000broken1.md")
      expect(logged).toContain("mem_0000000000000000000broken2.md")
      expect(logged).not.toContain("mem_00000000000000000000valid1.md")
    }),
  )

  it.live("treats a memory file copied by hand as a separate memory", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "reviews with flashcards", scope: "global" })),
          Effect.provide(memoryLayer(config)),
        )
        const copy = Memory.ID.make("mem_copiedbyhand000000000001")
        yield* Effect.promise(() =>
          fs.copyFile(path.join(config, "memory", `${written.id}.md`), path.join(config, "memory", `${copy}.md`)),
        )

        const listed = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.list()),
          Effect.provide(memoryLayer(config)),
        )
        expect(listed.map((item) => item.id).toSorted()).toEqual([copy, written.id].toSorted())

        // The copy is reachable in its own right rather than shadowed by the original.
        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.remove(copy)),
          Effect.provide(memoryLayer(config)),
        )
        const remaining = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.list()),
          Effect.provide(memoryLayer(config)),
        )
        expect(remaining.map((item) => item.id)).toEqual([written.id])
      }),
    ),
  )

  it.live("keeps a memory whose timestamp was left unquoted by hand", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const id = Memory.ID.make("mem_editedbyhand000000000001")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(config, "memory"), { recursive: true })
          // YAML reads this timestamp as a date rather than a string.
          await fs.writeFile(
            path.join(config, "memory", `${id}.md`),
            "---\nscope: global\ncreated: 2026-09-18T12:00:00.000Z\n---\nprefers worked examples\n",
          )
        })

        const listed = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.list()),
          Effect.provide(memoryLayer(config)),
        )
        expect(listed.map((item) => item.text)).toEqual(["prefers worked examples"])
        expect(listed[0].id).toBe(id)
        expect(listed[0].created).toBe("2026-09-18T12:00:00.000Z")
      }),
    ),
  )

  it.live("refuses a write at the cap and names a memory to delete rather than evicting one", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const layer = cappedLayer(config, 2)
        const written = yield* Memory.Service.pipe(
          Effect.flatMap((memory) =>
            Effect.forEach(["keeps a paper notebook", "reviews with flashcards"], (text) =>
              memory.write({ text, scope: "global" }),
            ),
          ),
          Effect.provide(layer),
        )

        const error = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "one memory too many", scope: "global" })),
          Effect.provide(layer),
          Effect.flip,
        )
        expect(error).toBeInstanceOf(Memory.LimitExceededError)
        expect(error.limit).toBe(2)
        expect(error.oldest).toBe(written[0].id)
        expect(error.message).toContain(written[0].id)

        // Nothing was evicted to make room, and the refused memory was not written.
        const listed = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.list()),
          Effect.provide(layer),
        )
        expect(listed.map((item) => item.text)).toEqual(["keeps a paper notebook", "reviews with flashcards"])
        expect(yield* Effect.promise(() => fs.readdir(path.join(config, "memory")))).toHaveLength(2)
      }),
    ),
  )

  it.live("accepts a write again once room has been made", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const layer = cappedLayer(config, 1)
        const first = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "keeps a paper notebook", scope: "global" })),
          Effect.provide(layer),
        )
        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.remove(first.id)),
          Effect.provide(layer),
        )

        const second = yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "reviews with flashcards", scope: "global" })),
          Effect.provide(layer),
        )
        expect(second.text).toBe("reviews with flashcards")
      }),
    ),
  )
})
