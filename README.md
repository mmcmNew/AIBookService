# AIBookReaderWeb

Кроссплатформенная читалка электронных книг с нейросетевой озвучкой в реальном времени, караоке-подсветкой предложений и поддержкой современных Voice API (Web Speech, Edge-TTS, Google Gemini Audio, ElevenLabs, OpenAI).

## Документация проекта

- [SPEC_TASKS.md](file:///F:/Projects/AIBookReaderWeb/SPEC_TASKS.md) — Полная архитектурная спецификация и план задач, декомпозированный по фазам и ролям для «Секретаря» / ИИ-агентов.

## Стек технологий

- **Frontend:** React 19 / 18, Vite, TypeScript, Tailwind CSS, Lucide Icons, Zustand
- **Storage & Cache:** Dexie.js (IndexedDB для оффлайн-кэша книг и аудиофрагментов)
- **Desktop:** Tauri v2 (Rust) для ультралегких сборок под Windows, macOS и Linux
- **Audio & TTS:** Web Audio API, Lookahead Queue (опережающая буферизация), Intl.Segmenter
- **Синтез речи:**
  1. *Оффлайн*: Web Speech API
  2. *Бесплатно*: Edge-TTS
  3. *AI Premium*: Google Gemini Audio, ElevenLabs, OpenAI TTS

## Карта блоков
Инструмент вынесен в отдельный репозиторий: https://github.com/mmcmNew/code-flow (зависимость `code-flow`). Карта этого проекта — `.blockmap/` (профиль, модель, версии схемы). Команды: `npx blockmap check`, `npx blockmap build` (страница `.blockmap/out/map.html`). Промпты агентов: `docs/block_map_agent_prompt.md`, `docs/block_map_executor_prompt.md`; правила схем, решения и питч — в репозитории code-flow (`docs/`).
