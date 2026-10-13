import { AggregatorApiMode, ITTSProvider, SynthesisOptions, VoiceOption } from '../../types/tts';

/**
 * Тип модели с точки зрения озвучки:
 * - speech     — TTS-модель (architecture.output_modalities содержит "speech"), только POST /audio/speech
 * - chat-audio — чат-модель с аудио-выходом (output_modalities содержит "audio"), POST /chat/completions + modalities
 * - other      — всё остальное (текст, изображения, STT/transcription, embeddings...)
 */
export type AggregatorModelKind = 'speech' | 'chat-audio' | 'other';

export interface AggregatorModelInfo {
  id: string;
  name: string;
  description?: string;
  /** true для speech и chat-audio */
  isAudio: boolean;
  kind: AggregatorModelKind;
  /** Голоса из каталога (поле supported_voices), если есть */
  voices?: string[];
}

/** Эвристика по id — только когда в каталоге нет architecture */
function kindFromId(id: string): AggregatorModelKind {
  const s = id.toLowerCase();
  if (/transcri|whisper|embed|rerank/.test(s)) return 'other';
  if (/(^|[\/\-_])(tts|speech)([\/\-_.:]|$)|tts-1|-tts|kokoro|piper|xtts|bark|orpheus|eleven-|voxtral.*tts|aura-2|seed-audio|mai-voice/.test(s)) return 'speech';
  if (/(^|\/)gpt-(4o-)?(mini-)?audio|audio-preview/.test(s)) return 'chat-audio';
  return 'other';
}

/**
 * Классификация модели из каталога /models по реальной структуре OpenRouter:
 *   architecture.modality = "text->speech", output_modalities = ["speech"]        → speech
 *   architecture.modality = "text+audio->text+audio", output_modalities has audio → chat-audio
 *   "audio->transcription" (STT), "text->embeddings", ... → other
 * Если architecture отсутствует (сторонний шлюз) — используется эвристика по id.
 */
export function classifyModel(m: any): AggregatorModelKind {
  const id: string = String(m?.id || m?.name || '');
  const arch = m?.architecture;
  const outs: string[] = Array.isArray(arch?.output_modalities)
    ? arch.output_modalities.map((x: any) => String(x).toLowerCase())
    : [];
  const modality: string = typeof arch?.modality === 'string' ? arch.modality.toLowerCase() : '';
  const outPart = modality.includes('->') ? modality.split('->')[1] : '';
  const outTokens = outs.length > 0 ? outs : outPart.split('+').filter(Boolean);

  if (outTokens.length > 0) {
    if (outTokens.includes('speech')) return 'speech';
    if (outTokens.includes('audio')) {
      // Генерация музыки (Lyria) — не озвучка текста
      if (/lyria|music/i.test(id)) return 'other';
      return 'chat-audio';
    }
    return 'other';
  }
  return kindFromId(id);
}

/** Id специального варианта «По умолчанию модели»: поле voice в запрос не отправляется */
export const OPENROUTER_DEFAULT_VOICE_ID = '';

export const OPENROUTER_DEFAULT_VOICE_OPTION: VoiceOption = {
  id: OPENROUTER_DEFAULT_VOICE_ID,
  name: 'По умолчанию модели (рекомендуется)',
  lang: 'ru-RU',
  gender: 'neutral',
  provider: 'openrouter',
};

const mkVoice = (id: string, name: string, gender: 'male' | 'female' | 'neutral'): VoiceOption => ({
  id,
  name: `${id[0].toUpperCase()}${id.slice(1)} (${name})`,
  lang: 'ru-RU',
  gender,
  provider: 'openrouter',
});

