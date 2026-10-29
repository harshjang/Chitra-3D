import { reconcileSceneStructure } from '../lib/structure-reconcile'
import { type AnyNode, generateId, ItemNode } from '../schema'
import { applySceneChanges } from './apply-changes'
import { type AgentHostRuntime, applyAgentOutcome } from './apply-outcome'
import { createRoom } from './create-room'
import {
  describeMisfit,
  doorZone,
  type LayoutItem,
  MAX_AUTO_FIT_M,
  nudgeInside,
  overlapDepth,
  relaxLayout,
} from './photo-object-fit'
import {
  isWallMountedPhotoCategory,
  photoObjectFootprintDimensions,
  photoObjectTransform,
  resolvePhotoSceneAsset,
} from './photo-scene-assets'
import type { PhotoObjectPlan, PhotoRoomPlan } from './photo-scene-plan'
import {
  canonicalizePhotoRoom,
  deduplicatePhotoObjects,
  parsePhotoScenePlan,
  toCreateRoomRequests,
} from './photo-scene-plan'
import type { AgentContext, SceneNodes } from './types'

type Point = readonly [number, number]
type PlannedObject = { room: PhotoRoomPlan; object: PhotoObjectPlan }

function objectFootprint(object: PlannedObject['object'], dimensions = object.dimensions): Point[] {
  const [width, , depth] = dimensions
  const c = Math.cos(object.yaw)
  const s = Math.sin(object.yaw)
  const corners: Point[] = [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ]
  return corners.map(([x, z]) => [
    object.position[0] + x * c + z * s,
    object.position[1] - x * s + z * c,
  ])
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
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

function segmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const t = Math.max(
    0,
    Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (dx * dx + dz * dz)),
  )
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz)
}

/** Furniture that merely touches is not intersecting: photo estimates are good to a few cm. */
const OVERLAP_TOLERANCE_M = 0.03

function footprintsOverlap(
  a: readonly Point[],
  b: readonly Point[],
  tolerance = OVERLAP_TOLERANCE_M,
): boolean {
  const axes = [a, b].flatMap((polygon) =>
    polygon.map((point, index) => {
      const next = polygon[(index + 1) % polygon.length]!
      const x = -(next[1] - point[1])
      const z = next[0] - point[0]
      const length = Math.hypot(x, z) || 1
      return [x / length, z / length] as const
    }),
  )
  return axes.every(([x, z]) => {
    const pa = a.map((point) => point[0] * x + point[1] * z)
    const pb = b.map((point) => point[0] * x + point[1] * z)
    // Penetration depth along this axis, in metres.
    return (
      Math.min(Math.max(...pa) - Math.min(...pb), Math.max(...pb) - Math.min(...pa)) > tolerance
    )
  })
}

function validateObjectPlacement<
  T extends {
    object: PhotoObjectPlan
    asset: NonNullable<ReturnType<typeof resolvePhotoSceneAsset>>
    baseY?: number
  },
