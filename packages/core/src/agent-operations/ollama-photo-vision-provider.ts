import type { PhotoVisionProvider, PhotoVisionRequest } from './photo-scene-vision-adapter'

export type OllamaPhotoVisionProviderOptions = {
  baseUrl?: string
  model?: string
  timeoutMs?: number
}

type OllamaChatResponse = {
  message?: { content?: string }
  error?: string
  done_reason?: string
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
}

/** Runs vision inference against a local Ollama server. No API key or cloud calls. */
export function createOllamaPhotoVisionProvider(
  options: OllamaPhotoVisionProviderOptions = {},
): PhotoVisionProvider {
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = options.model ?? 'qwen2.5vl:3b'
  const timeoutMs = options.timeoutMs ?? 180_000

  return {
    async infer(request: PhotoVisionRequest): Promise<unknown> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            stream: false,
            format: 'json',
            options: { temperature: 0, num_ctx: 16384, num_predict: 2048 },
            messages: [
              {
                role: 'user',
                content: `${request.systemPrompt}\n\n${request.userPrompt}\n\nReturn only the complete JSON object required by the prompt. Do not invent metric dimensions from photographs. If dimensions cannot be established, mark the uncertainty and use conservative, clearly labelled estimates.`,
                images: request.images.map((image) => image.base64.replace(/[\r\n]/g, '')),
              },
            ],
          }),
        })

        const payload = (await response.json().catch(() => ({}))) as OllamaChatResponse
        if (!response.ok) {
          throw new Error(
            payload.error ||
              `Local Ollama request failed (${response.status}). Is Ollama running and the model downloaded?`,
          )
        }
        const content = payload.message?.content
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error(
            `Ollama returned empty content. done=${payload.done}; reason=${payload.done_reason ?? 'unknown'}; promptTokens=${payload.prompt_eval_count ?? 'unknown'}; outputTokens=${payload.eval_count ?? 'unknown'}. Check the Ollama terminal for memory or context errors.`,
          )
        }
        try {
          return JSON.parse(content) as unknown
        } catch {
          throw new Error(
            'Ollama returned invalid JSON. Try fewer/smaller images or a more capable local vision model.',
          )
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Local Ollama inference timed out after ${timeoutMs} ms.`)
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