const VOICE_CATALOG: Record<string, VoiceOption> = {
  alloy: mkVoice('alloy', 'нейтральный', 'neutral'),
  ash: mkVoice('ash', 'мужской, разговорный', 'male'),
  ballad: mkVoice('ballad', 'мужской, дикторский', 'male'),
  coral: mkVoice('coral', 'женский, эмоциональный', 'female'),
  echo: mkVoice('echo', 'мужской, мягкий', 'male'),
  fable: mkVoice('fable', 'выразительный', 'male'),
  nova: mkVoice('nova', 'женский, энергичный', 'female'),
  onyx: mkVoice('onyx', 'мужской, глубокий', 'male'),
  sage: mkVoice('sage', 'женский, спокойный', 'female'),
  shimmer: mkVoice('shimmer', 'женский, звонкий', 'female'),
  verse: mkVoice('verse', 'мужской, динамичный', 'male'),
  marin: mkVoice('marin', 'женский, диктор', 'female'),
  cedar: mkVoice('cedar', 'мужской, тёплый', 'male'),
};

const pick = (ids: string[]) => ids.map((id) => VOICE_CATALOG[id]);

const VOICES_CHAT_AUDIO = pick(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);
const VOICES_TTS_1 = pick(['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']);
const VOICES_MINI_TTS = pick(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);

/** Обратная совместимость: прежний экспорт (список голосов OpenAI Audio) */
export const OPENROUTER_DEFAULT_VOICES: VoiceOption[] = VOICES_MINI_TTS;

/**
 * Маппинг модель -> поддерживаемые голоса. null — модель неизвестна,
 * голос нужно оставить по умолчанию или ввести вручную.
 */
export function getKnownModelVoices(model?: string): VoiceOption[] | null {
  const id = (model || '').toLowerCase();
  if (!id) return null;
  if (/gpt-4o-mini-tts/.test(id)) return VOICES_MINI_TTS;
  if (/(^|\/)tts-1(-hd)?$/.test(id)) return VOICES_TTS_1;
  if (/gpt-4o(-mini)?-audio|(^|\/)gpt-audio/.test(id)) return VOICES_CHAT_AUDIO;
  return null;
}

/** Нормализация голоса: пустая строка и 'default' означают «по умолчанию модели» */
export function normalizeAggregatorVoice(voiceId?: string): string {
  const t = (voiceId || '').trim();
  return t.toLowerCase() === 'default' ? '' : t;
}

/** Голоса из каталога (supported_voices) → VoiceOption[] */
export function catalogVoicesToOptions(ids?: string[]): VoiceOption[] {
  return (ids || []).map((id) => ({ id, name: id, lang: 'ru-RU', gender: 'neutral' as const, provider: 'openrouter' as const }));
}

/**
 * Список голосов для выбора в UI: «по умолчанию» + голоса шлюза (/audio/voices),
 * либо голоса модели из каталога (supported_voices), либо известные голоса модели.
 * Для неизвестных моделей — только «по умолчанию».
 */
export function resolveAggregatorVoiceOptions(
  model: string | undefined,
  gatewayVoices: VoiceOption[] = [],
  catalogVoices?: string[]
): VoiceOption[] {
  const own = gatewayVoices.filter((x) => x.id);
  const fromCatalog = catalogVoicesToOptions(catalogVoices);
  const list = fromCatalog.length > 0 ? fromCatalog : own.length > 0 ? own : getKnownModelVoices(model) || [];
  return [OPENROUTER_DEFAULT_VOICE_OPTION, ...list];
}

/** Годится ли голос для модели (неизвестная модель → любой ручной id допустим) */
export function isVoiceValidForModel(
  voiceId: string,
  model: string | undefined,
  gatewayVoices: VoiceOption[] = [],
  catalogVoices?: string[]
): boolean {
  const id = normalizeAggregatorVoice(voiceId);
  if (!id) return true;
  if (catalogVoices && catalogVoices.length > 0) return catalogVoices.includes(id);
  const own = gatewayVoices.filter((x) => x.id);
  const list = own.length > 0 ? own : getKnownModelVoices(model);
  if (!list) return true;
  return list.some((x) => x.id === id);
}

/**
 * Извлечение читаемого текста ошибки от OpenRouter, Cloudflare или OpenAI-совместимого шлюза
 */
