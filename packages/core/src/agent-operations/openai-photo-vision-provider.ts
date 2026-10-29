import type { PhotoVisionProvider, PhotoVisionRequest } from './photo-scene-vision-adapter'

export type OpenAIPhotoVisionProviderOptions = {
  /** Supply only from server-side environment/configuration. Never from client input. */
  apiKey: string
  /** Must be a vision-capable Responses API model. Defaults to gpt-4o. */
  model?: string
  timeoutMs?: number
}

type ResponsesApiPayload = {
  output_text?: string
  status?: string
  incomplete_details?: { reason?: string } | null
  output?: Array<{
    type?: string
    status?: string
    content?: Array<{
      type?: string
      text?: string
      refusal?: string
    }>
  }>
  error?: { message?: string; type?: string }
}

function getOutputText(payload: ResponsesApiPayload): string {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text
  }

  const parts: string[] = []
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'refusal' && content.refusal) {
        throw new Error(`Vision model refused the request: ${content.refusal}`)
      }
      if (content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text)
      }
    }
  }

  const text = parts.join('\n').trim()
  if (!text) {
    const reason = payload.incomplete_details?.reason
    throw new Error(
      `Vision model returned no JSON output${reason ? ` (incomplete: ${reason})` : ''}.`,
    )
  }
  return text
}

/**
 * Instantiate this only in server-side code. The caller validates returned data
 * with PhotoSceneInferenceBundleSchema via inferPhotoScene().
 */
export function createOpenAIPhotoVisionProvider(
  options: OpenAIPhotoVisionProviderOptions,
): PhotoVisionProvider {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('OpenAI API key is required.')

  const model = options.model?.trim() || 'gpt-4o'
  const timeoutMs = options.timeoutMs ?? 120_000

  return {
    async infer(request: PhotoVisionRequest): Promise<unknown> {
      if (request.images.length < 1 || request.images.length > 6) {
        throw new Error('The initial photo inference batch must contain 1 to 6 RGB images.')
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const content: Array<Record<string, unknown>> = [
          { type: 'input_text', text: request.userPrompt },
        ]

        for (const image of request.images) {
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) {
            throw new Error(
              `Unsupported image type "${image.mimeType}" for capture "${image.captureId}". Convert to JPEG or PNG first.`,
            )
          }
          content.push({
            type: 'input_text',
            text: `Capture ID: ${image.captureId}; sequenceIndex: ${image.sequenceIndex}.`,
          })
          content.push({
            type: 'input_image',
            image_url: `data:${image.mimeType};base64,${image.base64}`,
            detail: 'high',
          })
        }

        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            instructions: request.systemPrompt,
            input: [{ role: 'user', content }],
            text: { format: { type: 'json_object' } },
            max_output_tokens: 8000,
          }),
        })

        const payload = (await response.json().catch(() => ({}))) as ResponsesApiPayload

        if (!response.ok) {
          const message = payload.error?.message || `HTTP ${response.status}`
          throw new Error(`OpenAI Responses API error: ${message}`)
        }
        if (payload.status && payload.status !== 'completed') {
          const reason = payload.incomplete_details?.reason
          throw new Error(
            `OpenAI response status was "${payload.status}"${reason ? ` (${reason})` : ''}.`,
          )
        }

        const outputText = getOutputText(payload)
        try {
          return JSON.parse(outputText) as unknown
        } catch {
          throw new Error('Vision model response was not valid JSON.')
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`OpenAI photo inference timed out after ${timeoutMs} ms.`)
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
