import { describe, expect, test } from "bun:test"
import { shouldDisableWebUiRoutes } from "../../src/cli/cmd/serve"

describe("serve command options", () => {
  test("disables web UI routes for serve-only runtime entries", () => {
    expect(shouldDisableWebUiRoutes({ OPENCODE_DISABLE_WEB_UI_ROUTES: "1" })).toBe(true)
    expect(shouldDisableWebUiRoutes({ OPENCODE_DISABLE_WEB_UI_ROUTES: "0" })).toBe(false)
    expect(shouldDisableWebUiRoutes({})).toBe(false)
  })
})
