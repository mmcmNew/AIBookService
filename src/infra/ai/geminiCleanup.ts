/**
 * Адаптер вызова Gemini API для ИИ-очистки текста (Infra).
 * Делает один HTTP-запрос и возвращает сырой результат без принятия решений.
 */

export interface GeminiCleanupRequest {
  apiKey: string;
  model: string;
  instruction: string;
  payload: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface GeminiCleanupResponse {
  ok: boolean;
  status: number;
  text?: string;
  blockReason?: string;
  errorBody?: any;
}

const ENDPOINT = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export async function requestGeminiCleanup(req: GeminiCleanupRequest): Promise<GeminiCleanupResponse> {
  const doFetch = req.fetchImpl ?? fetch;
  const response = await doFetch(ENDPOINT(req.model), {
    method: 'POST',
    signal: req.signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': req.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.instruction }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(req.payload) }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    return {
      ok: false,
      status: response.status,
      errorBody,
    };
  }

  const data = await response.json();
  const text: string | undefined = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('');
  const blockReason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;

  return {
    ok: true,
    status: response.status,
    text,
    blockReason,
  };
}
