import { describe, expect, test } from 'bun:test'
import {
  photoObjectFootprintDimensions,
  photoObjectMaterialSlots,
  photoObjectTransform,
  resolvePhotoSceneAsset,
} from './photo-scene-assets'
import {
  canonicalizePhotoRoom,
  deduplicatePhotoObjects,
  PhotoScenePlanSchema,
  toCreateRoomRequests,
} from './photo-scene-plan'

function validPlan() {
  return {
    version: 1,
    units: 'metres',
    source: {
      kind: 'smartphone-images',
      imageCount: 4,
    },
    rooms: [
      {
        name: 'Living Room',
        polygon: [
          [0, 0],
          [4, 0],
          [4, 3],
          [0, 3],
        ],
        wallHeight: 2.7,
        wallThickness: 0.15,
        confidence: 0.95,
      },
    ],
  }
}

describe('PhotoScenePlanSchema', () => {
  test('matches photo objects only to category compatible catalog names', () => {
    const catalog: any[] = [
      { id: 'cactus', name: 'Cactus', tags: ['stand', 'decor'] },
      { id: 'table-lamp', name: 'Table Lamp', tags: ['table', 'light'] },
      { id: 'sofa', name: 'Sofa', tags: ['seating'] },
      { id: 'coffee-table', name: 'Coffee Table', tags: ['glass'] },
      {
        id: 'bookshelf',
        name: 'Bookshelf',
        tags: ['bookcase', 'storage'],
        dimensions: [0.93, 1.99, 0.33],
      },
      { id: 'shelf', name: 'Wall Shelf', tags: ['storage'] },
      {
        id: 'rectangular-carpet',
        name: 'Rectangular Carpet',
        tags: ['carpet', 'rug', 'rectangular', 'woven'],
        dimensions: [2.78, 0.04, 1.81],
      },
      {
        id: 'round-carpet',
        name: 'Round Carpet',
        tags: ['rug', 'circular'],
        dimensions: [1.99, 0.05, 1.99],
      },
      { id: 'single-bed', name: 'Single Bed', dimensions: [1.08, 0.6, 2.14] },
      {
        id: 'office-table',
        name: 'Office Table',
        tags: ['desk', 'study', 'wood'],
        dimensions: [1.51, 0.76, 0.62],
      },
      {
        id: 'closet',
        name: 'Closet',
        tags: ['wardrobe', 'storage'],
        dimensions: [1.95, 2.26, 0.6],
      },
      {
        id: 'dresser',
        name: 'Dresser',
        tags: ['drawers', 'bedroom'],
        dimensions: [1.23, 0.73, 0.61],
      },
      {
        id: 'bedside-table',
        name: 'Bedside Table',
        tags: ['drawer', 'nightstand'],
        dimensions: [0.45, 0.48, 0.46],
      },
    ]
    expect(
      resolvePhotoSceneAsset({ category: 'stand', objectType: 'display stand' }, catalog),
    ).toBeUndefined()
    expect(
      resolvePhotoSceneAsset(
        { category: 'table', objectType: 'dark table', assetId: 'table-lamp' },
        catalog,
      )?.id,
    ).toBe('coffee-table')
    expect(
      resolvePhotoSceneAsset(
        { category: 'sofa', objectType: 'black sofa', assetId: 'cactus' },
        catalog,
      )?.id,
    ).toBe('sofa')
    expect(
      resolvePhotoSceneAsset({ category: 'shelf', objectType: 'wall shelf with books' }, catalog)
        ?.id,
    ).toBe('shelf')
    expect(
      resolvePhotoSceneAsset({ category: 'shelf', objectType: 'freestanding bookcase' }, catalog)
        ?.id,
    ).toBe('bookshelf')
    expect(
      resolvePhotoSceneAsset({ category: 'shelf', objectType: 'bookshelf' }, catalog)?.id,
    ).toBe('bookshelf')
    expect(
      resolvePhotoSceneAsset(
        { category: 'rug', objectType: 'woven area rug', dimensions: [2, 0.04, 1.3] },
        catalog,
      )?.id,
    ).toBe('rectangular-carpet')
    expect(
      resolvePhotoSceneAsset(
        { category: 'rug', objectType: 'round woven rug', dimensions: [1.5, 0.05, 1.5] },
        catalog,
      )?.id,
    ).toBe('round-carpet')
    expect(
      resolvePhotoSceneAsset(
        { category: 'bed', objectType: 'single bed with plaid bedding' },
        catalog,
      )?.id,
    ).toBe('single-bed')
    expect(
      resolvePhotoSceneAsset({ category: 'desk', objectType: 'wooden study desk' }, catalog)?.id,
    ).toBe('office-table')
    expect(
      resolvePhotoSceneAsset({ category: 'wardrobe', objectType: 'tall black wardrobe' }, catalog)
        ?.id,
    ).toBe('closet')
    expect(
      resolvePhotoSceneAsset({ category: 'drawer', objectType: 'small black drawer unit' }, catalog)
        ?.id,
    ).toBe('bedside-table')
  })

  test('maps plan x/z and yaw into editor x/y/z transforms and scales to metres', () => {
    const transform = photoObjectTransform(
      {
        category: 'sofa',
        dimensions: [2, 0.8, 0.9],
        position: [3, 4],
        yaw: Math.PI / 2,
      },
      { id: 'sofa', name: 'Sofa', dimensions: [2.06, 0.74, 1.01] },
    )
    const expectedUniformScale = Math.sqrt((2 / 2.06) * (0.9 / 1.01))
    expect(transform).toEqual({
      position: [3, 0, 4],
      rotation: [0, Math.PI / 2, 0],
      scale: [expectedUniformScale, expectedUniformScale, expectedUniformScale],
    })
    expect(
      photoObjectTransform(
        {
          category: 'noticeboard',
          dimensions: [1.2, 0.7, 0.05],
          position: [2, 1],
          yaw: 0,
        },
        { id: 'picture', name: 'Picture', dimensions: [1, 1, 1] },
      ).position,
    ).toEqual([2, 0, 1])
  })

  test('accepts a valid room plan in metres', () => {
    const result = PhotoScenePlanSchema.safeParse(validPlan())
    expect(result.success).toBe(true)
  })

  test('accepts explicit room and opening inference metadata while preserving geometry', () => {
    const plan = validPlan()
    Object.assign(plan.rooms[0]!, {
      id: 'room-1',
      type: 'living',
      doors: [
        {
          id: 'door-1',
          wallIndex: 0,
          distanceAlongWall: 2,
          width: 0.9,
          height: 2.05,
          confidence: 0.82,
        },
      ],
      windows: [
        {
          id: 'window-1',
          wallIndex: 2,
          distanceAlongWall: 2,
          width: 1.2,
          height: 1.1,
          sillHeight: 0.9,
          confidence: 0.76,
        },
      ],
    })
    const parsed = PhotoScenePlanSchema.parse(plan)
    expect(parsed.rooms[0]).toMatchObject({ id: 'room-1', type: 'living' })
    expect(parsed.rooms[0]?.doors?.[0]).toMatchObject({
      id: 'door-1',
      wallIndex: 0,
      distanceAlongWall: 2,
      confidence: 0.82,
    })
    expect(parsed.rooms[0]?.windows?.[0]).toMatchObject({
      id: 'window-1',
      wallIndex: 2,
      distanceAlongWall: 2,
      confidence: 0.76,
    })
    expect(toCreateRoomRequests(parsed, 'level_test')[0]).toMatchObject({
      doors: [{ wallIndex: 0, t: 0.5, width: 0.9, height: 2.05 }],
      windows: [{ wallIndex: 2, t: 0.5, width: 1.2, height: 1.1 }],
    })
  })

  test('rejects invalid coordinates, malformed polygons and missing required fields', () => {
    const outOfRangePosition = validPlan()
    Object.assign(outOfRangePosition.rooms[0]!, {
      doors: [{ wallIndex: 0, distanceAlongWall: Number.NaN, width: 0.8, height: 2 }],
    })
    expect(PhotoScenePlanSchema.safeParse(outOfRangePosition).success).toBe(false)

    const malformedPolygon = validPlan()
    malformedPolygon.rooms[0]!.polygon = [
      [0, 0],
      [4, 3],
      [0, 3],
      [4, 0],
    ]
    expect(PhotoScenePlanSchema.safeParse(malformedPolygon).success).toBe(false)

    const missingField = validPlan()
    delete (missingField.rooms[0] as { name?: string }).name
    expect(PhotoScenePlanSchema.safeParse(missingField).success).toBe(false)
  })

  test('rejects openings outside their selected segment or wider than the segment', () => {
    const outside = validPlan()
    Object.assign(outside.rooms[0]!, {
      doors: [{ wallIndex: 0, distanceAlongWall: 4.2, width: 0.8, height: 2 }],
    })
    expect(PhotoScenePlanSchema.safeParse(outside).success).toBe(false)

    const tooWide = validPlan()
    Object.assign(tooWide.rooms[0]!, {
      doors: [{ wallIndex: 0, distanceAlongWall: 2, width: 4.2, height: 2 }],
    })
    expect(PhotoScenePlanSchema.safeParse(tooWide).success).toBe(false)
  })

  test('requires evidence-based elevations for wall-mounted objects', () => {
    const missing = validPlan()
    Object.assign(missing.rooms[0]!, {
      objects: [
        {
          id: 'curtain-1',
          category: 'curtain',
          objectType: 'curtain',
          dimensions: [1.2, 1.8, 0.1],
          position: [2, 0],
          yaw: 0,
          confidence: 0.8,
          uncertainties: ['height is visually uncertain'],
        },
      ],
    })
    const missingResult = PhotoScenePlanSchema.safeParse(missing)
    expect(missingResult.success).toBe(false)
    if (!missingResult.success) {
      expect(
        missingResult.error.issues.some(
          (issue) => issue.path.join('.') === 'rooms.0.objects.0.elevation',
        ),
      ).toBe(true)
    }

    const measured = validPlan()
    Object.assign(measured.rooms[0]!, {
      objects: [
        {
          id: 'curtain-1',
          category: 'curtain',
          objectType: 'curtain',
          dimensions: [1.2, 1.8, 0.1],
          elevation: 1.75,
          position: [2, 0],
          yaw: 0,
          confidence: 0.8,
          uncertainties: ['centre height estimated from visible floor and head rail'],
        },
      ],
    })
    expect(PhotoScenePlanSchema.safeParse(measured).success).toBe(true)
  })

  test('validates room objects in plan coordinates and tolerates legacy plans without objects', () => {
    const plan: any = validPlan()
    plan.rooms[0].objects = [
      {
        id: 'sofa-front',
        category: 'sofa',
        objectType: 'black sofa',
        dimensions: [2, 0.8, 0.9],
        position: [1, 0.5],
        yaw: Math.PI / 2,
        confidence: 0.78,
        uncertainties: ['scale estimated from visual cues'],
      },
    ]
    expect(PhotoScenePlanSchema.parse(plan).rooms[0]?.objects).toHaveLength(1)
    expect(PhotoScenePlanSchema.parse(validPlan()).rooms[0]?.objects).toEqual([])
    plan.rooms[0].objects[0]!.dimensions[0] = -1
    expect(PhotoScenePlanSchema.safeParse(plan).success).toBe(false)
  })

  test('rejects a self-intersecting room polygon', () => {
    const plan = validPlan()
    plan.rooms[0].polygon = [
      [0, 0],
      [4, 3],
      [0, 3],
      [4, 0],
    ]

    expect(PhotoScenePlanSchema.safeParse(plan).success).toBe(false)
  })

  test('rejects duplicate room names regardless of case', () => {
    const plan = validPlan()
    plan.rooms.push({
      ...plan.rooms[0],
      name: 'living room',
    })

    expect(PhotoScenePlanSchema.safeParse(plan).success).toBe(false)
  })

  test('rejects a polygon with negligible area', () => {
    const plan = validPlan()
    plan.rooms[0].polygon = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0.01],
    ]

    expect(PhotoScenePlanSchema.safeParse(plan).success).toBe(false)
  })

  test('converts a valid plan into native room requests', () => {
    const parsed = PhotoScenePlanSchema.parse(validPlan())
    const requests = toCreateRoomRequests(parsed, 'level_test')

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      name: 'Living Room',
      polygon: [
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ],
    })
  })

  test('preserves the shared plan frame for boundaries and objects', () => {
    const room = {
      ...validPlan().rooms[0]!,
      objects: [
        {
          id: 'chair',
          category: 'chair' as const,
          objectType: 'lounge chair',
          dimensions: [0.8, 0.9, 0.8] as [number, number, number],
          position: [13, -2] as [number, number],
          yaw: 0,
          confidence: 0.9,
          uncertainties: [],
        },
      ],
    }
    room.polygon = [
      [10, -5],
      [14, -5],
      [14, -2],
      [10, -2],
    ]
    const local = canonicalizePhotoRoom(room)
    expect(local.polygon[0]).toEqual([10, -5])
    expect(local.objects[0]?.position).toEqual([13, -2])
  })

  test('uses one uniform asset scale to preserve catalog proportions', () => {
    const object = {
      category: 'sofa' as const,
      dimensions: [2.4, 0.7, 1.1] as [number, number, number],
      position: [0, 0] as [number, number],
      yaw: 0,
    }
    const asset = { id: 'sofa', name: 'Sofa', dimensions: [2, 0.8, 1] as [number, number, number] }
    const transform = photoObjectTransform(object, asset)
    expect(transform.scale[0]).toBe(transform.scale[1])
    expect(transform.scale[1]).toBe(transform.scale[2])
    expect(photoObjectFootprintDimensions(object, asset)).toEqual([
      asset.dimensions[0] * transform.scale[0],
      asset.dimensions[2] * transform.scale[0],
    ])
  })

  test('deduplicates repeated observations by stable identity and keeps the strongest view', () => {
    const objects = [
      {
        id: 'table-a',
        category: 'table' as const,
        objectType: 'wood coffee table',
        dimensions: [1.4, 0.5, 0.8] as [number, number, number],
        position: [2, 2] as [number, number],
        yaw: 0,
        confidence: 0.61,
        uncertainties: ['partly occluded'],
      },
      {
        id: 'table-a',
        category: 'table' as const,
        objectType: 'wood coffee table',
        dimensions: [1.4, 0.5, 0.8] as [number, number, number],
        position: [2, 2] as [number, number],
        yaw: 0,
        confidence: 0.91,
        uncertainties: [],
      },
    ]
    expect(deduplicatePhotoObjects(objects)).toEqual([objects[1]])
  })

  test('assigns consistent upholstery and table finishes to supported named model slots', () => {
    expect(
      photoObjectMaterialSlots(
        { category: 'sofa', objectType: 'black sofa' },
        { id: 'sofa', name: 'Sofa' },
      ),
    ).toMatchObject({ slot_body: '#171717', slot_cushion: '#202020' })
    expect(
      photoObjectMaterialSlots(
        { category: 'chair', objectType: 'tan armchair' },
        { id: 'lounge-chair', name: 'Lounge Chair' },
      ),
    ).toMatchObject({ slot_body: '#ae8057' })
    expect(
      photoObjectMaterialSlots(
        { category: 'table', objectType: 'dark glass-top table' },
        { id: 'coffee-table', name: 'Coffee Table' },
      )?.slot_top,
    ).toBe('library:preset-glass')
  })
})
