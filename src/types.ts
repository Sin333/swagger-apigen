/**
 * Typed OpenAPI 3.0 AST.
 *
 * Kept close to the spec shape (not normalized into an IR yet) so it can serve
 * as a faithful in-memory representation of a parsed document. Downstream
 * passes (dependency graph, name canonicalization, TS emit) live elsewhere.
 *
 * Only fields we actually observe in the Denver/Nerdio swagger are typed;
 * unknown extensions are preserved on `extensions` (`x-*`) where useful.
 */

/** JSON pointer to a node inside the source document (RFC 6901). */
export type JsonPointer = string;

/** Root document. */
export type OpenApiDocument = {
    readonly openapi: string;
    readonly info: InfoObject;
    readonly paths: PathsObject;
    readonly components: ComponentsObject;
    readonly security: readonly SecurityRequirement[];
    readonly tags: readonly TagObject[];
};

export type InfoObject = {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
};

export type TagObject = {
    readonly name: string;
    readonly description?: string;
};

// ------------------------------- Paths ------------------------------------

export type PathsObject = ReadonlyMap<string, PathItemObject>;

export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';

export const HTTP_METHODS: readonly HttpMethod[] = [
    'get',
    'put',
    'post',
    'delete',
    'options',
    'head',
    'patch',
    'trace',
];

export type PathItemObject = {
    readonly pointer: JsonPointer;
    readonly path: string;
    readonly operations: ReadonlyMap<HttpMethod, OperationObject>;
    readonly parameters: readonly ParameterObject[];
};

export type OperationObject = {
    readonly pointer: JsonPointer;
    readonly method: HttpMethod;
    readonly path: string;
    readonly operationId?: string;
    readonly summary?: string;
    readonly description?: string;
    readonly tags: readonly string[];
    readonly parameters: readonly ParameterObject[];
    readonly requestBody?: RequestBodyObject;
    readonly responses: ReadonlyMap<string, ResponseObject>;
    readonly deprecated: boolean;
};

// ---------------------------- Parameters ----------------------------------

export type ParameterLocation = 'query' | 'header' | 'path' | 'cookie';

export type ParameterObject = {
    readonly pointer: JsonPointer;
    readonly name: string;
    readonly in: ParameterLocation;
    readonly required: boolean;
    readonly deprecated: boolean;
    readonly schema?: SchemaNode;
    readonly description?: string;
};

export type RequestBodyObject = {
    readonly pointer: JsonPointer;
    readonly required: boolean;
    readonly description?: string;
    readonly content: ReadonlyMap<string, MediaTypeObject>;
};

export type ResponseObject = {
    readonly pointer: JsonPointer;
    readonly statusCode: string;
    readonly description: string;
    readonly content: ReadonlyMap<string, MediaTypeObject>;
};

export type MediaTypeObject = {
    readonly pointer: JsonPointer;
    readonly mediaType: string;
    readonly schema?: SchemaNode;
};

// ---------------------------- Components ----------------------------------

export type ComponentsObject = {
    readonly schemas: ReadonlyMap<string, SchemaNode>;
    readonly securitySchemes: ReadonlyMap<string, SecuritySchemeObject>;
};

export type SecuritySchemeObject = {
    readonly pointer: JsonPointer;
    readonly type: string;
    readonly scheme?: string;
    readonly bearerFormat?: string;
    readonly name?: string;
    readonly in?: string;
    readonly description?: string;
};

export type SecurityRequirement = ReadonlyMap<string, readonly string[]>;

// ----------------------------- Schemas ------------------------------------

/**
 * Discriminated union covering every schema shape observed in the source
 * swagger. `kind` is a synthetic tag we assign during parsing; the spec has
 * no such field — it's the union of `type`, presence of `enum`, and presence
 * of `$ref`/`allOf`/`oneOf`/`anyOf`.
 */
export type SchemaNode =
    | SchemaRef
    | SchemaObject
    | SchemaArray
    | SchemaString
    | SchemaInteger
    | SchemaNumber
    | SchemaBoolean
    | SchemaEnum
    | SchemaAllOf
    | SchemaOneOf
    | SchemaAnyOf
    | SchemaUnknown;

export type SchemaBase = {
    readonly pointer: JsonPointer;
    readonly title?: string;
    readonly description?: string;
    readonly nullable: boolean;
    readonly deprecated: boolean;
    readonly readOnly: boolean;
    readonly writeOnly: boolean;
};

export type SchemaRef = SchemaBase & {
    readonly kind: 'ref';
    readonly ref: string;
    readonly refName: string;
};

export type SchemaObject = SchemaBase & {
    readonly kind: 'object';
    readonly properties: ReadonlyMap<string, SchemaNode>;
    readonly required: ReadonlySet<string>;
    readonly additionalProperties: SchemaNode | boolean;
    readonly discriminator?: DiscriminatorObject;
};

export type SchemaArray = SchemaBase & {
    readonly kind: 'array';
    readonly items: SchemaNode;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly uniqueItems: boolean;
};

export type SchemaString = SchemaBase & {
    readonly kind: 'string';
    readonly format?: string;
    readonly pattern?: string;
    readonly minLength?: number;
    readonly maxLength?: number;
};

export type SchemaInteger = SchemaBase & {
    readonly kind: 'integer';
    readonly format?: 'int32' | 'int64' | string;
    readonly minimum?: number;
    readonly maximum?: number;
};

export type SchemaNumber = SchemaBase & {
    readonly kind: 'number';
    readonly format?: 'float' | 'double' | string;
    readonly minimum?: number;
    readonly maximum?: number;
};

export type SchemaBoolean = SchemaBase & {
    readonly kind: 'boolean';
};

export type SchemaEnum = SchemaBase & {
    readonly kind: 'enum';
    readonly base: 'string' | 'integer' | 'number';
    readonly values: readonly (string | number)[];
    readonly memberNames?: readonly string[];
    readonly format?: string;
};

export type SchemaAllOf = SchemaBase & {
    readonly kind: 'allOf';
    readonly schemas: readonly SchemaNode[];
    readonly discriminator?: DiscriminatorObject;
    readonly discriminatorPropertySchema?: SchemaNode;
};

export type SchemaOneOf = SchemaBase & {
    readonly kind: 'oneOf';
    readonly schemas: readonly SchemaNode[];
    readonly discriminator?: DiscriminatorObject;
    /**
     * Schema of the discriminator property from the parent `properties[propertyName]`.
     * Used downstream to resolve the discriminator to an enum member.
     */
    readonly discriminatorPropertySchema?: SchemaNode;
};

export type SchemaAnyOf = SchemaBase & {
    readonly kind: 'anyOf';
    readonly schemas: readonly SchemaNode[];
    readonly discriminator?: DiscriminatorObject;
    readonly discriminatorPropertySchema?: SchemaNode;
};

/** Escape hatch for schemas the parser could not classify (e.g. `{}`). */
export type SchemaUnknown = SchemaBase & {
    readonly kind: 'unknown';
};

export type DiscriminatorObject = {
    readonly propertyName: string;
    readonly mapping: ReadonlyMap<string, string>;
};
