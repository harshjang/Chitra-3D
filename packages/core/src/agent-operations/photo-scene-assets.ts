import type { AssetInput } from '../schema'
import type { PhotoObjectPlan } from './photo-scene-plan'

/**
 * Returns whether the object category indicates wall-mounting (sits at an inferred elevation,
 * not on the floor). This drives validation and transform logic, not catalog filtering.
 */
export function isWallMountedPhotoCategory(category: PhotoObjectPlan['category']): boolean {
  // These are the only schema categories that require a wall-centre elevation.
  // This list is intentionally narrow: it reflects the schema discriminator, not room knowledge.
  return (['picture', 'noticeboard', 'curtain', 'shelf', 'book'] as readonly string[]).includes(
    category as string,
  )
}

type PhotoAssetQuery = Pick<PhotoObjectPlan, 'category' | 'objectType' | 'assetId'> & {
  dimensions?: PhotoObjectPlan['dimensions']
}

/**
 * Score a catalog asset against an observed object using only catalog metadata.
 * No category-specific regex tables. Score is purely text overlap + footprint similarity.
 */
function scoreAsset(object: PhotoAssetQuery, asset: AssetInput): number {
  const searchText =
    `${asset.id.replace(/[-_]/g, ' ')} ${asset.name} ${(asset.tags ?? []).join(' ')} ${asset.category ?? ''}`.toLocaleLowerCase()
  const queryTerms = object.objectType.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const textScore = queryTerms.reduce((sum, term) => sum + (searchText.includes(term) ? 1 : 0), 0)
  const native = asset.dimensions ?? [1, 1, 1]
  const dims = object.dimensions ?? [1, 1, 1]
  const objectAspect = Math.max(dims[0], dims[2]) / Math.max(0.001, Math.min(dims[0], dims[2]))
  const assetAspect =
    Math.max(native[0], native[2]) / Math.max(0.001, Math.min(native[0], native[2]))
  const aspectPenalty = Math.abs(Math.log(objectAspect / assetAspect))
  return textScore * 2 - aspectPenalty
}

/**
 * Whether a catalog model is compatible with how the object is mounted.
 * Uses only the asset's own `attachTo` and `category` fields — no hardcoded name patterns.
 */
function isCompatibleMounting(object: PhotoAssetQuery, asset: AssetInput): boolean {
  const wallMounted = isWallMountedPhotoCategory(object.category)
  // A ceiling fixture placed at y = 0 would sit on the floor.
  if (!wallMounted && asset.attachTo === 'ceiling') return false
  // A floor-standing object should not resolve to a wall or ceiling mount
  // unless no better match exists (handled by score ordering).
  return true
}

/**
 * Category-to-pattern map. Derived entirely from the catalog's own naming conventions
 * (id, name, tags), not from room knowledge. Each pattern matches names that are
 * semantically correct for the category, preventing a 'table lamp' winning for
 * 'table' or a 'cactus' winning for 'stand'.
 */
const CATEGORY_COMPATIBILITY: Record<string, RegExp> = {
  bed: /\b(bed|bunk)\b/i,
  wardrobe: /\b(wardrobe|closet|armoire)\b/i,
  drawer: /\b(drawer|dresser|nightstand|bedside[- ]table|bedside[- ]cabinet)\b/i,
  desk: /\b(desk|office[- ]table|study[- ]table|writing[- ]table)\b/i,
  sofa: /\b(sofa|couch|loveseat|settee)\b/i,
  chair: /\b(chair|armchair|lounge[- ]chair)\b/i,
  table:
    /\b(coffee|cocktail|side|end|occasional|dining|glass[- ]top|center|centre)[- ]?table\b|\btable\b(?!\s*lamp)/i,
  stand:
    /\b(display[- ]stand|newspaper[- ]stand|magazine[- ]stand|coat[- ]stand|plant[- ]stand)\b/i,
  bin: /\b(bin|wastebasket|waste[- ]bin|trash[- ]can)\b/i,
  picture: /\b(picture|painting|photo[- ]frame|wall[- ]frame|framed[- ]art)\b/i,
  noticeboard: /\b(noticeboard|notice[- ]board|bulletin[- ]board|cork[- ]board)\b/i,
  curtain: /\b(curtain|drape|drapery)\b/i,
  light: /\b(lamp|light|luminaire)\b/i,
  shelf: /\b(bookcase|bookshelf|wall[- ]shelf|shelf|shelving)\b/i,
  rug: /\b(rug|carpet|area[- ]rug)\b/i,
  book: /\b(book|books)\b/i,
  other: /.^/,
}

