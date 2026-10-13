import React, { useId, useState } from 'react';
import { X, Plus, Trash2, BookText, Globe, Check, Sparkles, HelpCircle } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { useBookStore } from '../../store/bookStore';
import { applyPronunciationDictionary, validateRegexPattern } from '../../engine/tokenizer/dictionaryReplacer';
import { Modal } from '../ui/Modal';

interface DictionaryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DictionaryModal: React.FC<DictionaryModalProps> = ({ isOpen, onClose }) => {
  const currentBook = useBookStore((state) => state.currentBook);
  const { replacementRules, addReplacementRule, removeReplacementRule, toggleReplacementRule } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<'book' | 'global'>('book');
  const [newPattern, setNewPattern] = useState('');
  const [newReplacement, setNewReplacement] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [testText, setTestText] = useState('Э. зашёл в кабинет.');
  const [regexError, setRegexError] = useState<string | null>(null);

  const titleId = useId();
  const patternId = useId();
  const replacementId = useId();
  const testId = useId();

  const currentBookId = currentBook?.metadata.id;

  // Правила текущей книги
  const bookRules = replacementRules.filter((r) => r.bookId && r.bookId === currentBookId);
  // Общие правила (без привязки к книге)
  const globalRules = replacementRules.filter((r) => !r.bookId);

  const displayedRules = activeTab === 'book' ? bookRules : globalRules;

