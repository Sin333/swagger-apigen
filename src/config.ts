/**
 * Public generator configuration.
 *
 * Every emit-time decision — naming, sorting, output layout, runtime-helper
 * bundling — is captured here so that presets can lock a project's conventions
 * in one object. External imports and per-file boilerplate are the templates'
 * responsibility; this shape stays lean and describes *what to emit*, not
 * *how the file frames it*.
 *
 * Use {@link DEFAULT_CONFIG} for a neutral starting point. Projects can
 * define their own presets on top and pass them to `ApiGen.generate`.
 */
export type ApigenConfig = {
    /**
     * Prepended to every emitted type name. Duplicates are avoided: a name that
     * already starts with the prefix is left untouched.
     */
    readonly typePrefix: string;

    /** Sort types alphabetically in the types file. */
    readonly sortTypes: boolean;

    /** Sort endpoints alphabetically by function name inside each endpoints file. */
    readonly sortRoutes: boolean;

    /** Sort object properties alphabetically. */
    readonly sortProperties: boolean;

    /**
     * When `true`, top-level object schemas are emitted as `export interface X { … }`
     * (with `extends` when the IR carries base refs). When `false`, they use
     * `export type X = Base & { … }`. Enums, unions, and aliases are unaffected.
     */
    readonly useInterface: boolean;

    /**
     * When `true`, emitted `Record<K, V>` occurrences become `UnsafeRecord<K, V>`
     * and the `UnsafeRecord` type is inlined at the top of the types file.
     * Encodes the idea that any string key may be missing at runtime.
     */
    readonly useUnsafeRecord: boolean;

    /**
     * When `true`, endpoints are split into one file per first tag under
     * `endpoints/{Tag}.ts` plus an `endpoints/index.ts` barrel.
     * When `false`, all endpoints land in a single flat `endpoints.ts`.
     */
    readonly separateEndpointsByTag: boolean;

    /**
     * When `true`, wraps every request-body type with `NullableToOptional<T>`
     * (bundled). The type is inlined at the top of the types file and endpoint
     * files import it from there.
     *
     * Effect on the emitted signature: fields typed as `T | null` become
     * optional parameters callers may omit.
     */
    readonly useNullableToOptional: boolean;

    /**
     * When `true`, wraps every successful response type with `RequiredData<T>`
     * (bundled). The type is inlined at the top of the types file and endpoint
     * files import it from there.
     *
     * ⚠️ This is a *type-only* wrapper: it declares the returned `data` field
     * as non-nullable at compile time but adds no runtime check. The HTTP call
     * template must guarantee — by contract or by runtime assertion — that
     * `data` is present in every response actually returned to the caller.
     */
    readonly isNotNullResponse: boolean;

    /** Root-level types file base name (without `.ts`). */
    readonly typesFileName: string;

    /**
     * When `true` (default), the generator writes to a temp directory and then
     * `rename`s the whole tree over `outDir`. IDE/git see a single event and
     * stale files from previous runs are wiped. When `false`, files are
     * written directly on top of `outDir` — files that are still regenerated
     * get overwritten in place, stale ones stay behind.
     */
    readonly atomicSwap: boolean;
};

/**
 * Neutral defaults: no prefix, single flat `endpoints.ts`, no bundled runtime
 * helpers. Sufficient to produce a compilable output for a generic OpenAPI
 * document with no project-specific runtime.
 */
export const DEFAULT_CONFIG: ApigenConfig = {
    typePrefix: '',
    sortTypes: true,
    sortRoutes: true,
    sortProperties: true,
    useInterface: false,
    useUnsafeRecord: false,
    separateEndpointsByTag: false,
    atomicSwap: true,
    useNullableToOptional: false,
    isNotNullResponse: false,
    typesFileName: 'types',
};

/** Shallow-merge `partial` onto {@link DEFAULT_CONFIG}. */
export const withDefaults = (partial?: Partial<ApigenConfig>): ApigenConfig => ({
    ...DEFAULT_CONFIG,
    ...partial,
});
