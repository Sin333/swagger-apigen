/**
 * Render a named `IrType` as a top-level TypeScript declaration.
 *
 * Matches the current generator output:
 *   - all fields required, `| null` in place of `?:`
 *   - integer-based enums get a `/** @format int32 *\/` JSDoc
 *   - properties sorted alphabetically (config-controlled)
 */

import type { ApigenConfig } from '../config.ts';
import type { IrType, IrUnionVariant } from '../ir/types.ts';
import { renderExpr, renderInlineObject, renderPropertyLine } from './expr.ts';
import { renderJsDocBlock } from './format.ts';
import { isSafeIdent, propKey, quoteString } from './ident.ts';
import { canonicalTypeName } from './name.ts';

export const renderType = (type: IrType, config: ApigenConfig): string => {
    const doc = renderJsDocBlock({
        ...(type.description ? { description: type.description } : {}),
        deprecated: type.deprecated,
    });
    return doc + renderTypeBody(type, config);
};

const renderTypeBody = (type: IrType, config: ApigenConfig): string => {
    switch (type.kind) {
        case 'object':
            return renderObjectDecl(type, config);
        case 'enum':
            return renderEnumDecl(type, config);
        case 'union':
            return renderUnionDecl(type, config);
        case 'alias':
            return `export type ${canonicalTypeName(type.name, config)} = ${renderExpr(type.target, config)};\n`;
    }
};

const renderObjectDecl = (
    type: Extract<IrType, { kind: 'object' }>,
    config: ApigenConfig,
): string => {
    const name = canonicalTypeName(type.name, config);
    const body = renderInlineObject(type.properties, type.additionalProperties, config);

    if (config.useInterface) {
        return renderObjectAsInterface(type, config, name, body);
    }
    return renderObjectAsTypeAlias(type, config, name, body);
};

const renderObjectAsTypeAlias = (
    type: Extract<IrType, { kind: 'object' }>,
    config: ApigenConfig,
    name: string,
    body: string,
): string => {
    if (type.extends.length === 0) {
        return `export type ${name} = ${body};\n`;
    }
    const bases = type.extends.map(e => canonicalTypeName(e, config)).join(' & ');
    if (type.properties.length === 0 && type.additionalProperties === true) {
        return `export type ${name} = ${bases};\n`;
    }
    return `export type ${name} = ${bases} & ${body};\n`;
};

const renderObjectAsInterface = (
    type: Extract<IrType, { kind: 'object' }>,
    config: ApigenConfig,
    name: string,
    body: string,
): string => {
    const extendsClause =
        type.extends.length > 0
            ? ` extends ${type.extends.map(e => canonicalTypeName(e, config)).join(', ')}`
            : '';
    // Interface body reuses the inline object rendering; strip the outer braces
    // so we can add our own `{ … }` framing appropriate to `interface`.
    const inner = body.startsWith('{') && body.endsWith('}') ? body.slice(1, -1) : ` ${body}`;
    return `export interface ${name}${extendsClause} {${inner}}\n`;
};

const renderEnumDecl = (
    type: Extract<IrType, { kind: 'enum' }>,
    config: ApigenConfig,
): string => {
    const name = canonicalTypeName(type.name, config);
    if (type.members.length === 0) {
        return `export type ${name} = never;\n`;
    }

    const jsDocBlock = type.base === 'integer' ? '/** @format int32 */\n' : '';

    const hasProperNames = type.members.every(m => isSafeIdent(m.name));
    if (hasProperNames) {
        const lines = type.members.map(m => {
            const value = typeof m.value === 'string' ? quoteString(m.value) : String(m.value);
            return `    ${m.name} = ${value},`;
        });
        return `${jsDocBlock}export enum ${name} {\n${lines.join('\n')}\n}\n`;
    }

    const literals = type.members.map(m =>
        typeof m.value === 'string' ? quoteString(m.value) : String(m.value),
    );
    return `${jsDocBlock}export type ${name} = ${literals.join(' | ')};\n`;
};

const renderUnionDecl = (
    type: Extract<IrType, { kind: 'union' }>,
    config: ApigenConfig,
): string => {
    const name = canonicalTypeName(type.name, config);
    if (type.variants.length === 0) return `export type ${name} = never;\n`;
    if (!type.discriminator) {
        const members = type.variants.map(v => renderExpr(v.type, config)).join(' | ');
        return `export type ${name} = ${members};\n`;
    }

    const key = propKey(type.discriminator.propertyName);
    const parts = type.variants.map(v => {
        const base = renderExpr(v.type, config);
        const discriminatorExpr = renderDiscriminatorTag(v, config);
        return discriminatorExpr !== undefined ? `(${base} & { ${key}: ${discriminatorExpr} })` : base;
    });
    return `export type ${name} =\n${parts.map(p => `    | ${p}`).join('\n')};\n`;
};

/**
 * The discriminator tag expression for a union variant.
 *   - When the discriminator points at an enum, produce `EnumName.MemberName`
 *     so consumers narrow via typed enum symbols.
 *   - Otherwise fall back to the raw string literal from the OpenAPI mapping.
 *   - When no discriminator value is attached, return `undefined` — caller emits
 *     the variant bare.
 */
const renderDiscriminatorTag = (
    variant: IrUnionVariant,
    config: ApigenConfig,
): string | undefined => {
    if (variant.discriminatorEnumMember) {
        return `${canonicalTypeName(variant.discriminatorEnumMember.typeName, config)}.${variant.discriminatorEnumMember.memberName}`;
    }
    if (variant.discriminatorValue !== undefined) return quoteString(variant.discriminatorValue);
    return undefined;
};

export { renderPropertyLine };
