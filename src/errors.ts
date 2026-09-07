import type { JsonPointer } from './types.ts';

/** Severity of a diagnostic produced during parsing/validation. */
export type Severity = 'error' | 'warning';

export type Diagnostic = {
    readonly severity: Severity;
    readonly pointer: JsonPointer;
    readonly message: string;
};

export const escapePointerSegment = (segment: string): string =>
    segment.replaceAll('~', '~0').replaceAll('/', '~1');

export const joinPointer = (parent: JsonPointer, ...segments: (string | number)[]): JsonPointer => {
    if (segments.length === 0) return parent;
    let out = parent;
    for (const s of segments) {
        out += '/' + escapePointerSegment(String(s));
    }
    return out;
};

/**
 * Thrown for failures that make the document unusable — malformed JSON, wrong
 * top-level shape, unsupported spec version. Everything recoverable is reported
 * as a `Diagnostic` instead.
 */
export class ParseError extends Error {
    readonly pointer: JsonPointer;

    constructor(message: string, pointer: JsonPointer = '') {
        super(pointer ? `${message} (at ${pointer || '/'})` : message);
        this.name = 'ParseError';
        this.pointer = pointer;
    }
}
