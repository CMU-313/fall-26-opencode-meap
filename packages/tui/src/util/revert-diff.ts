import { parsePatch } from "diff"

export function getRevertDiffFiles(diffText: string) {
  if (!diffText) return []

  // Split on git's per-file headers instead of handing the whole text to parsePatch: parsePatch silently drops
  // entries without ---/+++ lines (empty files, binary files, pure renames), which hid them from the undo summary.
  return diffText
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "))
    .flatMap((chunk) => {
      const lines = chunk.split("\n")
      const counts = countLines(chunk)
      const from = lines.find((line) => line.startsWith("rename from "))?.slice("rename from ".length)
      const to = lines.find((line) => line.startsWith("rename to "))?.slice("rename to ".length)
      // A rename touches two paths; undoing it changes both, so list both.
      if (from && to)
        return [
          { filename: from, additions: 0, deletions: 0 },
          { filename: to, additions: counts.additions, deletions: counts.deletions },
        ]
      return [
        { filename: headerName(lines[0]!, counts.name), additions: counts.additions, deletions: counts.deletions },
      ]
    })
}

function countLines(chunk: string) {
  try {
    const patch = parsePatch(chunk)[0]
    const name = [patch?.newFileName, patch?.oldFileName].find((item) => item && item !== "/dev/null")
    const lines = patch?.hunks.flatMap((hunk) => hunk.lines) ?? []
    return {
      name: name?.replace(/^[ab]\//, ""),
      additions: lines.filter((line) => line.startsWith("+")).length,
      deletions: lines.filter((line) => line.startsWith("-")).length,
    }
  } catch {
    return { name: undefined, additions: 0, deletions: 0 }
  }
}

// Without a rename, git's header is `diff --git a/<path> b/<path>` with the same path twice, so the path is
// recoverable from the header's length even when it contains spaces.
function headerName(header: string, parsed: string | undefined) {
  if (parsed) return parsed
  const rest = header.slice("diff --git ".length)
  return rest.slice(2, 2 + (rest.length - 5) / 2)
}
