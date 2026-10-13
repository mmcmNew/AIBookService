/**
 * Необязательная «ИИ-очистка» абзацев через Gemini (ключ пользователя).
 * Ничего не применяется автоматически: функция возвращает предложенные варианты, а редактор показывает diff
 * и применяет только подтверждённые.
 */

export const AI_CLEANUP_MODEL = 'gemini-2.5-flash';
const ENDPOINT = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export const AI_CLEANUP_INSTRUCTION =
  'Ты корректор текста, полученного после распознавания книги (OCR/PDF). Тебе приходит JSON-массив абзацев. ' +
  'Исправь только ошибки распознавания: перепутанные буквы, латинские двойники в русских словах, лишние пробелы внутри слов, ' +
  'разорванные переносом слова, остатки Markdown-разметки, мусорные символы. ' +
  'НЕ меняй смысл, стиль, порядок слов, не добавляй и не удаляй предложения, не переводи текст, не пересказывай. ' +
  'Если абзац уже корректен — верни его без изменений. ' +
  'Верни ТОЛЬКО JSON-массив строк той же длины и в том же порядке, без пояснений и без обрамления.';

export interface AiCleanupOptions {
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
  /** Максимум символов в одном запросе */
  batchChars?: number;
  /** Максимум абзацев в одном запросе */
  batchItems?: number;
  onProgress?: (done: number, total: number) => void;
  /** Для тестов */
  fetchImpl?: typeof fetch;
}

export interface AiCleanupResult {
  /** Предложенный текст для каждого абзаца (при ошибке или отклонении — исходный) */
  results: string[];
  /** Индексы абзацев, для которых получен вариант, отличающийся от исходного */
  changed: number[];
  /** Человекочитаемые ошибки (по батчам и отклонённым абзацам) */
  errors: string[];
}

export function splitIntoBatches(paragraphs: string[], maxChars: number, maxItems: number): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let size = 0;
  paragraphs.forEach((p, i) => {
    if (current.length > 0 && (size + p.length > maxChars || current.length >= maxItems)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(i);
    size += p.length;
  });
  if (current.length) batches.push(current);
  return batches;
}

function explainHttpError(status: number, body: any): string {
  const apiMsg: string | undefined = body?.error?.message;
  if (status === 400 && /API key/i.test(apiMsg ?? '')) return 'Ключ Gemini API недействителен. Проверьте его в настройках.';
  if (status === 401 || status === 403) return `Доступ запрещён (HTTP ${status}). Проверьте ключ Gemini API и его права.${apiMsg ? ' ' + apiMsg : ''}`;
  if (status === 429) return 'Превышен лимит запросов Gemini (HTTP 429). Подождите и повторите попытку.';
  if (status >= 500) return `Сервис Gemini временно недоступен (HTTP ${status}).`;
  return `Ошибка Gemini (HTTP ${status})${apiMsg ? ': ' + apiMsg : ''}`;
}

/** Достаёт JSON-массив из ответа модели (допускает обрамление ```json). */
export function parseJsonArray(raw: string): unknown[] | null {
  let t = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1];
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : null;
  } catch {
    const a = t.indexOf('[');
    const b = t.lastIndexOf(']');
    if (a >= 0 && b > a) {
      try {
        const v = JSON.parse(t.slice(a, b + 1));
        return Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Правка допустима, если модель не пересказала и не обрезала абзац. */
export function isReasonableEdit(before: string, after: string): boolean {
  if (!after.trim()) return false;
  const ratio = after.length / Math.max(1, before.length);
  return ratio >= 0.6 && ratio <= 1.5;
}

export async function aiCleanParagraphs(paragraphs: string[], options: AiCleanupOptions): Promise<AiCleanupResult> {
  const { apiKey, signal } = options;
  const model = options.model || AI_CLEANUP_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  const results = paragraphs.slice();
  const errors: string[] = [];
  if (!apiKey) {
    return { results, changed: [], errors: ['Не задан ключ Gemini API. Добавьте его в настройках (раздел «Ключи API»).'] };
  }

  const batches = splitIntoBatches(paragraphs, options.batchChars ?? 6000, options.batchItems ?? 20);
  let done = 0;
  options.onProgress?.(0, paragraphs.length);

  for (let b = 0; b < batches.length; b++) {
    if (signal?.aborted) {
      errors.push('Операция прервана пользователем.');
      break;
    }
    const idxs = batches[b];
    const input = idxs.map((i) => paragraphs[i]);
    try {
      const response = await doFetch(ENDPOINT(model), {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: AI_CLEANUP_INSTRUCTION }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        errors.push(`Пакет ${b + 1}/${batches.length}: ${explainHttpError(response.status, body)}`);
        // Ошибки ключа/лимита не лечатся повтором — прекращаем
        if ([400, 401, 403, 429].includes(response.status)) break;
        continue;
      }

      const data = await response.json();
      const text: string | undefined = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('');
      if (!text) {
        const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
        errors.push(`Пакет ${b + 1}/${batches.length}: модель не вернула текст${reason ? ` (${reason})` : ''}.`);
        continue;
      }
      const arr = parseJsonArray(text);
      if (!arr || arr.length !== input.length || arr.some((x) => typeof x !== 'string')) {
        errors.push(
          `Пакет ${b + 1}/${batches.length}: ответ модели не соответствует формату (ожидался массив из ${input.length} строк).`
        );
        continue;
      }
      idxs.forEach((paragraphIndex, k) => {
        const before = paragraphs[paragraphIndex];
        const after = (arr[k] as string).trim();
        if (after === before.trim()) return;
        if (isReasonableEdit(before, after)) results[paragraphIndex] = after;
        else errors.push(`Абзац ${paragraphIndex + 1}: правка отклонена (модель сильно изменила длину текста).`);
      });
    } catch (e) {
      if ((e as any)?.name === 'AbortError') {
        errors.push('Операция прервана пользователем.');
        break;
      }
      errors.push(`Пакет ${b + 1}/${batches.length}: сетевая ошибка (${e instanceof Error ? e.message : String(e)}).`);
    }
    done += idxs.length;
    options.onProgress?.(done, paragraphs.length);
  }

  const changed = results.reduce<number[]>((acc, r, i) => (r !== paragraphs[i] ? (acc.push(i), acc) : acc), []);
  return { results, changed, errors };
}
