import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { test, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
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