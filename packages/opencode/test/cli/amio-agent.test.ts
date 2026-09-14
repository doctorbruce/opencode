import { describe, expect, test } from "bun:test"
import { installAmioAgentEnvironment, parseAmioAgentArgs } from "../../src/cli/amio-agent"

describe("amio-agent CLI surface", () => {
  test("parses the Astron launch order", () => {
    expect(
      parseAmioAgentArgs([
        "--print-logs",
        "--log-level",
        "DEBUG",
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "57659",
      ]),
    ).toEqual({
      action: "serve",
      printLogs: true,
      logLevel: "DEBUG",
      pure: false,
      hostname: "127.0.0.1",
      port: 57659,
      mdns: false,
      mdnsDomain: "opencode.local",
      cors: [],
    })
  })

  test("parses sidecar network flags without loading the shared CLI", () => {
    expect(
      parseAmioAgentArgs([
        "serve",
        "--pure",
        "--mdns",
        "--mdns-domain=amio.local",
        "--cors",
        "https://first.example",
        "--cors=https://second.example",
      ]),
    ).toEqual({
      action: "serve",
      printLogs: false,
      logLevel: undefined,
      pure: true,
      hostname: "0.0.0.0",
      port: 0,
      mdns: true,
      mdnsDomain: "amio.local",
      cors: ["https://first.example", "https://second.example"],
    })
  })

  test("accepts inline values and boolean values", () => {
    expect(
      parseAmioAgentArgs([
        "--print-logs=false",
        "--log-level=INFO",
        "--pure=true",
        "serve",
        "--hostname=127.0.0.2",
        "--port=4096",
        "--mdns=false",
      ]),
    ).toMatchObject({
      action: "serve",
      printLogs: false,
      logLevel: "INFO",
      pure: true,
      hostname: "127.0.0.2",
      port: 4096,
      mdns: false,
    })
  })

  test("explicit hostname wins over the mDNS default", () => {
    expect(parseAmioAgentArgs(["serve", "--mdns", "--hostname", "localhost"])).toMatchObject({
      hostname: "localhost",
    })
    expect(parseAmioAgentArgs(["serve", "--mdns", "--no-mdns"])).toMatchObject({
      hostname: "127.0.0.1",
    })
  })

  test("supports help and version aliases", () => {
    expect(parseAmioAgentArgs(["-h"])).toEqual({ action: "help" })
    expect(parseAmioAgentArgs(["-v"])).toEqual({ action: "version" })
  })

  test("validates port, log level, values, and unknown arguments", () => {
    expect(() => parseAmioAgentArgs(["serve", "--port", "65536"])).toThrow("integer from 0 to 65535")
    expect(() => parseAmioAgentArgs(["serve", "--port", "1.5"])).toThrow("integer from 0 to 65535")
    expect(() => parseAmioAgentArgs(["serve", "--log-level", "TRACE"])).toThrow("Expected DEBUG, INFO, WARN, or ERROR")
    expect(() => parseAmioAgentArgs(["serve", "--hostname"])).toThrow("argument missing")
    expect(() => parseAmioAgentArgs(["--hostname", "serve"])).toThrow('Expected command "serve"')
    expect(() => parseAmioAgentArgs(["serve", "--hostname", "--port", "80"])).toThrow()
    expect(() => parseAmioAgentArgs(["serve", "serve"])).toThrow("may only be provided once")
    expect(() => parseAmioAgentArgs(["serve", "--wat"])).toThrow("Unknown option '--wat'")
  })

  test("marks the server as an amio-agent runtime", () => {
    const env: Record<string, string | undefined> = {}
    installAmioAgentEnvironment(env)
    expect(env).toEqual({
      OPENCODE_DISABLE_WEB_UI_ROUTES: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_WRITE_FORMAT: "1",
      OPENCODE_DISABLE_WRITE_DIAGNOSTICS: "1",
    })
  })
})
