/**
 * Render an `IrTypeExpr` as a TypeScript type expression string.
 *
 * Precedence: unions and intersections wrap themselves in parentheses when
 * they appear as members of arrays, records, or nullable wrappers, so the
 * output never depends on ambient binding rules.
 */

import type { ApigenConfig } from '../config.ts';
import type { IrProperty, IrTypeExpr } from '../ir/types.ts';
import { jsDocFormat, renderJsDocBlock } from './format.ts';
import { propKey, quoteString } from './ident.ts';
import { canonicalTypeName } from './name.ts';

export const renderExpr = (expr: IrTypeExpr, config: ApigenConfig): string =>
    renderExprAt(expr, false, config);

const renderExprAt = (expr: IrTypeExpr, needsParens: boolean, config: ApigenConfig): string => {
    switch (expr.kind) {
        case 'ref':
            return canonicalTypeName(expr.name, config);
        case 'string':
            return 'string';
        case 'integer':
        case 'number':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'null':
            return 'null';
        case 'unknown':
            return 'unknown';
        case 'literal':
            return renderLiteral(expr.value);
        case 'array':
            return `${renderExprAt(expr.items, true, config)}[]`;
        case 'record': {
            const wrapper = config.useUnsafeRecord ? 'UnsafeRecord' : 'Record';
            const key = renderExprAt(expr.key, false, config);
            const value = renderExprAt(expr.value, false, config);
            return `${wrapper}<${key}, ${value}>`;
        }
        case 'nullable': {
            const inner = renderExprAt(expr.inner, true, config);
            return needsParens ? `(${inner} | null)` : `${inner} | null`;
        }
        case 'union': {
            if (expr.members.length === 0) return 'never';
            if (expr.members.length === 1) return renderExprAt(expr.members[0]!, needsParens, config);
            const parts = expr.members.map(m => renderExprAt(m, true, config));
            const joined = parts.join(' | ');
            return needsParens ? `(${joined})` : joined;
        }
        case 'intersection': {
            if (expr.members.length === 0) return 'unknown';
            if (expr.members.length === 1) return renderExprAt(expr.members[0]!, needsParens, config);
            const parts = expr.members.map(m => renderExprAt(m, true, config));
            const joined = parts.join(' & ');
            return needsParens ? `(${joined})` : joined;
        }
        case 'object-inline':
            return renderInlineObject(expr.properties, expr.additionalProperties, config);
    }
};

const renderLiteral = (value: string | number | boolean): string => {
    if (typeof value === 'string') return quoteString(value);
    return String(value);
};

export const renderInlineObject = (
    properties: readonly IrProperty[],
    additionalProperties: IrTypeExpr | boolean,
    config: ApigenConfig,
): string => {
    if (properties.length === 0 && additionalProperties === true) {
        const wrapper = config.useUnsafeRecord ? 'UnsafeRecord' : 'Record';
        return `${wrapper}<string, unknown>`;
    }
    if (properties.length === 0 && additionalProperties === false) return 'Record<string, never>';

    const sorted = config.sortProperties ? sortByName(properties) : properties;
    const memberLines: string[] = [];
    for (const p of sorted) memberLines.push(renderPropertyLine(p, '    ', config));
    if (typeof additionalProperties !== 'boolean') {
        memberLines.push(`    [key: string]: ${renderExprAt(additionalProperties, false, config)};`);
    }
    return `{\n${memberLines.join('\n')}\n}`;
};

/**
 * Property line matching the current generator output: never `?:`; missing
 * `required` in swagger becomes `field: T | null`, JSDoc `@format` picked
 * from the underlying primitive.
 */
export const renderPropertyLine = (
    property: IrProperty,
    indent: string,
    config: ApigenConfig,
): string => {
    const type = ensureNullableForOptional(property.type, property.required);
    const doc = renderJsDocBlock(
        {
            ...(property.description ? { description: property.description } : {}),
            format: jsDocFormat(type),
            deprecated: property.deprecated,
        },
        indent,
    );
    const readonly = property.readOnly ? 'readonly ' : '';
    return `${doc}${indent}${readonly}${propKey(property.name)}: ${renderExpr(type, config)};`;
};

const ensureNullableForOptional = (expr: IrTypeExpr, required: boolean): IrTypeExpr => {
    if (required) return expr;
    if (expr.kind === 'nullable') return expr;
    return { kind: 'nullable', inner: expr };
};

const sortByName = <T extends { name: string }>(items: readonly T[]): readonly T[] =>
    [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export const indentBlock = (block: string, indent: string): string =>
    block
        .split('\n')
        .map(l => (l.length > 0 ? indent + l : l))
        .join('\n');
