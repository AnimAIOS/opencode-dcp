/**
 * Focused coverage for TUI branches that `v2-tui-render.test.tsx` does not hit:
 * the denied-compression panel state and the v2 setup's toast/no-op paths.
 * Bun-only (same FFI constraint as the other render tests); run via
 * `bun test tests/v2-tui-*.test.tsx`.
 */
/** @jsxImportSource @opentui/solid */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { testRender } from "@opentui/solid"
import { PanelDialog } from "../lib/tui/dialogs"
import type { ViewApi } from "../lib/tui/types"
import { resolveViewTheme } from "../lib/v2/theme"
import { setup } from "../lib/v2/tui"

function apiFor(): ViewApi {
    return {
        renderer: {
            height: 40,
            on: () => () => {},
            off: () => {},
        },
        theme: resolveViewTheme(() => undefined),
        ui: { dialog: { clear() {} } },
    }
}

describe("PanelDialog denied compression", () => {
    it("renders the supplied blocked reason without throwing", async () => {
        const api = apiFor()
        const dialog = () => (
            <PanelDialog
                api={api}
                manualMode={false}
                canCompress={false}
                blockedReason="Blocked by permissions"
                onContext={() => {}}
                onStats={() => {}}
                onManual={() => {}}
            />
        )
        const setup = await testRender(dialog as never)
        try {
            assert.ok(setup.renderer, "denied panel rendered without a renderer")
        } finally {
            await setup.renderer.destroy()
        }
    })
})

type ToastCall = {
    title?: string
    message?: string
    variant?: string
    duration?: number
}

function contextFor(
    onNotify: (handler: (event: unknown) => void) => void,
    toasts: ToastCall[],
    enabled = true,
) {
    let slots = 0
    const ctx = {
        location: { directory: "/repo" },
        data: {
            location: { default: () => ({ directory: "/repo" }) },
            on(event: string, handler: (event: unknown) => void) {
                assert.equal(event, "rpc.dcp.notify")
                onNotify(handler)
            },
        },
        client: {
            rpc() {
                return {
                    async status() {
                        return { enabled }
                    },
                }
            },
            session: { async command() {} },
        },
        renderer: { height: 40, on: () => () => {}, off: () => {} },
        theme: {},
        ui: {
            dialog: { set() {}, show() {}, clear() {} },
            router: { current: () => ({ type: "session", sessionID: "ses_live" }) },
            slot() {
                slots++
            },
            toast: { show: (toast: ToastCall) => toasts.push(toast) },
        },
        keymap: { layer() {} },
    }
    return { ctx, slotCount: () => slots }
}

describe("v2 TUI setup notifications", () => {
    it("maps rpc.dcp.notify events to toasts with defaults and truncation", async () => {
        let notify: ((event: unknown) => void) | undefined
        const toasts: ToastCall[] = []
        const { ctx } = contextFor((handler) => (notify = handler), toasts)

        await setup(ctx as never)
        assert.ok(notify, "expected an rpc.dcp.notify handler to be registered")

        notify({})
        notify({ data: {} })
        assert.equal(toasts.length, 0, "events without a message must be ignored")

        notify({ data: { message: "hello" } })
        assert.deepEqual(toasts[0], {
            title: "DCP",
            message: "hello",
            variant: "info",
            duration: 5000,
        })

        notify({
            data: {
                title: "Custom",
                message: Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n"),
                variant: "warning",
                duration: 1000,
            },
        })
        assert.deepEqual(toasts[1], {
            title: "Custom",
            message:
                Array.from({ length: 11 }, (_, i) => `line ${i}`).join("\n") + "\n... and 3 more",
            variant: "warning",
            duration: 1000,
        })
    })

    it("installs no UI hooks when DCP is disabled", async () => {
        let notified = false
        const { ctx, slotCount } = contextFor(() => (notified = true), [], false)
        await setup(ctx as never)
        assert.equal(notified, false)
        assert.equal(slotCount(), 0)
    })

    it("degrades to headless when host UI APIs are missing", async () => {
        const warnings: string[] = []
        const originalWarn = console.warn
        console.warn = (message?: unknown) => warnings.push(String(message))
        try {
            await setup({ client: { rpc() {} } } as never)
        } finally {
            console.warn = originalWarn
        }
        assert.equal(warnings.length, 1)
        assert.match(warnings[0], /headless/)
    })
})
