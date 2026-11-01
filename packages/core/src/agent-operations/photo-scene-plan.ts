import { z } from 'zod'

const Point2D = z.tuple([z.number().finite(), z.number().finite()])

// Plan coordinates are room-local metres. Polygon vertices run counter-clockwise
// in the plan's X/Z axes; each opening measures from a vertex toward the next.

const PhotoOpeningPlanSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    wallIndex: z.number().int().nonnegative(),
    /** Metres from polygon[wallIndex] along its edge toward the next vertex. */
    distanceAlongWall: z.number().finite().nonnegative(),
    confidence: z.number().min(0).max(1).optional(),
    width: z.number().positive(),
    height: z.number().positive(),
    sillHeight: z.number().nonnegative().optional(),
    hingesSide: z.enum(['left', 'right']).optional(),
    swingDirection: z.enum(['inward', 'outward']).optional(),
    style: z.string().optional(),
  })
  .strict()

const PhotoObjectFields = {
  id: z.string().trim().min(1).max(120),
  objectType: z.string().trim().min(1).max(120),
  dimensions: z.tuple([
    z.number().positive().max(20),
    z.number().positive().max(10),
    z.number().positive().max(20),
  ]),
  position: Point2D,
  // Radians, as used for the item's Y rotation. A larger magnitude almost always means
  // the model answered in degrees, which would silently turn the object the wrong way.
  yaw: z
    .number()
    .finite()
    .min(
      -2 * Math.PI - 1e-6,
      'yaw must be in radians (|yaw| <= 2*pi); got a value that looks like degrees',
    )
    .max(
      2 * Math.PI + 1e-6,
      'yaw must be in radians (|yaw| <= 2*pi); got a value that looks like degrees',
    ),
  assetId: z.string().trim().min(1).max(120).optional(),
  assetCategory: z.string().trim().min(1).max(120).optional(),
  confidence: z.number().min(0).max(1),
  uncertainties: z.array(z.string().trim().min(1).max(300)).default([]),
  groupId: z.string().trim().min(1).max(120).optional(),
}

export const PHOTO_OBJECT_CATEGORIES = [
  'picture',
  'noticeboard',
  'curtain',
  'shelf',
  'book',
  'bed',
  'wardrobe',
  'drawer',
  'desk',
  'sofa',
  'chair',
  'table',
  'stand',
  'bin',
  'light',
  'rug',
  'other',
] as const

const WallMountedPhotoObject = z
  .object({
    ...PhotoObjectFields,
    category: z.enum(PHOTO_OBJECT_CATEGORIES.slice(0, 5)),
    originalCategory: z.string().trim().min(1).max(120).optional(),
    /** Centre height above the finished floor, in metres. */
    elevation: z.number().finite().nonnegative().max(10).optional(),
  })
  .strict()
  .superRefine((object, ctx) => {
    if (object.elevation === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['elevation'],
        message: `Wall-mounted ${object.category} requires an evidence-based centre elevation above the finished floor; infer it from the photos or report the unresolved placement instead of guessing.`,
      })
    }
  })

const FloorPlacedPhotoObject = z
  .object({
    ...PhotoObjectFields,
    category: z.enum(PHOTO_OBJECT_CATEGORIES.slice(5)),
    originalCategory: z.string().trim().min(1).max(120).optional(),
    elevation: z.number().finite().nonnegative().max(10).optional(),
  })
  .strict()

export const PhotoObject = z.discriminatedUnion('category', [
  WallMountedPhotoObject,
  FloorPlacedPhotoObject,
])

