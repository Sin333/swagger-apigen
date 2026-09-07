/**
 * Builds the IR from a parsed OpenAPI document.
 *
 *   1. Registers the set of known schema names (used by the ref resolver).
 *   2. Converts every top-level component schema into an `IrType`.
 *   3. Converts every path operation into an `IrEndpoint`.
 *   4. Reports broken `$ref` targets as diagnostics.
 */

import type { Diagnostic } from '../errors.ts';
import type {
    MediaTypeObject,
    OpenApiDocument,
    OperationObject,
    ParameterObject,
    SchemaAllOf,
    SchemaAnyOf,
    SchemaArray,
    SchemaEnum,
    SchemaNode,
    SchemaObject,
    SchemaOneOf,
    SchemaRef,
} from '../types.ts';
import type {
    IrDiscriminator,
    IrEndpoint,
    IrEndpointParameter,
    IrEnumMember,
    IrModel,
    IrProperty,
    IrRequestBody,
    IrResponse,
    IrType,
    IrTypeExpr,
    IrUnionVariant,
} from './types.ts';

const REF_PREFIX = '#/components/schemas/';

// ------------------------------ Public API --------------------------------

/**
 * Lower a parsed OpenAPI document into the emitter-friendly {@link IrModel}.
 *
 * Responsibilities:
 *   - Convert every `components.schemas` entry into an {@link IrType}.
 *   - Convert every operation into a flat {@link IrEndpoint}.
 *   - Report unresolved `$ref`s as diagnostics (no throwing).
 *   - Resolve discriminated-union variants to their concrete enum members
 *     so the emitter can render `Enum.Member` instead of raw string values.
 *
 * The returned model is pure data — no filesystem or template access.
 *
 * @param document Successfully parsed OpenAPI document.
 * @returns        Intermediate representation plus collected diagnostics.
 */
export const buildIr = (document: OpenApiDocument): IrModel => {
    const ctx = new IrContext(new Set(document.components.schemas.keys()));

    const types = new Map<string, IrType>();
    for (const [name, node] of document.components.schemas) {
        types.set(name, buildRootType(ctx, name, node));
    }

    // Second pass: now that all enum types are built, enrich discriminated
    // union variants with resolved enum members.
    resolveDiscriminatorEnumMembers(types);

    const endpoints: IrEndpoint[] = [];
    for (const [, path] of document.paths) {
        for (const [, op] of path.operations) {
            endpoints.push(buildEndpoint(ctx, op));
        }
    }

    return {
        types,
        endpoints,
        diagnostics: ctx.diagnostics,
        unresolvedRefs: ctx.unresolvedRefs,
    };
};

/**
 * Walks the built types map and, for every discriminated union whose
 * discriminator resolves to an enum, replaces each variant's `discriminatorValue`
 * with a strongly-typed `discriminatorEnumMember` pointing at the actual enum
 * member. Values that don't match any enum member fall through unchanged.
 */
const resolveDiscriminatorEnumMembers = (types: Map<string, IrType>): void => {
    for (const [name, type] of types) {
        if (type.kind !== 'union' || !type.discriminator?.enumTypeName) continue;
        const enumType = types.get(type.discriminator.enumTypeName);
        if (!enumType || enumType.kind !== 'enum') continue;

        // String-compare because mapping keys are strings and enum values may be numeric.
        const memberByValue = new Map<string, string>();
        for (const m of enumType.members) memberByValue.set(String(m.value), m.name);

        let changed = false;
        const enrichedVariants = type.variants.map(v => {
            if (!v.discriminatorValue) return v;
            const memberName = memberByValue.get(v.discriminatorValue);
            if (!memberName) return v;
            changed = true;
            return {
                ...v,
                discriminatorEnumMember: { typeName: enumType.name, memberName },
            };
        });

        if (changed) types.set(name, { ...type, variants: enrichedVariants });
    }
};

// ------------------------------- Context ---------------------------------

class IrContext {
    readonly diagnostics: Diagnostic[] = [];
    readonly unresolvedRefs: Set<string> = new Set();
    readonly knownSchemaNames: ReadonlySet<string>;

    constructor(knownSchemaNames: ReadonlySet<string>) {
        this.knownSchemaNames = knownSchemaNames;
    }