  const handleAddRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPattern.trim() || !newReplacement.trim()) return;

    if (isRegex) {
      const check = validateRegexPattern(newPattern.trim());
      if (!check.ok) {
        setRegexError(check.reason || 'Небезопасное регулярное выражение');
        return;
      }
      try {
        new RegExp(newPattern.trim(), 'g');
      } catch (err) {
        setRegexError(err instanceof Error ? err.message : 'Некорректное регулярное выражение');
        return;
      }
    }
    setRegexError(null);

    const bookIdToAssign = activeTab === 'book' ? currentBookId : undefined;
    addReplacementRule(newPattern.trim(), newReplacement.trim(), isRegex, bookIdToAssign);

    setNewPattern('');
    setNewReplacement('');
    setIsRegex(false);
  };

  const previewResult = applyPronunciationDictionary(testText, replacementRules, currentBookId);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="w-[calc(100vw-2rem)] max-w-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
    >
      <div className="contents">
        
        {/* Шапка */}
        <div className="p-5 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <BookText className="w-5 h-5" />
            </div>
            <div>
              <h2 id={titleId} className="text-base font-bold text-slate-800 dark:text-zinc-100">
                Словарь замен и произношения
              </h2>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                Автоматическая подмена слов перед озвучкой диктором
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть словарь"
            className="p-1.5 rounded-xl text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Вкладки: Для книги / Общие */}
        <div role="tablist" aria-label="Область действия правил" className="flex border-b border-slate-200 dark:border-zinc-800 px-3 sm:px-5 gap-1 sm:gap-2 bg-slate-50/50 dark:bg-zinc-950/40 overflow-x-auto">
          <button
            role="tab"
            aria-selected={activeTab === 'book'}
            onClick={() => setActiveTab('book')}
            disabled={!currentBook}
            className={`py-3 px-3 text-xs md:text-sm font-semibold border-b-2 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              activeTab === 'book'
                ? 'border-amber-600 text-amber-700 dark:text-amber-500'
                : 'border-transparent text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
            }`}
          >
            <BookText className="w-4 h-4" />
            <span>Для этой книги ({bookRules.length})</span>
          </button>

          <button
            role="tab"
            aria-selected={activeTab === 'global'}
            onClick={() => setActiveTab('global')}
            className={`py-3 px-3 text-xs md:text-sm font-semibold border-b-2 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
              activeTab === 'global'
                ? 'border-amber-600 text-amber-700 dark:text-amber-500'
                : 'border-transparent text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
            }`}
          >
            <Globe className="w-4 h-4" />
            <span>Общие для всех книг ({globalRules.length})</span>
          </button>
        </div>

        {/* Тело модалки */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5" role="tabpanel">
          {/* Подсказка */}
          <div className="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200/80 dark:border-zinc-800 flex items-start gap-2.5 text-xs text-slate-600 dark:text-zinc-300">
            <HelpCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              {activeTab === 'book' ? (
                <span>
                  Правила в этой вкладке применяются <strong>только к книге «{currentBook?.metadata.title || 'текущей'}»</strong>. Например, можно заменить сокращение имени главного героя <code>Э.</code> на <code>Эндрю</code> или название планеты.
                </span>
              ) : (
                <span>
                  Общие правила применяются ко <strong>всем книгам</strong> (стандартные сокращения, такие как «т.е.», «руб.», «стр.»).
                </span>
              )}
            </div>
          </div>

          {/* Форма добавления правила */}
          <form onSubmit={handleAddRule} className="p-4 rounded-2xl bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-900/30 space-y-3">
            <div className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              <span>Добавить новое правило ({activeTab === 'book' ? 'для этой книги' : 'общее'})</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label htmlFor={patternId} className="block text-xs font-semibold text-slate-700 dark:text-zinc-400 mb-1">
                  Что искать (слово или сокращение)
                </label>
                <input
                  id={patternId}
                  type="text"
                  placeholder="Например: Э."
                  value={newPattern}
                  onChange={(e) => {
                    setNewPattern(e.target.value);
                    setRegexError(null);
                  }}
                  className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs md:text-sm outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label htmlFor={replacementId} className="block text-xs font-semibold text-slate-700 dark:text-zinc-400 mb-1">
                  Как произносить диктору
                </label>
                <input
                  id={replacementId}
                  type="text"
                  placeholder="Например: Эндрю"
                  value={newReplacement}
                  onChange={(e) => setNewReplacement(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs md:text-sm outline-none focus:border-amber-500"
                />
              </div>
            </div>

            {regexError && (
              <p role="alert" className="text-xs text-rose-700 dark:text-rose-400">
                Некорректное регулярное выражение: {regexError}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-700 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={isRegex}
                  onChange={(e) => setIsRegex(e.target.checked)}
                  className="rounded accent-amber-500"
                />
                <span>Регулярное выражение (RegExp)</span>
              </label>

              <button
                type="submit"
                disabled={!newPattern.trim() || !newReplacement.trim()}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-all"
              >
                <Plus className="w-4 h-4" />
                <span>Сохранить правило</span>
              </button>
            </div>
          </form>

          {/* Список правил */}
          <div className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-400">
              Список правил ({displayedRules.length})
            </h3>

            {displayedRules.length === 0 ? (
              <div className="text-center py-6 text-xs text-slate-400 dark:text-zinc-500 bg-slate-50/50 dark:bg-zinc-800/20 rounded-2xl border border-dashed border-slate-200 dark:border-zinc-800">
                {activeTab === 'book'
                  ? 'Для этой книги пока нет персональных правил. Добавьте первое сверху!'
                  : 'Нет общих правил.'}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {displayedRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200/80 dark:border-zinc-800 text-xs hover:border-slate-300 dark:hover:border-zinc-700 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-wrap">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => toggleReplacementRule(rule.id)}
                        className="rounded accent-amber-500 cursor-pointer"
                        aria-label={`${rule.enabled ? 'Отключить' : 'Включить'} правило ${rule.pattern}`}
                        title={rule.enabled ? 'Отключить правило' : 'Включить правило'}
                      />
                      <span className="font-mono font-semibold text-slate-800 dark:text-zinc-100 break-all">
                        {rule.pattern}
                      </span>
                      <span className="text-slate-500 text-[10px]" aria-label="заменяется на">➔</span>
                      <span className="text-amber-700 dark:text-amber-400 font-medium break-all">
                        {rule.replacement}
                      </span>
                      {rule.isRegex && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-zinc-300 font-mono">
                          regex
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => removeReplacementRule(rule.id)}
                      className="p-1 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/20 rounded-lg transition-colors"
                      title="Удалить правило"
                      aria-label={`Удалить правило ${rule.pattern}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Живой интерактивный тестер замен */}
          <div className="p-3.5 rounded-2xl bg-slate-100 dark:bg-zinc-800/70 border border-slate-200 dark:border-zinc-700 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-700 dark:text-zinc-300 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                <span>Песочница: проверка произношения</span>
              </span>
            </div>
            <label htmlFor={testId} className="sr-only">Тестовое предложение</label>
            <input
              id={testId}
              type="text"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              placeholder="Введите тестовое предложение..."
              className="w-full p-2 text-xs rounded-lg border border-slate-200 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-100 outline-none"
            />
            <div className="text-xs text-slate-600 dark:text-zinc-400 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-500">Диктор услышит:</span>
              <span className="text-amber-700 dark:text-amber-400 font-medium bg-white dark:bg-zinc-900 px-2 py-0.5 rounded border border-slate-200 dark:border-zinc-700">
                «{previewResult}»
              </span>
            </div>
          </div>
        </div>

        {/* Подвал */}
        <div className="p-4 border-t border-slate-200 dark:border-zinc-800 flex justify-end bg-slate-50 dark:bg-zinc-950/60 shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-slate-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            Готово
          </button>
        </div>
      </div>
    </Modal>
  );
};
