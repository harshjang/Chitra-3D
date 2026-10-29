/**
 * Geometry helpers for placing photo-inferred objects inside an inferred room.
 *
 * Pure functions with no repo imports. Conventions match photo-scene-executor.ts:
 * plan coordinates are [x, z] in metres, `position` is the object's centre,
 * `yaw` is in RADIANS, and a footprint is width (x) by depth (z) before yaw.
 */

export type Point = readonly [number, number]

/** Largest inward move applied automatically. Beyond this the inference is wrong, not just noisy. */
export const MAX_AUTO_FIT_M = 0.2

/** Stop 1 mm inside the clearance so rounding can never leave an object a hair short of it. */
const CLEARANCE_MARGIN_M = 0.001

export function footprintCorners(
  position: Point,
  yaw: number,
  width: number,
  depth: number,
): Point[] {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const local: Point[] = [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ]
  return local.map(([x, z]) => [position[0] + x * c + z * s, position[1] - x * s + z * c])
}

export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside
  }
  return inside
}

function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len2 = dx * dx + dz * dz
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2))
  return [a[0] + t * dx, a[1] + t * dz]
}

/** Nearest point on the room boundary, and how far away it is. */
export function nearestBoundary(p: Point, polygon: readonly Point[]) {
  let best: { point: Point; distance: number } = { point: polygon[0]!, distance: Infinity }
  for (let i = 0; i < polygon.length; i++) {
    const q = closestOnSegment(p, polygon[i]!, polygon[(i + 1) % polygon.length]!)
    const distance = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (distance < best.distance) best = { point: q, distance }
  }
  return best
}

/** Human-readable reason an object does not fit, with the numbers needed to debug it. */
export function describeMisfit(
  polygon: readonly Point[],
  position: Point,
  yaw: number,
  width: number,
  depth: number,
): string {
  const corners = footprintCorners(position, yaw, width, depth)
  const xs = polygon.map((p) => p[0])
  const zs = polygon.map((p) => p[1])
  const outside = corners
    .map((corner, index) => ({ corner, index, ...nearestBoundary(corner, polygon) }))
    .filter(({ corner }) => !pointInPolygon(corner, polygon))
  const deg = ((yaw * 180) / Math.PI).toFixed(1)
  const head =
    `footprint ${width.toFixed(2)} x ${depth.toFixed(2)} m centred at ` +
    `(${position[0].toFixed(2)}, ${position[1].toFixed(2)}), yaw ${yaw.toFixed(2)} rad (${deg} deg); `
  const span =
    `room spans x ${Math.min(...xs).toFixed(2)} to ${Math.max(...xs).toFixed(2)}, ` +
    `z ${Math.min(...zs).toFixed(2)} to ${Math.max(...zs).toFixed(2)}`
  if (outside.length === 0) {
    const closest = Math.min(...corners.map((corner) => nearestBoundary(corner, polygon).distance))
    return `${head}all corners inside, nearest is ${closest.toFixed(3)} m from a wall; ${span}`
  }
  const worst = outside.reduce((a, b) => (b.distance > a.distance ? b : a), outside[0]!)
  return (
    `${head}${outside.length} of 4 corners outside, worst corner ${worst.index} at ` +
    `(${worst.corner[0].toFixed(2)}, ${worst.corner[1].toFixed(2)}) is ${worst.distance.toFixed(3)} m past the wall; ${span}`
  )
}

/**
 * Moves an object inward, as little as possible, until every corner is inside the room
 * and at least `clearance` from every wall. Returns null when that needs more than
 * `maxShift` in total or does not converge (object too big for the space), so the caller
 * can still refuse a genuinely wrong inference.
 */
