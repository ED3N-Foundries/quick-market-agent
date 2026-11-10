export const SESSION_MS = 7 * 24 * 60 * 60 * 1000
export const LOGIN_SKEW_MS = 2 * 60 * 1000

export function loginMessage(chainId: number, address: string, issued: number): string {
  return `quick-market\nchainId: ${chainId}\naddress: ${address.toLowerCase()}\nissued: ${issued}`
}

export function botEnrollMessage(chainId: number, address: string, issued: number, seedMicros: number): string {
  return `quick-market bot\nchainId: ${chainId}\naddress: ${address.toLowerCase()}\nissued: ${issued}\nseed: ${seedMicros}`
}

export function nearLoginMessage(account: string, issued: number): string {
  return `quick-market\nchain: near-testnet\naccount: ${account}\nissued: ${issued}`
}

export function nearBotEnrollMessage(account: string, issued: number, seedMicros: number): string {
  return `quick-market bot\nchain: near-testnet\naccount: ${account}\nissued: ${issued}\nseed: ${seedMicros}`
}