function extractApiErrorMessage(errJson: any, statusText: string, status: number): string {
  let message = '';
  if (typeof errJson?.error === 'string') {
    message = errJson.error;
  } else if (errJson?.error?.message && typeof errJson.error.message === 'string') {
    message = errJson.error.message;
  } else if (typeof errJson?.message === 'string') {
    message = errJson.message;
  } else {
    message = statusText || 'Неизвестная ошибка сервера';
  }

  if (status === 403 && (message.includes('Access denied') || message.includes('security policy') || message.toLowerCase().includes('forbidden'))) {
    return `${message} (Cloudflare WAF / Geo-blocking: доступ к OpenRouter заблокирован по геолокации/IP. Требуется включенный VPN/прокси или сторонний рабочий шлюз)`;
  }
  if (status === 401) {
    return `${message} (Неверный или отсутствующий API-ключ. Проверьте ключ во вкладке «API Ключи (BYOK)»)`;
  }
  return message;
}

export class OpenRouterTTSProvider implements ITTSProvider {
  id = 'openrouter' as const;
  name = 'OpenRouter & Агрегаторы';
  description = 'Шлюз к аудио-моделям (OpenAI GPT-4o Audio и сторонние агрегаторы). Требует прямого доступа к API или VPN/прокси.';
  requiresApiKey = true;
  supportsVoiceCloning = false;
  supportsOffline = false;

