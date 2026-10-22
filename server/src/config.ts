// Конфигурация читается из process.env в момент вызова (удобно для тестов).

const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'tauri://localhost',
  'http://tauri.localhost',
];

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function int(value: string | undefined, def: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export function parseTrustProxy(value: string | undefined): false | number | string {
  if (!value) return false;
  const v = value.trim();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') return 'loopback, linklocal, uniquelocal';
  const n = parseInt(v, 10);
  if (String(n) === v && Number.isFinite(n) && n >= 1) return n;
  return v;
}

export const config = {
  isProduction: () => process.env.NODE_ENV === 'production',
  corsOrigins: () => {
    const l = list(process.env.CORS_ORIGINS);
    return l.length ? l : DEFAULT_ORIGINS;
  },
  allowedReturnOrigins: () => {
    const l = list(process.env.ALLOWED_RETURN_ORIGINS);
    return l.length ? l : DEFAULT_ORIGINS;
  },
  yookassaShopId: () => process.env.YOOKASSA_SHOP_ID || '',
  yookassaSecret: () => process.env.YOOKASSA_SECRET_KEY || '',
  yookassaConfigured: () => Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY),
  geminiApiKey: () => process.env.GEMINI_API_KEY || '',
  geminiTtsModel: () => process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts',
  geminiOcrModel: () => process.env.GEMINI_OCR_MODEL || 'gemini-2.5-flash',
  openaiApiKey: () => process.env.OPENAI_API_KEY || '',
  openaiTtsModel: () => process.env.OPENAI_TTS_MODEL || 'tts-1',
  elevenlabsApiKey: () => process.env.ELEVENLABS_API_KEY || '',
  openrouterApiKey: () => process.env.OPENROUTER_API_KEY || '',
  openrouterBaseUrl: () => process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  edgeTtsEnabled: () => process.env.EDGE_TTS_ENABLED !== 'false',
  pdfGeminiCost: () => int(process.env.PDF_GEMINI_COST_CHARS, 10000),
  freeCharacters: () => int(process.env.FREE_CHARACTERS, 15000),
  registerLimitPerHour: () => int(process.env.REGISTER_LIMIT_PER_HOUR, 5),
  trustProxy: () => parseTrustProxy(process.env.TRUST_PROXY),
  dataDir: () => process.env.DATA_DIR || '',
  databaseUrl: () => process.env.DATABASE_URL || '',
  pythonEnabled: () =>
    process.env.ENABLE_PYTHON_PDF === 'true' && Boolean(process.env.PYTHON_PATH) && Boolean(process.env.PYTHON_SCRIPT),
  pythonPath: () => process.env.PYTHON_PATH || '',
  pythonScript: () => process.env.PYTHON_SCRIPT || '',
};

/** Нормализация origin: scheme//host[:port] (работает и для tauri://localhost). */
export function originOf(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function sanitizeReturnUrl(candidate: unknown): string {
  const allowed = config.allowedReturnOrigins();
  if (typeof candidate === 'string' && candidate.length < 2000) {
    const o = originOf(candidate);
    if (o && allowed.includes(o)) return candidate;
  }
  return allowed[0];
}