    unresolved(ref: string, pointer: string): void {
        if (!this.unresolvedRefs.has(ref)) {
            this.unresolvedRefs.add(ref);
            this.diagnostics.push({
                severity: 'error',
                pointer,
                message: `Unresolved $ref "${ref}" (not a defined schema, primitive, or NSwag wrapper)`,
            });
        }
    }
}

// ------------------------ Root-schema conversion --------------------------

const buildRootType = (ctx: IrContext, name: string, node: SchemaNode): IrType => {
    const base = { name, description: node.description, deprecated: node.deprecated };

    switch (node.kind) {
        case 'object':
            return buildRootObject(ctx, base, node);
        case 'enum':
            return buildRootEnum(base, node);
        case 'oneOf':
        case 'anyOf':
            return buildRootUnion(ctx, base, node);
        case 'allOf':
            return buildRootAllOf(ctx, base, node);
        case 'ref':
        case 'array':
        case 'string':
        case 'integer':
        case 'number':
        case 'boolean':
        case 'unknown':
            return { ...base, kind: 'alias', target: buildExpr(ctx, node) };
    }
};

const buildRootObject = (
    ctx: IrContext,
    base: { name: string; description?: string; deprecated: boolean },
    node: SchemaObject,
): IrType => ({
    ...base,
    kind: 'object',
    properties: buildProperties(ctx, node),
    additionalProperties: buildAdditionalProperties(ctx, node.additionalProperties),
    extends: [],
});

const buildRootEnum = (
    base: { name: string; description?: string; deprecated: boolean },
    node: SchemaEnum,
): IrType => ({
    ...base,
    kind: 'enum',
    base: node.base,
    members: buildEnumMembers(node),
});

const buildEnumMembers = (node: SchemaEnum): readonly IrEnumMember[] => {
    const memberNames = node.memberNames;
    return node.values.map((value, i) => {
        const provided = memberNames?.[i];
        return {
            name: provided ?? synthesizeEnumMemberName(value, node.base),
            value,
        };
    });
};

const synthesizeEnumMemberName = (
    value: string | number,
    base: 'string' | 'integer' | 'number',
): string => {
    if (base === 'string') {
        const s = String(value);
        return sanitizeIdent(s) || 'Value';
    }
    return `Value${value}`;
};

const sanitizeIdent = (raw: string): string => {
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
    if (out && /[0-9]/.test(out[0]!)) out = `_${out}`;
    return out;
};

const buildRootUnion = (
    ctx: IrContext,
    base: { name: string; description?: string; deprecated: boolean },
    node: SchemaOneOf | SchemaAnyOf,
): IrType => {
    const variants: IrUnionVariant[] = node.schemas.map(s => ({
        type: buildExpr(ctx, s),
    }));

    let discriminator: IrDiscriminator | undefined;
    if (node.discriminator) {
        const mapping = new Map<string, string>();
        for (const [k, v] of node.discriminator.mapping) {
            const refName = v.startsWith('#/components/schemas/')
                ? v.slice('#/components/schemas/'.length)
                : v;
            mapping.set(k, refName);
        }
        const enumTypeName = extractDiscriminatorEnumName(node.discriminatorPropertySchema);
        discriminator = {
            propertyName: node.discriminator.propertyName,
            mapping,
            ...(enumTypeName ? { enumTypeName } : {}),
        };
        // Attach discriminator values back to their variants for convenience.
        const withDiscriminator = variants.map((v): IrUnionVariant => {
            if (v.type.kind !== 'ref') return v;
            for (const [dv, target] of mapping) {
                if (target === v.type.name) return { ...v, discriminatorValue: dv };
            }
            return v;
        });
        return { ...base, kind: 'union', variants: withDiscriminator, discriminator };
    }
    return { ...base, kind: 'union', variants };
};

/**
 * When the discriminator property points at an enum (via `$ref`), return that
 * enum's original schema name so IR post-processing can look it up. Anything
 * else — inline enum, primitive, etc. — is not supported and returns `undefined`.
 */
const extractDiscriminatorEnumName = (schema: SchemaNode | undefined): string | undefined => {
    if (!schema || schema.kind !== 'ref') return undefined;
    return schema.refName;
};

/**
 * `allOf` at root has two flavors in the wild:
 *   - The C# "nullable-ref" idiom `allOf: [$ref], nullable: true` — flatten to
 *     a nullable alias.
 *   - Multi-branch composition — record base type names in `extends` and
 *     merge inline object shapes.
 */
