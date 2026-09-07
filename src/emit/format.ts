/**
 * Emitter formatting utilities used across templates and helpers.
 */

import type { IrTypeExpr } from '../ir/types.ts';

/**
 * Extract a JSDoc `@format` tag from an expression, if any. Returns the
 * comment body (without `/** ... *\/`), so templates decide the framing.
 */
export const jsDocFormat = (expr: IrTypeExpr): string | null => {
    const format = pickFormat(expr);
    return format ? `@format ${format}` : null;
};

const pickFormat = (expr: IrTypeExpr): string | null => {
    switch (expr.kind) {
        case 'string':
        case 'integer':
        case 'number':
            return expr.format ?? null;
        case 'nullable':
            return pickFormat(expr.inner);
        default:
            return null;
    }
};

/**
 * Render a leading JSDoc block for a property/type. Returns an empty string
 * when there is nothing to emit.
 */
export const renderJsDocBlock = (
    parts: {
        readonly description?: string;
        readonly format?: string | null;
        readonly deprecated?: boolean;
    },
    indent: string = '',
): string => {
    const lines: string[] = [];
    if (parts.description) {
        for (const line of parts.description.trim().split(/\r?\n/)) {
            lines.push(`${indent} * ${line}`);
        }
    }
    if (parts.format) lines.push(`${indent} * ${parts.format}`);
    if (parts.deprecated) lines.push(`${indent} * @deprecated`);
    if (lines.length === 0) return '';
    // Collapse a single-line block into `/** … */` — matches the current output style.
    if (lines.length === 1) {
        const inner = lines[0]!.slice(indent.length + 3);
        return `${indent}/** ${inner} */\n`;
    }
    return `${indent}/**\n${lines.join('\n')}\n${indent} */\n`;
};
