import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Volume2, 
  Key, 
  BookText, 
  Eye, 
  Check, 
  Trash2, 
  Plus, 
  Sparkles,
  ExternalLink,
  Globe,
  RefreshCw,
  ShieldCheck,
  Loader2,
  Layers,
  Play
} from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { useUserStore } from '../../store/userStore';
import { requestTopUp } from '../../engine/account';
import { AggregatorApiMode, AggregatorModelInfo, TTSProviderType, VoiceOption } from '../../types/tts';
import {
  isDesktopApp,
  loadDesktopProxy,
  saveProxy,
  setOpenRouterModel as setOpenRouterModelDomain,
  setTheme,
  setFontFamily,
  setFontSize,
  setLineHeight,
  setAutoscroll,
  setActiveProvider,
  setSelectedVoiceId,
  setOpenRouterApiMode,
  setSpeed,
  setVolume,
  setApiKey,
  setGeminiModel,
  setOpenRouterBaseUrl,
  setProxy,
  setPdfRecognitionMode,
  setAlwaysAskPdfMode,
  addReplacementRule,
  removeReplacementRule,
  toggleReplacementRule,
  checkVoice,
  listProviders,
  loadCatalogVoices,
  fetchAggregatorModels,
  getAggregatorVoiceOptions,
  isAggregatorVoiceValid,
} from '../../engine/settings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'tts' | 'keys' | 'dictionary' | 'view' | 'network';
}