const buildRootAllOf = (
    ctx: IrContext,
    base: { name: string; description?: string; deprecated: boolean },
    node: SchemaAllOf,
): IrType => {
    if (node.schemas.length === 1 && node.schemas[0]) {
        const inner = buildExpr(ctx, node.schemas[0]);
        return {
            ...base,
            kind: 'alias',
            target: node.nullable ? wrapNullable(inner) : inner,
        };
    }

    const extendsList: string[] = [];
    const inlineProps: IrProperty[] = [];
    let additionalProperties: IrTypeExpr | boolean = true;
    let sawInline = false;

    for (const branch of node.schemas) {
        if (branch.kind === 'ref') {
            extendsList.push(branch.refName);
        } else if (branch.kind === 'object') {
            sawInline = true;
            inlineProps.push(...buildProperties(ctx, branch));
            additionalProperties = buildAdditionalProperties(ctx, branch.additionalProperties);
        }
    }

    if (!sawInline && extendsList.length > 0) {
        // Pure refs — represent as intersection alias so the emitter is free
        // to render it as `A & B` or as an interface with `extends`.
        return {
            ...base,
            kind: 'alias',
            target: {
                kind: 'intersection',
                members: extendsList.map((n): IrTypeExpr => ({ kind: 'ref', name: n })),
            },
        };
    }

    return {
        ...base,
        kind: 'object',
        properties: inlineProps,
        additionalProperties,
        extends: extendsList,
    };
};

// ------------------------- Inline expression build ------------------------

const buildExpr = (ctx: IrContext, node: SchemaNode): IrTypeExpr => {
    switch (node.kind) {
        case 'ref':
            return buildRefExpr(ctx, node);
        case 'object':
            return applyNullable(node, buildObjectExpr(ctx, node));
        case 'array':
            return applyNullable(node, buildArrayExpr(ctx, node));
        case 'string':
            return applyNullable(node, {
                kind: 'string',
                ...(node.format ? { format: node.format } : {}),
            });
        case 'integer':
            return applyNullable(node, {
                kind: 'integer',
                ...(node.format ? { format: node.format } : {}),
            });
        case 'number':
            return applyNullable(node, {
                kind: 'number',
                ...(node.format ? { format: node.format } : {}),
            });
        case 'boolean':
            return applyNullable(node, { kind: 'boolean' });
        case 'enum':
            return applyNullable(node, buildEnumExpr(node));
        case 'allOf':
            return applyNullable(node, buildAllOfExpr(ctx, node));
        case 'oneOf':
        case 'anyOf':
            return applyNullable(node, buildUnionExpr(ctx, node));
        case 'unknown':
            return { kind: 'unknown' };
    }
};

const buildRefExpr = (ctx: IrContext, node: SchemaRef): IrTypeExpr => {
    const name = node.ref.startsWith(REF_PREFIX) ? node.ref.slice(REF_PREFIX.length) : node.ref;
    if (!ctx.knownSchemaNames.has(name)) {
        ctx.unresolved(node.ref, node.pointer);
        return { kind: 'unknown' };
    }
    return applyNullable(node, { kind: 'ref', name });
};

/**
 * `{ properties: {}, additionalProperties: <schema> }` is a dictionary in
 * disguise — emit as a `record` expression so the emitter renders `Record<>`.
 */
const buildObjectExpr = (ctx: IrContext, node: SchemaObject): IrTypeExpr => {
    if (node.properties.size === 0 && typeof node.additionalProperties !== 'boolean') {
        return {
            kind: 'record',
            key: { kind: 'string' },
            value: buildExpr(ctx, node.additionalProperties),
        };
    }
    return {
        kind: 'object-inline',
        properties: buildProperties(ctx, node),
        additionalProperties: buildAdditionalProperties(ctx, node.additionalProperties),
    };
};

const buildArrayExpr = (ctx: IrContext, node: SchemaArray): IrTypeExpr => ({
    kind: 'array',
    items: buildExpr(ctx, node.items),
});

const buildEnumExpr = (node: SchemaEnum): IrTypeExpr => {
    if (node.values.length === 1) {
        const only = node.values[0];
        if (only !== undefined) return { kind: 'literal', value: only };
    }
    return {
        kind: 'union',
        members: node.values.map((v): IrTypeExpr => ({ kind: 'literal', value: v })),
    };
};

