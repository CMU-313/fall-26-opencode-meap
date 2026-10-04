import { Effect } from "effect"
import { generateText } from "ai"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { Provider } from "@/provider/provider"
import { Git, type Commit } from "@/git"

const resolveLanguage = Effect.fn("Cli.catchup.resolveLanguage")(function* () {
  const provider = yield* Provider.Service
  const model = yield* provider.defaultModel()
  const resolved = yield* provider.getModel(model.providerID, model.modelID)
  return yield* provider.getLanguage(resolved)
})

export const CatchupCommand = effectCmd({
  command: "catchup",
  describe: "generate a plain-language summary of recent commits",
  builder: (yargs) =>
    yargs.option("count", {
      describe: "number of recent commits to summarize (default: 5)",
      type: "number",
      default: 5,
    }),
  handler: Effect.fn("Cli.catchup")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return

    const git = yield* Git.Service
    const commits = yield* git.log(ctx.project.worktree, args.count)

    if (commits.length === 0) {
      console.log("No commit history found. Make sure you're inside a git repository with at least one commit.")
      return
    }

    const language = yield* resolveLanguage().pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          console.log(
            "Could not resolve a model provider for catchup. Make sure opencode is authenticated with a provider (same setup needed for `opencode run`).",
          )
          return undefined
        }),
      ),
    )

    if (!language) return

    const prompt = buildPrompt(commits)

    const summary = yield* Effect.promise(() =>
      generateText({
        model: language,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "You summarize recent git commit history in plain, non-technical language for a developer catching up after time away. Group related changes together, mention what actually changed in the code (not just repeating commit messages), and keep it concise.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }).then((r) => r.text),
    )

    console.log(summary)
  }),
})

export function buildPrompt(commits: readonly Commit[]): string {
  const blocks = commits.map((commit) => {
    const files = commit.files.length
      ? commit.files.map((f) => `    ${f.file} (+${f.additions}/-${f.deletions})`).join("\n")
      : "    (no file changes recorded)"
    return [
      `Commit ${commit.hash.slice(0, 7)} by ${commit.author} on ${commit.date}:`,
      `  Message: ${commit.message}`,
      `  Files changed:`,
      files,
    ].join("\n")
  })
  return `Here is the recent commit history, most recent first:\n\n${blocks.join("\n\n")}\n\nSummarize what has changed in plain language.`
}