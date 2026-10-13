// Снимки структуры схемы по выпускам версий (releases профиля).
import fs from 'node:fs';
import path from 'node:path';
import { profile, abs } from '../../ui/profile.mjs';
import { NL } from '../../ui/shared.mjs';

const file = (ver) => path.join(abs(profile.releasesDir), ver + '.json');
export const readSnapshot = (ver) => (fs.existsSync(file(ver)) ? JSON.parse(fs.readFileSync(file(ver), 'utf8')) : null);
export const writeSnapshot = (ver, obj) => { fs.mkdirSync(abs(profile.releasesDir), { recursive: true }); fs.writeFileSync(file(ver), JSON.stringify(obj, null, 2) + NL); };
