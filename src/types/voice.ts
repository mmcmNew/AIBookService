/** Нормализация голоса: пустая строка и 'default' означают «по умолчанию модели» */
export function normalizeAggregatorVoice(voiceId?: string): string {
  const t = (voiceId || '').trim();
  return t.toLowerCase() === 'default' ? '' : t;
}
