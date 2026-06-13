import { basename } from 'node:path';

export function planStateStem(planFileOrPath: string): string {
  const base = basename(planFileOrPath);
  return base.replace(/[^A-Za-z0-9._-]/g, '_') + '_';
}

