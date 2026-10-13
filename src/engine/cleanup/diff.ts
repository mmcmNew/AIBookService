/** Пословный diff двух строк для отображения «было / стало». */

export interface DiffPart {
  text: string;
  kind: 'same' | 'del' | 'ins';
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MAX_TOKENS = 600;

function tokenize(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

function push(parts: DiffPart[], kind: DiffPart['kind'], text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

/** Возвращает части для «было» (same+del) и «стало» (same+ins) в одном списке. */
export function wordDiff(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  // Общие префикс и суффикс отрезаем сразу — так LCS работает на малой части
  let start = 0;
  const minLen = Math.min(before.length, after.length);
  while (start < minLen && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const parts: DiffPart[] = [];
  push(parts, 'same', before.slice(0, start));

  const a = tokenize(before.slice(start, endB));
  const b = tokenize(after.slice(start, endA));
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    push(parts, 'del', before.slice(start, endB));
    push(parts, 'ins', after.slice(start, endA));
  } else {
    const n = a.length;
    const m = b.length;
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        push(parts, 'same', a[i]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push(parts, 'del', a[i++]);
      } else {
        push(parts, 'ins', b[j++]);
      }
    }
    while (i < n) push(parts, 'del', a[i++]);
    while (j < m) push(parts, 'ins', b[j++]);
  }
  push(parts, 'same', before.slice(endB));
  return parts;
}