>(room: PhotoRoomPlan, objects: readonly T[]): { accepted: T[]; rejected: SkippedPhotoObject[] } {
  const polygon = room.polygon as readonly Point[]
  const placed: { id: string; footprint: Point[]; bottom: number; top: number }[] = []
  const rejected: SkippedPhotoObject[] = []
  const accepted: T[] = []
  for (const entry of objects) {
    const { object, asset } = entry
    try {
      const wallMounted = isWallMountedPhotoCategory(object.category)
      const flat = (entry.asset.surface?.height ?? 1) < 0.05
      const baseY = entry.baseY ?? 0
      const bottom = wallMounted ? object.elevation! - object.dimensions[1] / 2 : baseY
      const top = wallMounted
        ? object.elevation! + object.dimensions[1] / 2
        : baseY + object.dimensions[1]
      if (bottom < 0 || top > room.wallHeight)
        throw new Error(
          `Object "${object.objectType}" (${object.id}) exceeds the inferred room height in "${room.name}".`,
        )
      const [width, depth] = photoObjectFootprintDimensions(object, asset)
      const footprint = objectFootprint(object, [width, object.dimensions[1], depth])
      for (const [index, point] of footprint.entries()) {
        if (!pointInPolygon(point, polygon))
          throw new Error(
            `Object "${object.objectType}" (${object.id}) extends outside room "${room.name}": ${describeMisfit(polygon, object.position, object.yaw, width, depth)}.`,
          )
        const distance = Math.min(
          ...polygon.map((edge, i) =>
            segmentDistance(point, edge, polygon[(i + 1) % polygon.length]!),
          ),
        )
        const requiredClearance = room.wallThickness / 2 + 0.025
        if (distance < requiredClearance)
          throw new Error(
            `Object "${object.objectType}" (${object.id}) has less than ${requiredClearance.toFixed(3)} m wall clearance in room "${room.name}".`,
          )
      }
      if (!wallMounted && !flat && baseY === 0) {
        for (const opening of room.doors ?? []) {
          const zone = doorZone(
            polygon,
            opening.wallIndex,
            opening.distanceAlongWall,
            opening.width,
            doorClearDepth(opening),
          )
          if (zone && (overlapDepth(footprint, zone)?.depth ?? 0) > OVERLAP_TOLERANCE_M)
            throw new Error(
              `Object "${object.objectType}" (${object.id}) blocks a door opening in room "${room.name}".`,
            )
        }
      }
      for (const previous of flat ? [] : placed) {
        const verticalOverlap = Math.min(top, previous.top) - Math.max(bottom, previous.bottom)
        if (
          verticalOverlap > OVERLAP_TOLERANCE_M &&
          footprintsOverlap(footprint, previous.footprint)
        )
          throw new Error(
            `Objects "${previous.id}" and "${object.id}" intersect in room "${room.name}".`,
          )
      }
      if (!flat) placed.push({ id: object.id, footprint, bottom, top })
      accepted.push(entry)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      rejected.push({
        id: object.id,
        category: object.category ?? 'other',
        objectType: object.objectType,
        room: room.name,
        reason: message.replace(/\s*\([^)]+\)/g, '').split('.')[0] ?? message,
        detail: message,
      })
    }
  }
  return { accepted, rejected }
}

/**
 * Builds a photo-derived plan with Pascal's native room operation.
 *
 * The plan is validated and preflighted against a simulated scene before
 * the real runtime is changed. Each room is then applied through the host's
 * normal reconciliation path.
 */
function doorClearDepth(opening: { width: number; swingDirection?: 'inward' | 'outward' }): number {
  // Outward doors only need a landing; inward doors need the full swing arc.
  return opening.swingDirection === 'outward' ? opening.width * 0.4 : opening.width
}

/** Use the catalog surface field to decide if a small object can rest on another. */
const MAX_STACK_AREA_RATIO = 0.35

type LayoutEntry = {
  room: PhotoRoomPlan
  object: PhotoObjectPlan
  asset: NonNullable<ReturnType<typeof resolvePhotoSceneAsset>>
  /** Height above the floor that this object's origin sits at (e.g. lamp on a desk). */
  baseY?: number
}

function footprintArea(entry: LayoutEntry): number {
  const [width, depth] = photoObjectFootprintDimensions(entry.object, entry.asset)
  return width * depth
}

/**
 * Photo estimates are noisy, so rather than rejecting an object that is a little off, settle the
 * room: pull furniture inside the walls, out of doorways and apart from its neighbours, and rest small
 * items (a lamp) on the larger piece (the desk) they were seen on.
 */
