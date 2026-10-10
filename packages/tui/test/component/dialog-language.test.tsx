/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { DialogLanguage } from "../../src/component/dialog-language"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider, useToast } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountDialog(input: { root: string; update: () => Response }) {
  const state = `${input.root}/state`
  await Bun.write(`${state}/kv.json`, "{}")
  const updates: unknown[] = []
  const calls = createFetch()
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(request, init)
    if (req.method === "PATCH" && new URL(req.url).pathname === "/global/config") {
      updates.push(await req.json())
      return input.update()
    }
    return calls.fetch(req)
  }) as typeof globalThis.fetch
  const ctx = {} as { toast: ReturnType<typeof useToast>; sync: ReturnType<typeof useSync> }

  function Probe() {
    ctx.toast = useToast()
    ctx.sync = useSync()
    return <DialogLanguage />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))

    return (
      <TestTuiContexts directory={input.root} paths={{ home: input.root, state, worktree: input.root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <SDKProvider url="http://test" directory={directory} fetch={fetch} events={eventSource()}>
                  <PermissionProvider>
                    <ProjectProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <ToastProvider>
                              <DialogProvider>
                                <Probe />
                              </DialogProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </ExitProvider>
                    </ProjectProvider>
                  </PermissionProvider>
                </SDKProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  await wait(() => ctx.sync?.status === "complete")
  await wait(
    () => app.renderer.currentFocusedRenderable !== null && app.captureCharFrame().includes("Response language"),
  )
  return { app, ctx, updates }
}

test("selecting a language saves it to the global config and confirms with a toast", async () => {
  await using tmp = await tmpdir()
  const dialog = await mountDialog({ root: tmp.path, update: () => json({ language: "Spanish" }) })

  try {
    await dialog.app.mockInput.typeText("Spanish")
    await dialog.app.renderOnce()
    dialog.app.mockInput.pressEnter()

    await wait(() => dialog.ctx.toast.currentToast !== null)
    expect(dialog.updates).toEqual([{ language: "Spanish" }])
    expect(dialog.ctx.toast.currentToast).toMatchObject({ message: "Responses will be in Spanish", variant: "info" })
  } finally {
    dialog.app.renderer.destroy()
  }
})

test("shows an error toast when saving the language fails", async () => {
  await using tmp = await tmpdir()
  const dialog = await mountDialog({
    root: tmp.path,
    update: () => json({ name: "UnknownError", data: { message: "config is read-only" } }, { status: 500 }),
  })

  try {
    await dialog.app.mockInput.typeText("French")
    await dialog.app.renderOnce()
    dialog.app.mockInput.pressEnter()

    await wait(() => dialog.ctx.toast.currentToast !== null)
    expect(dialog.updates).toEqual([{ language: "French" }])
    expect(dialog.ctx.toast.currentToast?.variant).toBe("error")
    expect(dialog.ctx.toast.currentToast?.message).not.toContain("Responses will be in")
  } finally {
    dialog.app.renderer.destroy()
  }
})
