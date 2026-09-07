import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';

import { joinPointer, ParseError, type Diagnostic } from './errors.ts';
import {
    HTTP_METHODS,
    type ComponentsObject,
    type DiscriminatorObject,
    type HttpMethod,
    type InfoObject,
    type JsonPointer,
    type MediaTypeObject,
    type OpenApiDocument,
    type OperationObject,
    type ParameterLocation,
    type ParameterObject,
    type PathItemObject,
    type PathsObject,
    type RequestBodyObject,
    type ResponseObject,
    type SchemaBase,
    type SchemaNode,
    type SecurityRequirement,
    type SecuritySchemeObject,
    type TagObject,
} from './types.ts';

/** Format of the source document. `auto` sniffs from the first non-whitespace char. */
export type OpenApiSourceFormat = 'json' | 'yaml' | 'auto';

/** Result of parsing a document. */
export type ParseResult = {
    readonly document: OpenApiDocument;
    readonly diagnostics: readonly Diagnostic[];
    /** All `$ref` strings observed, deduplicated. Useful for the IR phase. */
    readonly references: ReadonlySet<string>;
    /** Duration of parsing in milliseconds. */
    readonly durationMs: number;
    /** Which format the source turned out to be. */
    readonly format: 'json' | 'yaml';
};

const REF_PREFIX = '#/components/schemas/';

// ------------------------------ Public API --------------------------------

/** Parse OpenAPI JSON or YAML from a file path. Detects format from the extension. */
export const parseOpenApiFile = async (
    filePath: string,
    format: OpenApiSourceFormat = 'auto',
): Promise<ParseResult> => {
    const text = await readFile(filePath, 'utf8');
    const resolved = format === 'auto' ? detectFormatByPath(filePath) ?? 'auto' : format;
    return parseOpenApi(text, resolved);
};

