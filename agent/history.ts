export type BarPoint = {
  t: number
  price: number
}

export type WindowBar = {
  windowId: number
  first: number
  last: number
  ret: number
}

export function windowBars(points: readonly BarPoint[], now: number, windowMs: number, count: number): WindowBar[] {
  if (!(windowMs > 0) || count < 1) return []
  const openId = Math.floor(now / windowMs)
  const bars: WindowBar[] = []
  for (let offset = count; offset >= 1; offset--) {
    const windowId = openId - offset
    const start = windowId * windowMs
    const end = start + windowMs
    let firstT = Infinity
    let lastT = -Infinity
    let first = 0
    let last = 0
    let prints = 0
    for (const point of points) {
      if (point.t < start || point.t >= end) continue
      prints += 1
      if (point.t <= firstT) {
        firstT = point.t
        first = point.price
      }
      if (point.t >= lastT) {
        lastT = point.t
        last = point.price
      }
    }
    if (prints < 2 || first === 0) continue
    bars.push({ windowId, first, last, ret: (last - first) / first })
  }
  return bars
}

export function ewmaSignal(returns: readonly number[], lambda: number): { mean: number; variance: number; z: number } {
  if (returns.length === 0) return { mean: 0, variance: 0, z: 0 }
  let mean = returns[0]!
  let variance = 0
  for (let index = 1; index < returns.length; index++) {
    const value = returns[index]!
    const next = lambda * mean + (1 - lambda) * value
    variance = lambda * variance + (1 - lambda) * (value - next) ** 2
    mean = next
  }
  if (variance <= 1e-18) return { mean, variance, z: mean === 0 ? 0 : mean > 0 ? 8 : -8 }
  return { mean, variance, z: mean / Math.sqrt(variance) }
}
