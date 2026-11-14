// Reads an operator key file from ~/.config/feepass/ (never from the repo).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function readKeyFile(name: string): Record<string, string> {
  const text = readFileSync(join(homedir(), '.config', 'feepass', `${name}.env`), 'utf8');
  return Object.fromEntries(
    text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}