const PhotoRoom = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    type: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1),
    polygon: z.array(Point2D).min(3),
    wallHeight: z.number().positive(),
    wallThickness: z.number().positive(),
    doors: z.array(PhotoOpeningPlanSchema).optional(),
    windows: z.array(PhotoOpeningPlanSchema).optional(),
    objects: z.array(PhotoObject).max(200).optional().default([]),
    /** Wall-mounted objects whose height could not be read from the photos. Reported, never placed. */
    unresolvedObjects: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            objectType: z.string().trim().min(1).max(120),
            category: z.string().trim().min(1).max(120),
            reason: z.string().trim().min(1).max(300),
          })
          .strict(),
      )
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    scale: z
      .object({
        basis: z.enum(['known-measurement', 'visual-reference', 'estimated']),
        uncertainty: z.number().min(0).max(1),
        reference: z.string().trim().min(1).max(300).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const PhotoScenePlanObjectSchema = z
  .object({
    version: z.literal(1),
    units: z.literal('metres'),
    rooms: z.array(PhotoRoom).min(1).max(100),
    source: z
      .object({
        kind: z.literal('smartphone-images'),
        imageCount: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const names = new Set<string>()

    plan.rooms.forEach((room, index) => {
      const normalizedName = room.name.trim().toLowerCase()

      if (names.has(normalizedName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rooms', index, 'name'],
          message: `Duplicate room name "${room.name}"`,
        })
      }
      names.add(normalizedName)

      try {
        validatePolygon(room.polygon, `rooms[${index}].polygon`)
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rooms', index, 'polygon'],
          message: error instanceof Error ? error.message : 'Invalid room polygon',
        })
      }

      for (const [kind, openings] of [
        ['doors', room.doors ?? []],
        ['windows', room.windows ?? []],
      ] as const) {
        openings.forEach((opening, openingIndex) => {
          const path = ['rooms', index, kind, openingIndex]

          if (opening.wallIndex >= room.polygon.length) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, 'wallIndex'],
              message: 'wallIndex is outside the polygon',
            })
            return
          }

          const a = room.polygon[opening.wallIndex]!
          const b = room.polygon[(opening.wallIndex + 1) % room.polygon.length]!
          const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1])

          if (
            opening.distanceAlongWall > edgeLength ||
            opening.distanceAlongWall < opening.width / 2 ||
            edgeLength - opening.distanceAlongWall < opening.width / 2
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, 'distanceAlongWall'],
              message: 'Opening centre and width must fit on the declared wall segment',
            })
          }

          if (opening.width >= edgeLength) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, 'width'],
              message: 'Opening width must be smaller than its wall edge',
            })
          }
          if (
            room.wallHeight !== undefined &&
            (opening.sillHeight ?? 0) + opening.height > room.wallHeight
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, 'height'],
              message: 'Opening exceeds the room wall height',
            })
          }
        })
      }
    })
  })

/**
 * Vision models often return a room outline clockwise even when asked for counter-clockwise, and
 * "counter-clockwise" is ambiguous between plan axes and screen axes. The outline describes the
 * same room either way, so reverse it here instead of rejecting the plan. Wall k of the old outline
 * becomes wall n-1-k of the new one, and each opening is measured from the other end of its wall,
 * so every door and window stays exactly where it was. Anything this cannot interpret is returned
 * untouched for the schema to report.
 */
export function normalizePhotoPlanWinding(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.rooms)) return input
  return { ...input, rooms: input.rooms.map(normalizeRoomWinding) }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPlanPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((n) => typeof n === 'number' && Number.isFinite(n))

function normalizeRoomWinding(room: unknown): unknown {
  if (
    !isRecord(room) ||
    !Array.isArray(room.polygon) ||
    room.polygon.length < 3 ||
    !room.polygon.every(isPlanPoint)
  )
    return room
  const polygon = room.polygon as [number, number][]
  if (signedPolygonArea(polygon) >= 0) return room

  const n = polygon.length
  const reversed = polygon.map((_, i) => polygon[(n - i) % n]!)
  const remap = (opening: unknown) => {
    if (
      !isRecord(opening) ||
      typeof opening.wallIndex !== 'number' ||
      !Number.isInteger(opening.wallIndex) ||
      opening.wallIndex < 0 ||
      opening.wallIndex >= n ||
      typeof opening.distanceAlongWall !== 'number'
    )
      return opening
    const a = polygon[opening.wallIndex]!
    const b = polygon[(opening.wallIndex + 1) % n]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    return {
      ...opening,
      wallIndex: n - 1 - opening.wallIndex,
      distanceAlongWall: Math.min(length, Math.max(0, length - opening.distanceAlongWall)),
    }
  }
  return {
    ...room,
    polygon: reversed,
    ...(Array.isArray(room.doors) ? { doors: room.doors.map(remap) } : {}),
    ...(Array.isArray(room.windows) ? { windows: room.windows.map(remap) } : {}),
  }
}

