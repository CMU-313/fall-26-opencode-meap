To use the export feature of the stats cli command, pass the --export flag along with one of the three supported formats "json", "csv", and "md"

The stats file will be written to the opencode directory titled opencode_stats_<timestamp>.<format>
# User Guide

How to use and user test the features our team added to opencode. Each feature has its
own section.

- [Persistent memory](#persistent-memory)

---

## Persistent memory

opencode can remember things about you across conversations, such as how you like to
study, and use them in every later session, including in other projects. Telling it
_"remember that I prefer hints over full answers"_ is enough: it asks for your approval,
saves the memory, and from then on gives you hints instead of full solutions.

Memories are plain markdown files you can read, edit, and delete yourself. Nothing is
saved without your approval.

Issues: #4 (user story), #8, #9, #10, #33.

### Setup

Requirements: [Bun](https://bun.sh) 1.3 or newer, and an API key for a model provider.

```bash
bun install
bun dev
```

**Connect a model.** opencode needs a model provider to reply. OpenCode Zen's free models
only work from official opencode builds, not from this source checkout, so use your own
key. A free option is a Gemini key from [Google AI Studio](https://aistudio.google.com):

1. In the TUI, type `/connect`, search for **Google**, and paste your key.
2. Type `/models`, search for `gemini`, and pick a model.
3. Send "hi". The prompt bar should show your Gemini model, and it should reply.

### Try it

| #   | Do                                                                                                        | Expect                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Send _"Remember that I prefer hints over full answers when I'm studying."_                                | An approval prompt: **`◆ Remember "prefers hints over full answers"`**, kept across all your projects |
| 2   | Choose **Allow once**                                                                                     | The model confirms, and `ls ~/.config/opencode/memory/` shows a new `mem_….md` file                   |
| 3   | Quit opencode, then start it in another folder: `mkdir -p /tmp/other-course && bun dev /tmp/other-course` | —                                                                                                     |
| 4   | Send _"What do you remember about me?"_                                                                   | It mentions that you prefer hints                                                                     |
| 5   | Ask a study question, e.g. _"How do I solve the recurrence T(n) = 2T(n/2) + n?"_                          | It gives hints rather than the full solution                                                          |
| 6   | Ask it to remember something else, then choose **Reject**                                                 | Nothing is saved; the memory folder is unchanged                                                      |
| 7   | Ask it to remember something, choose **Allow always**, then ask it to remember one more thing             | No prompt the second time (until opencode restarts)                                                   |
| 8   | Edit a memory file's text, then send any message                                                          | The model sees your edit on the next message, with no restart                                         |
| 9   | Turn memory off (see [Settings](#settings)), restart, and repeat step 4                                   | It remembers nothing, and it can no longer record memories                                            |

### Managing your memories

Memories are stored in `~/.config/opencode/memory/`, one file per memory. (If you set
`XDG_CONFIG_HOME` or `OPENCODE_CONFIG_DIR`, they are under that directory instead.)

```markdown
---
scope: global
created: "2026-10-03T12:00:00.000Z"
---

prefers hints over full answers
```

- **Edit** a memory by changing the text under the second `---`.
- **Add** one by hand by creating a file whose name starts with `mem_` and ends in `.md`,
  such as `mem_midterm.md`, with the format above.
- **Delete** one by deleting its file. To delete all of them:
  `rm -f ~/.config/opencode/memory/mem_*.md`
- A file that is broken by hand is skipped with a warning in the log; your other memories
  still load.

The model cannot delete or change memories. If you ask it to forget something, it tells
you how to do it yourself.

### Settings

Add a `memory` section to `~/.config/opencode/opencode.json` (all projects) or to
`opencode.json` in a project:

```json
{
  "memory": {
    "enabled": true,
    "scope": "global",
    "max_entries": 100
  }
}
```

| Setting       | Values                      | Default  | Effect                                                                                                                                         |
| ------------- | --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`     | `true`, `false`             | `true`   | `false` keeps all memories out of the model's context and removes the memory tool                                                              |
| `scope`       | `"global"`, `"project"`     | `global` | Whether new memories apply everywhere or only in the current project. Outside a git repository, `"project"` is recorded as global.             |
| `max_entries` | a whole number of 1 or more | `100`    | At the limit, new memories are refused and you are told which one to delete; nothing is deleted for you. An invalid value is reported by name. |

Settings are read when opencode starts, so restart after changing them.

To record memories without being asked each time, add
`"permission": { "memory": "allow" }` to `opencode.json`.

### Troubleshooting

- **The model says "noted" but no prompt appeared.** No prompt means nothing was saved.
  It may already be remembered (it skips duplicates and should say so), or a lighter model
  may not have used its memory tool. Rephrase more directly: _"use your memory tool to
  remember …"_, or pick a larger model with `/models`.
- **No prompt after choosing "Allow always" earlier.** That approval lasts until opencode
  restarts.
- **A setting has no effect.** Restart opencode.
- **"OpenCode's free tier can only be used from within OpenCode."** Connect your own
  provider key as described in [Setup](#setup).

### Automated tests

**76 tests in 10 files.** Run them from each package's directory (tests cannot be run from
the repository root):

```bash
cd packages/core
bun test test/memory.test.ts test/memory-context.test.ts test/tool-memory.test.ts \
  test/tool-memory-permission.test.ts test/config/memory.test.ts        # 52 pass

cd ../opencode
bun test test/config/memory.test.ts test/session/system-memory.test.ts \
  test/tool/memory.test.ts test/tool/memory-permission.test.ts           # 20 pass

cd ../tui
bun test test/routes/session/permission.test.ts                          # 4 pass
```

**What is tested.** opencode has two session engines: a newer one in `packages/core`, and
an older one in `packages/opencode` that the TUI uses. Memory is implemented in both, so
both are tested.

| File                                                    | Tests                                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/memory.test.ts`                     | Storage: saving and re-reading, edit and delete, corrupted and hand-copied files, the entry cap                                                             |
| `packages/core/test/memory-context.test.ts`             | Delivery to the model: memories in new sessions and other projects, project scope, mid-conversation updates, deletion, unreadable folders, `enabled: false` |
| `packages/core/test/tool-memory.test.ts`                | The memory tool: what it records, scope inside and outside git, the cap, empty input, hidden when memory is off                                             |
| `packages/core/test/tool-memory-permission.test.ts`     | Approval: no built-in agent records without asking; approve, reject, and "always"                                                                           |
| `packages/core/test/config/memory.test.ts`              | Settings: valid values accepted in both config formats, an invalid `max_entries` reported by name, settings kept when an older config file is converted     |
| `packages/opencode/test/config/memory.test.ts`          | The TUI's config reader accepts `memory` and reports a bad `max_entries` at `memory.max_entries`                                                            |
| `packages/opencode/test/session/system-memory.test.ts`  | The TUI's system prompt: same text as the newer engine, project scope, `enabled: false`, unreadable folders, hand edits                                     |
| `packages/opencode/test/tool/memory.test.ts`            | The TUI's memory tool and when it is offered                                                                                                                |
| `packages/opencode/test/tool/memory-permission.test.ts` | The TUI's approval: prompt, approve, reject (memory folder left byte-identical), "always", and opting in through settings                                   |
| `packages/tui/test/routes/session/permission.test.ts`   | The wording of the approval prompt                                                                                                                          |

**Why these tests are sufficient.**

1. **Every acceptance criterion in #8, #9, #10, and #33 has at least one named test.**
2. **The tests were mutation-checked:** for each behavior, the code was deliberately broken
   and the matching tests were confirmed to fail. For example, removing the "ask before
   recording" rule makes every approval test fail with _"no approval prompt was raised."_
3. **Approval and model-context behavior is tested against the real services**, not
   stand-ins, so the tests exercise the same path a real session uses.
4. **The edge cases a student could hit by hand are covered:** corrupted, copied, and
   hand-edited files, unreadable folders, duplicates, and the entry cap.
5. **Nothing else regressed:** every package's full test suite was compared against a
   baseline taken before the feature, and CI passes on the feature branch.

**Not covered automatically:** whether a given model _chooses_ to use its memory tool
depends on the model, and that the TUI dialog displays the approval wording is checked by
hand. Steps 1 and 2 in [Try it](#try-it) cover both.