/** Parse OpenAPI JSON or YAML from a raw text string. */
export const parseOpenApi = (
    rawText: string,
    format: OpenApiSourceFormat = 'auto',
): ParseResult => {
    const started = performance.now();

    const resolvedFormat = format === 'auto' ? detectFormatByContent(rawText) : format;

    let root: unknown;
    try {
        root = resolvedFormat === 'yaml' ? parseYaml(rawText) : JSON.parse(rawText);
    } catch (err) {
        throw new ParseError(
            `Invalid ${resolvedFormat.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!isRecord(root)) {
        throw new ParseError('Root must be an object', '');
    }

    const ctx = new ParseContext();
    const document = parseRoot(ctx, root);

    return {
        document,
        diagnostics: ctx.diagnostics,
        references: ctx.references,
        durationMs: performance.now() - started,
        format: resolvedFormat,
    };
};

const detectFormatByPath = (path: string): 'json' | 'yaml' | null => {
    const lower = path.toLowerCase();
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
    return null;
};

const detectFormatByContent = (text: string): 'json' | 'yaml' => {
    for (const ch of text) {
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
        return ch === '{' || ch === '[' ? 'json' : 'yaml';
    }
    return 'json';
};

// -------------------------- Parsing internals -----------------------------

class ParseContext {
    readonly diagnostics: Diagnostic[] = [];
    readonly references: Set<string> = new Set();

    error(pointer: JsonPointer, message: string): void {
        this.diagnostics.push({ severity: 'error', pointer, message });
    }

    warn(pointer: JsonPointer, message: string): void {
        this.diagnostics.push({ severity: 'warning', pointer, message });
    }
}

const parseRoot = (ctx: ParseContext, root: Record<string, unknown>): OpenApiDocument => {
    const openapi = readString(root, 'openapi');
    if (!openapi) {
        throw new ParseError('Missing required "openapi" version string', '');
    }
    if (!/^3\.[012]\./.test(openapi)) {
        throw new ParseError(
            `Unsupported OpenAPI version "${openapi}". Only 3.0.x, 3.1.x and 3.2.x are supported.`,
            '/openapi',
        );
    }
    if (openapi.startsWith('3.2.')) {
        ctx.warn(
            '/openapi',
            `OpenAPI 3.2 detected: schema-level parsing reuses the 3.1 code path; non-schema features (QUERY method, sessionCookie, path arrayItem style, etc.) are silently dropped.`,
        );
    }

    return {
        openapi,
        info: parseInfo(ctx, root['info']),
        paths: parsePaths(ctx, root['paths']),
        components: parseComponents(ctx, root['components']),
        security: parseSecurityRequirements(ctx, root['security'], '/security'),
        tags: parseTags(ctx, root['tags']),
    };
};

const parseInfo = (ctx: ParseContext, raw: unknown): InfoObject => {
    if (!isRecord(raw)) {
        ctx.error('/info', 'Missing or non-object "info"');
        return { title: '', version: '' };
    }
    return {
        title: readString(raw, 'title') ?? '',
        version: readString(raw, 'version') ?? '',
        description: readString(raw, 'description'),
    };
};

const parseTags = (ctx: ParseContext, raw: unknown): readonly TagObject[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        ctx.error('/tags', '"tags" must be an array');
        return [];
    }
    const out: TagObject[] = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (!isRecord(item)) {
            ctx.error(joinPointer('/tags', i), 'Tag must be an object');
            continue;
        }
        const name = readString(item, 'name');
        if (!name) {
            ctx.error(joinPointer('/tags', i), 'Tag is missing "name"');
            continue;
        }
        out.push({ name, description: readString(item, 'description') });
    }
    return out;
};

// ------------------------------- Paths ------------------------------------

const parsePaths = (ctx: ParseContext, raw: unknown): PathsObject => {
    const paths = new Map<string, PathItemObject>();
    if (raw === undefined) {
        ctx.error('/paths', 'Missing "paths"');
        return paths;
    }
    if (!isRecord(raw)) {
        ctx.error('/paths', '"paths" must be an object');
        return paths;
    }
    for (const [path, item] of Object.entries(raw)) {
        const pointer = joinPointer('/paths', path);
        if (!isRecord(item)) {
            ctx.error(pointer, 'Path item must be an object');
            continue;
        }
        paths.set(path, parsePathItem(ctx, path, item, pointer));
    }
    return paths;
};

const parsePathItem = (
    ctx: ParseContext,
    path: string,
    raw: Record<string, unknown>,
    pointer: JsonPointer,
): PathItemObject => {
    const sharedParams = parseParameters(ctx, raw['parameters'], joinPointer(pointer, 'parameters'));
    const operations = new Map<HttpMethod, OperationObject>();

    for (const method of HTTP_METHODS) {
        const op = raw[method];
        if (op === undefined) continue;
        const opPointer = joinPointer(pointer, method);
        if (!isRecord(op)) {
            ctx.error(opPointer, `Operation "${method}" must be an object`);
            continue;
        }
        operations.set(method, parseOperation(ctx, method, path, op, opPointer, sharedParams));
    }

    return { pointer, path, operations, parameters: sharedParams };
};

const parseOperation = (
    ctx: ParseContext,
    method: HttpMethod,
    path: string,
    raw: Record<string, unknown>,
    pointer: JsonPointer,
    inheritedParameters: readonly ParameterObject[],
): OperationObject => {
    const localParams = parseParameters(ctx, raw['parameters'], joinPointer(pointer, 'parameters'));

    return {
        pointer,
        method,
        path,
        operationId: readString(raw, 'operationId'),
        summary: readString(raw, 'summary'),
        description: readString(raw, 'description'),
        tags: readStringArray(raw, 'tags'),
        parameters: mergeParameters(inheritedParameters, localParams),
        requestBody: parseRequestBody(ctx, raw['requestBody'], joinPointer(pointer, 'requestBody')),
        responses: parseResponses(ctx, raw['responses'], joinPointer(pointer, 'responses')),
        deprecated: readBoolean(raw, 'deprecated') ?? false,
    };
};

/**
 * OpenAPI 3.0: an operation-level parameter with the same `(name, in)` as a
 * path-level parameter overrides it.
 */
const mergeParameters = (
    inherited: readonly ParameterObject[],
    local: readonly ParameterObject[],
): readonly ParameterObject[] => {
    if (inherited.length === 0) return local;
    if (local.length === 0) return inherited;
    const key = (p: ParameterObject) => `${p.in}:${p.name}`;
    const localKeys = new Set(local.map(key));
    return [...inherited.filter(p => !localKeys.has(key(p))), ...local];
};

// ---------------------------- Parameters ----------------------------------

const VALID_PARAM_LOCATIONS: ReadonlySet<string> = new Set(['query', 'header', 'path', 'cookie']);

const parseParameters = (
    ctx: ParseContext,
    raw: unknown,
    pointer: JsonPointer,
): readonly ParameterObject[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        ctx.error(pointer, 'Parameters must be an array');
        return [];
    }
    const out: ParameterObject[] = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        const itemPointer = joinPointer(pointer, i);
        if (!isRecord(item)) {
            ctx.error(itemPointer, 'Parameter must be an object');
            continue;
        }
        const name = readString(item, 'name');
        const location = readString(item, 'in');
        if (!name) {
            ctx.error(itemPointer, 'Parameter is missing "name"');
            continue;
        }
        if (!location || !VALID_PARAM_LOCATIONS.has(location)) {
            ctx.error(itemPointer, `Parameter "${name}" has invalid "in": ${location ?? '<missing>'}`);
            continue;
        }
        out.push({
            pointer: itemPointer,
            name,
            in: location as ParameterLocation,
            required: readBoolean(item, 'required') ?? location === 'path',
            deprecated: readBoolean(item, 'deprecated') ?? false,
            schema:
                'schema' in item
                    ? parseSchema(ctx, item['schema'], joinPointer(itemPointer, 'schema'))
                    : undefined,
            description: readString(item, 'description'),
        });
    }
    return out;
};

const parseRequestBody = (
    ctx: ParseContext,
    raw: unknown,
    pointer: JsonPointer,
): RequestBodyObject | undefined => {
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) {
        ctx.error(pointer, 'requestBody must be an object');
        return undefined;
    }
    return {
        pointer,
        required: readBoolean(raw, 'required') ?? false,
        description: readString(raw, 'description'),
        content: parseContent(ctx, raw['content'], joinPointer(pointer, 'content')),
    };
};

const parseResponses = (
    ctx: ParseContext,
    raw: unknown,
    pointer: JsonPointer,
): ReadonlyMap<string, ResponseObject> => {
    const out = new Map<string, ResponseObject>();
    if (raw === undefined) {
        ctx.warn(pointer, 'Operation has no "responses"');
        return out;
    }
    if (!isRecord(raw)) {
        ctx.error(pointer, '"responses" must be an object');
        return out;
    }
    for (const [statusCode, item] of Object.entries(raw)) {
        const itemPointer = joinPointer(pointer, statusCode);
        if (!isRecord(item)) {
            ctx.error(itemPointer, 'Response must be an object');
            continue;
        }
        out.set(statusCode, {
            pointer: itemPointer,
            statusCode,
            description: readString(item, 'description') ?? '',
            content: parseContent(ctx, item['content'], joinPointer(itemPointer, 'content')),
        });
    }
    return out;
};

const parseContent = (
    ctx: ParseContext,
    raw: unknown,
    pointer: JsonPointer,
): ReadonlyMap<string, MediaTypeObject> => {
    const out = new Map<string, MediaTypeObject>();
    if (raw === undefined) return out;
    if (!isRecord(raw)) {
        ctx.error(pointer, '"content" must be an object');
        return out;
    }
    for (const [mediaType, item] of Object.entries(raw)) {
        const itemPointer = joinPointer(pointer, mediaType);
        if (!isRecord(item)) {
            ctx.error(itemPointer, 'Media type entry must be an object');
            continue;
        }
        out.set(mediaType, {
            pointer: itemPointer,
            mediaType,
            schema:
                'schema' in item
                    ? parseSchema(ctx, item['schema'], joinPointer(itemPointer, 'schema'))
                    : undefined,
        });
    }
    return out;
};

// ---------------------------- Components ----------------------------------

const parseComponents = (ctx: ParseContext, raw: unknown): ComponentsObject => {
    const schemas = new Map<string, SchemaNode>();
    const securitySchemes = new Map<string, SecuritySchemeObject>();

    if (raw === undefined) {
        return { schemas, securitySchemes };
    }
    if (!isRecord(raw)) {
        ctx.error('/components', '"components" must be an object');
        return { schemas, securitySchemes };
    }

    if (isRecord(raw['schemas'])) {
        for (const [name, schemaRaw] of Object.entries(raw['schemas'])) {
            const pointer = joinPointer('/components/schemas', name);
            schemas.set(name, parseSchema(ctx, schemaRaw, pointer));
        }
    } else if (raw['schemas'] !== undefined) {
        ctx.error('/components/schemas', '"schemas" must be an object');
    }

    if (isRecord(raw['securitySchemes'])) {
        for (const [name, schemeRaw] of Object.entries(raw['securitySchemes'])) {
            const pointer = joinPointer('/components/securitySchemes', name);
            if (!isRecord(schemeRaw)) {
                ctx.error(pointer, 'Security scheme must be an object');
                continue;
            }
            const type = readString(schemeRaw, 'type');
            if (!type) {
                ctx.error(pointer, 'Security scheme is missing "type"');
                continue;
            }
            securitySchemes.set(name, {
                pointer,
                type,
                scheme: readString(schemeRaw, 'scheme'),
                bearerFormat: readString(schemeRaw, 'bearerFormat'),
                name: readString(schemeRaw, 'name'),
                in: readString(schemeRaw, 'in'),
                description: readString(schemeRaw, 'description'),
            });
        }
    }

    return { schemas, securitySchemes };
};

const parseSecurityRequirements = (
    ctx: ParseContext,
    raw: unknown,
    pointer: JsonPointer,
): readonly SecurityRequirement[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        ctx.error(pointer, '"security" must be an array');
        return [];
    }
    const out: SecurityRequirement[] = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        const itemPointer = joinPointer(pointer, i);
        if (!isRecord(item)) {
            ctx.error(itemPointer, 'Security requirement must be an object');
            continue;
        }
        const req = new Map<string, readonly string[]>();
        for (const [name, scopes] of Object.entries(item)) {
            req.set(name, Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : []);
        }
        out.push(req);
    }
    return out;
};

// ------------------------------ Schemas -----------------------------------

const parseSchema = (ctx: ParseContext, raw: unknown, pointer: JsonPointer): SchemaNode => {
    if (!isRecord(raw)) {
        ctx.error(pointer, 'Schema must be an object');
        return makeUnknown(pointer, {});
    }

    // OpenAPI 3.1: `type` may be an array of strings including `"null"`. Fold
    // that into a single primitive + nullable flag so downstream code stays
    // 3.0-shaped.
    const { typeString, nullableFromTypeArray } = readSchemaType(ctx, raw, pointer);
    const nullable = (readBoolean(raw, 'nullable') ?? false) || nullableFromTypeArray;

    const base = parseSchemaBase(raw, pointer, nullable);

    // $ref — everything else is ignored per OpenAPI 3.0
    if (typeof raw['$ref'] === 'string') {
        const ref = raw['$ref'];
        ctx.references.add(ref);
        return {
            ...base,
            kind: 'ref',
            ref,
            refName: ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref,
        };
    }

    // Composition keywords take precedence over `type`
    if (Array.isArray(raw['allOf'])) {
        const discriminator = parseDiscriminator(
            ctx,
            raw['discriminator'],
            joinPointer(pointer, 'discriminator'),
        );
        return {
            ...base,
            kind: 'allOf',
            schemas: parseSchemaList(ctx, raw['allOf'], joinPointer(pointer, 'allOf')),
            ...(discriminator ? { discriminator } : {}),
            ...extractDiscriminatorPropertySchema(ctx, raw, discriminator, pointer),
        };
    }
    if (Array.isArray(raw['oneOf'])) {
        const discriminator = parseDiscriminator(
            ctx,
            raw['discriminator'],
            joinPointer(pointer, 'discriminator'),
        );
        return {
            ...base,
            kind: 'oneOf',
            schemas: parseSchemaList(ctx, raw['oneOf'], joinPointer(pointer, 'oneOf')),
            ...(discriminator ? { discriminator } : {}),
            ...extractDiscriminatorPropertySchema(ctx, raw, discriminator, pointer),
        };
    }
    if (Array.isArray(raw['anyOf'])) {
        const discriminator = parseDiscriminator(
            ctx,
            raw['discriminator'],
            joinPointer(pointer, 'discriminator'),
        );
        return {
            ...base,
            kind: 'anyOf',
            schemas: parseSchemaList(ctx, raw['anyOf'], joinPointer(pointer, 'anyOf')),
            ...(discriminator ? { discriminator } : {}),
            ...extractDiscriminatorPropertySchema(ctx, raw, discriminator, pointer),
        };
    }

    const type = typeString;

    // Enum can be attached to any primitive base — always handle it first.
    if (Array.isArray(raw['enum'])) {
        return parseEnum(ctx, raw, pointer, base, type);
    }

    switch (type) {
        case 'object':
        case undefined:
            return parseObject(ctx, raw, pointer, base);
        case 'array':
            return parseArray(ctx, raw, pointer, base);
        case 'string':
            return {
                ...base,
                kind: 'string',
                format: readString(raw, 'format'),
                pattern: readString(raw, 'pattern'),
                minLength: readNumber(raw, 'minLength'),
                maxLength: readNumber(raw, 'maxLength'),
            };
        case 'integer':
            return {
                ...base,
                kind: 'integer',
                format: readString(raw, 'format'),
                minimum: readNumber(raw, 'minimum'),
                maximum: readNumber(raw, 'maximum'),
            };
        case 'number':
            return {
                ...base,
                kind: 'number',
                format: readString(raw, 'format'),
                minimum: readNumber(raw, 'minimum'),
                maximum: readNumber(raw, 'maximum'),
            };
        case 'boolean':
            return { ...base, kind: 'boolean' };
        default:
            ctx.warn(pointer, `Unknown schema type "${type}"`);
            return makeUnknown(pointer, base);
    }
};

const parseSchemaBase = (
    raw: Record<string, unknown>,
    pointer: JsonPointer,
    nullable: boolean,
): SchemaBase => ({
    pointer,
    title: readString(raw, 'title'),
    description: readString(raw, 'description'),
    nullable,
    deprecated: readBoolean(raw, 'deprecated') ?? false,
    readOnly: readBoolean(raw, 'readOnly') ?? false,
    writeOnly: readBoolean(raw, 'writeOnly') ?? false,
});

type ReadSchemaType = {
    readonly typeString: string | undefined;
    readonly nullableFromTypeArray: boolean;
};

const readSchemaType = (
    ctx: ParseContext,
    raw: Record<string, unknown>,
    pointer: JsonPointer,
): ReadSchemaType => {
    const type = raw['type'];
    if (typeof type === 'string') return { typeString: type, nullableFromTypeArray: false };
    if (!Array.isArray(type)) return { typeString: undefined, nullableFromTypeArray: false };

    const strings = type.filter((t): t is string => typeof t === 'string');
    const hasNull = strings.includes('null');
    const nonNull = strings.filter(t => t !== 'null');

    if (nonNull.length === 1) return { typeString: nonNull[0], nullableFromTypeArray: hasNull };
    if (nonNull.length === 0) return { typeString: undefined, nullableFromTypeArray: hasNull };

    ctx.warn(
        pointer,
        `OpenAPI 3.1 type union [${strings.join(', ')}] is not supported; falling back to unknown`,
    );
    return { typeString: undefined, nullableFromTypeArray: hasNull };
};

const parseSchemaList = (
    ctx: ParseContext,
    raw: readonly unknown[],
    pointer: JsonPointer,
): readonly SchemaNode[] => {
    const out: SchemaNode[] = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        out[i] = parseSchema(ctx, raw[i], joinPointer(pointer, i));
    }
    return out;
};

const parseObject = (
    ctx: ParseContext,
    raw: Record<string, unknown>,
    pointer: JsonPointer,
    base: SchemaBase,
): SchemaNode => {
    const properties = new Map<string, SchemaNode>();
    if (isRecord(raw['properties'])) {
        const propsPointer = joinPointer(pointer, 'properties');
        for (const [name, propRaw] of Object.entries(raw['properties'])) {
            properties.set(name, parseSchema(ctx, propRaw, joinPointer(propsPointer, name)));
        }
    } else if (raw['properties'] !== undefined) {
        ctx.error(joinPointer(pointer, 'properties'), '"properties" must be an object');
    }

    const required = new Set<string>();
    if (Array.isArray(raw['required'])) {
        for (const r of raw['required']) {
            if (typeof r === 'string') required.add(r);
        }
    }

    let additionalProperties: SchemaNode | boolean;
    const ap = raw['additionalProperties'];
    if (ap === undefined || ap === true) {
        additionalProperties = true;
    } else if (ap === false) {
        additionalProperties = false;
    } else {
        additionalProperties = parseSchema(ctx, ap, joinPointer(pointer, 'additionalProperties'));
    }

    return {
        ...base,
        kind: 'object',
        properties,
        required,
        additionalProperties,
        discriminator: parseDiscriminator(ctx, raw['discriminator'], joinPointer(pointer, 'discriminator')),
    };
};

const parseArray = (
    ctx: ParseContext,
    raw: Record<string, unknown>,
    pointer: JsonPointer,
    base: SchemaBase,
): SchemaNode => {
    if (raw['items'] === undefined) {
        ctx.error(pointer, 'Array schema is missing "items"');
    }
    return {
        ...base,
        kind: 'array',
        items: parseSchema(ctx, raw['items'], joinPointer(pointer, 'items')),
        minItems: readNumber(raw, 'minItems'),
        maxItems: readNumber(raw, 'maxItems'),
        uniqueItems: readBoolean(raw, 'uniqueItems') ?? false,
    };
};

const parseEnum = (
    ctx: ParseContext,
    raw: Record<string, unknown>,
    pointer: JsonPointer,
    base: SchemaBase,
    type: string | undefined,
): SchemaNode => {
    const values: (string | number)[] = [];
    const enumPointer = joinPointer(pointer, 'enum');
    const enumRaw = raw['enum'] as readonly unknown[];
    for (let i = 0; i < enumRaw.length; i++) {
        const v = enumRaw[i];
        if (typeof v === 'string' || typeof v === 'number') {
            values.push(v);
        } else {
            ctx.error(joinPointer(enumPointer, i), 'Enum values must be string or number');
        }
    }

    let baseType: 'string' | 'integer' | 'number';
    if (type === 'string' || type === 'integer' || type === 'number') {
        baseType = type;
    } else if (values.every(v => typeof v === 'number' && Number.isInteger(v))) {
        baseType = 'integer';
    } else if (values.every(v => typeof v === 'number')) {
        baseType = 'number';
    } else {
        baseType = 'string';
    }

    // NSwag-style extension carrying enum member identifiers.
    const memberNames = readStringArrayOrUndefined(raw, 'x-enumNames');

    return {
        ...base,
        kind: 'enum',
        base: baseType,
        values,
        memberNames,
        format: readString(raw, 'format'),
    };
};

const parseDiscriminator = (
    ctx: ParseContext,
    raw: unknown,
    pointer: JsonPointer,
): DiscriminatorObject | undefined => {
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) {
        ctx.error(pointer, 'Discriminator must be an object');
        return undefined;
    }
    const propertyName = readString(raw, 'propertyName');
    if (!propertyName) {
        ctx.error(pointer, 'Discriminator is missing "propertyName"');
        return undefined;
    }
    const mapping = new Map<string, string>();
    if (isRecord(raw['mapping'])) {
        for (const [k, v] of Object.entries(raw['mapping'])) {
            if (typeof v === 'string') mapping.set(k, v);
        }
    }
    return { propertyName, mapping };
};

/**
 * When the parent schema declares `properties[discriminator.propertyName]`,
 * parse and return it under `discriminatorPropertySchema`. Downstream this lets
 * the IR resolve the discriminator against an enum type instead of falling back
 * to raw string literals.
 */
const extractDiscriminatorPropertySchema = (
    ctx: ParseContext,
    raw: Record<string, unknown>,
    discriminator: DiscriminatorObject | undefined,
    pointer: JsonPointer,
): { discriminatorPropertySchema?: SchemaNode } => {
    if (!discriminator) return {};
    const properties = raw['properties'];
    if (!isRecord(properties)) return {};
    const propRaw = properties[discriminator.propertyName];
    if (propRaw === undefined) return {};
    const propPointer = joinPointer(pointer, 'properties', discriminator.propertyName);
    return { discriminatorPropertySchema: parseSchema(ctx, propRaw, propPointer) };
};

const makeUnknown = (pointer: JsonPointer, base: Partial<SchemaBase>): SchemaNode => ({
    pointer,
    title: base.title,
    description: base.description,
    nullable: base.nullable ?? false,
    deprecated: base.deprecated ?? false,
    readOnly: base.readOnly ?? false,
    writeOnly: base.writeOnly ?? false,
    kind: 'unknown',
});

// ------------------------------- Helpers ----------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const readString = (obj: Record<string, unknown>, key: string): string | undefined => {
    const v = obj[key];
    return typeof v === 'string' ? v : undefined;
};

const readBoolean = (obj: Record<string, unknown>, key: string): boolean | undefined => {
    const v = obj[key];
    return typeof v === 'boolean' ? v : undefined;
};

const readNumber = (obj: Record<string, unknown>, key: string): number | undefined => {
    const v = obj[key];
    return typeof v === 'number' ? v : undefined;
};

const readStringArray = (obj: Record<string, unknown>, key: string): readonly string[] => {
    const v = obj[key];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
};

const readStringArrayOrUndefined = (
    obj: Record<string, unknown>,
    key: string,
): readonly string[] | undefined => {
    const v = obj[key];
    if (!Array.isArray(v)) return undefined;
    return v.filter((x): x is string => typeof x === 'string');
};