const buildAllOfExpr = (ctx: IrContext, node: SchemaAllOf): IrTypeExpr => {
    if (node.schemas.length === 1 && node.schemas[0]) {
        return buildExpr(ctx, node.schemas[0]);
    }
    return {
        kind: 'intersection',
        members: node.schemas.map(s => buildExpr(ctx, s)),
    };
};

const buildUnionExpr = (ctx: IrContext, node: SchemaOneOf | SchemaAnyOf): IrTypeExpr => ({
    kind: 'union',
    members: node.schemas.map(s => buildExpr(ctx, s)),
});

// --------------------------- Object internals -----------------------------

const buildProperties = (ctx: IrContext, node: SchemaObject): readonly IrProperty[] => {
    const out: IrProperty[] = [];
    for (const [propName, propNode] of node.properties) {
        out.push({
            name: propName,
            type: buildExpr(ctx, propNode),
            required: node.required.has(propName),
            readOnly: propNode.readOnly,
            deprecated: propNode.deprecated,
            ...(propNode.description ? { description: propNode.description } : {}),
        });
    }
    return out;
};

const buildAdditionalProperties = (
    ctx: IrContext,
    ap: SchemaNode | boolean,
): IrTypeExpr | boolean => (typeof ap === 'boolean' ? ap : buildExpr(ctx, ap));

// ------------------------------- Nullable ---------------------------------

const applyNullable = (node: SchemaNode, expr: IrTypeExpr): IrTypeExpr =>
    node.nullable ? wrapNullable(expr) : expr;

const wrapNullable = (expr: IrTypeExpr): IrTypeExpr =>
    expr.kind === 'nullable' ? expr : { kind: 'nullable', inner: expr };

// ------------------------------ Endpoints --------------------------------

const buildEndpoint = (ctx: IrContext, op: OperationObject): IrEndpoint => {
    const pathParams: IrEndpointParameter[] = [];
    const queryParams: IrEndpointParameter[] = [];
    const headerParams: IrEndpointParameter[] = [];

    for (const p of op.parameters) {
        const dst =
            p.in === 'path' ? pathParams : p.in === 'query' ? queryParams : p.in === 'header' ? headerParams : null;
        if (!dst) continue; // cookie params — skip
        dst.push(toIrParameter(ctx, p));
    }

    return {
        ...(op.operationId ? { operationId: op.operationId } : {}),
        method: op.method,
        path: op.path,
        tag: op.tags[0] ?? 'default',
        ...(op.summary ? { summary: op.summary } : {}),
        ...(op.description ? { description: op.description } : {}),
        deprecated: op.deprecated,
        pathParams,
        queryParams,
        headerParams,
        ...(buildRequestBody(ctx, op) && { requestBody: buildRequestBody(ctx, op)! }),
        responses: buildResponses(ctx, op),
    };
};

const toIrParameter = (ctx: IrContext, p: ParameterObject): IrEndpointParameter => ({
    name: p.name,
    type: p.schema ? buildExpr(ctx, p.schema) : { kind: 'unknown' },
    required: p.required,
    ...(p.description ? { description: p.description } : {}),
});

const buildRequestBody = (ctx: IrContext, op: OperationObject): IrRequestBody | undefined => {
    if (!op.requestBody) return undefined;
    const media = pickJsonMediaType(op.requestBody.content);
    if (!media || !media.schema) return undefined;
    return {
        mediaType: media.mediaType,
        type: buildExpr(ctx, media.schema),
        required: op.requestBody.required,
    };
};

const buildResponses = (ctx: IrContext, op: OperationObject): readonly IrResponse[] => {
    const out: IrResponse[] = [];
    for (const [statusCode, r] of op.responses) {
        const media = pickJsonMediaType(r.content);
        out.push({
            statusCode,
            ...(media?.mediaType ? { mediaType: media.mediaType } : {}),
            ...(media?.schema ? { type: buildExpr(ctx, media.schema) } : {}),
            description: r.description,
        });
    }
    return out;
};

const JSON_MEDIA_PREFERENCE: readonly string[] = ['application/json', 'text/json', 'application/*+json'];

const pickJsonMediaType = (
    content: ReadonlyMap<string, MediaTypeObject>,
): MediaTypeObject | undefined => {
    for (const preferred of JSON_MEDIA_PREFERENCE) {
        const hit = content.get(preferred);
        if (hit) return hit;
    }
    for (const [, media] of content) {
        if (media.mediaType.includes('json')) return media;
    }
    // Fall back to the first available media type at all.
    for (const [, media] of content) return media;
    return undefined;
};