export function resolvePhotoSceneAsset(
  object: PhotoAssetQuery,
  catalog: readonly AssetInput[],
): AssetInput | undefined {
  // Exact assetId match: only honour it when it also passes the category compatibility check.
  // If the hint fails (e.g. assetId='table-lamp' for category='table'), fall through to scoring.
  if (object.assetId) {
    const exact = catalog.find((asset) => asset.id === object.assetId)
    if (exact && isCompatibleMounting(object, exact)) {
      const pattern = CATEGORY_COMPATIBILITY[object.category]
      const nameText = `${exact.id.replace(/[-_]/g, ' ')} ${exact.name}`
      if (!pattern || pattern.test(nameText)) return exact
      // assetId hint failed category check — fall through to scored candidates below
    }
  }

  const compatiblePattern = CATEGORY_COMPATIBILITY[object.category]
  // No compatibility pattern for this category means no catalog entry can match it.
  if (compatiblePattern === undefined) return undefined

  const candidates = catalog.filter((asset) => {
    if (!isCompatibleMounting(object, asset)) return false
    // Match id+name only, not tags — tags like ['table'] on a lamp should not
    // cause it to match the 'table' category.
    const nameText = `${asset.id.replace(/[-_]/g, ' ')} ${asset.name}`
    if (!compatiblePattern.test(nameText)) return false
    return true
  })

  return candidates
    .map((asset, index) => ({ asset, index, score: scoreAsset(object, asset) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.asset
}

export function photoObjectTransform(
  object: Pick<PhotoObjectPlan, 'category' | 'dimensions' | 'position' | 'yaw' | 'elevation'>,
  asset: AssetInput,
  baseY = 0,
) {
  const native = asset.dimensions ?? [1, 1, 1]
  const scale = Math.sqrt((object.dimensions[0] / native[0]) * (object.dimensions[2] / native[2]))
  const wallMounted = isWallMountedPhotoCategory(object.category)
  return {
    position: [
      object.position[0],
      wallMounted ? (object.elevation ?? 0) : baseY,
      object.position[1],
    ] as [number, number, number],
    rotation: [0, object.yaw, 0] as [number, number, number],
    scale: [scale, scale, scale] as [number, number, number],
  }
}

/** Horizontal footprint of the native model after the same uniform scale used by placement. */
export function photoObjectFootprintDimensions(
  object: Pick<PhotoObjectPlan, 'category' | 'dimensions'>,
  asset: AssetInput,
): [number, number] {
  const native = asset.dimensions ?? [1, 1, 1]
  const scale = Math.sqrt((object.dimensions[0] / native[0]) * (object.dimensions[2] / native[2]))
  return [native[0] * scale, native[2] * scale]
}

type PhotoAppearanceInput = Pick<PhotoObjectPlan, 'category' | 'objectType'> & {
  appearance?: {
    colors?: string[]
    material?: string
    pattern?: string
  }
  dominantColors?: string[]
  material?: string
  pattern?: string
}

function normalizeAppearanceColor(value: string): string | undefined {
  const color = value.trim().toLowerCase()

  const namedColors: Record<string, string> = {
    black: '#171717',
    white: '#f5f5f5',
    tan: '#ae8057',
    beige: '#d8c3a5',
    brown: '#795548',
    grey: '#808080',
    gray: '#808080',
    red: '#c62828',
    blue: '#2563eb',
    green: '#388e3c',
    yellow: '#facc15',
  }

  if (/^#[0-9a-f]{6}$/i.test(color)) return color

  return namedColors[color]
}

export function photoObjectMaterialSlots(
  object: PhotoAppearanceInput,
  asset: Pick<AssetInput, 'id' | 'name'>,
): Record<string, string> | undefined {
  const description = `${object.objectType} ${asset.name} ${asset.id}`.toLowerCase()

  const colors = object.appearance?.colors ?? object.dominantColors ?? []

  // First try explicit appearance colors, then infer from the description text.
  const colorFromAppearance = colors
    .map(normalizeAppearanceColor)
    .find((value): value is string => value !== undefined)

  const color =
    colorFromAppearance ??
    (/\b(black|dark)\b/.test(description)
      ? '#171717'
      : /\btan\b/.test(description)
        ? '#ae8057'
        : /\bbeige\b/.test(description)
          ? '#d8c3a5'
          : /\bbrown\b/.test(description)
            ? '#795548'
            : undefined)

  const material = (object.appearance?.material ?? object.material ?? '').toLowerCase()

  const slots: Record<string, string> = {}

  const isSofa = /\bsofa\b/.test(description)
  const isChair = /\b(chair|armchair)\b/.test(description)
  const isTable = /\btable\b/.test(description)
  const isGlassTop = /\bglass\b/.test(description)

  if ((isSofa || isChair) && color) {
    slots.slot_body = color

    if (isSofa && color === '#171717') {
      slots.slot_cushion = '#202020'
    }
  }

  if (isTable && isGlassTop) {
    slots.slot_top = 'library:preset-glass'
  }

  // Preserve useful material information without inventing a finish
  // when the observed color is unavailable.
  if (isTable && material === 'wood' && color) {
    slots.slot_top = color
  }

  return Object.keys(slots).length > 0 ? slots : undefined
}
