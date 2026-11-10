export type CopyMode = 'origin' | 'extra';

export const DEFAULT_COPY_MODE: CopyMode = 'extra';

export function isCopyMode(value: unknown): value is CopyMode {
  return value === 'origin' || value === 'extra';
}

export function parseCopyMode(value: string): CopyMode {
  const normalized = value.trim().toLowerCase();
  if (!isCopyMode(normalized)) {
    throw new Error('@copy 只能是 origin 或 extra。');
  }
  return normalized;
}
