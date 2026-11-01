import { createGeminiPhotoVisionProvider } from '@pascal-app/core/gemini-photo-vision-provider'
import { PhotoCaptureManifestSchema } from '@pascal-app/core/photo-scene-inference'
import { inferPhotoScene, type PhotoVisionImage } from '@pascal-app/core/photo-scene-vision-adapter'
import { CATALOG_ITEMS } from '@pascal-app/editor/catalog'
import { NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 120

const MAX_BODY_BYTES = 18 * 1024 * 1024
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_IMAGES = 6

type RequestBody = {
  manifest?: unknown
  knownMeasurement?: { description?: unknown; metres?: unknown }
  images?: Array<{
    captureId?: unknown
    sequenceIndex?: unknown
    mimeType?: unknown
    base64?: unknown
  }>
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function POST(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return jsonError('Content-Type must be application/json.', 415)
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) {
    return jsonError(
      'Photo analysis is not configured. Set GEMINI_API_KEY in the repository-root .env.local file, then restart the editor server.',
      503,
    )
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonError('Request body is too large. Use at most 6 resized RGB images.', 413)
  }

  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return jsonError('Could not read request body.', 400)
  }

  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonError('Request body is too large. Use at most 6 resized RGB images.', 413)
  }

  let body: RequestBody
  try {
    body = JSON.parse(rawBody) as RequestBody
  } catch {
    return jsonError('Request body must be valid JSON.', 400)
  }

  let manifest
  try {
    manifest = PhotoCaptureManifestSchema.parse(body.manifest)
  } catch (error) {
    return jsonError(
      `Invalid capture manifest: ${error instanceof Error ? error.message : 'schema validation failed'}`,
      400,
    )
  }

  if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > MAX_IMAGES) {
    return jsonError(`Provide between 1 and ${MAX_IMAGES} image payloads per request.`, 400)
  }
  if (manifest.images.length !== body.images.length) {
    return jsonError('Manifest image count must match the supplied image payload count.', 400)
  }

  let totalImageBytes = 0
  const images: PhotoVisionImage[] = []
  for (const item of body.images) {
    if (
      typeof item.captureId !== 'string' ||
      typeof item.sequenceIndex !== 'number' ||
      !Number.isInteger(item.sequenceIndex) ||
      typeof item.mimeType !== 'string' ||
      typeof item.base64 !== 'string'
    ) {
      return jsonError('Each image needs captureId, sequenceIndex, mimeType and base64.', 400)
    }

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(item.mimeType)) {
      return jsonError(
        'Only JPEG, PNG, and WebP images are supported. Convert HEIC/HEIF first.',
        415,
      )
    }
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(item.base64) || !item.base64.trim()) {
      return jsonError(`Image "${item.captureId}" must contain raw base64 data.`, 400)
    }

    const estimatedBytes = Math.floor((item.base64.replace(/[\r\n]/g, '').length * 3) / 4)
    if (estimatedBytes > MAX_IMAGE_BYTES) {
      return jsonError(
        `Image "${item.captureId}" exceeds the 2 MiB per-image limit. Resize it first.`,
        413,
      )
    }
    totalImageBytes += estimatedBytes
    images.push({
      captureId: item.captureId,
      sequenceIndex: item.sequenceIndex,
      mimeType: item.mimeType as PhotoVisionImage['mimeType'],
      base64: item.base64,
    })
  }

  if (totalImageBytes > MAX_IMAGES * MAX_IMAGE_BYTES) {
    return jsonError('Combined image payload is too large.', 413)
  }

  try {
    const provider = createGeminiPhotoVisionProvider({
      apiKey,
      model: process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
    })
    let knownMeasurement: { description: string; metres: number } | undefined
    if (body.knownMeasurement !== undefined) {
      const { description, metres } = body.knownMeasurement
      if (
        typeof description !== 'string' ||
        !description.trim() ||
        typeof metres !== 'number' ||
        !Number.isFinite(metres) ||
        metres <= 0 ||
        metres > 1000
      ) {
        return jsonError(
          'Known measurement needs a description and a positive length in metres.',
          400,
        )
      }
      knownMeasurement = { description: description.trim(), metres }
    }
    const catalog = CATALOG_ITEMS.map((item) => ({
      id: item.id,
      category: item.category,
      name: item.name,
      dimensions: item.dimensions,
      attachTo: item.attachTo,
      tags: item.tags,
    }))
    const result = await inferPhotoScene({ manifest, images, knownMeasurement, catalog }, provider)
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Photo inference failed.'
    // Do not send secrets or upstream response bodies back to the browser.
    const safeMessage = message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    const isValidation = error instanceof Error && error.name === 'ZodError'
    const validationSummary =
      isValidation && 'issues' in error && Array.isArray(error.issues)
        ? error.issues
            .slice(0, 8)
            .map(
              (issue: { path?: unknown[]; message?: string }) =>
                `${Array.isArray(issue.path) ? issue.path.join('.') || 'response' : 'response'}: ${issue.message ?? 'invalid value'}`,
            )
            .join('; ') +
          (error.issues.length > 8 ? `; and ${error.issues.length - 8} more issue(s)` : '')
        : safeMessage
    return jsonError(
      isValidation ? `Model output failed schema validation: ${validationSummary}` : safeMessage,
      isValidation ? 422 : 502,
    )
  }
}
