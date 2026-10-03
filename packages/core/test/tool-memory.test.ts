import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Memory } from "@opencode-ai/core/memory"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { MemoryTool } from "@opencode-ai/core/tool/memory"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)

// Stands in for the permission service by approving every request and keeping it, so
// these tests cover what the tool does and asks for. The real approval prompt, and
// answering it, are covered separately against the real permission service.
const approving = () => {
  const requests: PermissionV2.AssertInput[] = []
  const layer = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: (input) => Effect.sync(() => void requests.push(input)),
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )
  return { requests, layer }
}

// Settings are read when the location opens, so each test builds its own tools over
// its own settings file and project.
const toolLayer = (input: { root: string; permission: Layer.Layer<PermissionV2.Service>; projectID?: ProjectID }) => {
  const directory = AbsolutePath.make(path.join(input.root, "project"))
  return AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, MemoryTool.node, Memory.node]),
    [
      [Global.node, Global.layerWith({ config: path.join(input.root, "config") })],
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            ...location({ directory }),
            project: { id: input.projectID ?? ProjectID.global, directory },
          }),
        ),
      ],
      [PermissionV2.node, input.permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )
}

const withRoot = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => body(tmp.path)))

// Writes the user-global settings file, where a student would configure memory.
const configure = (root: string, memory: object) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(root, "config"), { recursive: true })
    await fs.writeFile(path.join(root, "config", "opencode.json"), JSON.stringify({ memory }))
  })

const call = (text: string) => ({
  sessionID: SessionV2.ID.make("ses_memory_tool_test"),
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-memory", name: MemoryTool.name, input: { text } },
})

const remember = (text: string) =>
  ToolRegistry.Service.pipe(Effect.flatMap((registry) => executeTool(registry, call(text))))

const recorded = Memory.Service.pipe(Effect.flatMap((memory) => memory.list()))

describe("MemoryTool", () => {
  it.live("is offered by default and not at all when memory is turned off", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const offered = (permission: Layer.Layer<PermissionV2.Service>) =>
          ToolRegistry.Service.pipe(
            Effect.flatMap((registry) => toolDefinitions(registry)),
            Effect.map((definitions) => definitions.map((tool) => tool.name)),
            Effect.provide(toolLayer({ root, permission })),
          )

        expect(yield* offered(approving().layer)).toEqual([MemoryTool.name])
        yield* configure(root, { enabled: false })
        expect(yield* offered(approving().layer)).toEqual([])
      }),
    ),
  )

  it.live("records a global memory and tells the model what it recorded", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const permission = approving()
        const result = yield* remember("prefers hints over full answers").pipe(
          Effect.provide(toolLayer({ root, permission: permission.layer })),
        )

        const memories = yield* recorded.pipe(Effect.provide(toolLayer({ root, permission: permission.layer })))
        expect(memories).toMatchObject([{ text: "prefers hints over full answers", scope: "global" }])
        expect(memories[0].project_id).toBeUndefined()
        expect(result).toEqual({
          type: "text",
          value: `Remembered [${memories[0].id}]: prefers hints over full answers`,
        })
        // The approval request shows the student exactly what will be kept, and where.
        expect(permission.requests).toMatchObject([
          {
            action: "memory",
            resources: ["prefers hints over full answers"],
            save: ["*"],
            metadata: { scope: "global" },
          },
        ])
      }),
    ),
  )

  it.live("records a project memory when configured for project scope inside a git project", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        yield* configure(root, { scope: "project" })
        const permission = approving()
        const layer = toolLayer({ root, permission: permission.layer, projectID: ProjectID.make("prj_algorithms") })

        yield* remember("is preparing for the dynamic programming midterm").pipe(Effect.provide(layer))
        expect(yield* recorded.pipe(Effect.provide(layer))).toMatchObject([
          { scope: "project", project_id: ProjectID.make("prj_algorithms") },
        ])
        expect(permission.requests).toMatchObject([{ metadata: { scope: "project" } }])
      }),
    ),
  )

  it.live("records a global memory outside a git repository even when configured for project scope", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        yield* configure(root, { scope: "project" })
        const permission = approving()
        // Outside a git repository the location resolves to the shared global project.
        const layer = toolLayer({ root, permission: permission.layer, projectID: ProjectID.global })

        yield* remember("keeps notes in a plain folder").pipe(Effect.provide(layer))
        const memories = yield* recorded.pipe(Effect.provide(layer))
        expect(memories).toMatchObject([{ scope: "global" }])
        expect(memories[0].project_id).toBeUndefined()
        expect(permission.requests).toMatchObject([{ metadata: { scope: "global" } }])
      }),
    ),
  )

  it.live("applies the configured cap and tells the model which memory to delete", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        yield* configure(root, { max_entries: 1 })
        const layer = toolLayer({ root, permission: approving().layer })

        yield* remember("keeps a paper notebook").pipe(Effect.provide(layer))
        const [first] = yield* recorded.pipe(Effect.provide(layer))

        const refused = yield* remember("reviews with flashcards").pipe(Effect.provide(layer))
        expect(refused.type).toBe("error")
        expect(refused.value).toContain(first.id)
        expect(refused.value).toContain("maximum of 1")
        expect(yield* recorded.pipe(Effect.provide(layer))).toHaveLength(1)
      }),
    ),
  )

  it.live("rejects empty text before asking the user or writing anything", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const permission = approving()
        const layer = toolLayer({ root, permission: permission.layer })

        const result = yield* remember("").pipe(Effect.provide(layer))
        expect(result.type).toBe("error")
        expect(permission.requests).toEqual([])
        expect(yield* recorded.pipe(Effect.provide(layer))).toEqual([])
      }),
    ),
  )
})