  /**
   * Список голосов: всегда «По умолчанию модели» + (для сторонних шлюзов) голоса из /audio/voices.
   * Голоса конкретной модели см. resolveAggregatorVoiceOptions().
   */
  async getVoices(apiKey?: string, baseUrl?: string): Promise<VoiceOption[]> {
    const cleanUrl = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const result: VoiceOption[] = [OPENROUTER_DEFAULT_VOICE_OPTION];

    // У openrouter.ai нет /audio/voices — спрашиваем только сторонние шлюзы
    if (!cleanUrl.includes('openrouter.ai')) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const res = await fetch(`${cleanUrl}/audio/voices`, { headers, signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          const voiceList = Array.isArray(data) ? data : data?.voices || data?.data || [];
          if (Array.isArray(voiceList)) {
            for (const x of voiceList) {
              const id = typeof x === 'string' ? x : x?.id || x?.voice_id || x?.name;
              if (!id || typeof id !== 'string') continue;
              result.push({
                id,
                name: typeof x === 'string' ? x : `${x.name || id}${x.lang ? ` (${x.lang})` : ''}`,
                lang: x?.lang || 'ru-RU',
                gender: x?.gender === 'male' || x?.gender === 'female' ? x.gender : 'neutral',
                provider: 'openrouter',
              });
            }
          }
        }
      } catch {
        // шлюз не поддерживает /audio/voices — это нормально
      } finally {
        clearTimeout(timer);
      }
    }
    return result;
  }

  /**
   * Получение реального списка моделей со шлюза (с кэшем на 10 минут и защитой от параллельных запросов).
   * Не скрывает ошибки: если шлюз недоступен, выбрасывает исключение с точной причиной.
   * Для openrouter.ai дополнительно запрашивается /models?output_modalities=speech, так как
   * по умолчанию каталог OpenRouter НЕ содержит TTS-моделей.
   * @param force true — игнорировать кэш (кнопка «Проверить подключение»)
   */
  async fetchModels(apiKey?: string, baseUrl: string = 'https://openrouter.ai/api/v1', force = false): Promise<AggregatorModelInfo[]> {
    const cleanUrl = baseUrl.replace(/\/+$/, '');
    const cacheKey = `${cleanUrl}|${apiKey ? apiKey.slice(-6) : ''}`;
    if (!force) {
      const hit = catalogCache.get(cacheKey);
      if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models;
      const pending = catalogInflight.get(cacheKey);
      if (pending) return pending;
    }
    const p = this.loadCatalog(apiKey, cleanUrl)
      .then((models) => {
        catalogCache.set(cacheKey, { at: Date.now(), models });
        for (const m of models) catalogKinds.set(`${cleanUrl}|${m.id}`, m);
        return models;
      })
      .finally(() => {
        catalogInflight.delete(cacheKey);
      });
    catalogInflight.set(cacheKey, p);
    return p;
  }

  private async loadCatalog(apiKey: string | undefined, cleanUrl: string): Promise<AggregatorModelInfo[]> {
    const headers: Record<string, string> = {
      'HTTP-Referer': 'https://aibookreader.app',
      'X-Title': 'AIBookReader',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const get = async (url: string): Promise<any[]> => {
      let response: Response;
      try {
        response = await fetch(url, { method: 'GET', headers });
      } catch (netErr: any) {
        throw new Error(`Сетевая ошибка при обращении к ${url}: ${netErr.message || 'Сервер недоступен или запрос заблокирован CORS/сетью'}`);
      }
      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        const errMsg = extractApiErrorMessage(errJson, response.statusText, response.status);
        throw new Error(`Ошибка подключения к ${url} (${response.status}): ${errMsg}`);
      }
      const json = await response.json().catch(() => null);
      const raw = json?.data || json?.models || [];
      return Array.isArray(raw) ? raw : [];
    };

    const isOR = cleanUrl.includes('openrouter.ai');
    const [base, speech] = await Promise.all([
      get(`${cleanUrl}/models`),
      isOR ? get(`${cleanUrl}/models?output_modalities=speech`).catch(() => [] as any[]) : Promise.resolve([] as any[]),
    ]);

    const byId = new Map<string, any>();
    for (const m of [...base, ...speech]) {
      const id = m?.id || m?.name;
      if (id && !byId.has(id)) byId.set(id, m);
    }

    const rank = { speech: 0, 'chat-audio': 1, other: 2 } as const;
    const parsed: AggregatorModelInfo[] = Array.from(byId.values()).map((m) => {
      const id: string = m.id || m.name;
      const kind = classifyModel(m);
      const voices = Array.isArray(m.supported_voices)
        ? m.supported_voices.filter((v: any) => typeof v === 'string' && v)
        : undefined;
      return {
        id,
        name: m.name || id,
        description: m.description || '',
        isAudio: kind !== 'other',
        kind,
        voices: voices && voices.length > 0 ? voices : undefined,
      };
    });

    // Сначала TTS (speech), затем chat-audio, затем остальные; внутри групп по алфавиту
    return parsed.sort((a, b) => rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id));
  }

  /**
   * Синтез речи.
   * - chat: /chat/completions, modalities ["text","audio"], stream:true, audio.format pcm16
   *   (ответ — SSE-чанки delta.audio.data, base64 PCM16 24 кГц mono, оборачивается в WAV).
   * - speech: OpenAI-совместимый POST /audio/speech (есть и у openrouter.ai). Ответ — сырой аудио-поток (mp3 / pcm).
   *
   * В режиме auto эндпоинт выбирается: запомненный выбор → классификация по каталогу → эвристика по id;
   * при ошибке «не тот эндпоинт» запрос автоматически повторяется через другой, и выбор запоминается.
   * Режимы chat / speech — жёсткое принуждение, без повторов.
   */
  async synthesize(text: string, options: SynthesisOptions): Promise<ArrayBuffer> {
    if (!options.apiKey) {
      throw new Error('Для OpenRouter / агрегатора требуется указать API-ключ в настройках (вкладка "API Ключи (BYOK)").');
    }

    const cleanUrl = (options.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const model = (options.model || 'openai/gpt-audio-mini').trim();
    const voice = normalizeAggregatorVoice(options.voiceId);
    const requested: AggregatorApiMode = options.apiMode || 'auto';
    const ctx: RequestCtx = { cleanUrl, model, voice, text, apiKey: options.apiKey, signal: options.signal };

    const runOnce = (c: RequestCtx, mode: EndpointMode) => (mode === 'chat' ? requestChatAudio(c) : requestSpeech(c));
    // Шлюз ответил «voice is missing» — повторяем с голосом из каталога модели (или alloy) и запоминаем его
    const run = async (mode: EndpointMode): Promise<ArrayBuffer> => {
      try {
        return await runOnce(ctx, mode);
      } catch (e: any) {
        if (ctx.voice || !(e instanceof ApiHttpError) || e.status !== 400 || !VOICE_REQUIRED.test(e.message)) throw e;
        const v = requiredVoiceFor(ctx);
        const buf = await runOnce({ ...ctx, voice: v }, mode);
        rememberVoice(ctx, v);
        return buf;
      }
    };
    const label = (mode: EndpointMode) => `${cleanUrl}${mode === 'chat' ? '/chat/completions' : '/audio/speech'}`;
    const withCtx = (mode: EndpointMode, e: any) =>
      e instanceof Error ? new Error(`${e.message}\n[модель ${model}, эндпоинт ${label(mode)}]`) : e;

    if (requested === 'chat' || requested === 'speech') {
      try {
        return await run(requested);
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        throw withCtx(requested, err);
      }
    }

    const primary = resolveAutoMode(cleanUrl, model);
    try {
      const buf = await run(primary);
      rememberMode(cleanUrl, model, primary);
      return buf;
    } catch (err: any) {
      if (err?.name === 'AbortError' || !shouldSwitchEndpoint(primary, err, cleanUrl)) throw withCtx(primary, err);
      const other: EndpointMode = primary === 'chat' ? 'speech' : 'chat';
      try {
        const buf = await run(other);
        rememberMode(cleanUrl, model, other);
        return buf;
      } catch (err2: any) {
        if (err2?.name === 'AbortError') throw err2;
        throw new Error(
          `${err.message}\n[модель ${model}, эндпоинт ${label(primary)}]\nАвто-повтор через ${label(other)} тоже не сработал: ${err2.message}\n[модель ${model}, эндпоинт ${label(other)}]`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Выбор эндпоинта (auto)
// ---------------------------------------------------------------------------

type EndpointMode = 'chat' | 'speech';

const CATALOG_TTL_MS = 10 * 60 * 1000;
const catalogCache = new Map<string, { at: number; models: AggregatorModelInfo[] }>();
const catalogInflight = new Map<string, Promise<AggregatorModelInfo[]>>();
/** Классификация из каталога: baseUrl|modelId → модель */
const catalogKinds = new Map<string, AggregatorModelInfo>();

const MODE_STORAGE_KEY = 'aibr-tts-endpoint-mode';
const learnedModes = new Map<string, EndpointMode>();
let learnedLoaded = false;

function loadLearned() {
  if (learnedLoaded) return;
  learnedLoaded = true;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(MODE_STORAGE_KEY) : null;
    const obj = raw ? JSON.parse(raw) : {};
    for (const [k, v] of Object.entries(obj)) if (v === 'chat' || v === 'speech') learnedModes.set(k, v);
  } catch {
    /* хранилище недоступно */
  }
}

function rememberMode(cleanUrl: string, model: string, mode: EndpointMode) {
  loadLearned();
  const key = `${cleanUrl}|${model}`;
  if (learnedModes.get(key) === mode) return;
  learnedModes.set(key, mode);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MODE_STORAGE_KEY, JSON.stringify(Object.fromEntries(learnedModes)));
  } catch {
    /* ignore */
  }
}

/** Классификация модели из загруженного каталога (если каталог загружался) */
export function getCatalogModelInfo(baseUrl: string | undefined, model: string | undefined): AggregatorModelInfo | undefined {
  const url = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  return model ? catalogKinds.get(`${url}|${model.trim()}`) : undefined;
}

/** Какой эндпоинт будет использован в режиме auto (для подсказок в UI и тестов) */
export function resolveAutoMode(cleanUrl: string, model: string): EndpointMode {
  loadLearned();
  const learned = learnedModes.get(`${cleanUrl}|${model}`);
  if (learned) return learned;
  const info = catalogKinds.get(`${cleanUrl}|${model}`);
  if (info?.kind === 'speech') return 'speech';
  if (info?.kind === 'chat-audio') return 'chat';
  if (kindFromId(model) === 'speech' || guessSpeechModel(model)) return 'speech';
  return 'chat';
}

const WRONG_FOR_CHAT = /audio\/speech|text-to-speech|\btts\b|speech model|cannot be used with the chat\/completions|not a chat model|not supported.*chat/i;
const WRONG_FOR_SPEECH = /chat\/completions|chat model|not a (tts|text-to-speech|speech)|does not support.*(speech|tts)|not.*(tts|text-to-speech) model|unsupported (model|endpoint)|unknown (model|endpoint)|unrecognized request url|no route/i;

/** Нужно ли в auto-режиме повторить запрос через другой эндпоинт */
function shouldSwitchEndpoint(primary: EndpointMode, err: any, cleanUrl: string): boolean {
  if (err instanceof NoAudioError) return primary === 'chat';
  if (!(err instanceof ApiHttpError)) return false;
  const msg = err.message || '';
  if (primary === 'chat') {
    return [400, 404, 405, 415, 422, 501].includes(err.status) && WRONG_FOR_CHAT.test(msg);
  }
  // primary === 'speech'
  if ([404, 405, 501].includes(err.status) && !cleanUrl.includes('openrouter.ai')) return true; // у шлюза нет /audio/speech
  return [400, 404, 405, 415, 422].includes(err.status) && WRONG_FOR_SPEECH.test(msg);
}

// ---------------------------------------------------------------------------
// Внутренние функции
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 120_000;
const PCM_SAMPLE_RATE = 24000;

interface RequestCtx {
  cleanUrl: string;
  model: string;
  voice: string;
  text: string;
  apiKey: string;
  signal?: AbortSignal;
}

class ApiHttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Чат-модель ответила без аудио (текст/пусто) — вероятно, это не chat-audio модель */
class NoAudioError extends Error {}

function guessSpeechModel(model: string): boolean {
  return /(^|[\/\-_])(tts|speech)([\/\-_.]|$)|tts-1|kokoro|piper|xtts|bark/i.test(model);
}

function isOpenAIModel(model: string): boolean {
  return /^openai\//i.test(model) || /^(tts-1|gpt-4o|gpt-audio)/i.test(model);
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://aibookreader.app',
    'X-Title': 'AIBookReader',
  };
}

function withTimeout(parent: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function pcm16ToWav(pcm: Uint8Array, sampleRate = PCM_SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buffer);
  const str = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, pcm.length, true);
  new Uint8Array(buffer, 44).set(pcm);
  return buffer;
}

