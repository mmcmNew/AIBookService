import fs from 'node:fs';
import path from 'node:path';

const DIST_DIR = path.resolve('dist');

const PATTERNS = [
  { name: 'sk-or-v1- (OpenRouter)', regex: /sk-or-v1-[A-Za-z0-9_-]{20,}/g },
  { name: 'sk-proj- (OpenAI Project)', regex: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: 'sk-ant- (Anthropic)', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'AIza (Google API Key)', regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'sk- (General Secret Key)', regex: /sk-[A-Za-z0-9_-]{32,}/g },
];

function getFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function check() {
  const files = getFiles(DIST_DIR);
  if (files.length === 0) {
    console.error('check-dist-secrets: dist folder is empty or not found');
    process.exit(1);
  }

  let foundSecrets = false;

  for (const file of files) {
    // Only check text / web assets
    const ext = path.extname(file).toLowerCase();
    if (!['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.txt', '.map'].includes(ext)) {
      continue;
    }

    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(process.cwd(), file);

    for (const { name, regex } of PATTERNS) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(content)) !== null) {
        foundSecrets = true;
        const val = match[0];
        const prefix = val.slice(0, 6);
        const length = val.length;
        console.error(
          `[SECRET DETECTED] File: ${relPath}, Pattern: ${name}, Prefix: ${prefix}..., Length: ${length}`
        );
      }
    }
  }

  if (foundSecrets) {
    console.error('check-dist-secrets: Secrets found in build output! Aborting.');
    process.exit(1);
  }

  console.log('check-dist-secrets: No secrets detected in dist.');
}

check();
