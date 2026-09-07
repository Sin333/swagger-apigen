/**
 * Utilities for producing safe TypeScript identifiers and property/string
 * literals. Keeps the emitter free of scattered escaping logic.
 */

const RESERVED_WORDS: ReadonlySet<string> = new Set([
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'new',
    'null',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
    'let',
    'static',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
]);

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** True when `name` is a valid, non-reserved TS identifier. */
export const isSafeIdent = (name: string): boolean =>
    name.length > 0 && IDENT_RE.test(name) && !RESERVED_WORDS.has(name);

/** Escape a value for use inside single-quoted TS string literals. */
export const quoteString = (s: string): string =>
    `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;

/**
 * Format a property/parameter name. Reserved words are legal property keys in
 * TypeScript, so they don't need quoting here — only names with characters
 * outside the identifier alphabet do.
 */
export const propKey = (name: string): string =>
    IDENT_RE.test(name) ? name : quoteString(name);

/**
 * Turn arbitrary text into a valid TS identifier. Non-alphanumeric characters
 * become word boundaries (PascalCase). Empty result falls back to `_`.
 */
export const toIdent = (raw: string, mode: 'pascal' | 'camel' = 'pascal'): string => {
    let out = '';
    let capitalize = true;
    for (const ch of raw) {
        if (/[A-Za-z0-9]/.test(ch)) {
            out += capitalize ? ch.toUpperCase() : ch;
            capitalize = false;
        } else {
            capitalize = true;
        }
    }
    if (out === '') return '_';
    if (/^[0-9]/.test(out)) out = `_${out}`;
    if (mode === 'camel') out = out.charAt(0).toLowerCase() + out.slice(1);
    if (RESERVED_WORDS.has(out)) out = `${out}_`;
    return out;
};

/**
 * Format a JSDoc block for the emitted source. Returns an empty string when
 * there is nothing to say — so the caller can drop it into templates unconditionally.
 */
export const jsDoc = (parts: { description?: string; deprecated?: boolean }): string => {
    const lines: string[] = [];
    if (parts.description) {
        for (const line of parts.description.trim().split(/\r?\n/)) {
            lines.push(` * ${line}`);
        }
    }
    if (parts.deprecated) lines.push(' * @deprecated');
    if (lines.length === 0) return '';
    return `/**\n${lines.join('\n')}\n */\n`;
};
