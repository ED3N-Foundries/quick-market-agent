import { expect, test } from "bun:test"
import { loadWalletMap, metaGet, metaSet, openSwarm, saveStakes, saveWallets, stakesFor, type WalletRow } from "./swarmdb"

function wallet(address: string, bankroll: number): WalletRow {
  return {
    address,
    idx: 1,
    online: 1,
    phase: "",
    bankroll,
    lastSide: null,
    lastStake: null,
    lastSkip: null,
    wins: 0,
    losses: 0,
    mind: "tape",
    tempo: 10,
    visitEnd: 0,
    enrolled: 1,
    rngA: 1,
    gateJson: "{}",
    cursor: 0,
    visitStart: 0,
    gapEnd: 0,
    handled: 0,
    wokeAt: null,
    sleptAt: null,
    updatedAt: 1,
  }
}

test("agent wallets, stakes, and cursors are chain-scoped in one database", () => {
  const db = openSwarm(":memory:")
  try {
    saveWallets(db, [wallet("0xabc", 100)], "base-sepolia")
    saveWallets(db, [wallet("near.testnet", 200)], "near-testnet")
    saveStakes(db, 7, [{ address: "0xabc", side: "up", stakeMicros: 10 }], "base-sepolia")
    saveStakes(db, 7, [{ address: "near.testnet", side: "down", stakeMicros: 20 }], "near-testnet")
    metaSet(db, "settle_cursor", "7", "base-sepolia")
    metaSet(db, "settle_cursor", "9", "near-testnet")

    expect(loadWalletMap(db, "base-sepolia").get("0xabc")?.bankroll).toBe(100)
    expect(loadWalletMap(db, "near-testnet").get("near.testnet")?.bankroll).toBe(200)
    expect(stakesFor(db, 7, "base-sepolia")).toEqual([{ address: "0xabc", side: "up", stakeMicros: 10 }])
    expect(stakesFor(db, 7, "near-testnet")).toEqual([{ address: "near.testnet", side: "down", stakeMicros: 20 }])
    expect(metaGet(db, "settle_cursor", "base-sepolia")).toBe("7")
    expect(metaGet(db, "settle_cursor", "near-testnet")).toBe("9")
  } finally {
    db.close()
  }
})