/** Если данные уже контейнер (WAV/MP3/OGG/FLAC) — вернуть как есть, иначе считать сырым PCM16 и обернуть в WAV */
function finalizeAudio(bytes: Uint8Array): ArrayBuffer {
  const ascii = (o: number, n: number) => String.fromCharCode(...Array.from(bytes.subarray(o, o + n)));
  const isContainer =
    ascii(0, 4) === 'RIFF' ||
    ascii(0, 3) === 'ID3' ||
    ascii(0, 4) === 'OggS' ||
    ascii(0, 4) === 'fLaC' ||
    (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (isContainer) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  return pcm16ToWav(bytes);
}

function errorFromJson(json: any, fallback: string): string | null {
  if (!json || !json.error) return null;
  const e = json.error;
  if (typeof e === 'string') return e;
  const code = e.code ? ` [${e.code}]` : '';
  const raw = e.metadata?.raw;
  const meta = raw ? ` — ${typeof raw === 'string' ? raw : JSON.stringify(raw)}` : '';
  return `${e.message || fallback}${code}${meta}`;
}

async function throwHttpError(res: Response, label: string): Promise<never> {
  const raw = await res.text().catch(() => '');
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    /* не JSON */
  }
  const msg = json
    ? extractApiErrorMessage(json, res.statusText, res.status)
    : raw.slice(0, 300) || res.statusText || 'Неизвестная ошибка';
  throw new ApiHttpError(`${label} вернул ошибку (${res.status}): ${msg}`, res.status);
}

