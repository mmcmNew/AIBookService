// Общее для всех частей инструмента: слой по пути файла, признак записи, короткий хеш.
// Раньше эти правила были скопированы в build.mjs, blockmap.mjs и verify.mjs.
import crypto from 'node:crypto';
import { profile } from './profile.mjs';

export const layerOf = (f) => profile.layerOf(f);

// Обращение к таблице БД, меняющее данные
export const DB_WRITE = /\.(put|add|bulkPut|bulkAdd|delete|clear|update|bulkDelete|modify)\s*\(/;

export const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

// Имя действия (функции стора/домена), которое по названию меняет состояние
export const WRITE_ACTION = /^(dispatch|set|update|add|remove|delete|put|clear|reset|toggle|save|append|push|open|close|apply|begin|start|stop|play|pause|jump|advance)/i;

// Блоки карты по файлам: файл -> [id блоков]
export const blocksByFile = (m) => { const r = {}; for (const [id, b] of Object.entries(m.blocks)) (r[b.file] ||= []).push(id); return r; };

export const NL = String.fromCharCode(10);