export function nudgeInside(
  polygon: readonly Point[],
  position: Point,
  yaw: number,
  width: number,
  depth: number,
  clearance: number,
  maxShift = MAX_AUTO_FIT_M,
): { position: [number, number]; shift: number } | null {
  const target = clearance + CLEARANCE_MARGIN_M
  let x = position[0]
  let z = position[1]
  for (let iteration = 0; iteration < 40; iteration++) {
    let push: { dx: number; dz: number; amount: number } | null = null
    for (const corner of footprintCorners([x, z], yaw, width, depth)) {
      const { point: q, distance } = nearestBoundary(corner, polygon)
      const outside = !pointInPolygon(corner, polygon)
      const amount = outside ? distance + target : target - distance
      if (amount <= 1e-9) continue
      if (distance < 1e-12) continue
      const sign = outside ? 1 : -1
      const candidate = {
        dx: (sign * (q[0] - corner[0])) / distance,
        dz: (sign * (q[1] - corner[1])) / distance,
        amount,
      }
      if (!push || candidate.amount > push.amount) push = candidate
    }
    if (!push) {
      const shift = Math.hypot(x - position[0], z - position[1])
      return shift <= maxShift ? { position: [x, z], shift } : null
    }
    x += push.dx * push.amount
    z += push.dz * push.amount
    if (Math.hypot(x - position[0], z - position[1]) > maxShift) return null
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Layout relaxation: resolve noisy photo-estimated positions instead of rejecting objects.
// ---------------------------------------------------------------------------------------------

export type LayoutItem = {
  id: string
  position: [number, number]
  yaw: number
  /** Footprint size before yaw. */
  width: number
  depth: number
  /**
   * solid: stays inside the room, out of door zones, and apart from other solids.
   * flat: lies on the floor (a rug). Stays inside the room but never collides with anything.
   * stacked: rests on `supportId` (a lamp on a desk) and moves with it.
   */
  kind: 'solid' | 'flat' | 'stacked'
  supportId?: string
}

/** Penetration below this is left alone: it is within the accuracy of a photo estimate. */
const SEPARATION_TOLERANCE_M = 0.01
/** Extra gap added when separating, so rounding never leaves two pieces touching. */
const SEPARATION_MARGIN_M = 0.005
export const MAX_LAYOUT_SHIFT_M = 1.5

const centreOf = (polygon: readonly Point[]): Point => [
  polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length,
  polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length,
]

/**
 * Every straight push that separates two convex outlines, cheapest first. `axis` is the unit direction
 * `a` would move, and `depth` is how far. Both directions of each edge normal are offered, so a caller
 * can pick another way out when the cheapest one runs into a wall. Empty when they do not overlap.
 */
export function overlapCandidates(
  a: readonly Point[],
  b: readonly Point[],
): { axis: [number, number]; depth: number }[] {
  const seen = new Set<string>()
  const axes: [number, number][] = []
  for (const polygon of [a, b]) {
    polygon.forEach((point, index) => {
      const next = polygon[(index + 1) % polygon.length]!
      const x = -(next[1] - point[1])
      const z = next[0] - point[0]
      const length = Math.hypot(x, z) || 1
      let ax = x / length
      let az = z / length
      if (ax < -1e-9 || (Math.abs(ax) <= 1e-9 && az < 0)) {
        ax = -ax
        az = -az
      }
      const key = `${ax.toFixed(5)},${az.toFixed(5)}`
      if (!seen.has(key)) {
        seen.add(key)
        axes.push([ax, az])
      }
    })
  }
  const found: { axis: [number, number]; depth: number }[] = []
  for (const [x, z] of axes) {
    const pa = a.map((p) => p[0] * x + p[1] * z)
    const pb = b.map((p) => p[0] * x + p[1] * z)
    const towardPositive = Math.max(...pb) - Math.min(...pa)
    const towardNegative = Math.max(...pa) - Math.min(...pb)
    if (towardPositive <= 0 || towardNegative <= 0) return []
    found.push({ axis: [x, z], depth: towardPositive }, { axis: [-x, -z], depth: towardNegative })
  }
  return found.sort((p, q) => p.depth - q.depth)
}

/** The cheapest separating push, or null when the outlines do not overlap. */
export function overlapDepth(
  a: readonly Point[],
  b: readonly Point[],
): { axis: [number, number]; depth: number } | null {
  return overlapCandidates(a, b)[0] ?? null
}

/**
 * The floor area in front of a door that furniture must keep clear: the opening plus a small margin
 * at the wall, reaching `depth` metres into the room. Assumes a counter-clockwise outline, so the
 * room interior is to the left of each wall's direction.
 */
export function doorZone(
  polygon: readonly Point[],
  wallIndex: number,
  distanceAlongWall: number,
  width: number,
  depth: number,
): Point[] | null {
  const a = polygon[wallIndex]
  const b = polygon[(wallIndex + 1) % polygon.length]
  if (!a || !b) return null
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (!length) return null
  const d: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]
  const inward: Point = [-d[1], d[0]]
  const c: Point = [a[0] + d[0] * distanceAlongWall, a[1] + d[1] * distanceAlongWall]
  const half = width / 2 + 0.05
  const left: Point = [c[0] - d[0] * half, c[1] - d[1] * half]
  const right: Point = [c[0] + d[0] * half, c[1] + d[1] * half]
  return [
    left,
    right,
    [right[0] + inward[0] * depth, right[1] + inward[1] * depth],
    [left[0] + inward[0] * depth, left[1] + inward[1] * depth],
  ]
}

/**
 * Moves items the least amount that puts them inside the room, out of door zones and apart from each
 * other. Larger pieces move less than smaller ones. Nothing moves more than `maxTotalShift` from where
 * the photos put it, so a genuinely wrong estimate is still left for validation to report.
 */
export function relaxLayout(
  polygon: readonly Point[],
  items: readonly LayoutItem[],
  zones: readonly (readonly Point[])[],
  clearance: number,
  options: { maxTotalShift?: number; iterations?: number } = {},
): Map<string, [number, number]> {
  const maxTotal = options.maxTotalShift ?? MAX_LAYOUT_SHIFT_M
  const iterations = options.iterations ?? 60
  const origin = new Map(items.map((i) => [i.id, [...i.position] as [number, number]]))
  const pos = new Map(items.map((i) => [i.id, [...i.position] as [number, number]]))
  const onFloor = items.filter((i) => i.kind !== 'stacked')
  const solids = items.filter((i) => i.kind === 'solid')
  const corners = (i: LayoutItem) => footprintCorners(pos.get(i.id)!, i.yaw, i.width, i.depth)
  const isClear = (i: LayoutItem, p: readonly [number, number]) =>
    footprintCorners(p, i.yaw, i.width, i.depth).every(
      (c) => pointInPolygon(c, polygon) && nearestBoundary(c, polygon).distance >= clearance - 1e-6,
    )
  const moved = (i: LayoutItem, dx: number, dz: number): [number, number] => {
    const p = pos.get(i.id)!
    return [p[0] + dx, p[1] + dz]
  }
  const shove = (i: LayoutItem, dx: number, dz: number) => {
    const p = pos.get(i.id)!
    p[0] += dx
    p[1] += dz
  }

  const withinBudget = (item: LayoutItem, candidate: readonly [number, number]) => {
    const start = origin.get(item.id)!
    return Math.hypot(candidate[0] - start[0], candidate[1] - start[1]) <= maxTotal + 1e-8
  }
  const candidateMove = (item: LayoutItem, dx: number, dz: number, amount: number) => {
    const p = pos.get(item.id)!
    const candidate: [number, number] = [p[0] + dx * amount, p[1] + dz * amount]
    return withinBudget(item, candidate) && isClear(item, candidate) ? candidate : null
  }
  const applyMove = (item: LayoutItem, candidate: [number, number]) => {
    const p = pos.get(item.id)!
    const distance = Math.hypot(candidate[0] - p[0], candidate[1] - p[1])
    pos.set(item.id, candidate)
    return distance
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    let largest = 0

    // 1. Keep every floor object's full rotated footprint inside the room and clear of walls.
    // Only accept the correction when it remains within the object's total movement budget.
    for (const item of onFloor) {
      const current = pos.get(item.id)!
      const fit = nudgeInside(
        polygon,
        current,
        item.yaw,
        item.width,
        item.depth,
        clearance,
        maxTotal,
      )
      if (!fit || !withinBudget(item, fit.position)) continue
      if (fit.shift > 1e-6) largest = Math.max(largest, applyMove(item, fit.position))
    }

    // 2. Clear door zones. Never use an unverified fallback axis: that used to push objects
    // through walls and then clamp them back into the doorway, leaving the original collision.
    for (const item of solids) {
      for (const zone of zones) {
        const options = overlapCandidates(corners(item), zone)
        if (!options.length || options[0]!.depth <= SEPARATION_TOLERANCE_M) continue
        const way = options.find((option) =>
          candidateMove(item, option.axis[0], option.axis[1], option.depth + SEPARATION_MARGIN_M),
        )
        if (!way) continue
        const candidate = candidateMove(
          item,
          way.axis[0],
          way.axis[1],
          way.depth + SEPARATION_MARGIN_M,
        )
        if (candidate) largest = Math.max(largest, applyMove(item, candidate))
      }
    }

    // 3. Separate solid furniture. The larger footprint yields less; prefer a valid move that
    // keeps both pieces in the room and inside their individual movement budgets. If splitting
    // the movement is impossible, try moving the smaller piece alone before giving up.
    for (let i = 0; i < solids.length; i++) {
      for (let j = i + 1; j < solids.length; j++) {
        const a = solids[i]!
        const b = solids[j]!
        const options = overlapCandidates(corners(a), corners(b))
        if (!options.length || options[0]!.depth <= SEPARATION_TOLERANCE_M) continue
        const areaA = Math.max(a.width * a.depth, 1e-6)
        const areaB = Math.max(b.width * b.depth, 1e-6)
        const shareA = areaB / (areaA + areaB)
        let resolved = false

        for (const option of options) {
          const push = option.depth + SEPARATION_MARGIN_M
          const moveA = candidateMove(a, option.axis[0], option.axis[1], push * shareA)
          const moveB = candidateMove(b, -option.axis[0], -option.axis[1], push * (1 - shareA))
          if (!moveA || !moveB) continue
          largest = Math.max(largest, applyMove(a, moveA), applyMove(b, moveB))
          resolved = true
          break
        }

        if (!resolved) {
          const smaller = areaA <= areaB ? a : b
          for (const option of options) {
            const direction =
              smaller === a ? option.axis : ([-option.axis[0], -option.axis[1]] as [number, number])
            const candidate = candidateMove(
              smaller,
              direction[0],
              direction[1],
              option.depth + SEPARATION_MARGIN_M,
            )
            if (!candidate) continue
            largest = Math.max(largest, applyMove(smaller, candidate))
            resolved = true
            break
          }
        }
      }
    }

    if (largest < 1e-3) break
  }

  // Stacked items travel with whatever they rest on.
  for (const item of items) {
    if (item.kind !== 'stacked' || !item.supportId) continue
    const support = pos.get(item.supportId)
    const supportOrigin = origin.get(item.supportId)
    const o = origin.get(item.id)!
    if (support && supportOrigin)
      pos.set(item.id, [o[0] + support[0] - supportOrigin[0], o[1] + support[1] - supportOrigin[1]])
  }
  return pos
}
