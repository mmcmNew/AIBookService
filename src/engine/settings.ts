import { useSettingsStore } from '../store/settingsStore';
import { isVoiceValidForModel, getCatalogModelInfo } from './providers/openRouterTts';

/**
 * Установка модели OpenRouter с валидацией выбранного голоса.
 * Вынесено из стора в слой Domain, чтобы стор не зависел от логики каталога и валидации.
 */
export function setOpenRouterModel(openRouterModel: string): void {
  const state = useSettingsStore.getState();
  const cur = state.selectedVoiceIds.openrouter ?? '';
  const keep = isVoiceValidForModel(
    cur,
    openRouterModel,
    [],
    getCatalogModelInfo(state.openRouterBaseUrl, openRouterModel)?.voices
  );
  useSettingsStore.setState({
    openRouterModel,
    selectedVoiceIds: keep ? state.selectedVoiceIds : { ...state.selectedVoiceIds, openrouter: '' },
  });
}
