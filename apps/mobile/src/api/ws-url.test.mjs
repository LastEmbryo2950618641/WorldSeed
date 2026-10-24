import assert from "node:assert/strict"
import test from "node:test"

/** Keep in sync with toWsEventsUrl in client.ts */
function toWsEventsUrl(apiBaseUrl, apiToken) {
  const base = apiBaseUrl.replace(/\/+$/u, "")
  const wsBase = base.startsWith("https://")
    ? `wss://${base.slice("https://".length)}`
    : base.startsWith("http://")
      ? `ws://${base.slice("http://".length)}`
      : base
  const url = new URL(`${wsBase}/events`)
  url.searchParams.set("token", apiToken)
  return url.toString()
}

test("toWsEventsUrl maps https to wss and attaches token", () => {
  assert.equal(toWsEventsUrl("https://seed.example.com/", "tok"), "wss://seed.example.com/events?token=tok")
})

test("toWsEventsUrl maps http to ws", () => {
  assert.equal(toWsEventsUrl("http://127.0.0.1:8787", "abc"), "ws://127.0.0.1:8787/events?token=abc")
})
