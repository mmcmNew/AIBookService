import { ITTSProvider, TTSProviderType, VoiceOption } from '../../types/tts';
import { webSpeechProvider } from './webSpeech';
import { edgeTTSProvider } from './edgeTts';
import { cloudTTSProvider } from './cloudTts';
import { geminiTTSProvider } from './geminiTts';
import { openAITTSProvider } from './openaiTts';
import { elevenLabsTTSProvider } from './elevenLabsTts';
import { openRouterTTSProvider } from './openRouterTts';

export const PROVIDERS_MAP: Record<TTSProviderType, ITTSProvider> = {
  'cloud': cloudTTSProvider,
  'edge-tts': edgeTTSProvider,
  'webspeech': webSpeechProvider,
  'gemini': geminiTTSProvider,
  'openai': openAITTSProvider,
  'elevenlabs': elevenLabsTTSProvider,
  'openrouter': openRouterTTSProvider,
};

export function getProvider(type: TTSProviderType): ITTSProvider {
  return PROVIDERS_MAP[type] || edgeTTSProvider;
}

export async function getAllVoices(
  apiKeys: { gemini?: string; openai?: string; elevenlabs?: string; openrouter?: string },
  openRouterBaseUrl?: string
): Promise<VoiceOption[]> {
  const allVoices: VoiceOption[] = [];

  for (const provider of Object.values(PROVIDERS_MAP)) {
    try {
      const apiKey = provider.id === 'gemini' ? apiKeys.gemini
        : provider.id === 'openai' ? apiKeys.openai
        : provider.id === 'elevenlabs' ? apiKeys.elevenlabs
        : provider.id === 'openrouter' ? apiKeys.openrouter
        : undefined;

      const voices = provider.id === 'openrouter'
        ? await provider.getVoices(apiKey, openRouterBaseUrl)
        : await provider.getVoices(apiKey);

      allVoices.push(...voices);
    } catch (e) {
      console.warn(`Не удалось загрузить голоса для провайдера ${provider.name}:`, e);
    }
  }

  return allVoices;
}
