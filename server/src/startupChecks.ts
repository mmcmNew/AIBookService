/**
 * Проверка конфигурации окружения при старте сервера в production.
 * Возвращает список предупреждений для вывода в консоль (без падения процесса).
 */
export function collectConfigWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];

  if (env.NODE_ENV !== 'production') {
    return warnings;
  }

  if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) {
    warnings.push('Платежи отключены: отсутствует YOOKASSA_SHOP_ID или YOOKASSA_SECRET_KEY.');
  }

  if (!env.ALLOWED_RETURN_ORIGINS || !env.ALLOWED_RETURN_ORIGINS.trim()) {
    warnings.push('Не задан ALLOWED_RETURN_ORIGINS: адрес возврата после оплаты будет localhost.');
  }

  if (!env.DATABASE_URL || !env.DATABASE_URL.trim()) {
    warnings.push('Не задан DATABASE_URL: данные в JSON-файлах пропадут при пересоздании контейнера без тома.');
  }

  if (!env.CORS_ORIGINS || !env.CORS_ORIGINS.trim()) {
    warnings.push('Не задан CORS_ORIGINS: используются значения по умолчанию.');
  }

  return warnings;
}
