export let url: URL | undefined

export function set(value: URL) {
  url = value
}

export function clear(value: URL) {
  if (url !== value) return
  url = undefined
}

export * as ServerAddress from "./address"
