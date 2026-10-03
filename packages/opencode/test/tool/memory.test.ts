import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Memory } from "@opencode-ai/core/memory"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MemoryTool } from "@/tool/memory"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { it } from "../lib/effect"

type MemorySettings = { enabled?: boolean; scope?: "global" | "project"; max_entries?: number }

// Memories live under core's Global config directory. Each test points it inside its
// own temporary project so tests never see one another's memories.
const memoryConfig = InstanceState.context.pipe(Effect.map((ctx) => path.join(ctx.directory, ".memory-config")))

const toolLayer = (config: string, memory?: MemorySettings) =>
  LayerNode.compile(LayerNode.group([Memory.node, Config.node, Truncate.node, Agent.node]), [
    [Global.node, Global.layerWith({ config })],
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ memory }) })],
  ])

// Stands in for the permission prompt by approving every request and keeping it, so
// these tests cover what the tool does and asks for. Answering a real prompt is
// covered against the legacy permission service separately.
const approving = () => {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_memory_tool"),
    messageID: MessageID.make("msg_memory_tool"),
    callID: "call-memory",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) => Effect.sync(() => void requests.push(req)),
  }
  return { requests, ctx }
}

const remember = (text: string, ctx: Tool.Context) =>
  Effect.gen(function* () {
    const tool = yield* Tool.init(yield* MemoryTool)
    return yield* tool.execute({ text }, ctx)
  })

const recorded = Memory.Service.pipe(Effect.flatMap((memory) => memory.list()))

describe("tool.memory", () => {
  it.instance("records a global memory and tells the model what it recorded", () =>
    Effect.gen(function* () {
      const permission = approving()
      yield* Effect.gen(function* () {
        const result = yield* remember("prefers hints over full answers", permission.ctx)
        const memories = yield* recorded
        expect(memories).toMatchObject([{ text: "prefers hints over full answers", scope: "global" }])
        expect(memories[0].project_id).toBeUndefined()
        // The same output text as the v2 tool.
        expect(result.output).toBe(`Remembered [${memories[0].id}]: prefers hints over full answers`)
      }).pipe(Effect.provide(toolLayer(yield* memoryConfig)))

      // The approval request carries the text, so the prompt can show what will be kept.
      expect(permission.requests).toEqual([
        {
          permission: "memory",
          patterns: ["prefers hints over full answers"],
          always: ["*"],
          metadata: { text: "prefers hints over full answers", scope: "global" },
        },
      ])
    }),
  )

  it.instance(
    "records a project memory when configured for project scope inside a git project",
    () =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const permission = approving()
        yield* Effect.gen(function* () {
          yield* remember("is preparing for the dynamic programming midterm", permission.ctx)
          expect(yield* recorded).toMatchObject([{ scope: "project", project_id: ctx.project.id }])
        }).pipe(Effect.provide(toolLayer(yield* memoryConfig, { scope: "project" })))
        expect(ctx.project.id).not.toBe(ProjectID.global)
        expect(permission.requests).toMatchObject([{ metadata: { scope: "project" } }])
      }),
    { git: true },
  )

  it.instance("records a global memory outside a git repository even when configured for project scope", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const permission = approving()
      yield* Effect.gen(function* () {
        yield* remember("keeps notes in a plain folder", permission.ctx)
        const memories = yield* recorded
        expect(memories).toMatchObject([{ scope: "global" }])
        expect(memories[0].project_id).toBeUndefined()
      }).pipe(Effect.provide(toolLayer(yield* memoryConfig, { scope: "project" })))
      // Outside git the instance resolves to the shared global project.
      expect(ctx.project.id).toBe(ProjectID.global)
      expect(permission.requests).toMatchObject([{ metadata: { scope: "global" } }])
    }),
  )

  it.instance("applies the configured cap and tells the model which memory to delete", () =>
    Effect.gen(function* () {
      const permission = approving()
      yield* Effect.gen(function* () {
        yield* remember("keeps a paper notebook", permission.ctx)
        const [first] = yield* recorded

        const exit = yield* remember("reviews with flashcards", permission.ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain(first.id)
        expect(message).toContain("maximum of 1")
        expect(yield* recorded).toHaveLength(1)
      }).pipe(Effect.provide(toolLayer(yield* memoryConfig, { max_entries: 1 })))
    }),
  )

  it.instance("rejects empty text before asking the user or writing anything", () =>
    Effect.gen(function* () {
      const permission = approving()
      yield* Effect.gen(function* () {
        expect(Exit.isFailure(yield* remember("", permission.ctx).pipe(Effect.exit))).toBe(true)
        expect(yield* recorded).toEqual([])
      }).pipe(Effect.provide(toolLayer(yield* memoryConfig)))
      expect(permission.requests).toEqual([])
    }),
  )
})

// The registry reads settings when the instance starts, so it is built here with the
// settings under test, mirroring how registry.test.ts builds it.
const registryLayer = (memory?: MemorySettings) =>
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [
      Config.node,
      TestConfig.layer({
        get: () => Effect.succeed({ memory }),
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ])

const offered = (memory?: MemorySettings) =>
  ToolRegistry.Service.pipe(
    Effect.flatMap((registry) => registry.ids()),
    Effect.provide(registryLayer(memory)),
  )

describe("tool.registry memory", () => {
  it.instance("offers the memory tool by default", () =>
    Effect.gen(function* () {
      expect(yield* offered()).toContain("memory")
    }),
  )

  it.instance("does not offer the memory tool when memory is turned off", () =>
    Effect.gen(function* () {
      expect(yield* offered({ enabled: false })).not.toContain("memory")
    }),
  )
})
