// ============================================================
// Smart Circuit — SPICE Value Parser
// ============================================================
// Converts human-readable component values to/from SPICE notation.
// Examples: "10kΩ" → "10k", "100nF" → "100n", "4.7µH" → "4.7u"

/**
 * Unit suffixes that should be stripped from values.
 * Order matters: longer suffixes first to avoid partial matches.
 */
const UNIT_SUFFIXES = ['Ω', 'ohm', 'OHM', 'Ohm', 'F', 'H', 'V', 'A'];

/**
 * Map of SI prefix characters/strings to their SPICE equivalents.
 * SPICE uses 'Meg' for mega (not 'M', which means milli in SPICE).
 */
const SI_PREFIX_MAP: Record<string, string> = {
  'T': 'T',     // tera  (1e12)
  'G': 'G',     // giga  (1e9)
  'M': 'Meg',   // mega  (1e6) — SPICE convention
  'Meg': 'Meg', // already correct
  'MEG': 'Meg',
  'k': 'k',     // kilo  (1e3)
  'K': 'k',     // common user alias
  'm': 'm',     // milli (1e-3)
  'µ': 'u',     // micro (1e-6)
  'μ': 'u',     // micro (alternate unicode)
  'u': 'u',     // micro (ASCII alias)
  'U': 'u',     // micro (uppercase alias)
  'n': 'n',     // nano  (1e-9)
  'p': 'p',     // pico  (1e-12)
  'f': 'f',     // femto (1e-15)
};

/**
 * Reverse map: SPICE prefix → display prefix (with correct Unicode).
 */
const SPICE_TO_DISPLAY: Record<string, string> = {
  'T': 'T',
  'G': 'G',
  'Meg': 'M',
  'k': 'k',
  'm': 'm',
  'u': 'µ',
  'n': 'n',
  'p': 'p',
  'f': 'f',
};

/**
 * Default unit suffix for SPICE prefix contexts.
 */
const PREFIX_DEFAULT_UNIT: Record<string, string> = {
  'T': 'Ω',
  'G': 'Ω',
  'Meg': 'Ω',
  'k': 'Ω',
  'm': '',    // ambiguous — could be mV, mA, mΩ
  'u': 'F',   // µF is most common
  'n': 'F',   // nF
  'p': 'F',   // pF
  'f': 'F',   // fF
};

/**
 * Convert a human-readable component value to SPICE notation.
 *
 * Examples:
 *   "10kΩ"   → "10k"
 *   "100nF"  → "100n"
 *   "4.7µH"  → "4.7u"
 *   "1MΩ"    → "1Meg"
 *   "5V"     → "5"
 *   "DC 5V"  → "DC 5"
 *   "AC 1 0" → "AC 1 0" (pass-through for SPICE expressions)
 */
export function parseSpiceValue(value: string): string {
  if (!value || value.trim() === '') return '0';

  let v = value.trim();

  // If it starts with a SPICE keyword (DC, AC, PULSE, SIN, etc.), handle specially
  const spiceKeywords = ['DC', 'AC', 'PULSE', 'SIN', 'EXP', 'PWL', 'SFFM'];
  const upperV = v.toUpperCase();
  for (const kw of spiceKeywords) {
    if (upperV.startsWith(kw + ' ') || upperV.startsWith(kw + '(')) {
      // Process each token after the keyword
      const prefix = v.substring(0, kw.length);
      const rest = v.substring(kw.length);
      // Parse individual numeric tokens in the rest
      const parsed = rest.replace(/[\d.]+[a-zA-ZΩµμ]+/g, (match) => parseSingleValue(match));
      return prefix + parsed;
    }
  }

  return parseSingleValue(v);
}

/**
 * Parse a single numeric value with optional SI prefix and unit suffix.
 */
function parseSingleValue(v: string): string {
  // Strip unit suffixes from the end
  for (const suffix of UNIT_SUFFIXES) {
    if (v.endsWith(suffix)) {
      v = v.slice(0, -suffix.length);
      break;
    }
  }

  // Try to match a number followed by an SI prefix
  // Pattern: optional sign, digits, optional decimal, optional digits, then prefix
  const match = v.match(/^([+-]?\d*\.?\d+)\s*(T|G|Meg|MEG|M|k|K|m|µ|μ|u|U|n|p|f)$/);
  if (match) {
    const num = match[1];
    const prefix = match[2];
    const spicePrefix = SI_PREFIX_MAP[prefix] || prefix;
    return num + spicePrefix;
  }

  // If it's already a plain number (with or without decimal), return as-is
  if (/^[+-]?\d*\.?\d+$/.test(v)) {
    return v;
  }

  // Return as-is for anything else (already SPICE notation or unknown format)
  return v;
}

/**
 * Format a SPICE value back to human-readable display.
 *
 * Examples:
 *   "10k"  → "10kΩ"   (with unit="Ω")
 *   "100n" → "100nF"  (with unit="F")
 *   "4.7u" → "4.7µH"  (with unit="H")
 *   "1Meg" → "1MΩ"    (with unit="Ω")
 */
export function formatSpiceValue(value: string, unit?: string): string {
  if (!value || value.trim() === '') return '0';

  const v = value.trim();

  // Try to match number + SPICE prefix
  const match = v.match(/^([+-]?\d*\.?\d+)(T|G|Meg|k|m|u|n|p|f)$/);
  if (match) {
    const num = match[1];
    const spicePrefix = match[2];
    const displayPrefix = SPICE_TO_DISPLAY[spicePrefix] || spicePrefix;
    const displayUnit = unit || PREFIX_DEFAULT_UNIT[spicePrefix] || '';
    return num + displayPrefix + displayUnit;
  }

  // Plain number — just append unit if provided
  if (/^[+-]?\d*\.?\d+$/.test(v) && unit) {
    return v + unit;
  }

  return v;
}
