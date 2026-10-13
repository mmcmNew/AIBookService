#!/usr/bin/env node
// Консольная утилита Block Map для людей и агентов: диспетчер команд.
//   node tools/blockmap/blockmap.mjs <команда> [аргументы]
// Сами команды: cli/*.mjs. Логика без ввода-вывода: lib/*.mjs.
import { cmd, load } from './cli/context.mjs';
import { cmds as inspect } from './cli/inspect.mjs';
import { cmds as check } from './cli/check.mjs';
import { cmds as edit } from './cli/edit.mjs';
import { cmds as versions } from './cli/versions.mjs';
import { cmds as layout } from './cli/layout.mjs';

const own = {
  help() {
    console.log(`Block Map: node tools/blockmap/blockmap.mjs <команда>
  list                  блоки: слой, сценарии, статус хеша, покрытие
  block <id>            всё про блок: контракт, шаги, связи, расхождения  (--json)
  impact <файл[:стр]>   какие блоки, сценарии и ресурсы заденет правка
  zones                 где блоки лезут в чужие зоны (ресурсы, слои)
  version               версия схемы, веха, что изменилось с прошлого выпуска и какое увеличение версии нужно
  release "заметка" [--bump=..] [--milestone=".."]  выпустить версию схемы (снимок структуры + запись в историю)
  layout [сценарий] [--apply]  подобрать колонки блоков так, чтобы стрелки пересекались меньше
  lint [id]             проверка ПЛАНОВОЙ архитектуры по схемам: слои, владельцы, откуда данные, блок-схема против сценария
  states [id]           каталог состояний: куски, владелец, кто пишет и читает, логика в сторах
  reality [id]          реальные связи из кода, которых нет на схеме (кто что пишет и вызывает)
  reality-ack <от> <к> ".."  принять реальную связь осознанно (она перестанет считаться расхождением)
  check [--strict]      актуальна ли карта (код 1 если нет)
  risks                 проглоченные ошибки по всему проекту (--logged, --all)
  ack <файл:стр> ".."   принять риск осознанно (привязано к хешу кода)
  edge-ack <от> <к> ".." принять неподтверждённую стрелку как известное расхождение
  declare [--apply]     заявить ресурсы блокам, чьи файлы их уже используют
  bind <id> [id …] | --changed | --all   утвердить блоки/сценарии (--changed: все изменившиеся)
  baseline              запомнить текущие ✗ и предупреждения как эталон «до»
  check --diff          сравнить с эталоном: что новое, что закрыто (код возврата 1, если есть новые ✗)
  build                 только пересобрать out/map.html
Общие флаги: --json, --fast (не пересобирать граф импортов)`);
  },
  build() { const { log } = load(); console.log(log.trim()); },
};
const cmds = { ...own, ...inspect, ...check, ...edit, ...versions, ...layout };
(cmds[cmd] || cmds.help)();
