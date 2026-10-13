// Ручная модель (model.json): читает и пишет файл, про смысл содержимого не знает.
import fs from 'node:fs';
import { profile, abs } from '../../ui/profile.mjs';
import { NL } from '../../ui/shared.mjs';

export const readRaw = () => JSON.parse(fs.readFileSync(abs(profile.modelFile), 'utf8'));
export const writeRaw = (raw) => fs.writeFileSync(abs(profile.modelFile), JSON.stringify(raw, null, 2) + NL);
