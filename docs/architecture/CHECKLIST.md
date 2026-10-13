# Чек-лист сопровождения архитектурных схем AIBookReaderWeb

Архитектурная карта системы декомпозирована на небольшие независимые файлы данных в каталоге `docs/architecture/flows/`.  
При любых изменениях в потоках данных, рефакторинге или добавлении функционала обновите соответствующий файл схемы, чтобы интерактивная карта всегда соответствовала живому коду.

---

## 📌 Соответствие функциональных этапов и файлов схем

| Этап | Название | Файл схемы данных | Ключевые файлы кода |
| :---: | :--- | :--- | :--- |
| **0** | **Общая функциональная схема** | `docs/architecture/flows/level0_overview.json` | Корневой маршрутизатор и обзор связей |
| **1** | **Библиотека и импорт книги** | `docs/architecture/flows/01_library_and_import.json` | `src/components/library/LibraryView.tsx`, `src/engine/parsers/index.ts` |
| **2** | **Распознавание PDF** | `docs/architecture/flows/02_pdf_recognition.json` | `src/engine/pdf/pagedSession.ts`, `recognizers.ts`, `pageScheduler.ts`, `pageCompose.ts` |
| **3** | **Очистка и редактор** | `docs/architecture/flows/03_cleanup_and_editor.json` | `src/engine/cleanup/pipeline.ts`, `src/components/editor/BookEditor.tsx` |
| **4** | **Главы и содержание** | `docs/architecture/flows/04_chapters_and_toc.json` | `src/engine/pdf/chapterPlan.ts`, `src/components/reader/ChapterSidebar.tsx` |
| **5** | **Чтение и подсветка** | `docs/architecture/flows/05_reading_and_highlight.json` | `src/components/reader/BookView.tsx`, `PagedTextView.tsx`, `sentenceTokenizer.ts` |
| **6** | **Озвучка (плеер, кэш, TTS)** | `docs/architecture/flows/06_tts_and_player.json` | `src/engine/audio/playerState.ts`, `audioManager.ts`, `openRouterTts.ts` |
| **7** | **Баланс и оплата** | `docs/architecture/flows/07_billing_and_payment.json` | `server/src/routes/payment.ts`, `server/src/services/yookassa.ts` |
| **8** | **Настройки** | `docs/architecture/flows/08_settings.json` | `src/store/settingsStore.ts`, `src/components/settings/SettingsModal.tsx` |
| **9** | **Хранилище** | `docs/architecture/flows/09_storage.json` | `src/storage/db.ts`, `server/src/db.ts` |

---

## 🚀 Чек-лист при внесении изменений в код

### 1. Добавление новой функции или шага конвейера
- [ ] Открыть соответствующий файл этапа `docs/architecture/flows/XX_....json`.
- [ ] Добавить узел в массив `"nodes"`:
  ```json
  {
    "id": "unique_step_id",
    "label": "Название шага",
    "type": "step | condition | io | subflow",
    "file": "src/path/to/file.ts",
    "line": 42,
    "symbol": "functionName",
    "summary": "Однострочное описание назначения шага",
    "isRisky": false,
    "recentlyChanged": true,
    "changeNote": "Краткое описание изменения"
  }
  ```
- [ ] Добавить связи в массив `"edges"` (`"from"`, `"to"`, `"label"`).

### 2. Изменение условий ветвления или эндпоинтов
- [ ] Проверить условия выхода (`type: "condition"`).
- [ ] Указать метки на рёбрах (стрелках): например, `"Успех"`, `"Ошибка 404"`, `"Скан без OCR"`.

### 3. Отметка потенциальных рисков (`isRisky: true`)
- Обязательно выставляйте отметку `isRisky: true` и поле `riskReason` в случаях:
  - Риск утечки или сброса токенов/баланса пользователя.
  - Асинхронные гонки (race conditions) при быстром скролле или навигации.
  - Операции, способные повредить текст (например, удаление управляющих символов до исправления сдвинутой кириллицы).
  - Внешние сетевые вызовы без гарантии идемпотентности.

### 4. Отметка свежих правок (`recentlyChanged: true`)
- [ ] При модификации алгоритма переключить `recentlyChanged: true` и обновить `changeNote`.
- [ ] Сохранить файл. Интерактивная карта автоматически отобразит обновлённый статус шага и подсветит его в фильтрах.

---

## 🛠️ Как запустить и открыть интерактивную карту
1. В Antigravity IDE: открыть сгенерированный артефакт в боковой панели.
2. В браузере локально: открыть файл `docs/architecture/index.html`.
3. Ссылки вида `vscode://file/...:строка` позволяют переходить прямо в нужную строку кода в VS Code / Antigravity в один клик.