/**
 * Two repairs for common model slips, so one flaw in one object cannot discard the whole plan:
 * - A wall-mounted object (picture, noticeboard, curtain, shelf, book) with no height above the floor
 *   is set aside in `unresolvedObjects`. The schema refuses to guess a height, and the caller reports it.
 * - A rotation far outside +-2*pi was almost certainly written in degrees, so it is converted, and the
 *   object's uncertainties say so.
 */
export function normalizePhotoObjects(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.rooms)) return input
  return { ...input, rooms: input.rooms.map(normalizeRoomObjects) }
}

function normalizeRoomObjects(room: unknown): unknown {
  if (!isRecord(room) || !Array.isArray(room.objects)) return room
  const wallMounted = PHOTO_OBJECT_CATEGORIES.slice(0, 5) as readonly string[]
  const kept: unknown[] = []
  const unresolved: unknown[] = Array.isArray(room.unresolvedObjects)
    ? [...room.unresolvedObjects]
    : []
  let changed = false
  const validCategories = new Set<string>(PHOTO_OBJECT_CATEGORIES)

  for (const object of room.objects) {
    if (!isRecord(object)) {
      kept.push(object)
      continue
    }
    const rawCategory = typeof object.category === 'string' ? object.category : ''
    // Gemini sometimes returns free-text values like "furniture" or "storage unit".
    // Map anything not in the canonical list to "other" so parsing succeeds.
    const category = validCategories.has(rawCategory) ? rawCategory : 'other'
    if (rawCategory && rawCategory !== category) {
      changed = true
      if (!object.originalCategory) object.originalCategory = rawCategory
    }

    if (
      typeof object.yaw === 'number' &&
      Number.isFinite(object.yaw) &&
      Math.abs(object.yaw) > 2 * Math.PI + 1e-6
    ) {
      changed = true
      const notes = Array.isArray(object.uncertainties) ? object.uncertainties : []
      kept.push({
        ...object,
        yaw: (object.yaw * Math.PI) / 180,
        uncertainties: [...notes, `Rotation was given as ${object.yaw} and read as degrees.`],
      })
      continue
    }
    kept.push(object)
  }

  if (!changed) return room
  return { ...room, objects: kept, ...(unresolved.length ? { unresolvedObjects: unresolved } : {}) }
}

/** Everything applied to a model's raw plan before validation. */
export function normalizePhotoPlan(input: unknown): unknown {
  return normalizePhotoObjects(normalizePhotoPlanWinding(input))
}

export const PhotoScenePlanSchema = z.preprocess(normalizePhotoPlan, PhotoScenePlanObjectSchema)

export type PhotoScenePlan = z.infer<typeof PhotoScenePlanSchema>
export type PhotoRoomPlan = PhotoScenePlan['rooms'][number]
export type PhotoOpeningPlan = z.infer<typeof PhotoOpeningPlanSchema>
export type PhotoObjectPlan = z.infer<typeof PhotoObject>

type Point = readonly [number, number]

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  const epsilon = 1e-9
  return (
    Math.abs(cross(a, b, p)) <= epsilon &&
    p[0] >= Math.min(a[0], b[0]) - epsilon &&
    p[0] <= Math.max(a[0], b[0]) + epsilon &&
    p[1] >= Math.min(a[1], b[1]) - epsilon &&
    p[1] <= Math.max(a[1], b[1]) + epsilon
  )
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const epsilon = 1e-9
  const abC = cross(a, b, c)
  const abD = cross(a, b, d)
  const cdA = cross(c, d, a)
  const cdB = cross(c, d, b)

  if (
    ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
    ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))
  ) {
    return true
  }

  return (
    (Math.abs(abC) <= epsilon && onSegment(a, b, c)) ||
    (Math.abs(abD) <= epsilon && onSegment(a, b, d)) ||
    (Math.abs(cdA) <= epsilon && onSegment(c, d, a)) ||
    (Math.abs(cdB) <= epsilon && onSegment(c, d, b))
  )
}

