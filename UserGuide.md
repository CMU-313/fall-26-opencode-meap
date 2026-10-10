# User Guide

How to use and user test the features our team added to opencode. Each feature has its
own section.

- [Export Stats](#export-stats)

---

## Export Stats

### Usage

To use the export feature of the stats cli command, pass the --export flag along with one of the three supported formats "json", "csv", and "md"

The stats file will be written to the opencode directory titled opencode_stats_<timestamp>.<format>

Stats files are written with the timestamp to prevent collisions upon subsequent stats --export invocations without clearing directory.

### Testing 

Full test suite for --export functionality is located here:
packages/opencode/test/cli/stats-export.test.ts

The initial 10 tests from sprint 1 covered output invariance across export formats.

The 12 sprint 2 tests covered specific edge cases and failure modes of the specific export formats:
- null values are never written to file output
- 0 in date range in stats objects writes empty datestring instead of zero epoch
- model containing | in name does not break .md table
- negative flag params do not affect output written to file
- exportPath returns correct joined string
- export methods write file of correct specified format
- writeExport reports written file path via stderr msg
- writeExport to unwriteable path throws err
- reportStats defaults to cli output and control flow for export formats is correct

These tests help to validate the initially outlined success criteria involving stats records being updated upon use and export functionality being successful across json and csv formats, with the addition of markdown format.

---

- [Export Stats](#export-stats)
- [Persistent memory](#persistent-memory)
- [Catching Up on Recent Commits](#catching-up-on-recent-commits)
- [Change Model Language](#response-language)
---

## Export Stats

### Usage

To use the export feature of the stats cli command, pass the --export flag along with one of the three supported formats "json", "csv", and "md"

The stats file will be written to the opencode directory titled opencode_stats_<timestamp>.<format>

Stats files are written with the timestamp to prevent collisions upon subsequent stats --export invocations without clearing directory.

### Testing 

Full test suite for --export functionality is located here:
packages/opencode/test/cli/stats-export.test.ts

The initial 10 tests from sprint 1 covered output invariance across export formats.

The 12 sprint 2 tests covered specific edge cases and failure modes of the specific export formats:
- null values are never written to file output
- 0 in date range in stats objects writes empty datestring instead of zero epoch
- model containing | in name does not break .md table
- negative flag params do not affect output written to file
- exportPath returns correct joined string
- export methods write file of correct specified format
- writeExport reports written file path via stderr msg
- writeExport to unwriteable path throws err
- reportStats defaults to cli output and control flow for export formats is correct

These tests help to validate the initially outlined success criteria involving stats records being updated upon use and export functionality being successful across json and csv formats, with the addition of markdown format.

---



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

---

## Catching Up on Recent Commits

If you've been away from the project and want a quick, plain-language summary of what's
changed, use the `catchup` command. It reads your recent git history and asks your
configured model to summarize it.

Issues: #25 (fetch and structure commit history), #26 (generate and display the summary).

### Usage

```bash
opencode catchup
```

This summarizes the last 5 commits by default. To summarize a different number of
commits, pass `--count`:

```bash
opencode catchup --count 10
```

### Setup

`catchup` needs a model provider, the same setup `opencode run` already requires. If you
haven't connected one, run opencode, type `/connect`, search for **Google**, and paste a
free Gemini key from [Google AI Studio](https://aistudio.google.com). Then use `/models`
to pick a Gemini text model. OpenCode Zen's free models only work from official opencode
builds, not from this source checkout, so use your own key. If no provider is configured,
`catchup` tells you it couldn't resolve a model instead of failing silently.

### Try it

| #   | Do                                                                             | Expect                                                                                           |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | In a repo with a few commits, run `bun run src/index.ts catchup`               | A plain-language summary that groups related commits and describes what changed in the code      |
| 2   | Compare it with `git log --oneline -5`                                         | Each point in the summary matches a real commit, in order, and nothing is invented               |
| 3   | Run `bun run src/index.ts catchup --count 2`                                   | The summary covers only the two most recent commits                                              |
| 4   | Run it from a folder that isn't a git repo, or a repo with no commits          | A message saying no commit history was found, and no model call is made                          |

The wording of the summary varies between runs, since a model writes it. Example output:

```
Welcome back! Here is a summary of the project's progress since the initial setup:

### Project Launch
The repository was initialized with a full monorepo structure...

### New "Catchup" Feature
* Git History Integration: Added the ability for the system to fetch and read recent git logs.
* Plain-Language Summaries: Created a new CLI command called `catchup`...
```

### Testing

The tests are in `packages/opencode/test/cli/catchup.test.ts` (4 tests) and
`packages/opencode/test/git/git.test.ts` (12 tests, 3 of them for `Git.Service.log()`).
Run them from the package directory:

```bash
cd packages/opencode
bun test test/cli/catchup.test.ts test/git/git.test.ts
```

| File                                         | Tests                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/test/git/git.test.ts`     | `log()` parses hash, author, date, message, and changed files; a count limits how many commits come back; a non-git folder returns an empty list |
| `packages/opencode/test/cli/catchup.test.ts` | The prompt includes each commit's hash, author, date, message, and per-file +/- stats; commits are ordered most recent first; commits with no file changes don't crash; the no-history case is handled |

**Why these tests are sufficient.**

1. **Every acceptance criterion in #25 and #26 has at least one named test**, covering
   fetching and parsing commit history, building the prompt, and handling an empty history.
2. **The tests cover what is deterministic and in our control:** the data handed to the
   model is correctly structured, and the command exits cleanly when there is nothing to
   summarize.
3. **There is no automated test that calls a live model**, because its output varies and
   would make CI flaky and dependent on network access and credentials.
4. **The live path was checked by hand** with a real Gemini model against this repo's
   actual commit history, and the summary was compared with `git log` (step 2 in
   [Try it](#try-it-1) covers this).

**Not covered automatically:** the quality and wording of a model's summary. Steps 1 and 2
in Try it cover that.


## Response Language

  If you'd rather read opencode's answers in your own language, you can choose the
  language it responds in. The choice is saved, so every later reply uses it, in every
  project, until you change it.

  Issues: #20 (settings config field for language choice). PRs: #36 (feature), #37 (edge
  case tests and a fix for whitespace-only values).

  ### Usage

  In the TUI, type `/language`, type to filter the list, and press Enter. A toast confirms
  _"Responses will be in Spanish"_. Built-in choices: English, Spanish, French, German,
  Italian, Portuguese, Chinese, Japanese, Korean, Hindi, Arabic, Russian, Vietnamese,
  Indonesian, Turkish.

  `/language` saves the choice to `~/.config/opencode/opencode.json`. You can also set it
  by hand there, or in a project's `opencode.json` to apply it to one project only. Any
  language name works, including ones not in the list:

  ```json
  {
    "language": "Brazilian Portuguese"
  }
  ```

  A project's setting overrides the global one. With no `language` set, opencode answers in
  English as before.

  ### Setup

  Replies need a model provider. If you haven't connected one, run opencode, type
  `/connect`, search for **Google**, and paste a free Gemini key from
  [Google AI Studio](https://aistudio.google.com). Then use `/models` to pick a Gemini text
  model.

  ### Try it

| #   | Do                                                                          | Expect                                                                                                         |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | With no `language` in any config, ask "hi"                                  | A reply in English                                                                                             |
| 2   | Type `/language` and pick **Spanish**                                       | The toast _"Responses will be in Spanish"_, and `"language": "Spanish"` in `~/.config/opencode/opencode.json` |
| 3   | Without restarting, ask "what is a closure?"                                | A reply in Spanish                                                                                             |
| 4   | Quit, start opencode again, and ask anything                                | Still Spanish                                                                                                  |
| 5   | Add `"language": "French"` to a project's `opencode.json` and restart there | Replies in French in that project; other projects stay Spanish                                                 |

  Picking English saves `"English"` rather than clearing the setting; to remove it, delete
  the `language` line from the config. How closely replies stick to the language depends on
  the model, and code and command output are not translated.

  ### Testing

  The tests are in `packages/opencode/test/cli/run/language-process.test.ts` (6 tests),
  `packages/opencode/test/config/config.test.ts` (13 language tests), and
  `packages/tui/test/component/dialog-language.test.tsx` (2 tests). Run them from each
  package directory:

  ```bash
  cd packages/opencode
  bun test test/cli/run/language-process.test.ts
  bun test test/config/config.test.ts -t language

  cd ../tui
  bun test test/component/dialog-language.test.tsx
  ```

 | File                                                      | Tests                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/test/cli/run/language-process.test.ts` | Runs the real `opencode run` against a fake model and checks the system prompt: a configured language adds one instruction, custom names pass through, and no setting, an empty value, or a whitespace-only value adds nothing; a value with newlines stays on one line |
| `packages/opencode/test/config/config.test.ts`            | Precedence (`.opencode` over project over global), updating the global language keeps comments and other settings and creates the file if missing, non-English names like `日本語` are kept, and non-string values are rejected                   |
| `packages/tui/test/component/dialog-language.test.tsx`    | Choosing a language in `/language` sends one config update with that language and shows the success toast; a failed update shows an error toast                                                                                               |

  **Why these tests are sufficient.**

  1. **Every acceptance criterion in #20 has at least one named test.** Changing the
     language changes the response language ("asks the model to respond in the configured
     language", plus the dialog save test); with no setting, the app defaults to English
     ("sends no language instruction when no language is configured"); and the setting
     persists across sessions (the config update tests write the file and read it back, and
     each CLI test starts a new process from the saved file).
  2. **The tests use the real code paths:** the CLI tests run the actual binary and inspect
     the request the model receives, and the TUI test renders the actual dialog and sends a
     real config update request.
  3. **The edge cases cover every way a bad value could reach the prompt:** each config
     location, environment variables, wrong types, and empty or whitespace-only values.
  4. **There is no automated test that calls a live model**, because its output varies and
     would make CI flaky. The live path was checked by hand with a real model 

  **Not covered automatically:** whether a given model actually replies in the chosen
  language
