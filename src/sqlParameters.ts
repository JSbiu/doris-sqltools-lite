// Hue-style SQL parameter substitution, kept free of the `vscode` import so the
// whole substitution surface can be unit-tested from plain Node.
//
// Syntax (deliberately identical to Hue's so existing templates keep working):
//
//   ${name}              a parameter
//   ${name=US}           a parameter with an inline default
//   ${name=A, B, C}      a parameter with candidate values (offered as a dropdown)
//   ${name=CA(Canada)}   candidate with a display label; the value is `CA`
//   $${name}             an escape: emits the literal text `${name}`, untouched
//
// Values are inserted verbatim -- no quoting, no escaping, exactly like Hue. That
// is why a text value has to be quoted in the template (`'${name}'`) while a
// numeric one must not be. The parameter panel compensates by previewing the
// substituted SQL, so a wrong quote is visible before the query runs.
//
// Substitution must happen AFTER the statement is chosen and split: a value may
// legitimately contain `;`, `--` or a newline, and those must never be allowed to
// move a statement boundary.

export interface SqlParameter {
  readonly name: string;
  // Values offered for this parameter. Empty when the template declares none.
  // A single entry acts as a default; several act as a choice list.
  readonly candidates: readonly string[];
  // Display labels for candidates, parallel to `candidates` (Hue's `CA(Canada)`).
  readonly labels: readonly (string | undefined)[];
}

export interface ParameterResolution {
  // The substituted SQL. When nothing was resolved this is the input, verbatim.
  readonly sql: string;
  // Names that had no value: neither supplied nor declared inline.
  readonly missing: readonly string[];
  // Names actually substituted, and with what -- what the result panel reports.
  readonly used: Readonly<Record<string, string>>;
}

export type ParameterValues = Readonly<Record<string, string | undefined>>;

// A parameter name has to look like an identifier. Anything else (`${1}`, `${a b}`,
// `${}`, an unbalanced brace) is left alone so that template literals inside SQL
// strings and regex literals such as '${1}' are never mangled.
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// Exposed so the value store can reject anything that is not a real parameter
// name, keeping junk out of the saved state.
export function isParameterName(value: unknown): value is string {
  return typeof value === 'string' && NAME_PATTERN.test(value);
}

interface ScanMatch {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly candidates: string[];
  readonly labels: (string | undefined)[];
}

// Finds every `${...}` that is a genuine parameter reference. Escaped ones
// (`$${...}`) are skipped here because they are consumed during substitution.
function scan(sql: string): ScanMatch[] {
  const matches: ScanMatch[] = [];
  let index = 0;

  while (index < sql.length) {
    const start = sql.indexOf('${', index);
    if (start < 0) {
      break;
    }
    // `$${` is the escape sequence, not a parameter.
    if (start > 0 && sql[start - 1] === '$') {
      index = start + 2;
      continue;
    }
    const end = sql.indexOf('}', start + 2);
    if (end < 0) {
      // Unbalanced template: nothing sensible to substitute, leave it alone.
      break;
    }

    const body = sql.slice(start + 2, end);
    const equals = body.indexOf('=');
    const name = equals < 0 ? body : body.slice(0, equals);
    if (!NAME_PATTERN.test(name)) {
      index = end + 1;
      continue;
    }

    const declaration = equals < 0 ? undefined : body.slice(equals + 1);
    const { candidates, labels } = splitCandidates(declaration);
    matches.push({ start, end: end + 1, name, candidates, labels });
    index = end + 1;
  }

  return matches;
}

// Hue writes a candidate list as `A, B, C`, optionally with a display label per
// value: `CA(Canada)`. A bare value has no label.
function splitCandidates(declaration: string | undefined): {
  candidates: string[];
  labels: (string | undefined)[];
} {
  if (declaration === undefined) {
    return { candidates: [], labels: [] };
  }

  const candidates: string[] = [];
  const labels: (string | undefined)[] = [];
  for (const raw of declaration.split(',')) {
    const piece = raw.trim();
    if (piece.length === 0) {
      continue;
    }
    const labelled = /^(.*?)\s*\(([^()]*)\)$/.exec(piece);
    if (labelled && labelled[1].trim().length > 0) {
      candidates.push(labelled[1].trim());
      labels.push(labelled[2].trim() || undefined);
    } else {
      candidates.push(piece);
      labels.push(undefined);
    }
  }
  return { candidates, labels };
}

// The parameters a template declares, in order of first appearance, without
// duplicates.
export function parseSqlParameters(sql: string): SqlParameter[] {
  const seen = new Map<string, SqlParameter>();
  for (const match of scan(sql)) {
    if (!seen.has(match.name)) {
      seen.set(match.name, {
        name: match.name,
        candidates: match.candidates,
        labels: match.labels,
      });
    }
  }
  return [...seen.values()];
}

export function hasSqlParameters(sql: string): boolean {
  return scan(sql).length > 0;
}

// The value a template declares for a parameter by itself: an inline default is
// shorthand for "use this when I say nothing", while a candidate list is a
// question that still needs an answer.
//
// Collected per name across the whole template rather than per occurrence, so a
// parameter used several times only needs its default written once:
//   ${x=A} ... ${x}   -> both become A
function collectDefaults(matches: readonly ScanMatch[]): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const match of matches) {
    if (match.candidates.length === 1 && !defaults.has(match.name)) {
      defaults.set(match.name, match.candidates[0]);
    }
  }
  return defaults;
}

// Fills in the given values. Precedence is: supplied value, then the template's
// own inline default; anything still unanswered is reported as missing and left
// in place, so the caller can either ask for it or send the template untouched.
//
// The order of the two steps matters, which is why callers must not do this by
// hand: substitution first (the scan skips escaped placeholders), then
// unescaping. Unescaping first would turn `$${name}` into a real placeholder and
// prompt the user for the value they explicitly escaped.
export function resolveSqlParameters(sql: string, values: ParameterValues): ParameterResolution {
  const matches = scan(sql);
  if (matches.length === 0) {
    return { sql: unescapeDollarPlaceholders(sql), missing: [], used: {} };
  }

  const defaults = collectDefaults(matches);
  const used: Record<string, string> = {};
  const missing: string[] = [];
  let out = '';
  let cursor = 0;

  for (const match of matches) {
    out += sql.slice(cursor, match.start);
    cursor = match.end;

    const supplied = values[match.name];
    const value = supplied !== undefined && supplied !== '' ? supplied : defaults.get(match.name);

    if (value === undefined) {
      if (!missing.includes(match.name)) {
        missing.push(match.name);
      }
      // Leave the placeholder in place; it is only ever sent if the caller
      // explicitly chooses "send as-is".
      out += sql.slice(match.start, match.end);
      continue;
    }

    out += value;
    used[match.name] = value;
  }

  out += sql.slice(cursor);
  return { sql: unescapeDollarPlaceholders(out), missing, used };
}

// Turns `$${name}` into a literal `${name}`. Used on its own for the "send the
// template untouched" path, and as the last step of substitution -- one helper so
// the escape cannot mean two different things in two places.
export function unescapeDollarPlaceholders(sql: string): string {
  return sql.replace(/\$\$\{/g, '${');
}
