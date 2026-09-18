export * as Memory from "./memory"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { ProjectID } from "./project-id"
import { statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("mem")).pipe(
  Schema.brand("Memory.ID"),
  statics((schema) => ({
    // Ascending so the lexical order of the stored files is also the order the
    // memories were recorded in.
    create: () => schema.make("mem_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export const Scope = Schema.Literals(["global", "project"]).annotate({
  description: "Whether the memory applies everywhere or only to the project that recorded it",
})
export type Scope = typeof Scope.Type

export const Info = Schema.Struct({
  id: ID,
  text: Schema.String.annotate({ description: "The remembered fact, stated in one or two sentences" }),
  scope: Scope,
  project_id: ProjectID.pipe(Schema.optional).annotate({
    description: "Project the memory belongs to, present only for project scoped memories",
  }),
  created: Schema.String.annotate({ description: "ISO-8601 timestamp of when the memory was recorded" }),
}).annotate({ identifier: "Memory" })
export type Info = typeof Info.Type
