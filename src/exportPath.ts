// Pure helpers for the "default export directory" flow.
// Deliberately free of any `vscode` import so `node --test` can require the
// compiled output directly (see tests/export-path.test.js).

// Treats missing, blank, and non-string values as "not configured" so clearing
// the setting falls back to the save dialog instead of writing to a bogus path.
export function normalizeExportDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildExportFileName(title: string, extension: string, now: Date): string {
  const safeTitle = title.replace(/[^a-z0-9_-]+/gi, '_') || 'query';
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `query_${safeTitle}_${timestamp}.${extension}`;
}
