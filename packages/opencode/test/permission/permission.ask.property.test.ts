import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { test, expect } from "bun:test"
import { Cause, Effect, Fiber, Layer, Exit } from "effect"
import fc from "fast-check"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

fc.configureGlobal({ seed: 42 })

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected permission effect to fail")
  })

// R1: evaluate() returning deny isn't enough on its own — ask() has to
// actually reject for any pattern a deny rule matches, not only the literal
// "*" wildcard. My original R1 property only ever called evaluate(), never
// ask() itself, so a bug that only breaks ask()'s own deny check (H4)
// slipped through every one of my existing properties.
// Kind: invariant
it.instance(
  "R1: ask() rejects with DeniedError for any pattern a deny rule matches, not only '*'",
  () =>
    Effect.gen(function* () {
      for (const command of fc.sample(fc.string({ minLength: 1, maxLength: 20 }), 20)) {
        const err = yield* fail(
          ask({
            sessionID: SessionID.make("session_test"),
            permission: "bash",
            patterns: [command],
            metadata: {},
            always: [],
            ruleset: [{ permission: "bash", pattern: command, action: "deny" }],
          }).pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.fail(new Error("ask() never resolved (expected an immediate DeniedError)")),
            }),
          ),
        )
        expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      }
    }),
  { git: true },
)

// R5 (additional): reply()'s "always" grant stores the exact pattern from the
// request, not a broadened command family. My original R5 property never
// calls the real reply() — it builds grant objects itself and calls merge()
// directly, so it can't see a bug inside reply()'s own implementation.
// Credit: tiffany4's red-team mutant 2 (storing
// `pattern.split(" ")[0] + " *"` instead of the real pattern).
// Kind: invariant
it.instance(
  "R5: reply('always') grants the exact pattern, not a broadened command family",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_rt2"),
        sessionID: SessionID.make("session_rt2"),
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: ["git status"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_rt2"), reply: "always" })
      yield* Fiber.join(fiber)

      // "git push origin main" was never in the always list, only "git status" was.
      // A deny rule for it should still block, not get swallowed by a broadened grant.
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_rt2b"),
          permission: "bash",
          patterns: ["git push origin main"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "git push origin main", action: "deny" }],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)