async function doFetch(url: string, init: RequestInit, parent: AbortSignal | undefined) {
  const t = withTimeout(parent, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: t.signal });
    return { res, t };
  } catch (err: any) {
    t.cleanup();
    if (err?.name === 'AbortError') {
      if (t.isTimedOut()) throw new Error(`Таймаут: ${url} не ответил за ${REQUEST_TIMEOUT_MS / 1000} с.`);
      throw err;
    }
    throw new Error(`Сетевая ошибка при запросе к ${url}: ${err?.message || 'сервер недоступен, заблокирован CORS или сетью'}`);
  }
}

/** Шлюз ответил «voice is missing/required» — модели нужен явный голос */
const VOICE_REQUIRED = /voice.{0,40}(missing|required|must be|not provided|is empty)|(missing|required).{0,30}voice/i;

const VOICE_STORAGE_KEY = 'aibr-tts-model-voice';
const learnedVoices = new Map<string, string>();
let voicesLoaded = false;

function loadLearnedVoices() {
  if (voicesLoaded) return;
  voicesLoaded = true;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VOICE_STORAGE_KEY) : null;
    for (const [k, v] of Object.entries(raw ? JSON.parse(raw) : {})) if (typeof v === 'string' && v) learnedVoices.set(k, v);
  } catch {
    /* хранилище недоступно */
  }
}