const KIND_LABEL: Record<AggregatorModelInfo['kind'], string> = {
  speech: 'TTS (/audio/speech)',
  'chat-audio': 'Chat Audio (/chat/completions)',
  other: 'не озвучка',
};
const KIND_BADGE: Record<AggregatorModelInfo['kind'], string> = {
  speech: '[TTS]',
  'chat-audio': '[Chat Audio]',
  other: '[текст]',
};

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, initialTab = 'tts' }) => {
  const [activeTab, setActiveTab] = useState<'tts' | 'keys' | 'dictionary' | 'view' | 'network'>(
    initialTab === 'keys' ? 'tts' : initialTab
  );
  const [availableVoices, setAvailableVoices] = useState<VoiceOption[]>([]);
  const [newWord, setNewWord] = useState('');
  const [newReplacement, setNewReplacement] = useState('');
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyServer, setProxyServer] = useState('http://127.0.0.1:7890');
  const [isRestarting, setIsRestarting] = useState(false);
  const [proxyStatusMsg, setProxyStatusMsg] = useState<string | null>(null);

  const [openRouterModels, setOpenRouterModels] = useState<AggregatorModelInfo[]>([]);
  const [modelsStatus, setModelsStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [onlyAudioModels, setOnlyAudioModels] = useState(true);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [testState, setTestState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; message?: string }>({ status: 'idle' });
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const testUrlRef = useRef<string | null>(null);

  const { theme, fontFamily, fontSize, lineHeight, autoscroll, activeProvider, selectedVoiceIds, openRouterApiMode, speed, volume, apiKeys, geminiModel, openRouterModel, openRouterBaseUrl, proxy, pdfRecognitionMode, alwaysAskPdfMode, replacementRules } = useSettingsStore();

  const modelsReqRef = useRef(0);
  const handleFetchModels = async (force = true) => {
    const reqId = ++modelsReqRef.current;
    setIsLoadingModels(true);
    setModelsError(null);
    setModelsStatus('loading');
    try {
      const models = await fetchAggregatorModels(
        apiKeys.openrouter,
        openRouterBaseUrl || 'https://openrouter.ai/api/v1',
        force
      );
      if (reqId !== modelsReqRef.current) return;
      setOpenRouterModels(models);
      setModelsStatus('success');
    } catch (err: any) {
      if (reqId !== modelsReqRef.current) return;
      setOpenRouterModels([]);
      setModelsError(err.message || 'Ошибка загрузки моделей');
      setModelsStatus('error');
    } finally {
      if (reqId === modelsReqRef.current) setIsLoadingModels(false);
    }
  };

  // Автозагрузка каталога моделей при открытии вкладки / смене ключа / baseUrl (дебаунс; кэш в провайдере)
  useEffect(() => {
    if (!isOpen || activeTab !== 'tts' || activeProvider !== 'openrouter') return;
    const timer = setTimeout(() => {
      handleFetchModels(false);
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, activeTab, activeProvider, apiKeys.openrouter, openRouterBaseUrl]);

  // Загружаем голоса и прокси для текущих настроек
  useEffect(() => {
    if (isOpen) {
      if (initialTab) {
        setActiveTab(initialTab === 'keys' ? 'tts' : initialTab);
      }
      let cancelled = false;
      setVoicesLoading(true);
      loadCatalogVoices(apiKeys, openRouterBaseUrl)
        .then((v) => { if (!cancelled) setAvailableVoices(v); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setVoicesLoading(false); });
      setProxyEnabled(proxy?.enabled || false);
      setProxyServer(proxy?.server || 'http://127.0.0.1:7890');

      if (isDesktopApp()) {
        loadDesktopProxy().then((desktopCfg) => {
          if (desktopCfg) {
            setProxyEnabled(desktopCfg.enabled);
            setProxyServer(desktopCfg.server);
          }
        });
      }
      return () => {
        cancelled = true;
      };
    }
  }, [isOpen, initialTab, apiKeys, openRouterBaseUrl]);

  // Остановка тестового звука при закрытии окна / размонтировании
  const stopTestAudio = () => {
    testAudioRef.current?.pause();
    testAudioRef.current = null;
    if (testUrlRef.current) {
      URL.revokeObjectURL(testUrlRef.current);
      testUrlRef.current = null;
    }
  };
  useEffect(() => {
    if (!isOpen) stopTestAudio();
    return () => stopTestAudio();
  }, [isOpen]);

  // Сброс результата проверки при смене провайдера/модели/шлюза
  useEffect(() => {
    setTestState({ status: 'idle' });
  }, [activeProvider, openRouterModel, openRouterBaseUrl, openRouterApiMode]);

  // Список голосов текущего провайдера
  const selectedCatalogModel = openRouterModels.find((m) => m.id === (openRouterModel || '').trim());
  const catalogVoices = selectedCatalogModel?.voices;
  const gatewayVoices = availableVoices.filter((v: VoiceOption) => v.provider === 'openrouter' && v.id);
  const currentProviderVoices: VoiceOption[] =
    activeProvider === 'openrouter'
      ? getAggregatorVoiceOptions(openRouterModel, gatewayVoices, catalogVoices)
      : availableVoices.filter((v: VoiceOption) => v.provider === activeProvider);
  const selectedVoiceId = selectedVoiceIds?.[activeProvider] ?? '';

  // Валидация сохранённого голоса против доступного списка
  useEffect(() => {
    if (!isOpen || voicesLoading) return;
    if (activeProvider === 'openrouter') {
      if (selectedVoiceId && !isAggregatorVoiceValid(selectedVoiceId, openRouterModel, gatewayVoices, catalogVoices)) {
        setSelectedVoiceId('');
      }
    } else if (currentProviderVoices.length > 0 && !currentProviderVoices.some((v) => v.id === selectedVoiceId)) {
      setSelectedVoiceId(currentProviderVoices[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, voicesLoading, activeProvider, openRouterModel, availableVoices, selectedVoiceId, openRouterModels]);

  if (!isOpen) return null;

  const isAggregator = activeProvider === 'openrouter';
  const voiceInList = currentProviderVoices.some((v) => v.id === selectedVoiceId);
  const customVoiceAllowed = isAggregator && currentProviderVoices.length <= 1;
  const isCustomVoice = customVoiceAllowed && selectedVoiceId !== '' && !voiceInList;
  const canTestSynthesis = activeProvider !== 'webspeech' && activeProvider !== 'cloud';

  const handleTestSynthesis = async () => {
    stopTestAudio();
    setTestState({ status: 'loading' });
    try {
      const buffer = await checkVoice('Проверка озвучки. Если вы слышите эту фразу, подключение работает.');
      if (!buffer || buffer.byteLength === 0) throw new Error('Получен пустой аудио-ответ.');
      const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
      const isWav = String.fromCharCode(...Array.from(head)) === 'RIFF';
      const url = URL.createObjectURL(new Blob([buffer], { type: isWav ? 'audio/wav' : 'audio/mpeg' }));
      testUrlRef.current = url;
      const audio = new Audio(url);
      audio.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
      testAudioRef.current = audio;
      await audio.play();
      setTestState({ status: 'ok', message: `Успешно: получено ${(buffer.byteLength / 1024).toFixed(0)} КБ аудио, воспроизводится.` });
    } catch (err: any) {
      setTestState({ status: 'error', message: err?.message || 'Неизвестная ошибка синтеза' });
    }
  };

  const handleAddRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (newWord.trim() && newReplacement.trim()) {
      addReplacementRule(newWord.trim(), newReplacement.trim());
      setNewWord('');
      setNewReplacement('');
    }
  };

  const handleSaveProxy = async (restart = false) => {
    const newCfg = { enabled: proxyEnabled, server: proxyServer.trim() };
    if (restart) {
      setIsRestarting(true);
    }
    try {
      await saveProxy(newCfg, restart);
    } catch (err) {
      console.error(err);
    }
    setProxyStatusMsg(
      isDesktopApp()
        ? 'Настройки сохранены. Перезапустите приложение для применения прокси.'
        : 'Настройки прокси сохранены в профиле.'
    );
    setTimeout(() => setProxyStatusMsg(null), 4000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div role="dialog" aria-modal="true" aria-label="Настройки читалки" className="w-full max-w-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Шапка модалки */}
        <div className="p-5 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 dark:text-zinc-100 flex items-center gap-2">
            <span>Настройки читалки</span>
          </h2>
          <button
            onClick={onClose}
            aria-label="Закрыть настройки"
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Навигационные вкладки */}
        <div className="flex border-b border-slate-200 dark:border-zinc-800 px-5 gap-2 bg-slate-50/50 dark:bg-zinc-950/40 overflow-x-auto">
          <button
            onClick={() => setActiveTab('tts')}
            className={`py-3 px-3 text-xs md:text-sm font-semibold border-b-2 flex items-center gap-1.5 transition-colors shrink-0 ${
              activeTab === 'tts'
                ? 'border-amber-500 text-amber-600 dark:text-amber-500'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200'
            }`}
          >
            <Volume2 className="w-4 h-4" />
            <span>Озвучка и ключи</span>
          </button>

          <button
            onClick={() => setActiveTab('network')}
            className={`py-3 px-3 text-xs md:text-sm font-semibold border-b-2 flex items-center gap-1.5 transition-colors shrink-0 ${
              activeTab === 'network'
                ? 'border-amber-500 text-amber-600 dark:text-amber-500'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200'
            }`}
          >
            <Globe className="w-4 h-4" />
            <span>Прокси / Сеть</span>
          </button>

          <button
            onClick={() => setActiveTab('dictionary')}
            className={`py-3 px-3 text-xs md:text-sm font-semibold border-b-2 flex items-center gap-1.5 transition-colors shrink-0 ${
              activeTab === 'dictionary'
                ? 'border-amber-500 text-amber-600 dark:text-amber-500'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200'
            }`}
          >
            <BookText className="w-4 h-4" />
            <span>Словарь замен</span>
          </button>

          <button
            onClick={() => setActiveTab('view')}
            className={`py-3 px-3 text-xs md:text-sm font-semibold border-b-2 flex items-center gap-1.5 transition-colors shrink-0 ${
              activeTab === 'view'
                ? 'border-amber-500 text-amber-600 dark:text-amber-500'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200'
            }`}
          >
            <Eye className="w-4 h-4" />
            <span>Оформление</span>
          </button>
        </div>

        {/* Тело модалки */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* ВКЛАДКА 1: ОЗВУЧКА */}
          {activeTab === 'tts' && (
            <div className="space-y-6">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-400 mb-2">
                  Движок синтеза речи
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {(Object.keys(listProviders()) as TTSProviderType[]).map((pKey) => {
                    const provider = listProviders()[pKey];
                    const isSelected = activeProvider === pKey;
                    return (
                      <div
                        key={pKey}
                        onClick={() => setActiveProvider(pKey)}
                        className={`p-3 rounded-2xl border cursor-pointer transition-all ${
                          isSelected
                            ? 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/30'
                            : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-sm text-slate-800 dark:text-zinc-100">
                            {provider.name}
                          </span>
                          {isSelected && <Check className="w-4 h-4 text-amber-500" />}
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1 line-clamp-2">
                          {provider.description}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 1. Google Gemini */}
              {activeProvider === 'gemini' && (
                <div className="space-y-4 p-4 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-zinc-700/60">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-zinc-300 flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-amber-500" />
                      Google Gemini API Key
                    </span>
                    <a
                      href="https://aistudio.google.com/app/apikey"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-amber-600 dark:text-amber-500 flex items-center gap-1 hover:underline font-medium"
                    >
                      <span>Получить ключ</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <input
                    type="password"
                    placeholder="AIzaSy..."
                    value={apiKeys.gemini || ''}
                    onChange={(e) => setApiKey('gemini', e.target.value)}
                    className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                  />

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1.5">
                      Модель Google Gemini
                    </label>
                    <select
                      value={geminiModel}
                      onChange={(e) => setGeminiModel(e.target.value)}
                      className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                    >
                      <option value="gemini-3.8-flash-tts">Gemini 3.8 Flash TTS (Студийное качество озвучки, рекомендуется)</option>
                      <option value="gemini-3.8-flash">Gemini 3.8 Flash (Интеллектуальная модель)</option>
                      <option value="gemini-3.1-flash-tts-preview">Gemini 3.1 Flash TTS (Preview)</option>
                      <option value="gemini-3.8-flash-lite-tts">Gemini 3.8 Flash-Lite TTS (Быстрая и экономичная)</option>
                    </select>
                  </div>
                </div>
              )}

              {/* 2. OpenAI */}
              {activeProvider === 'openai' && (
                <div className="space-y-3 p-4 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-zinc-700/60">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-zinc-300 flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-amber-500" />
                      OpenAI API Key
                    </span>
                    <a
                      href="https://platform.openai.com/api-keys"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-amber-600 dark:text-amber-500 flex items-center gap-1 hover:underline font-medium"
                    >
                      <span>Получить ключ</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <input
                    type="password"
                    placeholder="sk-proj-..."
                    value={apiKeys.openai || ''}
                    onChange={(e) => setApiKey('openai', e.target.value)}
                    className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                  />
                  <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                    Использует официальный OpenAI /audio/speech с высококачественными моделями tts-1 / tts-1-hd.
                  </p>
                </div>
              )}

              {/* 3. ElevenLabs */}
              {activeProvider === 'elevenlabs' && (
                <div className="space-y-3 p-4 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-zinc-700/60">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-zinc-300 flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-amber-500" />
                      ElevenLabs API Key
                    </span>
                    <a
                      href="https://elevenlabs.io/app/settings/api-keys"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-amber-600 dark:text-amber-500 flex items-center gap-1 hover:underline font-medium"
                    >
                      <span>Получить ключ</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <input
                    type="password"
                    placeholder="xi-..."
                    value={apiKeys.elevenlabs || ''}
                    onChange={(e) => setApiKey('elevenlabs', e.target.value)}
                    className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                  />
                  <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                    Премиальный синтез речи с огромной библиотекой клонированных и выразительных голосов.
                  </p>
                </div>
              )}

              {/* 4. Настройки OpenRouter и Агрегаторов */}
              {activeProvider === 'openrouter' && (
                <div className="space-y-4 p-4 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-zinc-700/60">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-zinc-300 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                      Параметры OpenRouter / Агрегатора
                    </span>
                    <button
                      type="button"
                      onClick={() => handleFetchModels(true)}
                      disabled={isLoadingModels}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 transition-all disabled:opacity-50"
                      title="Проверить подключение и загрузить свежий каталог моделей с сервера"
                    >
                      {isLoadingModels ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      <span>{isLoadingModels ? 'Проверка...' : 'Проверить подключение'}</span>
                    </button>
                  </div>

                  {/* API-ключ OpenRouter / кастомного шлюза */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[11px] font-semibold text-slate-700 dark:text-zinc-300 flex items-center gap-1">
                        <Key className="w-3 h-3 text-amber-500" />
                        <span>API-ключ (OpenRouter / RouterAI / кастомный шлюз)</span>
                      </label>
                      <a
                        href="https://openrouter.ai/keys"
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-amber-600 dark:text-amber-500 flex items-center gap-1 hover:underline font-medium"
                      >
                        <span>Получить ключ OpenRouter</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <input
                      type="password"
                      value={apiKeys.openrouter || ''}
                      onChange={(e) => setApiKey('openrouter', e.target.value)}
                      placeholder="sk-or-v1-... или ключ вашего шлюза (если требуется)"
                      className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                    />
                  </div>

                  {/* Статус подключения / ошибки */}
                  {modelsStatus === 'error' && modelsError && (
                    <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/30 p-3 rounded-xl border border-rose-200 dark:border-rose-900/50 space-y-1.5">
                      <div className="font-semibold flex items-center gap-1.5">
                        <span>❌ Подключение не удалось:</span>
                      </div>
                      <div className="font-mono text-[11px] break-words">{modelsError}</div>
                      {modelsError.includes('403') && (
                        <div className="text-[11px] text-rose-600 dark:text-rose-400 pt-1 border-t border-rose-200/50 dark:border-rose-900/40">
                          💡 <strong>Совет:</strong> OpenRouter блокирует прямой доступ из РФ (Cloudflare WAF). Перейдите во вкладку <strong>«Прокси / Сеть»</strong> для настройки прокси, включите системный VPN или укажите альтернативный рабочий шлюз.
                        </div>
                      )}
                    </div>
                  )}

                  {modelsStatus === 'success' && (
                    <div className="text-xs text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 p-2.5 rounded-xl border border-emerald-200 dark:border-emerald-900/50 flex items-center justify-between">
                      <span className="font-medium">
                        ✓ Подключение активно. Найдено {openRouterModels.length} моделей: TTS (/audio/speech) — {openRouterModels.filter(m => m.kind === 'speech').length}, Chat Audio — {openRouterModels.filter(m => m.kind === 'chat-audio').length}
                      </span>
                    </div>
                  )}

                  {modelsStatus === 'idle' && openRouterModels.length === 0 && (
                    <div className="text-xs text-slate-600 dark:text-zinc-400 bg-slate-100/70 dark:bg-zinc-800/60 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700">
                      Каталог моделей загружается автоматически; кнопка <strong>«Проверить подключение»</strong> обновляет его принудительно. ID модели можно ввести вручную.
                    </div>
                  )}

                  {/* Быстрые пресеты шлюзов */}
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1.5">
                      Шлюз API (Базовый URL)
                    </label>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {[
                        { label: 'RouterAI (РФ)', url: 'https://routerai.ru/api/v1' },
                        { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
                        { label: 'DeepInfra', url: 'https://api.deepinfra.com/v1' },
                        { label: 'Together AI', url: 'https://api.together.xyz/v1' },
                        { label: 'Groq', url: 'https://api.groq.com/openai/v1' },
                        { label: 'Local (11434)', url: 'http://localhost:11434/v1' },
                      ].map((preset) => (
                        <button
                          key={preset.url}
                          type="button"
                          onClick={() => {
                            setOpenRouterBaseUrl(preset.url);
                            setModelsStatus('idle');
                            setModelsError(null);
                            setOpenRouterModels([]);
                          }}
                          className={`px-2.5 py-1 text-[11px] rounded-lg font-medium border transition-colors ${
                            (openRouterBaseUrl || 'https://openrouter.ai/api/v1') === preset.url
                              ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 font-bold'
                              : 'border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-300'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      value={openRouterBaseUrl || 'https://openrouter.ai/api/v1'}
                      onChange={(e) => {
                        setOpenRouterBaseUrl(e.target.value);
                        setModelsStatus('idle');
                        setModelsError(null);
                        setOpenRouterModels([]);
                      }}
                      placeholder="https://openrouter.ai/api/v1"
                      className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                    />
                  </div>

                  {/* Режим API шлюза */}
                  <div>
                    <label htmlFor="aggregator-api-mode" className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1.5">
                      Режим запроса к шлюзу
                    </label>
                    <select
                      id="aggregator-api-mode"
                      value={openRouterApiMode || 'auto'}
                      onChange={(e) => setOpenRouterApiMode(e.target.value as AggregatorApiMode)}
                      className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                    >
                      <option value="auto">Авто (по типу модели из каталога; при ошибке «не тот эндпоинт» — повтор через другой)</option>
                      <option value="chat">Принудительно Chat Audio (/chat/completions, стриминг PCM)</option>
                      <option value="speech">Принудительно /audio/speech (TTS-модели)</option>
                    </select>
                    <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1">
                      TTS-модели (output «speech», напр. bytedance-seed/seed-audio-1-0, elevenlabs/*, google/*-tts) работают через /audio/speech, чат-модели с аудио (openai/gpt-audio*) — через /chat/completions. В режиме «Авто» выбор делается сам. {selectedCatalogModel ? `Выбранная модель: ${KIND_LABEL[selectedCatalogModel.kind]}.` : ''}
                    </p>
                  </div>

                  {/* Выбор модели с фильтрацией */}
                  <div>
                    {openRouterModels.length > 0 && (
                      <div className="mb-2">
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400">
                            Выбор из каталога ({openRouterModels.filter(m => !onlyAudioModels || m.isAudio).length})
                          </label>
                          <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-zinc-400 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={onlyAudioModels}
                              onChange={(e) => setOnlyAudioModels(e.target.checked)}
                              className="rounded text-amber-500 accent-amber-500"
                            />
                            <span>Только озвучка (TTS и Chat Audio)</span>
                          </label>
                        </div>

                        <select
                          value={openRouterModel || ''}
                          onChange={(e) => setOpenRouterModelDomain(e.target.value)}
                          className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500 mb-2"
                        >
                          <option value="" disabled>-- Выберите модель из списка --</option>
                          {openRouterModels
                            .filter((m) => !onlyAudioModels || m.isAudio)
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {KIND_BADGE[m.kind]} {m.name} — {m.id}
                              </option>
                            ))}
                        </select>
                      </div>
                    )}

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1">
                        ID активной модели:
                      </label>
                      <input
                        type="text"
                        value={openRouterModel || ''}
                        onChange={(e) => setOpenRouterModelDomain(e.target.value)}
                        placeholder="например, openai/gpt-4o-mini-audio-preview"
                        className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* 5. Бесплатные движки WebSpeech и Edge-TTS */}
              {(activeProvider === 'webspeech' || activeProvider === 'edge-tts') && (
                <div className="p-3.5 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-900/40 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>
                    <strong>{listProviders()[activeProvider]?.name}:</strong> Бесплатный движок, не требует API-ключей.
                  </span>
                </div>
              )}

              {/* Выбор голоса */}
              <div>
                <label htmlFor="voice-select" className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-400 mb-2">
                  Голос диктора ({currentProviderVoices.length}){voicesLoading && ' — загрузка...'}
                </label>
                {currentProviderVoices.length > 0 ? (
                  <>
                    <select
                      id="voice-select"
                      value={isCustomVoice ? '__custom__' : selectedVoiceId}
                      onChange={(e) => setSelectedVoiceId(e.target.value === '__custom__' ? ' ' : e.target.value)}
                      className="w-full p-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm font-medium text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                    >
                      {currentProviderVoices.map((v: VoiceOption) => (
                        <option key={v.id || '__default__'} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                      {customVoiceAllowed && <option value="__custom__">Другой (ввести ID вручную)...</option>}
                    </select>
                    {customVoiceAllowed && isCustomVoice && (
                      <input
                        type="text"
                        aria-label="ID голоса"
                        value={selectedVoiceId.trim()}
                        onChange={(e) => setSelectedVoiceId(e.target.value.trim() || ' ')}
                        placeholder="ID голоса (необязательно), например nova"
                        className="mt-2 w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                      />
                    )}
                    {isAggregator && (
                      <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1.5">
                        {getAggregatorVoiceOptions(openRouterModel, gatewayVoices, catalogVoices).length > 1
                          ? 'Показаны голоса, поддерживаемые выбранной моделью. «По умолчанию» — голос не передаётся, модель выберет свой.'
                          : 'Для этой модели список голосов неизвестен: оставьте «По умолчанию» или введите ID голоса вручную.'}
                      </p>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 p-3 rounded-xl border border-amber-200 dark:border-amber-900/40">
                    {voicesLoading ? 'Загрузка голосов...' : 'Для этого провайдера укажите API-ключ в блоке выше, чтобы загрузить голоса.'}
                  </div>
                )}

                {canTestSynthesis && (
                  <div className="mt-3 space-y-2">
                    <button
                      type="button"
                      onClick={handleTestSynthesis}
                      disabled={testState.status === 'loading'}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 transition-all disabled:opacity-50"
                    >
                      {testState.status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                      <span>{testState.status === 'loading' ? 'Синтез...' : 'Тест озвучки'}</span>
                    </button>
                    {testState.status === 'ok' && (
                      <div role="status" className="text-xs text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 p-2.5 rounded-xl border border-emerald-200 dark:border-emerald-900/50">
                        ✓ {testState.message}
                      </div>
                    )}
                    {testState.status === 'error' && (
                      <div role="alert" className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/30 p-3 rounded-xl border border-rose-200 dark:border-rose-900/50">
                        <div className="font-semibold mb-1">Не удалось озвучить:</div>
                        <div className="font-mono text-[11px] break-words whitespace-pre-wrap">{testState.message}</div>
                      </div>
                    )}
                  </div>
                )}

                {activeProvider === 'cloud' && (
                  <div className="mt-3 p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 flex items-center justify-between">
                    <div>
                      <span className="text-xs text-slate-600 dark:text-zinc-400">Остаток символов: </span>
                      <strong className="text-xs font-mono text-amber-600 dark:text-amber-400">
                        {useUserStore.getState().balance.toLocaleString()}
                      </strong>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        requestTopUp();
                      }}
                      className="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold text-xs shadow-sm transition-all"
                    >
                      Пополнить в ЮKassa
                    </button>
                  </div>
                )}
              </div>

              {/* Скорость и громкость */}
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">
                    <span>Скорость</span>
                    <span>{speed}x</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={speed}
                    onChange={(e) => setSpeed(parseFloat(e.target.value))}
                    className="w-full accent-amber-500"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">
                    <span>Громкость</span>
                    <span>{Math.round(volume * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    className="w-full accent-amber-500"
                  />
                </div>
              </div>

              {/* Сводка всех ключей (BYOK) */}
              <div className="pt-2 border-t border-slate-200/80 dark:border-zinc-800">
                <details className="group rounded-2xl bg-slate-50 dark:bg-zinc-800/30 border border-slate-200 dark:border-zinc-700/60 p-4">
                  <summary className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-400 cursor-pointer list-none flex items-center justify-between select-none">
                    <span className="flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-amber-500" />
                      Все API-ключи (BYOK)
                    </span>
                    <span className="text-xs text-slate-400 group-open:rotate-180 transition-transform">
                      ▼
                    </span>
                  </summary>
                  <div className="mt-4 space-y-3.5 pt-3 border-t border-slate-200/60 dark:border-zinc-700/60">
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                      🔒 Все ключи хранятся исключительно локально в вашем браузере (BYOK) и никуда не передаются.
                    </div>
                    {/* Gemini */}
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <label className="text-[11px] font-semibold text-slate-700 dark:text-zinc-300">Google Gemini API Key</label>
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-[10px] text-amber-600 dark:text-amber-500 hover:underline">Получить</a>
                      </div>
                      <input
                        type="password"
                        placeholder="AIzaSy..."
                        value={apiKeys.gemini || ''}
                        onChange={(e) => setApiKey('gemini', e.target.value)}
                        className="w-full p-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                      />
                    </div>
                    {/* OpenRouter / RouterAI */}
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <label className="text-[11px] font-semibold text-slate-700 dark:text-zinc-300">OpenRouter / RouterAI API Key</label>
                        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-[10px] text-amber-600 dark:text-amber-500 hover:underline">Получить</a>
                      </div>
                      <input
                        type="password"
                        placeholder="sk-or-v1-... или ключ шлюза"
                        value={apiKeys.openrouter || ''}
                        onChange={(e) => setApiKey('openrouter', e.target.value)}
                        className="w-full p-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                      />
                    </div>
                    {/* OpenAI */}
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <label className="text-[11px] font-semibold text-slate-700 dark:text-zinc-300">OpenAI API Key</label>
                        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="text-[10px] text-amber-600 dark:text-amber-500 hover:underline">Получить</a>
                      </div>
                      <input
                        type="password"
                        placeholder="sk-proj-..."
                        value={apiKeys.openai || ''}
                        onChange={(e) => setApiKey('openai', e.target.value)}
                        className="w-full p-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                      />
                    </div>
                    {/* ElevenLabs */}
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <label className="text-[11px] font-semibold text-slate-700 dark:text-zinc-300">ElevenLabs API Key</label>
                        <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer" className="text-[10px] text-amber-600 dark:text-amber-500 hover:underline">Получить</a>
                      </div>
                      <input
                        type="password"
                        placeholder="xi-..."
                        value={apiKeys.elevenlabs || ''}
                        onChange={(e) => setApiKey('elevenlabs', e.target.value)}
                        className="w-full p-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500"
                      />
                    </div>
                  </div>
                </details>
              </div>
            </div>
          )}

          {/* ВКЛАДКА: ПРОКСИ / СЕТЬ */}
          {activeTab === 'network' && (
            <div className="space-y-5">
              {/* Информационный баннер среды */}
              <div className={`p-4 rounded-2xl border flex items-start gap-3 ${
                isDesktopApp()
                  ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                  : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
              }`}>
                <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5" />
                <div className="text-xs space-y-1">
                  <div className="font-bold">
                    {isDesktopApp() ? 'Локальная версия приложения (Tauri Desktop)' : 'Браузерная версия (Web)'}
                  </div>
                  <p className="opacity-90 leading-relaxed">
                    {isDesktopApp()
                      ? 'Настройки прокси передаются напрямую в сетевой движок WebView2. Все исходящие запросы (Google Gemini, OpenAI, ElevenLabs, Edge TTS WebSocket) пойдут через указанный локальный прокси.'
                      : 'В веб-версии браузер использует системные настройки прокси Windows. Для индивидуальной изоляции трафика используйте десктопное приложение (.exe).'}
                  </p>
                </div>
              </div>

              {/* Включение прокси */}
              <div className="flex items-center justify-between p-4 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-zinc-800">
                <div>
                  <h4 className="font-semibold text-sm text-slate-800 dark:text-zinc-200">
                    Использовать локальный прокси
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-zinc-400">
                    Поддерживаются протоколы HTTP и SOCKS5 (Clash, v2rayN, Xray, Outline)
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={proxyEnabled}
                  onChange={(e) => setProxyEnabled(e.target.checked)}
                  className="w-5 h-5 rounded accent-amber-500 cursor-pointer"
                />
              </div>

              {/* Адрес сервера */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-400 mb-2">
                  Адрес прокси-сервера (URL или IP:PORT)
                </label>
                <input
                  type="text"
                  placeholder="http://127.0.0.1:7890 или socks5://127.0.0.1:10808"
                  value={proxyServer}
                  onChange={(e) => setProxyServer(e.target.value)}
                  disabled={!proxyEnabled}
                  className="w-full p-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono text-sm text-slate-800 dark:text-zinc-100 outline-none focus:border-amber-500 disabled:opacity-40"
                />
              </div>

              {/* Быстрые пресеты */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-2">
                  Быстрые пресеты для популярных локальных клиентов:
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'Clash / Mihomo', val: 'http://127.0.0.1:7890' },
                    { label: 'v2rayN SOCKS5', val: 'socks5://127.0.0.1:10808' },
                    { label: 'v2rayN HTTP', val: 'http://127.0.0.1:10809' },
                    { label: 'Xray / Shadowsocks', val: 'socks5://127.0.0.1:2080' },
                  ].map((preset) => (
                    <button
                      key={preset.val}
                      type="button"
                      disabled={!proxyEnabled}
                      onClick={() => setProxyServer(preset.val)}
                      className="p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 hover:border-amber-500 bg-white dark:bg-zinc-800 text-left text-xs disabled:opacity-40 transition-colors"
                    >
                      <span className="font-semibold text-slate-800 dark:text-zinc-200 block">{preset.label}</span>
                      <span className="font-mono text-[11px] text-amber-600 dark:text-amber-400">{preset.val}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Кнопки сохранения */}
              <div className="pt-2 flex flex-col sm:flex-row items-center gap-2.5">
                {isDesktopApp() && (
                  <button
                    type="button"
                    disabled={isRestarting}
                    onClick={() => handleSaveProxy(true)}
                    className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 active:scale-95 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-amber-500/20 transition-all"
                  >
                    <RefreshCw className={`w-4 h-4 ${isRestarting ? 'animate-spin' : ''}`} />
                    <span>Сохранить и перезапустить приложение</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleSaveProxy(false)}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 font-semibold text-xs transition-colors"
                >
                  Сохранить настройки
                </button>
              </div>

              {proxyStatusMsg && (
                <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-xs font-medium text-center">
                  {proxyStatusMsg}
                </div>
              )}
            </div>
          )}

          {/* ВКЛАДКА: СЛОВАРЬ ЗАМЕН */}
          {activeTab === 'dictionary' && (
            <div className="space-y-4">
              <form onSubmit={handleAddRule} className="flex gap-2">
                <input
                  type="text"
                  placeholder="Слово или сокращение"
                  value={newWord}
                  onChange={(e) => setNewWord(e.target.value)}
                  className="flex-1 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs md:text-sm outline-none focus:border-amber-500"
                />
                <input
                  type="text"
                  placeholder="Как произносить"
                  value={newReplacement}
                  onChange={(e) => setNewReplacement(e.target.value)}
                  className="flex-1 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs md:text-sm outline-none focus:border-amber-500"
                />
                <button
                  type="submit"
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-semibold flex items-center gap-1 shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  <span>Добавить</span>
                </button>
              </form>

              <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
                {replacementRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-zinc-800 text-xs"
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => toggleReplacementRule(rule.id)}
                        className="rounded accent-amber-500"
                      />
                      <span className="font-semibold text-slate-800 dark:text-zinc-200">{rule.pattern}</span>
                      <span className="text-slate-400">➔</span>
                      <span className="text-amber-600 dark:text-amber-400 font-medium">{rule.replacement}</span>
                    </div>
                    <button
                      onClick={() => removeReplacementRule(rule.id)}
                      className="text-slate-400 hover:text-rose-500 p-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ВКЛАДКА 4: ОФОРМЛЕНИЕ */}
          {activeTab === 'view' && (
            <div className="space-y-6">
              {/* Тема */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-400 mb-2">
                  Цветовая схема
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { id: 'light', name: 'Светлая', bg: 'bg-white text-slate-900 border-slate-200' },
                    { id: 'dark', name: 'Тёмная', bg: 'bg-zinc-900 text-zinc-100 border-zinc-700' },
                    { id: 'sepia', name: 'Сепия', bg: 'bg-[#f6f0e2] text-[#2b2114] border-[#eddcc5]' },
                    { id: 'oled', name: 'OLED Black', bg: 'bg-black text-zinc-100 border-zinc-900' },
                  ].map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTheme(t.id as any)}
                      className={`p-3 rounded-2xl border text-xs font-semibold text-center transition-all ${t.bg} ${
                        theme === t.id ? 'ring-2 ring-amber-500 font-bold scale-[1.02]' : 'opacity-80'
                      }`}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Шрифт */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-400 mb-2">
                  Семейство шрифтов
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'serif', name: 'С засечками (Merriweather)', font: 'font-serif' },
                    { id: 'sans', name: 'Без засечек (Inter)', font: 'font-sans' },
                    { id: 'mono', name: 'Моноширинный', font: 'font-mono' },
                  ].map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setFontFamily(f.id as any)}
                      className={`p-3 rounded-2xl border text-xs font-medium text-center transition-all ${f.font} ${
                        fontFamily === f.id
                          ? 'border-amber-500 bg-amber-50/40 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 font-bold'
                          : 'border-slate-200 dark:border-zinc-800'
                      }`}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Размер шрифта */}
              <div>
                <div className="flex justify-between text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1.5">
                  <span>Размер шрифта</span>
                  <span>{fontSize} px</span>
                </div>
                <input
                  type="range"
                  min="14"
                  max="32"
                  step="1"
                  value={fontSize}
                  onChange={(e) => setFontSize(parseInt(e.target.value))}
                  className="w-full accent-amber-500"
                />
              </div>

              {/* Автоскролл */}
              <div className="flex items-center justify-between pt-2">
                <div>
                  <h4 className="font-semibold text-sm text-slate-800 dark:text-zinc-200">
                    Автоматическая прокрутка
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-zinc-400">
                    Плавно центрировать активное предложение на экране при чтении
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={autoscroll}
                  onChange={(e) => setAutoscroll(e.target.checked)}
                  className="w-5 h-5 rounded accent-amber-500 cursor-pointer"
                />
              </div>

              {/* Распознавание PDF */}
              <div className="pt-4 border-t border-slate-200 dark:border-zinc-800 space-y-3">
                <div>
                  <h4 className="font-semibold text-sm text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-amber-500" />
                    <span>Распознавание PDF файлов</span>
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                    Основной движок разбора структуры документа при добавлении книг
                  </p>
                </div>

                <div className="space-y-2">
                  {[
                    {
                      id: 'pdfjs',
                      name: 'Быстрый встроенный слой (PDF.js)',
                      badge: 'Рекомендуется',
                      desc: 'Книга открывается мгновенно, страницы распознаются по мере чтения и в фоне. Сохраняет подсветку поверх оригинальных страниц.',
                    },
                    {
                      id: 'pymupdf',
                      name: 'Умный структурный парсер (PyMuPDF4LLM)',
                      badge: 'Встроенный Sidecar',
                      desc: 'В приложении — постранично: текст из цифрового слоя, а для сканов автоматический OCR. Очищает 2 колонки, колонтитулы, склеивает переносы между страницами. В браузере — серверный режим целиком.',
                    },
                    ...(typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
                      ? [{ id: 'ocr', name: 'Принудительный OCR (Tesseract)', badge: 'Сканы', desc: 'Каждая страница распознаётся оптически, постранично и в фоне.' }]
                      : []),
                    {
                      id: 'gemini',
                      name: 'Нейросетевой AI OCR (Google Gemini)',
                      badge: 'Vision OCR',
                      desc: 'Оптическое распознавание по странице через Gemini API с вашим ключом (запросы только на ближайшие страницы). Без ключа — серверный режим целиком.',
                    },
                  ].map((mode) => (
                    <div
                      key={mode.id}
                      onClick={() => setPdfRecognitionMode(mode.id as any)}
                      className={`p-3 rounded-2xl border cursor-pointer transition-all ${
                        pdfRecognitionMode === mode.id
                          ? 'border-amber-500 bg-amber-50/40 dark:bg-amber-950/20 ring-1 ring-amber-500/30'
                          : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-800 dark:text-zinc-200">
                          {mode.name}
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded font-medium bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400">
                          {mode.badge}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1">
                        {mode.desc}
                      </p>
                    </div>
                  ))}
                </div>

                <label className="flex items-center gap-2 pt-1 text-xs text-slate-600 dark:text-zinc-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={alwaysAskPdfMode}
                    onChange={(e) => setAlwaysAskPdfMode(e.target.checked)}
                    className="w-4 h-4 rounded text-amber-500 accent-amber-500"
                  />
                  <span>Спрашивать способ распознавания при каждом открытии PDF</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Подвал модалки */}
        <div className="p-4 border-t border-slate-200 dark:border-zinc-800 flex justify-end bg-slate-50/50 dark:bg-zinc-950/40">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold text-xs shadow-md transition-all"
          >
            Готово
          </button>
        </div>
      </div>
    </div>
  );
};
