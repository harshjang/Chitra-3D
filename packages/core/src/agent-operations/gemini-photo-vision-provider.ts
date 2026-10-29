import type { PhotoVisionProvider, PhotoVisionRequest } from './photo-scene-vision-adapter'

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
  error?: { message?: string; status?: string }
}

export type GeminiPhotoVisionProviderOptions = {
  apiKey: string
  model?: string
  timeoutMs?: number
}

export function createGeminiPhotoVisionProvider(
  options: GeminiPhotoVisionProviderOptions,
): PhotoVisionProvider {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('Gemini API key is required.')

  const model = options.model?.trim() || 'gemini-2.5-flash'
  const timeoutMs = options.timeoutMs ?? 120_000

  return {
    async infer(request: PhotoVisionRequest): Promise<unknown> {
      if (request.images.length < 1 || request.images.length > 6) {
        throw new Error('Photo inference requires between 1 and 6 images.')
      }

      const parts: Array<Record<string, unknown>> = [
        { text: `${request.systemPrompt}\n\n${request.userPrompt}` },
      ]

      for (const image of request.images) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) {
          throw new Error(`Unsupported image type: ${image.mimeType}`)
        }

        parts.push({
          text: `Capture ID: ${image.captureId}; sequenceIndex: ${image.sequenceIndex}.`,
        })
        parts.push({
          inline_data: {
            mime_type: image.mimeType,
            data: image.base64.replace(/[\r\n]/g, ''),
          },
        })
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ role: 'user', parts }],
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0,
                maxOutputTokens: 8192,
              },
            }),
          },
        )

        const payload = (await response.json().catch(() => ({}))) as GeminiResponse

        if (!response.ok) {
          const message = payload.error?.message || `HTTP ${response.status}`
          throw new Error(`Gemini API error (${response.status}): ${message}`)
        }

        const text = (payload.candidates ?? [])
          .flatMap((candidate) => candidate.content?.parts ?? [])
          .map((part) => part.text ?? '')
          .join('\n')
          .trim()

        if (!text) {
          throw new Error(
            `Gemini returned no text${payload.promptFeedback?.blockReason ? `; blocked: ${payload.promptFeedback.blockReason}` : ''}.`,
          )
        }

        try {
          return JSON.parse(text) as unknown
        } catch {
          throw new Error('Gemini response was not valid JSON.')
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Gemini photo inference timed out after ${timeoutMs} ms.`)
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