function rememberVoice(ctx: { cleanUrl: string; model: string }, voice: string) {
  loadLearnedVoices();
  learnedVoices.set(`${ctx.cleanUrl}|${ctx.model}`, voice);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(Object.fromEntries(learnedVoices)));
  } catch {
    /* ignore */
  }
}

/** Голос для модели, которой он обязателен: запомненный → из каталога (supported_voices) → alloy */
function requiredVoiceFor(ctx: { cleanUrl: string; model: string }): string {
  loadLearnedVoices();
  return learnedVoices.get(`${ctx.cleanUrl}|${ctx.model}`) || getCatalogModelInfo(ctx.cleanUrl, ctx.model)?.voices?.[0] || 'alloy';
}

/** Модели, у которых speech-эндпоинт принимает только pcm (Gemini TTS и т.п.) */
const PCM_ONLY_HINT = /only supports?.*pcm|response_format.*pcm|pcm only/i;

async function requestSpeech(ctx: RequestCtx, format: 'mp3' | 'pcm' = 'mp3'): Promise<ArrayBuffer> {
  const label = `${ctx.cleanUrl}/audio/speech`;
  // Тело по документации OpenRouter: model, input, voice?, response_format (mp3 | pcm), speed?
  const body: Record<string, unknown> = {
    model: ctx.model,
    input: ctx.text,
    response_format: format,
  };
  // Для OpenAI-моделей voice обязателен; для прочих — только если задан явно (иначе модель берёт свой голос по умолчанию)
  loadLearnedVoices();
  const voice = ctx.voice || learnedVoices.get(`${ctx.cleanUrl}|${ctx.model}`) || (isOpenAIModel(ctx.model) ? 'alloy' : '');
  if (voice) body.voice = voice;
  // speed НЕ шлём: скорость применяется плеером через playbackRate (иначе применилась бы дважды,
  // а модели без управления скоростью вернули бы 400 на не-дефолтное значение)

  const { res, t } = await doFetch(label, { method: 'POST', headers: buildHeaders(ctx.apiKey), body: JSON.stringify(body) }, ctx.signal);
  try {
    if (!res.ok) await throwHttpError(res, 'Эндпоинт /audio/speech');
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('json') || ct.startsWith('text/')) {
      const raw = await res.text().catch(() => '');
      let json: any = null;
      try {
        json = JSON.parse(raw);
      } catch {
        /* не JSON */
      }
      const err = errorFromJson(json, 'Ошибка шлюза');
      const code = Number(json?.error?.code);
      throw new ApiHttpError(
        err ? `Эндпоинт /audio/speech вернул ошибку в теле ответа: ${err}` : `Эндпоинт /audio/speech вернул ${ct || 'не аудио'} вместо аудио: ${raw.slice(0, 200)}`,
        Number.isFinite(code) && code >= 400 ? code : 400
      );
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) throw new Error('Эндпоинт /audio/speech вернул пустой ответ.');
    // audio/pcm (или запрошенный pcm) — сырой PCM16 24 кГц mono: оборачиваем в WAV
    if (format === 'pcm' || ct.includes('pcm') || ct.includes('l16')) return pcm16ToWav(new Uint8Array(buf));
    return finalizeAudio(new Uint8Array(buf));
  } catch (err: any) {
    if (err?.name === 'AbortError' && t.isTimedOut()) throw new Error('Таймаут при получении аудио от /audio/speech.');
    // Модель поддерживает только pcm — повторяем в pcm
    if (format === 'mp3' && err instanceof ApiHttpError && err.status === 400 && PCM_ONLY_HINT.test(err.message)) {
      t.cleanup();
      return requestSpeech(ctx, 'pcm');
    }
    throw err;
  } finally {
    t.cleanup();
  }
}

