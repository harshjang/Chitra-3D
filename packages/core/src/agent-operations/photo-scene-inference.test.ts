import { describe, expect, test } from 'bun:test'
import {
  PhotoCaptureManifestSchema,
  PhotoSceneInferenceBundleSchema,
  parsePhotoCaptureManifest,
} from './photo-scene-inference'
import { inferPhotoScene, normalizePhotoObjectCategories } from './photo-scene-vision-adapter'

const image = (id: string, sequenceIndex: number) => ({
  id,
  fileName: `${id}.jpg`,
  mimeType: 'image/jpeg' as const,
  byteSize: 2048,
  sequenceIndex,
  modality: 'rgb' as const,
  width: 1920,
  height: 1080,
})

const validPlan = {
  version: 1,
  units: 'metres',
  source: { kind: 'smartphone-images', imageCount: 2 },
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
      wallThickness: 0.12,
      confidence: 0.86,
    },
  ],
}

const validManifest = {
  version: 1,
  purpose: 'rgb-spatial-reconstruction',
  images: [image('img-001', 0), image('img-002', 1)],
}

describe('PhotoCaptureManifestSchema', () => {
  test('accepts ordered RGB smartphone images', () => {
    expect(parsePhotoCaptureManifest(validManifest).images).toHaveLength(2)
  })

  test('rejects duplicate IDs and capture sequence positions', () => {
    expect(
      PhotoCaptureManifestSchema.safeParse({
        ...validManifest,
        images: [image('same', 0), image('same', 1)],
      }).success,
    ).toBe(false)
    expect(
      PhotoCaptureManifestSchema.safeParse({
        ...validManifest,
        images: [image('one', 0), image('two', 0)],
      }).success,
    ).toBe(false)
  })

  test('rejects partial image dimensions and non-RGB modalities', () => {
    expect(
      PhotoCaptureManifestSchema.safeParse({
        ...validManifest,
        images: [{ ...image('img-001', 0), height: undefined }],
      }).success,
    ).toBe(false)
    expect(
      PhotoCaptureManifestSchema.safeParse({
        ...validManifest,
        images: [{ ...image('img-001', 0), modality: 'depth' }],
      }).success,
    ).toBe(false)
  })
})

