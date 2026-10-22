import { EdgeTtsConnector } from './edge.js';
import { ElevenLabsTtsConnector } from './elevenlabs.js';
import { GeminiTtsConnector } from './gemini.js';
import { OpenAiTtsConnector } from './openai.js';
import { OpenRouterTtsConnector } from './openrouter.js';
import { ITtsConnector, SynthesisRequest, SynthesisResponse, TTSProviderId, TTSVoice } from './types.js';

export interface TtsManagerOptions {
  connectors?: Record<TTSProviderId, ITtsConnector>;
}

export class TtsManager {
  private connectors: Map<TTSProviderId, ITtsConnector>;

  constructor(options: TtsManagerOptions = {}) {
    this.connectors = new Map();

    if (options.connectors) {
      for (const [id, conn] of Object.entries(options.connectors)) {
        this.connectors.set(id as TTSProviderId, conn);
      }
    } else {
      this.register(new GeminiTtsConnector());
      this.register(new OpenAiTtsConnector());
      this.register(new ElevenLabsTtsConnector());
      this.register(new EdgeTtsConnector());
      this.register(new OpenRouterTtsConnector());
    }
  }

  register(connector: ITtsConnector): void {
    this.connectors.set(connector.id, connector);
  }

  getConnector(id: TTSProviderId): ITtsConnector | undefined {
    return this.connectors.get(id);
  }

  getAvailableProviders(): { id: TTSProviderId; name: string; configured: boolean }[] {
    const list = [];
    for (const conn of this.connectors.values()) {
      list.push({
        id: conn.id,
        name: conn.name,
        configured: conn.isConfigured(),
      });
    }
    return list;
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    const allVoices: TTSVoice[] = [];

    for (const conn of this.connectors.values()) {
      if (!conn.isConfigured()) continue;
      try {
        const voices = await conn.getVoices();
        allVoices.push(...voices);
      } catch (err) {
        console.warn(`[TtsManager] Не удалось получить голоса для ${conn.name}:`, err);
      }
    }

    return allVoices;
  }

  async findProviderForVoice(voiceId?: string): Promise<TTSProviderId | undefined> {
    if (!voiceId) return undefined;
    const all = await this.getAllVoices();
    const found = all.find((v) => v.id === voiceId);
    return found?.provider;
  }

  async synthesize(providerId: TTSProviderId, req: SynthesisRequest): Promise<SynthesisResponse> {
    const connector = this.connectors.get(providerId);
    if (!connector) {
      throw new Error(`Неизвестный провайдер озвучки: "${providerId}". Доступные: ${Array.from(this.connectors.keys()).join(', ')}`);
    }

    if (!connector.isConfigured()) {
      throw new Error(`Провайдер "${connector.name}" не настроен на сервере (отсутствует API-ключ в переменных окружения).`);
    }

    return connector.synthesize(req);
  }
}