async function requestChatAudio(ctx: RequestCtx): Promise<ArrayBuffer> {
  const label = `${ctx.cleanUrl}/chat/completions`;
  const audio: Record<string, unknown> = { format: 'pcm16' };
  // Голос шлём только если выбран явно; для OpenAI-моделей он обязателен → alloy
  loadLearnedVoices();
  const voice = ctx.voice || learnedVoices.get(`${ctx.cleanUrl}|${ctx.model}`) || (isOpenAIModel(ctx.model) ? 'alloy' : '');
  if (voice) audio.voice = voice;

  const body = {
    model: ctx.model,
    modalities: ['text', 'audio'],
    audio,
    stream: true, // аудио-вывод в chat/completions работает только в стриме
    messages: [
      {
        role: 'system',
        content:
          'You are an expressive audiobook narrator. Read the following text verbatim with natural expression. Do not add any greeting, preface, explanation, commentary, markdown, or summary. Only speak the text exactly as provided.',
      },
      { role: 'user', content: ctx.text },
    ],
  };

  const { res, t } = await doFetch(label, { method: 'POST', headers: buildHeaders(ctx.apiKey), body: JSON.stringify(body) }, ctx.signal);
  try {
    if (!res.ok) await throwHttpError(res, 'OpenRouter / Aggregator API');

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const audioParts: string[] = [];
    let textContent = '';

    const handleObject = (evt: any) => {
      const errMsg = errorFromJson(evt, 'Ошибка генерации');
      if (errMsg) throw new Error(`Ошибка от модели/шлюза: ${errMsg}`);
      const choice = evt?.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason === 'error') {
        throw new Error(`Генерация прервана с ошибкой (finish_reason=error) для модели "${ctx.model}".`);
      }
      const src = choice.delta ?? choice.message;
      if (src?.audio?.data && typeof src.audio.data === 'string') audioParts.push(src.audio.data);
      if (typeof src?.content === 'string') textContent += src.content;
    };

    if (res.body && !ct.includes('application/json')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const processLine = (line: string) => {
        const l = line.trim();
        if (!l.startsWith('data:')) return; // комментарии (": OPENROUTER PROCESSING") пропускаем
        const payload = l.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let evt: any;
        try {
          evt = JSON.parse(payload);
        } catch {
          return;
        }
        handleObject(evt);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        lines.forEach(processLine);
      }
      buffer += decoder.decode();
      if (buffer) processLine(buffer);
    } else {
      // Шлюз проигнорировал stream и вернул обычный JSON (возможно с error при HTTP 200)
      const raw = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Шлюз вернул неожиданный ответ (не SSE и не JSON): ${raw.slice(0, 200)}`);
      }
      handleObject(json);
    }

    if (audioParts.length > 0) {
      const bytes = base64ToBytes(audioParts.join(''));
      if (bytes.length === 0) throw new Error(`Модель "${ctx.model}" вернула пустое аудио.`);
      return finalizeAudio(bytes);
    }

    if (textContent.trim()) {
      throw new NoAudioError(
        `Модель "${ctx.model}" вернула текст без аудио ("${textContent.trim().slice(0, 80)}"). Убедитесь, что это chat-audio модель (например openai/gpt-audio-mini), либо это TTS-модель — тогда нужен /audio/speech.`
      );
    }
    throw new NoAudioError(`Модель "${ctx.model}" вернула пустой ответ (нет ни аудио, ни текста). Проверьте ID модели, баланс и доступность модели у шлюза.`);
  } catch (err: any) {
    if (err?.name === 'AbortError' && t.isTimedOut()) throw new Error('Таймаут при получении аудио-потока от /chat/completions.');
    throw err;
  } finally {
    t.cleanup();
  }
}

export const openRouterTTSProvider = new OpenRouterTTSProvider();
