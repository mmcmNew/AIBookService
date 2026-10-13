// Эталон проверки («до»): список ✗ и предупреждений, с которым сравнивают позже (check --diff).
import fs from 'node:fs';
import path from 'node:path';
import { profile, abs } from '../../ui/profile.mjs';

const file = () => path.join(abs(profile.outDir), 'baseline.json');
export const readBaseline = () => (fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), 'utf8')) : null);
export const writeBaseline = (obj) => { fs.mkdirSync(abs(profile.outDir), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(obj, null, 2)); };
