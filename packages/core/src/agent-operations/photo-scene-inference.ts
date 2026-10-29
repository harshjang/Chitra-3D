import { z } from 'zod'
import { PhotoScenePlanSchema } from './photo-scene-plan'

/** Metadata for one RGB photograph supplied to the baseline reconstruction model. */
export const PhotoCaptureImageSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    fileName: z.string().trim().min(1).max(512),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
    sequenceIndex: z.number().int().nonnegative(),
    modality: z.literal('rgb').default('rgb'),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    capturedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((image, ctx) => {
    if ((image.width === undefined) !== (image.height === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['width'],
        message: 'width and height must either both be provided or both be omitted',
      })
    }
  })

export const PhotoCaptureManifestSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal('rgb-spatial-reconstruction'),
    images: z.array(PhotoCaptureImageSchema).min(1).max(500),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>()
    const sequenceIndices = new Set<number>()

    manifest.images.forEach((image, index) => {
      if (ids.has(image.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['images', index, 'id'],
          message: `duplicate image id: ${image.id}`,
        })
      }
      ids.add(image.id)

      if (sequenceIndices.has(image.sequenceIndex)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['images', index, 'sequenceIndex'],
          message: `duplicate sequenceIndex: ${image.sequenceIndex}`,
        })
      }
      sequenceIndices.add(image.sequenceIndex)
    })
  })

export const PhotoSceneRoomAssessmentSchema = z
  .object({
    roomName: z.string().trim().min(1).max(160),
    confidence: z.number().min(0).max(1),
    evidenceImageIds: z.array(z.string().trim().min(1).max(160)).min(1),
    uncertainties: z.array(z.string().trim().min(1).max(500)).default([]),
  })
  .strict()

/**
 * Model-independent handoff from image understanding to native scene construction.
 * Geometry remains a PhotoScenePlan; this contract adds evidence and uncertainty,
 * not meshes or alternate geometry representations.
 */
export const PhotoSceneInferenceBundleSchema = z
  .object({
    version: z.literal(1),
    manifest: PhotoCaptureManifestSchema,
    plan: PhotoScenePlanSchema,
    roomAssessments: z.array(PhotoSceneRoomAssessmentSchema),
    warnings: z.array(z.string().trim().min(1).max(1000)).default([]),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (bundle.plan.source.imageCount !== bundle.manifest.images.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plan', 'source', 'imageCount'],
        message: 'plan source imageCount must equal manifest image count',
      })
    }

    const imageIds = new Set(bundle.manifest.images.map((image) => image.id))
    bundle.roomAssessments.forEach((assessment, index) => {
      assessment.evidenceImageIds.forEach((id, evidenceIndex) => {
        if (!imageIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['roomAssessments', index, 'evidenceImageIds', evidenceIndex],
            message: `evidence image id is not present in the manifest: ${id}`,
          })
        }
      })
    })

    const planRoomNames = new Set(bundle.plan.rooms.map((room) => room.name.toLocaleLowerCase()))
    const assessmentNames = new Set<string>()
    bundle.roomAssessments.forEach((assessment, index) => {
      const key = assessment.roomName.toLocaleLowerCase()
      if (!planRoomNames.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roomAssessments', index, 'roomName'],
          message: `assessment refers to a room absent from the plan: ${assessment.roomName}`,
        })
      }
      if (assessmentNames.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roomAssessments', index, 'roomName'],
          message: `duplicate room assessment: ${assessment.roomName}`,
        })
      }
      assessmentNames.add(key)
    })
  })

export type PhotoCaptureImage = z.infer<typeof PhotoCaptureImageSchema>
export type PhotoCaptureManifest = z.infer<typeof PhotoCaptureManifestSchema>
export type PhotoSceneRoomAssessment = z.infer<typeof PhotoSceneRoomAssessmentSchema>
export type PhotoSceneInferenceBundle = z.infer<typeof PhotoSceneInferenceBundleSchema>

export function parsePhotoCaptureManifest(input: unknown): PhotoCaptureManifest {
  return PhotoCaptureManifestSchema.parse(input)
}

export function parsePhotoSceneInferenceBundle(input: unknown): PhotoSceneInferenceBundle {
  return PhotoSceneInferenceBundleSchema.parse(input)
}
