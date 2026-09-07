/**
 * Runtime helper types the emitter can inline into a generated `types` file.
 *
 * These are *real* TypeScript declarations rather than string constants so
 * they can be type-checked by tsgo, IDE-navigated, and refactored like any
 * other code. `apigen`'s emitter reads this file at generation time and
 * copies the requested declarations verbatim into the output.
 *
 * Delimiter comments (`// #region <Name>` / `// #endregion`) bracket each
 * declaration. Do not rename or remove them — the loader relies on them.
 */

// #region UnsafeRecord
/** `Record<K, V>` variant that admits `undefined` values, matching how a JSON
 *  API may omit keys at runtime even when the type says they exist. */
export type UnsafeRecord<K extends string | number, V> = Record<K, V | undefined>;
// #endregion

// #region NullableToOptional
/** Rewrite fields typed as `T | null` into optional properties so the caller
 *  may omit them entirely when constructing a request body. */
export type NullableToOptional<T> = {
    // fields without null — stay required
    [K in keyof T as null extends T[K] ? never : K]: T[K];
} & {
    // fields with null — become optional
    [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
// #endregion

// #region RequiredData
/** Strip the `data?: T | null` layer from a response envelope and return the
 *  inner type as non-nullable. Type-only — no runtime check is added. */
export type RequiredData<T> = T extends { data?: (infer U) | null } ? NonNullable<U> : never;
// #endregion