function signedPolygonArea(polygon: readonly Point[]): number {
  let twiceArea = 0

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    twiceArea += a[0] * b[1] - b[0] * a[1]
  }

  return twiceArea / 2
}

function validatePolygon(polygon: readonly Point[], path: string): void {
  if (signedPolygonArea(polygon) <= 0.01) {
    throw new Error(
      `${path}: room polygon must be counter-clockwise in room-local X/Z axes and exceed 0.01 m²`,
    )
  }

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!

    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.01) {
      throw new Error(`${path}: edge ${i} is too short`)
    }

    for (let j = i + 1; j < polygon.length; j++) {
      // Consecutive edges share a vertex by design.
      if (j === i || j === (i + 1) % polygon.length || i === (j + 1) % polygon.length) {
        continue
      }

      const c = polygon[j]!
      const d = polygon[(j + 1) % polygon.length]!

      if (segmentsIntersect(a, b, c, d)) {
        throw new Error(`${path}: edges ${i} and ${j} intersect`)
      }
    }
  }
}

export function parsePhotoScenePlan(input: unknown): PhotoScenePlan {
  const plan = PhotoScenePlanSchema.parse(input)
  const names = new Set<string>()

  plan.rooms.forEach((room, index) => {
    const path = `rooms[${index}]`
    const normalizedName = room.name.trim().toLowerCase()

    if (names.has(normalizedName)) {
      throw new Error(`${path}: duplicate room name "${room.name}"`)
    }
    names.add(normalizedName)

    validatePolygon(room.polygon, `${path}.polygon`)
  })

  return plan
}

/**
 * Converts validated rooms into inputs for Pascal's existing create_room
 * operation. This does not mutate the scene.
 */
export function toCreateRoomRequests(plan: PhotoScenePlan, levelId: string) {
  if (!levelId.trim()) {
    throw new Error('levelId must not be empty')
  }

  return plan.rooms.map((room) => {
    const opening = (value: PhotoOpeningPlan) => {
      const { id: _id, confidence: _confidence, distanceAlongWall, ...spec } = value
      const a = room.polygon[value.wallIndex]!
      const b = room.polygon[(value.wallIndex + 1) % room.polygon.length]!
      const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1])
      return { ...spec, t: distanceAlongWall / edgeLength }
    }
    return {
      levelId,
      name: room.name,
      polygon: room.polygon.map(([x, z]) => [x, z]),
      ...(room.wallHeight === undefined ? {} : { wallHeight: room.wallHeight }),
      ...(room.wallThickness === undefined ? {} : { wallThickness: room.wallThickness }),
      ...(room.doors === undefined ? {} : { doors: room.doors.map(opening) }),
      ...(room.windows === undefined ? {} : { windows: room.windows.map(opening) }),
    }
  })
}

/** Preserve the room-local X/Z frame for geometry and object centres. */
export function canonicalizePhotoRoom<T extends PhotoRoomPlan>(room: T): T {
  return {
    ...room,
    polygon: room.polygon.map(([x, z]) => [x, z]) as T['polygon'],
    objects: room.objects.map((object) => ({ ...object })),
  }
}

/** Keep one observation per stable model-assigned identity, preferring the clearest view. */
export function deduplicatePhotoObjects<T extends PhotoObjectPlan>(objects: readonly T[]): T[] {
  const byId = new Map<string, T>()
  for (const object of objects) {
    const existing = byId.get(object.id)
    if (!existing || object.confidence > existing.confidence) byId.set(object.id, object)
  }
  return [...byId.values()]
}