function layoutRoomObjects<T extends LayoutEntry>(
  room: PhotoRoomPlan,
  entries: readonly T[],
): (T & { baseY?: number })[] {
  const polygon = room.polygon as readonly Point[]
  const clearance = room.wallThickness / 2 + 0.025
  const floor = entries.filter((entry) => !isWallMountedPhotoCategory(entry.object.category))

  // What rests on what.
  const supportOf = new Map<string, T>()
  for (const small of floor) {
    // An object rests on a surface if the supporting model declares a surface height.
    if (!floor.some((big) => big !== small && big.asset.surface != null)) continue
    const centre = small.object.position as Point
    const holders = floor
      .filter((big) => {
        if (big === small || (big.asset.surface?.height ?? 1) < 0.05) return false
        if (big.asset.surface == null) return false // cannot rest on this piece
        if (footprintArea(small) > footprintArea(big) * MAX_STACK_AREA_RATIO) return false
        const [bw, bd] = photoObjectFootprintDimensions(big.object, big.asset)
        return pointInPolygon(
          centre,
          objectFootprint(big.object, [bw, big.object.dimensions[1], bd]),
        )
      })
      .sort((a, b) => footprintArea(a) - footprintArea(b))
    if (holders[0]) supportOf.set(small.object.id, holders[0])
  }

  const items: LayoutItem[] = floor.map((entry) => {
    const [width, depth] = photoObjectFootprintDimensions(entry.object, entry.asset)
    const support = supportOf.get(entry.object.id)
    return {
      id: entry.object.id,
      position: [...entry.object.position] as [number, number],
      yaw: entry.object.yaw,
      width,
      depth,
      kind: (entry.asset.surface?.height ?? 1) < 0.05 ? 'flat' : support ? 'stacked' : 'solid',
      ...(support ? { supportId: support.object.id } : {}),
    }
  })
  const zones = (room.doors ?? []).flatMap((opening) => {
    const zone = doorZone(
      polygon,
      opening.wallIndex,
      opening.distanceAlongWall,
      opening.width,
      doorClearDepth(opening),
    )
    return zone ? [zone] : []
  })
  const positions = relaxLayout(polygon, items, zones, clearance)

  return entries.map((entry) => {
    const { object, asset } = entry
    let position = object.position as [number, number]
    let note = ''
    if (isWallMountedPhotoCategory(object.category)) {
      // Hung on a wall: only nudge it inside, as before.
      const [width, depth] = photoObjectFootprintDimensions(object, asset)
      const fit = nudgeInside(
        polygon,
        position,
        object.yaw,
        width,
        depth,
        clearance,
        MAX_AUTO_FIT_M,
      )
      if (fit && fit.shift > 1e-6) {
        position = fit.position
        note = `Position moved ${fit.shift.toFixed(2)} m inward to fit inside the room.`
      }
    } else {
      const next = positions.get(object.id)
      if (next) {
        const shift = Math.hypot(next[0] - position[0], next[1] - position[1])
        if (shift > 1e-6) {
          position = next
          note = `Position adjusted by ${shift.toFixed(2)} m to fit the room.`
        }
      }
    }
    const holder = supportOf.get(object.id)
    const baseY = holder
      ? (() => {
          const native = holder.asset.dimensions ?? [1, 1, 1]
          const sc = Math.sqrt(
            (holder.object.dimensions[0] / native[0]) * (holder.object.dimensions[2] / native[2]),
          )
          return native[1] * sc
        })()
      : undefined
    if (!note && baseY === undefined) return entry
    return {
      ...entry,
      ...(baseY === undefined ? {} : { baseY }),
      object: {
        ...object,
        position,
        uncertainties: [
          ...(object.uncertainties ?? []),
          ...(note ? [note] : []),
          ...(holder ? [`Placed on the ${holder.object.objectType}.`] : []),
        ],
      },
    }
  })
}

export type SkippedPhotoObject = {
  id: string
  category: string
  objectType: string
  room: string
  /** Short, plain-language reason. */
  reason: string
  /** Full technical message, for debugging. */
  detail?: string
}

