import { ReplacementRule } from '../../types/settings';

// Стандартный базовый словарь сокращений для русского языка
export const DEFAULT_RULES: ReplacementRule[] = [
  { id: '1', pattern: '\\bи т\\.д\\.', replacement: 'и так далее', isRegex: true, enabled: true },
  { id: '2', pattern: '\\bи т\\.п\\.', replacement: 'и тому подобное', isRegex: true, enabled: true },
  { id: '3', pattern: '\\bт\\.е\\.', replacement: 'то есть', isRegex: true, enabled: true },
  { id: '4', pattern: '\\bт\\.к\\.', replacement: 'так как', isRegex: true, enabled: true },
  { id: '5', pattern: '\\bруб\\.', replacement: 'рублей', isRegex: true, enabled: true },
  { id: '6', pattern: '\\bг\\.', replacement: 'года', isRegex: true, enabled: true },
  { id: '7', pattern: '\\bгг\\.', replacement: 'годов', isRegex: true, enabled: true },
  { id: '8', pattern: '\\bстр\\.', replacement: 'страница', isRegex: true, enabled: true },
  { id: '9', pattern: '\\bгл\\.', replacement: 'глава', isRegex: true, enabled: true },
];

export const MAX_REGEX_PATTERN_LENGTH = 200;
/** Строки длиннее этого порога не обрабатываются пользовательскими regex-правилами (защита от зависания). */
export const MAX_REGEX_INPUT_LENGTH = 20000;
const MAX_CACHE_SIZE = 500;

/**
 * Проверяет пользовательский regex-паттерн: длина, корректность синтаксиса и
 * эвристика против катастрофического бэктрекинга (ReDoS).
 */
export function validateRegexPattern(pattern: string): { ok: boolean; reason?: string } {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, reason: 'Пустой шаблон' };
  }
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return { ok: false, reason: `Шаблон слишком длинный (максимум ${MAX_REGEX_PATTERN_LENGTH} символов)` };
  }
  try {
    new RegExp(pattern, 'gi');
  } catch (e: any) {
    return { ok: false, reason: `Некорректное регулярное выражение: ${e?.message || e}` };
  }

  // Убираем экранированные символы и символьные классы, чтобы не путать их со скобками/квантификаторами
  const stripped = pattern
    .replace(/\\./g, 'x')
    .replace(/\[(?:[^\]\\]|\\.)*\]/g, 'x');

  // Вложенные квантификаторы: (a+)+, (a*)*, (a+){2,}, (.*a)+ и т.п.
  if (/\((?:[^()]*[+*]|[^()]*\{\d+,\d*\})[^()]*\)\s*(?:[+*]|\{\d+,\d*\})/.test(stripped)) {
    return { ok: false, reason: 'Вложенные квантификаторы могут вызвать зависание (например, (a+)+)' };
  }

  // Квантифицированная группа с дублирующимися/пустыми/префиксными альтернативами: (a|a)*, (a|ab)+
  const altGroup = /\(([^()]*\|[^()]*)\)\s*(?:[+*]|\{\d+,\d*\})/g;
  let m: RegExpExecArray | null;
  while ((m = altGroup.exec(stripped)) !== null) {
    const body = m[1].replace(/^\?(?::|<?[=!])/, '');
    const alts = body.split('|');
    const seen = new Set<string>();
    for (const a of alts) {
      if (a === '' || seen.has(a)) {
        return { ok: false, reason: 'Повторяющиеся альтернативы в квантифицированной группе могут вызвать зависание' };
      }
      seen.add(a);
    }
    for (let i = 0; i < alts.length; i++) {
      for (let j = 0; j < alts.length; j++) {
        if (i !== j && alts[j].startsWith(alts[i])) {
          return { ok: false, reason: 'Пересекающиеся альтернативы в квантифицированной группе могут вызвать зависание' };
        }
      }
    }
  }

  // Обратная ссылка внутри квантифицированной группы
  if (/\((?:[^()]*\\\d[^()]*)\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern)) {
    return { ok: false, reason: 'Обратные ссылки в квантифицированных группах не поддерживаются' };
  }

  return { ok: true };
}

// Кэш скомпилированных правил: ключ = flags + '/' + isRegex + '/' + pattern. null = некорректное правило.
const regexCache = new Map<string, RegExp | null>();

function compileRule(rule: ReplacementRule): RegExp | null {
  const flags = rule.isRegex ? 'gi' : 'gu';
  const key = `${flags}/${rule.isRegex ? 'r' : 'l'}/${rule.pattern}`;
  if (regexCache.has(key)) return regexCache.get(key)!;

  let compiled: RegExp | null = null;
  try {
    if (rule.isRegex) {
      if (validateRegexPattern(rule.pattern).ok) {
        compiled = new RegExp(rule.pattern, flags);
      } else {
        console.warn(`Правило замен отклонено (небезопасный/некорректный шаблон): "${rule.pattern}"`);
      }
    } else {
      if (rule.pattern.length > MAX_REGEX_PATTERN_LENGTH * 5) {
        console.warn('Правило замен отклонено: слишком длинный шаблон');
      } else {
        // Экранируем спецсимволы
        const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Границы слов: только если символ словесный (чтобы "Э." или "г." корректно находились)
        const startBound = /^\w/u.test(rule.pattern) ? '(?:^|\\s|(?<=\\W))' : '';
        const endBound = /\w$/u.test(rule.pattern) ? '\\b' : '';
        compiled = new RegExp(`${startBound}${escaped}${endBound}`, flags);
      }
    }
  } catch (e) {
    console.warn(`Ошибка компиляции правила замен: "${rule.pattern}"`, e);
    compiled = null;
  }

  if (regexCache.size >= MAX_CACHE_SIZE) {
    // Простейшее вытеснение: удаляем самую старую запись
    const firstKey = regexCache.keys().next().value;
    if (firstKey !== undefined) regexCache.delete(firstKey);
  }
  regexCache.set(key, compiled);
  return compiled;
}

/**
 * Применяет последовательно правила замен из словаря к тексту перед отправкой в TTS.
 * В отличие от старого проекта, здесь:
 * 1. Замены не перезаписывают друг друга, а применяются кумулятивно к результату предыдущей.
 * 2. Сохраняется регистр букв.
 * 3. Поддерживаются регулярные выражения и простые слова.
 */
export function applyPronunciationDictionary(
  text: string,
  userRules: ReplacementRule[] = [],
  currentBookId?: string
): string {
  if (!text) return '';

  let processed = text;
  
  // Правила: глобальные (без bookId) либо относящиеся к конкретной книге
  const relevantUserRules = userRules.filter(r => 
    r.enabled && (!r.bookId || r.bookId === currentBookId)
  );

  const activeRules = [
    ...DEFAULT_RULES.filter(r => r.enabled),
    ...relevantUserRules,
  ];

  for (const rule of activeRules) {
    if (!rule.pattern || !rule.replacement) continue;

    if (rule.isRegex && processed.length > MAX_REGEX_INPUT_LENGTH) continue;

    const regex = compileRule(rule);
    if (!regex) continue;
    try {
      regex.lastIndex = 0;
      processed = processed.replace(regex, rule.replacement);
    } catch (e) {
      console.warn(`Ошибка применения правила замен: "${rule.pattern}"`, e);
    }
  }

  // Очистка от лишних двойных пробелов
  return processed.replace(/\s+/g, ' ').trim();
}
