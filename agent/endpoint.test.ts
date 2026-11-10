import { expect, test } from "bun:test"
import { apiEndpointFromUrl, peekApiEndpoint, refreshApiEndpoint, resolveHostIp } from "./endpoint"

test("the api url keeps the host and the port", () => {
  expect(apiEndpointFromUrl("http://127.0.0.1:3001")).toEqual({ host: "127.0.0.1:3001", hostname: "127.0.0.1" })
  expect(apiEndpointFromUrl("http://127.0.0.1:3001/api/session")).toEqual({
    host: "127.0.0.1:3001",
    hostname: "127.0.0.1",
  })
  expect(apiEndpointFromUrl("https://qm.example/api")).toEqual({ host: "qm.example:443", hostname: "qm.example" })
  expect(apiEndpointFromUrl("qm.example:3001")).toEqual({ host: "qm.example:3001", hostname: "qm.example" })
  expect(apiEndpointFromUrl("http://[::1]:3001")).toEqual({ host: "[::1]:3001", hostname: "::1" })
})

test("an address literal is its own ip", async () => {
  let called = false
  const ip = await resolveHostIp("127.0.0.1", async () => {
    called = true
    return []
  })
  expect(called).toBe(false)
  expect(ip).toBe("127.0.0.1")
  expect(peekApiEndpoint("http://10.1.2.3:3001")).toEqual({ host: "10.1.2.3:3001", ip: "10.1.2.3" })
})

test("a hostname prefers ipv4 and keeps every address", async () => {
  const mixed = await resolveHostIp("qm.example", async () => ["2001:db8::1", "203.0.113.8", "203.0.113.8", "198.51.100.2"])
  expect(mixed).toBe("203.0.113.8, 198.51.100.2")
  const v6 = await resolveHostIp("qm.example", async () => ["2001:db8::1"])
  expect(v6).toBe("2001:db8::1")
  const failed = await resolveHostIp("qm.example", async () => {
    throw new Error("dns")
  })
  expect(failed).toBeNull()
})

test("the resolved ip is remembered until the ttl passes", async () => {
  const url = "http://remembered.example:3001"
  let calls = 0
  const resolve = async () => {
    calls += 1
    return calls === 1 ? ["203.0.113.8"] : ["198.51.100.2"]
  }
  await refreshApiEndpoint(url, 1_000, resolve)
  expect(peekApiEndpoint(url)).toEqual({ host: "remembered.example:3001", ip: "203.0.113.8" })
  await refreshApiEndpoint(url, 10_000, resolve)
  expect(calls).toBe(1)
  await refreshApiEndpoint(url, 40_000, resolve)
  expect(peekApiEndpoint(url).ip).toBe("198.51.100.2")
})

test("a failed lookup keeps the last ip for that host", async () => {
  const url = "http://sticky.example:3001"
  await refreshApiEndpoint(url, 1_000, async () => ["203.0.113.9"])
  await refreshApiEndpoint(url, 40_000, async () => {
    throw new Error("dns")
  })
  expect(peekApiEndpoint(url)).toEqual({ host: "sticky.example:3001", ip: "203.0.113.9" })
})
