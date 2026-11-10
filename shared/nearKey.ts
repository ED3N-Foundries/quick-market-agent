import * as ed from "@noble/ed25519"
import { sha256 } from "@noble/hashes/sha2.js"
import bs58 from "bs58"
import { isImplicitAccount } from "./near"

export const NEP413_RECIPIENT = "quick-market"

const textEncoder = new TextEncoder()

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function unhex(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return null
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** NEAR packs a 32-byte seed, or that seed followed by its public key. */
export function seedFromSecret(secretKey: string): Uint8Array | null {
  const trimmed = secretKey.trim()
  if (!trimmed.startsWith("ed25519:")) return null
  try {
    const bytes = bs58.decode(trimmed.slice("ed25519:".length))
    if (bytes.length === 32) return bytes
    if (bytes.length !== 64) return null
    return bytes.slice(0, 32)
  } catch {
    return null
  }
}

export async function publicKeyBytes(secretKey: string): Promise<Uint8Array | null> {
  const trimmed = secretKey.trim()
  const seed = seedFromSecret(trimmed)
  if (!seed) return null
  const pub = await ed.getPublicKeyAsync(seed)
  try {
    const packed = bs58.decode(trimmed.slice("ed25519:".length))
    if (packed.length === 64 && hex(packed.slice(32)) !== hex(pub)) return null
  } catch {
    return null
  }
  return pub
}

export async function accountFromSecret(secretKey: string): Promise<string | null> {
  const pub = await publicKeyBytes(secretKey)
  return pub ? hex(pub) : null
}

export async function generateNearSecret(): Promise<{ secretKey: string; account: string }> {
  const seed = ed.utils.randomSecretKey()
  const pub = await ed.getPublicKeyAsync(seed)
  const packed = new Uint8Array(64)
  packed.set(seed, 0)
  packed.set(pub, 32)
  return { secretKey: `ed25519:${bs58.encode(packed)}`, account: hex(pub) }
}

export function publicKeyFromAccount(account: string): Uint8Array | null {
  if (!isImplicitAccount(account)) return null
  return unhex(account)
}

export function parseNearPublicKey(value: string): Uint8Array | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith("ed25519:")) return null
  try {
    const bytes = bs58.decode(trimmed.slice("ed25519:".length))
    return bytes.length === 32 ? bytes : null
  } catch {
    return null
  }
}

export async function signNearMessage(message: string, secretKey: string): Promise<string | null> {
  const seed = seedFromSecret(secretKey)
  if (!seed) return null
  const signature = await ed.signAsync(textEncoder.encode(message), seed)
  return hex(signature)
}

export async function verifyNearMessage(message: string, account: string, signatureHex: string): Promise<boolean> {
  const pub = publicKeyFromAccount(account)
  const signature = unhex(signatureHex.trim())
  if (!pub || !signature || signature.length !== 64) return false
  return ed.verifyAsync(signature, textEncoder.encode(message), pub)
}

function pushU32(out: number[], value: number) {
  out.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255)
}

function pushStr(out: number[], value: string) {
  const bytes = textEncoder.encode(value)
  pushU32(out, bytes.length)
  for (const byte of bytes) out.push(byte)
}

/** NEP-413 bytes a wallet signs: the 413 tag, then the borsh payload. */
export function nep413Bytes(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error("Nonce must be 32 bytes")
  const out = [0x9d, 0x01, 0x00, 0x80]
  pushStr(out, message)
  for (const byte of nonce) out.push(byte)
  pushStr(out, recipient)
  out.push(0)
  return Uint8Array.from(out)
}

function decodeSignature(value: string): Uint8Array | null {
  const trimmed = value.trim()
  const hexed = unhex(trimmed)
  if (hexed && hexed.length === 64) return hexed
  try {
    const decoded = bs58.decode(trimmed)
    if (decoded.length === 64) return decoded
  } catch {
    // Try base64 next.
  }
  try {
    const decoded = Uint8Array.from(atob(trimmed), (char) => char.charCodeAt(0))
    return decoded.length === 64 ? decoded : null
  } catch {
    return null
  }
}

export async function verifyNep413(input: {
  message: string
  account: string
  publicKey: string
  signature: string
  nonce: Uint8Array
  recipient: string
}): Promise<boolean> {
  const pub = parseNearPublicKey(input.publicKey)
  const signature = decodeSignature(input.signature)
  if (!pub || !signature) return false
  if (isImplicitAccount(input.account) && hex(pub) !== input.account) return false
  let bytes: Uint8Array
  try {
    bytes = nep413Bytes(input.message, input.nonce, input.recipient)
  } catch {
    return false
  }
  return ed.verifyAsync(signature, bytes, pub)
}

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes)
}

export { bs58 }
