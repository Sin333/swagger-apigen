/**
 * Typed wrappers around Eta template rendering.
 *
 * Each wrapper takes the template source string (already resolved via
 * {@link resolveTemplateSources}) plus a typed `data` object. The naming
 * follows the file names shipped in `apigen/templates/`.
 *
 * Users can never call `eta.renderStringAsync(...)` directly from consumer
 * code; going through the wrappers gives compile-time checking of every
 * field the template touches.
 */

import type { Eta } from 'eta';

import type { ApigenConfig } from '../config.ts';

/**
 * Context for `types-file.eta`. `bundledTypes` contains source snippets to
 * inline at the top of the file (`UnsafeRecord`, `NullableToOptional`,
 * `RequiredData`) based on config flags. Templates may inspect `config`
 * directly to add project-specific imports.
 */
export type TypesFileData = {
    readonly config: ApigenConfig;
    /** Runtime type source snippets to inline before user schemas. */
    readonly bundledTypes: readonly string[];
    /** Rendered top-level declarations. */
    readonly declarations: readonly string[];
};

/**
 * Context for `endpoints-file.eta`. Templates decide which imports to emit
 * — inspect `config` for the enabled runtime helpers, and use
 * `typesImportFrom` to reach the types module.
 */
export type EndpointsFileData = {
    readonly config: ApigenConfig;
    /** Canonical type names used by this file's endpoints. */
    readonly typeImports: readonly string[];
    /** Names of bundled runtime helpers to import from the types module. */
    readonly bundledTypeImports: readonly string[];
    /** Import path for the types module, relative to this endpoint file. */
    readonly typesImportFrom: string;
    /** Rendered endpoint function sources. */
    readonly endpoints: readonly string[];
};

export type EndpointsBarrelData = {
    readonly modules: readonly { readonly tag: string; readonly alias: string }[];
};

export type RootIndexData = {
    readonly typesModule: string;
    readonly endpointsModule: string;
};

export const renderTypesFile = (eta: Eta, source: string, data: TypesFileData): Promise<string> =>
    eta.renderStringAsync(source, data);

export const renderEndpointsFile = (
    eta: Eta,
    source: string,
    data: EndpointsFileData,
): Promise<string> => eta.renderStringAsync(source, data);

export const renderEndpointsBarrel = (
    eta: Eta,
    source: string,
    data: EndpointsBarrelData,
): Promise<string> => eta.renderStringAsync(source, data);

export const renderRootIndex = (
    eta: Eta,
    source: string,
    data: RootIndexData,
): Promise<string> => eta.renderStringAsync(source, data);
