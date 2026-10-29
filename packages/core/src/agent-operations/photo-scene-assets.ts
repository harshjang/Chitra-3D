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
 * Finds the best-matching catalog model for an observed object.
 * Priority: exact assetId match > highest score from all mounting-compatible candidates.
 * No category-specific name filters.
 */
export function resolvePhotoSceneAsset(
  object: PhotoAssetQuery,
  catalog: readonly AssetInput[],
): AssetInput | undefined {
  if (object.assetId) {
    const exact = catalog.find((asset) => asset.id === object.assetId)
    if (exact && isCompatibleMounting(object, exact)) return exact
  }
  const candidates = catalog.filter((asset) => isCompatibleMounting(object, asset))
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