export function executePhotoScenePlan(
  input: unknown,
  levelId: string,
  context: AgentContext,
  runtime: AgentHostRuntime,
) {
  const plan = parsePhotoScenePlan(input)
  const requests = toCreateRoomRequests(plan, levelId)
  const objectPlans: PlannedObject[] = plan.rooms.flatMap((sourceRoom) => {
    const room = canonicalizePhotoRoom(sourceRoom)
    return deduplicatePhotoObjects(room.objects).map((object) => ({ room, object }))
  })
  const catalog = context.catalog ?? []
  const resolveAsset = (object: (typeof objectPlans)[number]['object']) =>
    resolvePhotoSceneAsset(object, catalog)
  // An object with no matching catalog model is left out and reported to the caller. No substitute
  // is placed, and the room is still built, so one missing model (a curtain) cannot block everything.
  const objectsSkipped: SkippedPhotoObject[] = plan.rooms.flatMap((sourceRoom) =>
    (sourceRoom.unresolvedObjects ?? []).map((item) => ({
      id: item.id,
      category: item.category ?? 'other',
      objectType: item.objectType,
      room: sourceRoom.name,
      reason: item.reason,
    })),
  )
  const objectsWithAssets = objectPlans.flatMap((entry) => {
    const asset = resolveAsset(entry.object)
    if (!asset) {
      objectsSkipped.push({
        id: entry.object.id,
        category: entry.object.category ?? 'other',
        objectType: entry.object.objectType,
        room: entry.room.name,
        reason: 'No matching model in the catalog',
      })
      return []
    }
    return [{ ...entry, asset }]
  })
  const fittedObjects = [...new Set(objectsWithAssets.map(({ room }) => room))].flatMap((room) =>
    layoutRoomObjects(
      room,
      objectsWithAssets.filter((entry) => entry.room === room),
    ),
  )
  const placeable: typeof fittedObjects = []
  for (const room of new Set(fittedObjects.map(({ room }) => room))) {
    const { accepted, rejected } = validateObjectPlacement(
      room,
      fittedObjects.filter((entry) => entry.room === room),
    )
    placeable.push(...accepted)
    objectsSkipped.push(...rejected)
  }

  // Preflight all rooms in sequence against a private scene copy. This catches
  // foreseeable geometry and room-conflict failures before touching the host.
  let simulated = structuredClone(runtime.getNodes()) as Record<string, AnyNode>

  const simulateRuntime: AgentHostRuntime = {
    getNodes: () => simulated,
    applyChanges: (changes) => {
      simulated = applySceneChanges(simulated, changes) as Record<string, AnyNode>
    },
    reconcile: () => {
      simulated = reconcileSceneStructure({
        nodes: simulated,
        mintId: (kind) => generateId(kind),
      }).nodes as Record<string, AnyNode>
    },
  }

  for (const request of requests) {
    const outcome = createRoom(simulated, request as Parameters<typeof createRoom>[1], context)
    const result = outcome.result as {
      skippedOpenings?: Array<{ kind: string; index: number; message: string }>
      doorIds?: string[]
      windowIds?: string[]
    }
    if (
      result.skippedOpenings?.length ||
      (result.doorIds?.length ?? 0) !== (request.doors?.length ?? 0) ||
      (result.windowIds?.length ?? 0) !== (request.windows?.length ?? 0)
    ) {
      const details = result.skippedOpenings?.map((opening) => opening.message).join(' ')
      throw new Error(
        `Could not convert every inferred opening in room "${request.name}" into a native wall opening.${details ? ` ${details}` : ''}`,
      )
    }
    applyAgentOutcome(outcome, simulateRuntime)
  }

  // Validate every inferred object before mutating the live scene. Silently
  // dropping low confidence objects made failed inference look like a valid,
  // incomplete reconstruction.
  const objectNodes = placeable.map(({ room, object, asset, baseY }) => {
    const safeId = object.id
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 80)
    const transform = photoObjectTransform(object, asset, baseY ?? 0)
    const node = ItemNode.parse({
      id: `item_photo_${safeId}`,
      name: object.objectType,
      parentId: levelId,
      ...transform,
      asset,
      metadata: {
        photoReconstructionId: object.id,
        inferredConfidence: object.confidence,
        inferredUncertainties: object.uncertainties,
        roomName: room.name,
        ...(room.scale ? { inferredScale: room.scale } : {}),
      },
    })
    return { node, parentId: levelId }
  })

  // Only execute after the full plan has passed preflight.
  const results: Record<string, unknown>[] = []

  for (const request of requests) {
    const currentNodes: SceneNodes = runtime.getNodes()
    const outcome = createRoom(currentNodes, request as Parameters<typeof createRoom>[1], context)
    results.push(applyAgentOutcome(outcome, runtime))
  }

  const current = runtime.getNodes()
  const collision = objectNodes.find(
    ({ node }) =>
      current[node.id] &&
      current[node.id]?.metadata?.photoReconstructionId !== node.metadata?.photoReconstructionId,
  )
  if (collision)
    throw new Error(
      `Generated object id ${collision.node.id} conflicts with an existing scene node.`,
    )
  const create = objectNodes.filter(({ node }) => !current[node.id])
  const update = objectNodes.flatMap(({ node }) =>
    current[node.id]?.type === 'item' ? [{ id: node.id, data: node }] : [],
  )
  runtime.applyChanges({ create, update })

  return {
    ok: true,
    roomsRequested: requests.length,
    roomsCreated: results.length,
    objectsPlaced: objectNodes.length,
    objectsSkipped,
    /** Model files the placed objects use, so a caller can load them before showing the scene. */
    assetUrls: [
      ...new Set(
        placeable
          .map(({ asset }) => asset.src)
          .filter((src): src is string => typeof src === 'string'),
      ),
    ],
    results,
  }
}
