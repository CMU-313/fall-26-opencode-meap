import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { logLines } from "effect/testing/TestConsole"
import fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "../../src/effect/instance-state"
import { MCP } from "../../src/mcp"
import { SystemPrompt } from "../../src/session/system"
import { Skill } from "../../src/skill"
import { it } from "../lib/effect"

// Memories live under core's Global config directory. Each test points it inside its
// own temporary project so tests never see one another's memories.
const memoryConfig = InstanceState.context.pipe(Effect.map((ctx) => path.join(ctx.directory, ".memory-config")))

const promptLayer = (config: string, filesystem?: Layer.Layer<FSUtil.Service>) =>
  LayerNode.compile(SystemPrompt.node, [
    [MCP.node, Layer.mock(MCP.Service, { instructions: () => Effect.succeed([]) })],
    [Skill.node, Layer.mock(Skill.Service, { available: () => Effect.succeed([]) })],
    [Global.node, Global.layerWith({ config })],
    ...(filesystem ? [[FSUtil.node, filesystem] as const] : []),
  ])

const memoryPrompt = (config: string, filesystem?: Layer.Layer<FSUtil.Service>) =>
  SystemPrompt.Service.pipe(
    Effect.flatMap((prompt) => prompt.memory()),
    Effect.provide(promptLayer(config, filesystem)),
  )

// Writes a memory file the way a student would by hand.
const writeMemory = (config: string, id: string, text: string, frontmatter = "scope: global") =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(config, "memory"), { recursive: true })
    await fs.writeFile(
      path.join(config, "memory", `${id}.md`),
      `---\n${frontmatter}\ncreated: '2026-10-03T12:00:00.000Z'\n---\n${text}\n`,
    )
  })

const header = "Here is what you have been asked to remember about this user:"

describe("session.system memory", () => {
  it.instance("shows memories in the system prompt with the same text as the v2 engine", () =>
    Effect.gen(function* () {
      const config = yield* memoryConfig
      yield* writeMemory(config, "mem_0001hints", "prefers hints over full answers")
      yield* writeMemory(config, "mem_0002blocks", "studies in twenty five minute blocks")

      // Spelled out rather than built with the shared renderer, so this engine is pinned
      // to the text on its own and a drift in either engine fails a test.
      expect(yield* memoryPrompt(config)).toBe(
        [
          header,
          "- [mem_0001hints] prefers hints over full answers",
          "- [mem_0002blocks] studies in twenty five minute blocks",
        ].join("\n"),
      )
    }),
  )

  it.instance(
    "shows global memories and this project's memories, but not another project's",
    () =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const config = yield* memoryConfig
        yield* writeMemory(config, "mem_0001global", "prefers hints over full answers")
        yield* writeMemory(
          config,
          "mem_0002here",
          "is preparing for the dynamic programming midterm",
          `scope: project\nproject_id: ${ctx.project.id}`,
        )
        yield* writeMemory(
          config,
          "mem_0003elsewhere",
          "uses latex for problem sets",
          "scope: project\nproject_id: prj_elsewhere",
        )

        expect(yield* memoryPrompt(config)).toBe(
          [
            header,
            "- [mem_0001global] prefers hints over full answers",
            "- [mem_0002here] is preparing for the dynamic programming midterm",
          ].join("\n"),
        )
      }),
    { git: true },
  )

  it.instance(
    "adds nothing when memory is turned off",
    () =>
      Effect.gen(function* () {
        const config = yield* memoryConfig
        yield* writeMemory(config, "mem_0001hints", "prefers hints over full answers")
        expect(yield* memoryPrompt(config)).toBeUndefined()
      }),
    { config: { memory: { enabled: false } } },
  )

  it.instance("adds nothing when there are no memories", () =>
    Effect.gen(function* () {
      // No header over an empty list.
      expect(yield* memoryPrompt(yield* memoryConfig)).toBeUndefined()
    }),
  )

  it.instance("leaves memories out with a warning, rather than failing, when they cannot be read", () =>
    Effect.gen(function* () {
      const config = yield* memoryConfig
      yield* writeMemory(config, "mem_0001hints", "prefers hints over full answers")
      // Fails only the read of the memory directory, so the rest of the session's
      // filesystem use is untouched.
      const unreadable = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              glob: (pattern, options) =>
                options?.cwd === path.join(config, "memory")
                  ? Effect.fail(new FSUtil.FileSystemError({ method: "glob" }))
                  : fs.glob(pattern, options),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      expect(yield* memoryPrompt(config, unreadable)).toBeUndefined()
      const logged = JSON.stringify(yield* logLines)
      expect(logged).toContain("WARN")
      expect(logged).toContain("leaving memories out of the system prompt")
    }),
  )

  it.instance("picks up a hand edit on the next step, since the prompt is rebuilt every step", () =>
    Effect.gen(function* () {
      const config = yield* memoryConfig
      yield* writeMemory(config, "mem_0001habit", "studies late at night")

      yield* Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        expect(yield* prompt.memory()).toBe([header, "- [mem_0001habit] studies late at night"].join("\n"))
        yield* writeMemory(config, "mem_0001habit", "studies early in the morning")
        expect(yield* prompt.memory()).toBe([header, "- [mem_0001habit] studies early in the morning"].join("\n"))
      }).pipe(Effect.provide(promptLayer(config)))
    }),
  )
})
