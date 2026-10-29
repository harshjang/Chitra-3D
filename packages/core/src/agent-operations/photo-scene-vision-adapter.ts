import {
  PhotoCaptureManifestSchema,
  type PhotoSceneInferenceBundle,
  PhotoSceneInferenceBundleSchema,
} from './photo-scene-inference'
import type { PhotoOpeningPlan, PhotoRoomPlan, PhotoScenePlan } from './photo-scene-plan'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PhotoVisionImage = {
  captureId: string
  sequenceIndex: number
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  base64: string
}

export type PhotoVisionRequest = {
  systemPrompt: string
  userPrompt: string
  images: PhotoVisionImage[]
}

export type PhotoVisionProvider = {
  infer: (request: PhotoVisionRequest) => Promise<unknown>
}

export type CatalogEntry = {
  id: string
  category: string
  name: string
  dimensions?: [number, number, number]
  attachTo?: string
  tags?: string[]
  surface?: { height: number }
}

export type PhotoVisionRunInput = {
  manifest: unknown
  images: PhotoVisionImage[]
  knownMeasurement?: { description: string; metres: number }
  catalog?: readonly CatalogEntry[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — Observation prompt
// Ask only for free-text observations. No JSON schema pressure. No catalog.
// The model's single job here is to describe what it sees accurately.
// ─────────────────────────────────────────────────────────────────────────────

const OBSERVATION_SYSTEM_PROMPT = `
You are a precise architectural surveyor analyzing a set of overlapping RGB
photographs of one indoor space. Your only job is to describe what you
observe with careful spatial accuracy. Do not guess what you cannot see.

Return a single JSON object with this exact structure and no other text:
{
  "room": {
    "type": "<room type, e.g. bedroom / office / kitchen>",
    "estimatedWidth": <metres, number>,
    "estimatedDepth": <metres, number>,
    "estimatedCeilingHeight": <metres, number>,
    "scaleConfidence": <0-1, how confident you are in the absolute size>,
    "walls": {
      "door": "<which wall: north / south / east / west, or describe>",
      "window": "<which wall>",
      "notes": "<any other orientation notes>"
    }
  },
  "door": {
    "wall": "<north|south|east|west>",
    "centreFromLeftWhenFacing": <metres from left corner when standing outside facing the door>,
    "width": <metres>,
    "height": <metres>,
    "swingDirection": "<inward|outward — omit if truly unknown>"
  },
  "windows": [
    {
      "wall": "<north|south|east|west>",
      "centreFromLeftWhenFacing": <metres>,
      "width": <metres>,
      "height": <metres>,
      "sillHeight": <metres above floor>
    }
  ],
  "objects": [
    {
      "id": "<short unique id, e.g. bed-1>",
      "name": "<what you see, free text, e.g. Single bed with plaid cover>",
      "touchesWall": "<north|south|east|west|none — which wall the back of the object is against>",
      "faceDirection": "<north|south|east|west — which direction the front of the object faces>",
      "distanceFromLeftCornerOfTouchedWall": <metres along that wall to the object centre>,
      "distanceFromWall": <metres the front edge is from the wall it touches, i.e. depth>,
      "width": <metres, the dimension PARALLEL to the wall it touches (along the wall)>,
      "height": <metres>,
      "depth": <metres, the dimension PERPENDICULAR to the wall — how far it protrudes INTO the room>,
      "isWallMounted": <true if hangs on the wall — shelf, picture, curtain>,
      "heightOnWall": <metres above floor to centre, only if isWallMounted is true>,
      "dominantColors": ["<color name>", ...],
      "material": "<wood / metal / fabric / plastic / glass / other>",
      "pattern": "<solid / plaid / striped / patterned / none>",
      "confidence": <0-1>
    }
  ]
}

Rules:
- Use cardinal directions consistently: the wall with the main door is south.
  The wall to the left when facing south is east. Right is west. Opposite is north.
- Every object must have a touchesWall or "none" if free-standing.
- faceDirection is the direction the usable side faces (chair seat, desk surface, 
  bed foot, wardrobe door). It is usually opposite to touchesWall.
- Measure widths and depths from the photos using visible reference objects
  (a standard door is 2.05 m tall × 0.85 m wide; a bed is ~0.9–1.0 m wide × 1.9–2.0 m long).
- Do not invent objects not visible in the photos.
- Output only the JSON object, no markdown, no explanation.
`.trim()

function buildObservationUserPrompt(
  manifest: ReturnType<typeof PhotoCaptureManifestSchema.parse>,
  knownMeasurement?: { description: string; metres: number },
): string {
  const lines: string[] = [
    `Analyze these ${manifest.images.length} photographs of one indoor space.`,
  ]
  if (knownMeasurement) {
    lines.push(
      `The user measured one feature: "${knownMeasurement.description}" = ${knownMeasurement.metres} m. ` +
        `Use this as your primary scale anchor.`,
    )
  }
  lines.push(
    `Images are ordered by sequence index. Treat them as overlapping views of the same room.`,
    `Image manifest: ${JSON.stringify(manifest.images.map((i) => ({ id: i.id, seq: i.sequenceIndex })))}`,
  )
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — Map observations → validated plan (deterministic code, no AI)
// ─────────────────────────────────────────────────────────────────────────────

type ObservedRoom = {
  type?: string
  estimatedWidth?: number
  estimatedDepth?: number
  estimatedCeilingHeight?: number
  scaleConfidence?: number
  walls?: { door?: string; window?: string; notes?: string }
}

type ObservedDoor = {
  wall?: string
  centreFromLeftWhenFacing?: number
  width?: number
  height?: number
  swingDirection?: string
}

type ObservedWindow = {
  wall?: string
  centreFromLeftWhenFacing?: number
  width?: number
  height?: number
  sillHeight?: number
}

type ObservedObject = {
  id?: string
  name?: string
  touchesWall?: string
  faceDirection?: string
  distanceFromLeftCornerOfTouchedWall?: number
  distanceFromWall?: number
  width?: number
  height?: number
  depth?: number
  isWallMounted?: boolean
  heightOnWall?: number
  dominantColors?: string[]
  material?: string
  pattern?: string
  confidence?: number
}

type Observation = {
  room?: ObservedRoom
  door?: ObservedDoor
  windows?: ObservedWindow[]
  objects?: ObservedObject[]
}

const WALL_DIRECTIONS = ['north', 'south', 'east', 'west'] as const
type WallDir = (typeof WALL_DIRECTIONS)[number]

/**
 * The room polygon is always laid out in the same canonical frame:
 *   south wall = z=0 (the door wall), north = z=D, west = x=0, east = x=W.
 * Vertices CCW: [0,0](SW), [W,0](SE), [W,D](NE), [0,D](NW)
 * Wall indices: 0=south(S→E), 1=east(E→N), 2=north(N→W), 3=west(W→S)
 *
 * Cardinal → wallIndex:
 *   south=0  east=1  north=2  west=3
 *
 * Cardinal → yaw (object front faces this direction):
 *   north(+Z) = 0   west(-X) = PI/2   south(-Z) = PI   east(+X) = -PI/2
 */
const WALL_INDEX: Record<WallDir, number> = { south: 0, east: 1, north: 2, west: 3 }
const WALL_DIRECTION_YAW: Record<WallDir, number> = {
  north: 0,
  west: Math.PI / 2,
  south: Math.PI,
  east: -Math.PI / 2,
}

// Edge direction vectors in polygon order (CCW)
const WALL_EDGE_VECTORS: Record<WallDir, [number, number]> = {
  south: [1, 0], // S wall goes east (x+)
  east: [0, 1], // E wall goes north (z+)
  north: [-1, 0], // N wall goes west (x-)
  west: [0, -1], // W wall goes south (z-)
}

// Corner (start vertex of each wall) in [x,z]
function wallStart(wall: WallDir, W: number, D: number): [number, number] {
  return { south: [0, 0], east: [W, 0], north: [W, D], west: [0, D] }[wall] as [number, number]
}

function normalizeWall(raw: string | undefined): WallDir | null {
  if (!raw) return null
  const lower = raw.trim().toLowerCase()
  for (const dir of WALL_DIRECTIONS) {
    if (lower.includes(dir)) return dir
  }
  return null
}

function safeNum(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Score a catalog entry for a free-text object description. Category match gives a large bonus. */
function scoreCandidate(name: string, asset: CatalogEntry, preferredCategory?: string): number {
  const haystack =
    `${asset.id.replace(/[-_]/g, ' ')} ${asset.name} ${(asset.tags ?? []).join(' ')}`.toLowerCase()
  const terms = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const textScore = terms.reduce((sum, t) => sum + (haystack.includes(t) ? 1 : 0), 0)
  // A strong category match trumps name-term similarity so a 'desk' observation is
  // never beaten by a 'table lamp' that shares the word 'light'.
  const categoryBonus = preferredCategory && asset.category === preferredCategory ? 8 : 0
  return textScore * 2 + categoryBonus
}

/**
 * Pick the best matching catalog entry.
 * 1. Ceiling fixtures are excluded for floor-placed objects.
 * 2. First try: entries whose category matches what the name implies (big bonus).
 * 3. Fall back to the best text-match if nothing category-specific fits well.
 */
function pickCatalogEntry(
  obj: ObservedObject,
  catalog: readonly CatalogEntry[],
): CatalogEntry | undefined {
  const wallMounted = obj.isWallMounted ?? false
  const eligible = catalog.filter((a) => {
    if (!wallMounted && a.attachTo === 'ceiling') return false
    return true
  })
  // Infer a preferred category from the object name using the catalog's own category values.
  // This avoids any hardcoded category list: we just see which catalog category name appears
  // most in the object's free-text description.
  const nameLower = (obj.name ?? '').toLowerCase()
  const categoryCounts = new Map<string, number>()
  for (const a of eligible) {
    const cat = a.category
    const score = (nameLower.match(new RegExp(cat.replace(/[-_]/g, '[- _]?'), 'gi')) ?? []).length
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + score)
  }
  const preferredCategory = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  return eligible
    .map((a) => ({ a, score: scoreCandidate(obj.name ?? '', a, preferredCategory) }))
    .sort((x, y) => y.score - x.score)[0]?.a
}

/** Convert one observed object to a plan object. */
function convertObject(
  obj: ObservedObject,
  W: number,
  D: number,
  catalog: readonly CatalogEntry[],
): Record<string, unknown> | null {
  const confidence = safeNum(obj.confidence, 0.5)
  if (confidence < 0.2) return null

  const touchWall = normalizeWall(obj.touchesWall)
  const faceWall = normalizeWall(obj.faceDirection)
  const w = safeNum(obj.width, 1)
  const h = safeNum(obj.height, 1)
  const d = safeNum(obj.depth, 1)

  // Object centre in room-local [x, z]
  let cx: number, cz: number
  if (touchWall) {
    const edgeVec = WALL_EDGE_VECTORS[touchWall]
    const start = wallStart(touchWall, W, D)
    const along = safeNum(obj.distanceFromLeftCornerOfTouchedWall, 0)
    const out = safeNum(obj.distanceFromWall, d / 2)
    // Position along the wall
    cx = start[0] + edgeVec[0] * along
    cz = start[1] + edgeVec[1] * along
    // Push inward by half the depth (to the object centre) + any gap
    const inward = pushInward(touchWall)
    const inwardDist = d / 2 + out
    cx += inward[0] * inwardDist
    cz += inward[1] * inwardDist
  } else {
    cx = W / 2
    cz = D / 2
  }

  // Clamp to inside the room with a small margin
  const margin = 0.05
  cx = Math.max(margin, Math.min(W - margin, cx))
  cz = Math.max(margin, Math.min(D - margin, cz))

  // Yaw: use faceDirection if present, otherwise infer from touchesWall
  const facingDir = faceWall ?? opposite(touchWall)
  const yaw = facingDir ? WALL_DIRECTION_YAW[facingDir] : 0

  // Catalog match
  const asset = pickCatalogEntry(obj, catalog)
  const category = asset?.category ?? 'other'
  const assetId = asset?.id

  // Appearance
  const appearance = {
    colors: obj.dominantColors ?? [],
    material: obj.material ?? 'unknown',
    pattern: obj.pattern ?? 'none',
  }

  const base: Record<string, unknown> = {
    id: obj.id ?? `obj-${Math.random().toString(36).slice(2, 6)}`,
    objectType: obj.name ?? 'unknown object',
    category,
    dimensions: [w, h, d],
    position: [cx, cz],
    yaw,
    confidence,
    uncertainties: [],
    appearance,
    ...(assetId ? { assetId } : {}),
  }

  if (obj.isWallMounted && obj.heightOnWall != null) {
    base.elevation = obj.heightOnWall
  }

  return base
}

/** Inward-pointing unit vector from a wall toward the room centre. */
function pushInward(wall: WallDir): [number, number] {
  return { south: [0, 1], east: [-1, 0], north: [0, -1], west: [1, 0] }[wall] as [number, number]
}

function opposite(wall: WallDir | null): WallDir | null {
  if (!wall) return null
  return { south: 'north', north: 'south', east: 'west', west: 'east' }[wall] as WallDir
}

/** Convert an observed door/window to a plan opening. */
function convertOpening(
  obs: ObservedDoor | ObservedWindow,
  W: number,
  D: number,
): Record<string, unknown> | null {
  const wall = normalizeWall(obs.wall)
  if (!wall) return null
  const wallIndex = WALL_INDEX[wall]
  const edgeVec = WALL_EDGE_VECTORS[wall]
  const start = wallStart(wall, W, D)
  // Edge length: south/north = W, east/west = D
  const edgeLength = Math.abs(edgeVec[0]) > 0 ? W : D
  const dist = safeNum(obs.centreFromLeftWhenFacing, edgeLength / 2)
  // Clamp centre within edge, at least halfWidth from each end
  const halfW = safeNum((obs as ObservedDoor).width, 0.85) / 2
  const centre = Math.max(halfW, Math.min(edgeLength - halfW, dist))
  return {
    wallIndex,
    distanceAlongWall: centre,
    width: safeNum((obs as ObservedDoor).width, 0.85),
    height: safeNum((obs as ObservedDoor).height, 2.05),
    ...('sillHeight' in obs && obs.sillHeight != null ? { sillHeight: obs.sillHeight } : {}),
    ...('swingDirection' in obs &&
    (obs.swingDirection === 'inward' || obs.swingDirection === 'outward')
      ? { swingDirection: obs.swingDirection as 'inward' | 'outward' }
      : {}),
    confidence: 0.8,
  }
}

/** Full deterministic conversion from Observation → PhotoScenePlan-compatible object. */
export function observationToPlan(
  observation: Observation,
  manifest: ReturnType<typeof PhotoCaptureManifestSchema.parse>,
  catalog: readonly CatalogEntry[],
): unknown {
  const room = observation.room ?? {}
  const W = safeNum(room.estimatedWidth, 3)
  const D = safeNum(room.estimatedDepth, 3.5)
  const H = safeNum(room.estimatedCeilingHeight, 2.6)
  const scaleConf = safeNum(room.scaleConfidence, 0.4)

  const polygon: [number, number][] = [
    [0, 0],
    [W, 0],
    [W, D],
    [0, D],
  ]

  const door = observation.door ? convertOpening(observation.door, W, D) : null
  const windows = (observation.windows ?? []).map((w) => convertOpening(w, W, D)).filter(Boolean)

  const objects = (observation.objects ?? [])
    .map((o) => convertObject(o, W, D, catalog))
    .filter(Boolean)

  const planRoom: Record<string, unknown> = {
    name: room.type ? capitalise(room.type) : 'Room',
    polygon,
    wallHeight: H,
    wallThickness: 0.12,
    confidence: scaleConf,
    scale: {
      basis: scaleConf > 0.7 ? 'visual-reference' : 'estimated',
      uncertainty: Math.max(0, Math.min(1, 1 - scaleConf)),
    },
    ...(door ? { doors: [door] } : { doors: [] }),
    windows,
    objects,
  }

  return {
    version: 1,
    manifest,
    plan: {
      version: 1,
      units: 'metres',
      source: { kind: 'smartphone-images', imageCount: manifest.images.length },
      rooms: [planRoom],
    },
    roomAssessments: [
      {
        roomName: planRoom.name,
        confidence: scaleConf,
        evidenceImageIds: manifest.images.map((i) => i.id),
        uncertainties: ['Scale estimated from visual references only.'],
      },
    ],
    warnings: [],
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalizer (retained from original — fixes opening field aliases)
// ─────────────────────────────────────────────────────────────────────────────
type GeminiOpening = Partial<PhotoOpeningPlan> & {
  hinge?: unknown
  swing?: unknown
  position?: unknown
  t?: unknown
}
type GeminiRoom = Omit<Partial<PhotoRoomPlan>, 'doors' | 'windows'> & {
  doors?: GeminiOpening[]
  windows?: GeminiOpening[]
}
type GeminiPlan = Omit<Partial<PhotoScenePlan>, 'rooms'> & { rooms?: GeminiRoom[] }
type GeminiBundle = Omit<Partial<PhotoSceneInferenceBundle>, 'plan'> & { plan?: GeminiPlan }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function normalizeSide(value: unknown): PhotoOpeningPlan['hingesSide'] | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim().toLowerCase()
  return s === 'left' || s === 'right' ? s : undefined
}
function normalizeSwing(value: unknown): PhotoOpeningPlan['swingDirection'] | undefined {
  if (typeof value !== 'string') return undefined
  const d = value.trim().toLowerCase()
  if (d === 'in' || d === 'inward') return 'inward'
  if (d === 'out' || d === 'outward') return 'outward'
  return undefined
}
function normalizeOpening(opening: GeminiOpening, _polygon: unknown, _path: string): unknown {
  const { hinge, swing, position: _pos, t: _t, ...canonical } = opening
  const hingesSide = normalizeSide(canonical.hingesSide) ?? normalizeSide(hinge)
  const swingDirection = normalizeSwing(canonical.swingDirection) ?? normalizeSwing(swing)
  return {
    ...canonical,
    ...(hingesSide ? { hingesSide } : {}),
    ...(swingDirection ? { swingDirection } : {}),
  }
}
export function normalizeGeminiPhotoSceneResponse(raw: unknown): unknown {
  const rawRecord = record(raw)
  const planRecord = record(rawRecord?.plan)
  if (!rawRecord || !planRecord || !Array.isArray(planRecord.rooms)) return raw
  const response = raw as GeminiBundle
  const rooms = planRecord.rooms.map((roomValue, roomIndex) => {
    const room = record(roomValue)
    if (!room) return roomValue
    const polygon = room.polygon
    return {
      ...room,
      ...(Array.isArray(room.doors)
        ? {
            doors: room.doors.map((o, i) =>
              record(o)
                ? normalizeOpening(o as GeminiOpening, polygon, `rooms[${roomIndex}].doors[${i}]`)
                : o,
            ),
          }
        : {}),
      ...(Array.isArray(room.windows)
        ? {
            windows: room.windows.map((o, i) =>
              record(o)
                ? normalizeOpening(o as GeminiOpening, polygon, `rooms[${roomIndex}].windows[${i}]`)
                : o,
            ),
          }
        : {}),
    }
  })
  return { ...response, plan: { ...response.plan, rooms } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED_IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']

export const PHOTO_SCENE_VISION_SYSTEM_PROMPT = OBSERVATION_SYSTEM_PROMPT

export async function inferPhotoScene(
  input: PhotoVisionRunInput,
  provider: PhotoVisionProvider,
): Promise<PhotoSceneInferenceBundle> {
  const manifest = PhotoCaptureManifestSchema.parse(input.manifest)
  if (input.images.length !== manifest.images.length) {
    throw new Error(`Image payload count (${input.images.length}) does not match manifest.`)
  }
  const manifestById = new Map(manifest.images.map((i) => [i.id, i]))
  const seen = new Set<string>()
  for (const image of input.images) {
    if (seen.has(image.captureId)) throw new Error(`Duplicate image payload "${image.captureId}".`)
    seen.add(image.captureId)
    const capture = manifestById.get(image.captureId)
    if (!capture) throw new Error(`Unknown capture "${image.captureId}".`)
    if (capture.sequenceIndex !== image.sequenceIndex)
      throw new Error(`Sequence mismatch for "${image.captureId}".`)
    if (capture.mimeType !== image.mimeType)
      throw new Error(`MIME type mismatch for "${image.captureId}".`)
    if (!SUPPORTED_IMAGE_MIME_TYPES.includes(capture.mimeType))
      throw new Error(`Unsupported MIME type for "${image.captureId}": ${capture.mimeType}.`)
    if (!image.base64.trim()) throw new Error(`Empty base64 for "${image.captureId}".`)
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(image.base64))
      throw new Error(`Invalid base64 for "${image.captureId}".`)
  }
  for (const capture of manifest.images) {
    if (!seen.has(capture.id)) throw new Error(`Missing payload for "${capture.id}".`)
  }

  const orderedImages = [...input.images].sort((a, b) => a.sequenceIndex - b.sequenceIndex)

  // Stage 1: ask the model only for free observations
  const raw = await provider.infer({
    systemPrompt: OBSERVATION_SYSTEM_PROMPT,
    userPrompt: buildObservationUserPrompt(manifest, input.knownMeasurement),
    images: orderedImages,
  })

  // Parse the observation (lenient — bad fields degrade gracefully)
  let observation: Observation = {}
  try {
    if (typeof raw === 'string') {
      const cleaned = raw.replace(/```json|```/gi, '').trim()
      observation = JSON.parse(cleaned) as Observation
    } else if (typeof raw === 'object' && raw !== null) {
      observation = raw as Observation
    }
  } catch {
    // If the model returns something we can't parse, build an empty plan rather than crashing
    observation = {}
  }

  // Stage 2: convert observations to a fully valid plan using deterministic code
  const plan = observationToPlan(observation, manifest, input.catalog ?? [])

  return PhotoSceneInferenceBundleSchema.parse(plan)
}