describe('PhotoSceneInferenceBundleSchema', () => {
  test('normalizes known category aliases before strict validation and preserves object identity', async () => {
    const object = (id: string, category: string, objectType = category) => ({
      id,
      category,
      objectType,
      dimensions: [1, 1, 1],
      position: [1, 1],
      yaw: 0,
      confidence: 0.8,
      uncertainties: [],
      ...(['shelf', 'book', 'bookshelf'].includes(category.toLowerCase())
        ? { elevation: 1.2 }
        : {}),
    })
    const objects = [
      object('bed-1', 'bed'),
      object('wardrobe-1', 'WARDROBE_CABINET'),
      object('desk-1', 'desk'),
      object('chair-1', 'Folding_Chair', 'folding chair'),
      object('drawer-1', 'bedside_table', 'bedside drawer unit'),
      object('shelf-1', 'Bookshelf', 'bookshelf with books'),
      object('book-1', 'book'),
      object('lamp-1', 'Desk_Lamp'),
      object('rug-1', 'rug'),
      object('bin-1', 'Waste_Bin'),
    ]
    const raw = {
      version: 1,
      manifest: { ...validManifest, images: [image('img-001', 0)] },
      plan: {
        ...validPlan,
        source: { kind: 'smartphone-images', imageCount: 1 },
        rooms: [
          {
            ...validPlan.rooms[0],
            objects,
          },
        ],
      },
      roomAssessments: [
        { roomName: 'Living Room', confidence: 0.8, evidenceImageIds: ['img-001'] },
      ],
      warnings: [],
    }
    const normalized = normalizePhotoObjectCategories(raw) as typeof raw
    const categories = normalized.plan.rooms[0]!.objects.map((item) => item.category)
    expect(categories).toEqual([
      'bed',
      'wardrobe',
      'desk',
      'chair',
      'drawer',
      'shelf',
      'book',
      'light',
      'rug',
      'bin',
    ])
    expect(normalized.plan.rooms[0]!.objects.map((item) => item.id)).toEqual(
      objects.map((item) => item.id),
    )
    expect(normalized.plan.rooms[0]!.objects[1]).toMatchObject({
      category: 'wardrobe',
      originalCategory: 'WARDROBE_CABINET',
    })

    const inferred = await inferPhotoScene(
      {
        manifest: { ...validManifest, images: [image('img-001', 0)] },
        images: [
          { captureId: 'img-001', sequenceIndex: 0, mimeType: 'image/jpeg', base64: 'aGVsbG8=' },
        ],
      },
      { infer: async () => raw },
    )
    expect(inferred.plan.rooms[0]!.objects.map((item) => item.category)).toEqual(categories)
  })

  test('keeps strict category errors for unknown labels', () => {
    expect(() =>
      normalizePhotoObjectCategories({ plan: { rooms: [{ objects: [{ category: 'ottoman' }] }] } }),
    ).toThrow(/unsupported category "ottoman"/)
  })
  test('accepts a plan with evidence-backed room assessment', () => {
    const result = PhotoSceneInferenceBundleSchema.safeParse({
      version: 1,
      manifest: validManifest,
      plan: validPlan,
      roomAssessments: [
        {
          roomName: 'Living Room',
          confidence: 0.86,
          evidenceImageIds: ['img-001', 'img-002'],
          uncertainties: ['Far wall partly occluded'],
        },
      ],
      warnings: [],
    })
    expect(result.success).toBe(true)
  })

  test('accepts the reported model metadata on rooms, doors and windows', () => {
    const modelPlan = {
      ...validPlan,
      rooms: [
        {
          ...validPlan.rooms[0],
          id: 'room-1',
          type: 'living-room',
          confidence: 0.91,
          doors: [
            {
              id: 'door-1',
              wallIndex: 0,
              distanceAlongWall: 2,
              width: 0.9,
              height: 2.05,
              confidence: 0.84,
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
              confidence: 0.79,
            },
          ],
          objects: [
            {
              id: 'sofa-1',
              category: 'sofa',
              objectType: 'black sofa',
              dimensions: [2, 0.8, 0.9],
              position: [1, 1],
              yaw: 0,
              confidence: 0.8,
              uncertainties: [],
            },
          ],
        },
      ],
    }
    const result = PhotoSceneInferenceBundleSchema.parse({
      version: 1,
      manifest: validManifest,
      plan: modelPlan,
      roomAssessments: [
        { roomName: 'Living Room', confidence: 0.9, evidenceImageIds: ['img-001'] },
      ],
    })
    expect(result.plan.rooms[0]).toMatchObject({
      id: 'room-1',
      type: 'living-room',
    })
    expect(result.plan.rooms[0]?.doors?.[0]).toMatchObject({
      id: 'door-1',
      distanceAlongWall: 2,
      confidence: 0.84,
    })
    expect(result.plan.rooms[0]?.windows?.[0]).toMatchObject({
      id: 'window-1',
      distanceAlongWall: 2,
      confidence: 0.79,
    })
    expect(result.plan.rooms[0]?.objects).toHaveLength(1)
    expect(result.plan.rooms[0]?.objects[0]?.dimensions).toEqual([2, 0.8, 0.9])
  })

  test('validates conditional elevations and a complete room response', () => {
    const floorObject = {
      id: 'bed-1',
      category: 'bed',
      objectType: 'bed',
      dimensions: [2, 0.5, 1.5],
      position: [1, 1],
      yaw: 0,
      confidence: 0.8,
    }
    const wallObject = {
      id: 'shelf-1',
      category: 'shelf',
      objectType: 'wall shelf',
      dimensions: [1, 0.2, 0.25],
      position: [2, 0],
      yaw: 0,
      confidence: 0.8,
      elevation: 1.4,
    }
    const response = (objects: unknown[]) => ({
      version: 1,
      manifest: validManifest,
      plan: {
        ...validPlan,
        rooms: [
          {
            ...validPlan.rooms[0],
            doors: [{ wallIndex: 0, distanceAlongWall: 2, width: 0.9, height: 2 }],
            windows: [
              { wallIndex: 2, distanceAlongWall: 1.5, width: 1, height: 1, sillHeight: 0.8 },
            ],
            objects,
          },
        ],
      },
      roomAssessments: [
        { roomName: 'Living Room', confidence: 0.8, evidenceImageIds: ['img-001'] },
      ],
    })
    const parsed = PhotoSceneInferenceBundleSchema.parse(response([floorObject, wallObject]))
    expect(parsed.plan.rooms[0]?.objects).toHaveLength(2)
    expect(
      PhotoSceneInferenceBundleSchema.safeParse(response([{ ...wallObject, elevation: undefined }]))
        .success,
    ).toBe(false)
    expect(
      PhotoSceneInferenceBundleSchema.safeParse(
        response([{ ...floorObject, yaw: Number.POSITIVE_INFINITY }]),
      ).success,
    ).toBe(false)
    expect(
      PhotoSceneInferenceBundleSchema.safeParse(
        response([{ ...floorObject, position: [Number.NaN, 1] }]),
      ).success,
    ).toBe(false)
    expect(
      PhotoSceneInferenceBundleSchema.safeParse(
        response([{ ...floorObject, dimensions: [1, Number.POSITIVE_INFINITY, 1] }]),
      ).success,
    ).toBe(false)
    expect(
      PhotoSceneInferenceBundleSchema.safeParse(
        response([floorObject, wallObject, { ...wallObject, id: 'bad', elevation: Number.NaN }]),
      ).success,
    ).toBe(false)
  })

  test('rejects image-count mismatch and unknown evidence references', () => {
    expect(
      PhotoSceneInferenceBundleSchema.safeParse({
        version: 1,
        manifest: validManifest,
        plan: { ...validPlan, source: { kind: 'smartphone-images', imageCount: 1 } },
        roomAssessments: [
          { roomName: 'Living Room', confidence: 0.8, evidenceImageIds: ['img-001'] },
        ],
      }).success,
    ).toBe(false)

    expect(
      PhotoSceneInferenceBundleSchema.safeParse({
        version: 1,
        manifest: validManifest,
        plan: validPlan,
        roomAssessments: [
          { roomName: 'Living Room', confidence: 0.8, evidenceImageIds: ['missing-image'] },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('inferPhotoScene Gemini response normalization', () => {
  const oneImageManifest = {
    version: 1 as const,
    purpose: 'rgb-spatial-reconstruction' as const,
    images: [image('img-001', 0)],
  }

  function runWithResponse(response: unknown) {
    return inferPhotoScene(
      {
        manifest: oneImageManifest,
        images: [
          { captureId: 'img-001', sequenceIndex: 0, mimeType: 'image/jpeg', base64: 'aGVsbG8=' },
        ],
      },
      { infer: async () => response },
    )
  }

  test('maps Gemini hinge and swing aliases while preserving canonical opening geometry and metadata', async () => {
    const result = await runWithResponse({
      version: 1,
      manifest: oneImageManifest,
      plan: {
        ...validPlan,
        source: { kind: 'smartphone-images', imageCount: 1 },
        rooms: [
          {
            ...validPlan.rooms[0],
            doors: [
              {
                id: 'door-1',
                wallIndex: 0,
                position: [1.4, 0],
                width: 0.8,
                height: 2.05,
                confidence: 0.92,
                hinge: 'left',
                swing: 'in',
              },
            ],
            windows: [
              {
                id: 'window-1',
                wallIndex: 2,
                position: [2.1, 3],
                width: 1.2,
                height: 1.2,
                sillHeight: 0.9,
                confidence: 0.87,
                hinge: 'right',
                swing: 'outward',
              },
            ],
            objects: [
              {
                id: 'desk-1',
                category: 'desk',
                objectType: 'desk',
                dimensions: [1.4, 0.75, 0.65],
                position: [1, 1],
                yaw: 0.2,
                confidence: 0.8,
                uncertainties: [],
              },
            ],
          },
        ],
      },
      roomAssessments: [
        {
          roomName: 'Living Room',
          confidence: 0.86,
          evidenceImageIds: ['img-001'],
          uncertainties: ['scale is estimated'],
        },
      ],
      warnings: ['Dimensions are estimates'],
    })

    expect(result.plan.rooms[0]?.doors?.[0]).toMatchObject({
      id: 'door-1',
      wallIndex: 0,
      distanceAlongWall: 1.4,
      width: 0.8,
      height: 2.05,
      confidence: 0.92,
      hingesSide: 'left',
      swingDirection: 'inward',
    })
    expect(result.plan.rooms[0]?.windows?.[0]).toMatchObject({
      id: 'window-1',
      wallIndex: 2,
      distanceAlongWall: 1.9,
      width: 1.2,
      height: 1.2,
      sillHeight: 0.9,
      confidence: 0.87,
      hingesSide: 'right',
      swingDirection: 'outward',
    })
    expect(result.plan.rooms[0]?.objects[0]?.dimensions).toEqual([1.4, 0.75, 0.65])
    expect(result.roomAssessments[0]?.uncertainties).toEqual(['scale is estimated'])
    expect(result.warnings).toEqual(['Dimensions are estimates'])
  })

  test('still rejects invalid room geometry after opening normalization', async () => {
    const response = {
      version: 1,
      manifest: oneImageManifest,
      plan: {
        ...validPlan,
        source: { kind: 'smartphone-images', imageCount: 1 },
        rooms: [
          {
            ...validPlan.rooms[0],
            polygon: [
              [0, 0],
              [4, 3],
              [0, 3],
              [4, 0],
            ],
            doors: [{ wallIndex: 0, distanceAlongWall: 2, width: 0.8, height: 2.05 }],
          },
        ],
      },
      roomAssessments: [
        { roomName: 'Living Room', confidence: 0.8, evidenceImageIds: ['img-001'] },
      ],
    }

    await expect(runWithResponse(response)).rejects.toThrow(/rooms\[0\]\.polygon/)
  })

  test('rejects a point on another wall instead of reattaching it', async () => {
    const response = {
      version: 1,
      manifest: oneImageManifest,
      plan: {
        ...validPlan,
        source: { kind: 'smartphone-images', imageCount: 1 },
        rooms: [
          {
            ...validPlan.rooms[0],
            doors: [
              {
                wallIndex: 0,
                position: [2, 3],
                width: 0.8,
                height: 2,
              },
            ],
          },
        ],
      },
      roomAssessments: [
        { roomName: 'Living Room', confidence: 0.8, evidenceImageIds: ['img-001'] },
      ],
    }

    await expect(runWithResponse(response)).rejects.toThrow(
      /not on declared wall 0; candidate wall segments within 0.025 m: 2/,
    )
  })

  test('projects a rounded point only onto its declared segment and keeps dimensions', async () => {
    const response = {
      version: 1,
      manifest: oneImageManifest,
      plan: {
        ...validPlan,
        source: { kind: 'smartphone-images', imageCount: 1 },
        rooms: [
          {
            ...validPlan.rooms[0],
            doors: [
              {
                wallIndex: 0,
                position: [1.25, 0.01],
                width: 0.8,
                height: 2,
              },
            ],
          },
        ],
      },
      roomAssessments: [
        { roomName: 'Living Room', confidence: 0.8, evidenceImageIds: ['img-001'] },
      ],
    }
    const result = await runWithResponse(response)
    expect(result.plan.rooms[0]?.doors?.[0]).toMatchObject({
      wallIndex: 0,
      distanceAlongWall: 1.25,
      width: 0.8,
      height: 2,
    })
  })
})
