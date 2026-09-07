/**
 * Intermediate Representation — the normalized model consumed by the emitter.
 *
 * Difference from the parser AST:
 *   - `$ref` targets are pre-classified: real named type / inline synthetic
 *     wrapper (`Nullable_X`, `IReadOnlyCollection_X`, `Dictionary_K_V`, …) /
 *     C# primitive (`String`, `Int32`, `DateTime`, …). Broken refs surface
 *     as diagnostics.
 *   - Wrapper flattening: single-element `allOf` and the C# `allOf: [$ref] +
 *     nullable: true` idiom collapse into a nullable ref.
 *   - Only IR-relevant fields survive. Structural pointers (`JsonPointer`)
 *     are dropped; use the parser AST if you need source location.
 *
 * IR is intentionally split between *type definitions* (the named things that
 * will be emitted as `type X = …` / `interface X {…}`) and *type expressions*
 * (the inline shapes appearing in properties, parameters, and responses).
 */

import type { HttpMethod } from '../types.ts';

// ------------------------------- Model -----------------------------------

import type { Diagnostic } from '../errors.ts';

export type IrModel = {
    readonly types: ReadonlyMap<string, IrType>;
    readonly endpoints: readonly IrEndpoint[];
    readonly diagnostics: readonly Diagnostic[];
    /** Types referenced but never defined (after synthetic expansion). */
    readonly unresolvedRefs: ReadonlySet<string>;
};

// ---------------------------- Type definitions ----------------------------

export type IrType = IrObjectType | IrEnumType | IrUnionType | IrAliasType;

export type IrTypeBase = {
    readonly name: string;
    readonly description?: string;
    readonly deprecated: boolean;
};

export type IrObjectType = IrTypeBase & {
    readonly kind: 'object';
    readonly properties: readonly IrProperty[];
    readonly additionalProperties: IrTypeExpr | boolean;
    /** Canonical names of types this object composes via `allOf`. */
    readonly extends: readonly string[];
};

export type IrEnumType = IrTypeBase & {
    readonly kind: 'enum';
    readonly base: 'string' | 'integer' | 'number';
    readonly members: readonly IrEnumMember[];
};

export type IrEnumMember = {
    readonly name: string;
    readonly value: string | number;
};

export type IrUnionType = IrTypeBase & {
    readonly kind: 'union';
    readonly variants: readonly IrUnionVariant[];
    readonly discriminator?: IrDiscriminator;
};

export type IrUnionVariant = {
    readonly type: IrTypeExpr;
    /**
     * Raw discriminator value as it appears in the OpenAPI `mapping`.
     * Kept for fallback rendering when {@link discriminatorEnumMember} is unavailable.
     */
    readonly discriminatorValue?: string;
    /**
     * Enum type + member the discriminator value resolves to. Populated when the
     * discriminator property points at an enum schema. Emit prefers this over the
     * raw string literal so consumers get real enum symbols.
     */
    readonly discriminatorEnumMember?: {
        readonly typeName: string;
        readonly memberName: string;
    };
};

export type IrDiscriminator = {
    readonly propertyName: string;
    /** Discriminator value → canonical variant type name. */
    readonly mapping: ReadonlyMap<string, string>;
    /**
     * Original name of the enum schema the discriminator property refers to
     * (not yet canonicalized — apply `canonicalTypeName` at emit).
     */
    readonly enumTypeName?: string;
};

export type IrAliasType = IrTypeBase & {
    readonly kind: 'alias';
    readonly target: IrTypeExpr;
};

export type IrProperty = {
    readonly name: string;
    readonly type: IrTypeExpr;
    readonly required: boolean;
    readonly readOnly: boolean;
    readonly deprecated: boolean;
    readonly description?: string;
};

// --------------------------- Type expressions -----------------------------

export type IrTypeExpr =
    | IrExprRef
    | IrExprString
    | IrExprInteger
    | IrExprNumber
    | IrExprBoolean
    | IrExprNull
    | IrExprUnknown
    | IrExprArray
    | IrExprRecord
    | IrExprUnion
    | IrExprIntersection
    | IrExprObjectInline
    | IrExprLiteral
    | IrExprNullable;

export type IrExprRef = { readonly kind: 'ref'; readonly name: string };
export type IrExprString = { readonly kind: 'string'; readonly format?: string };
export type IrExprInteger = { readonly kind: 'integer'; readonly format?: string };
export type IrExprNumber = { readonly kind: 'number'; readonly format?: string };
export type IrExprBoolean = { readonly kind: 'boolean' };
export type IrExprNull = { readonly kind: 'null' };
export type IrExprUnknown = { readonly kind: 'unknown' };
export type IrExprArray = { readonly kind: 'array'; readonly items: IrTypeExpr };
export type IrExprRecord = {
    readonly kind: 'record';
    readonly key: IrExprString | IrExprInteger;
    readonly value: IrTypeExpr;
};
export type IrExprUnion = { readonly kind: 'union'; readonly members: readonly IrTypeExpr[] };
export type IrExprIntersection = {
    readonly kind: 'intersection';
    readonly members: readonly IrTypeExpr[];
};
export type IrExprObjectInline = {
    readonly kind: 'object-inline';
    readonly properties: readonly IrProperty[];
    readonly additionalProperties: IrTypeExpr | boolean;
};
export type IrExprLiteral = {
    readonly kind: 'literal';
    readonly value: string | number | boolean;
};
export type IrExprNullable = { readonly kind: 'nullable'; readonly inner: IrTypeExpr };

// ------------------------------ Endpoints --------------------------------

export type IrEndpoint = {
    readonly operationId?: string;
    readonly method: HttpMethod;
    readonly path: string;
    readonly tag: string;
    readonly summary?: string;
    readonly description?: string;
    readonly deprecated: boolean;
    readonly pathParams: readonly IrEndpointParameter[];
    readonly queryParams: readonly IrEndpointParameter[];
    readonly headerParams: readonly IrEndpointParameter[];
    readonly requestBody?: IrRequestBody;
    readonly responses: readonly IrResponse[];
};

export type IrEndpointParameter = {
    readonly name: string;
    readonly type: IrTypeExpr;
    readonly required: boolean;
    readonly description?: string;
};

export type IrRequestBody = {
    readonly mediaType: string;
    readonly type: IrTypeExpr;
    readonly required: boolean;
};

export type IrResponse = {
    readonly statusCode: string;
    readonly mediaType?: string;
    readonly type?: IrTypeExpr;
    readonly description: string;
};
