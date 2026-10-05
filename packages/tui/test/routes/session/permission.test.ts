import { describe, expect, test } from "bun:test"
import { memoryPrompt } from "../../../src/routes/session/permission"

describe("memory approval prompt", () => {
  test("shows the exact text the model wants to remember", () => {
    expect(
      memoryPrompt({
        patterns: ["prefers hints over full answers"],
        metadata: { text: "prefers hints over full answers", scope: "global" },
      }).title,
    ).toBe('Remember "prefers hints over full answers"')
  })

  test("says a global memory is kept across every project", () => {
    expect(
      memoryPrompt({
        patterns: ["reviews with flashcards"],
        metadata: { text: "reviews with flashcards", scope: "global" },
      }).detail,
    ).toBe("Kept across all your projects and future conversations")
  })

  test("says a project memory is kept for this project only", () => {
    expect(
      memoryPrompt({
        patterns: ["is preparing for the dynamic programming midterm"],
        metadata: { text: "is preparing for the dynamic programming midterm", scope: "project" },
      }).detail,
    ).toBe("Kept for this project only, across future conversations")
  })

  test("falls back to the requested pattern when the text is missing from the metadata", () => {
    // The request's pattern is the memory text too, so the prompt never shows a blank.
    expect(memoryPrompt({ patterns: ["studies in short blocks"], metadata: {} }).title).toBe(
      'Remember "studies in short blocks"',
    )
  })
})
