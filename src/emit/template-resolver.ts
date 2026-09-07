/**
 * Resolves the five template names apigen renders (`types-file`,
 * `endpoints-file`, `endpoints-barrel`, `root-index`, `endpoint-call`) to
 * their source strings.
 *
 * Lookup priority for each name:
 *   1. Explicit path in {@link TemplateOverrides} (e.g. `endpointCall`)
 *   2. `<dir>/<name>.eta` if `dir` is set and the file exists
 *   3. Library default shipped in `apigen/templates/`
 *
 * The design keeps overrides granular — users can replace a single
 * `endpoint-call.eta` (e.g. to swap `fetchApi` for axios) without providing
 * the other four.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const currentDir = dirname(fileURLToPath(import.meta.url));

/** Library-shipped `.eta` files. Consumed as fallback when a user does not override. */
export const DEFAULT_TEMPLATES_DIR = resolve(currentDir, '../../templates');

/** Public knobs allowing the caller to swap individual template files. */
export type TemplateOverrides = {
    /**
     * Directory scanned for any of the five `.eta` files. Missing files fall
     * back to the library defaults, so users can override just the templates
     * they need.
     */
    readonly dir?: string;
    /** Absolute path to a custom `types-file.eta`. Overrides `dir`. */
    readonly typesFile?: string;
    /** Absolute path to a custom `endpoints-file.eta`. Overrides `dir`. */
    readonly endpointsFile?: string;
    /** Absolute path to a custom `endpoints-barrel.eta`. Overrides `dir`. */
    readonly endpointsBarrel?: string;
    /** Absolute path to a custom `root-index.eta`. Overrides `dir`. */
    readonly rootIndex?: string;
    /** Absolute path to a custom `endpoint-decl.eta`. Overrides `dir`. */
    readonly endpointDecl?: string;
    /** Absolute path to a custom `endpoint-call.eta`. Overrides `dir`. */
    readonly endpointCall?: string;
};

/** Resolved template sources — one string per known template name. */
export type ResolvedTemplateSources = {
    readonly typesFile: string;
    readonly endpointsFile: string;
    readonly endpointsBarrel: string;
    readonly rootIndex: string;
    readonly endpointDecl: string;
    readonly endpointCall: string;
};

export const resolveTemplateSources = (
    overrides: TemplateOverrides = {},
): ResolvedTemplateSources => ({
    typesFile: loadTemplate('types-file', overrides.typesFile, overrides.dir),
    endpointsFile: loadTemplate('endpoints-file', overrides.endpointsFile, overrides.dir),
    endpointsBarrel: loadTemplate('endpoints-barrel', overrides.endpointsBarrel, overrides.dir),
    rootIndex: loadTemplate('root-index', overrides.rootIndex, overrides.dir),
    endpointDecl: loadTemplate('endpoint-decl', overrides.endpointDecl, overrides.dir),
    endpointCall: loadTemplate('endpoint-call', overrides.endpointCall, overrides.dir),
});

const loadTemplate = (
    name: string,
    explicitPath: string | undefined,
    dir: string | undefined,
): string => {
    if (explicitPath) return readFileSync(explicitPath, 'utf8');
    if (dir) {
        const candidate = resolve(dir, `${name}.eta`);
        if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    }
    return readFileSync(resolve(DEFAULT_TEMPLATES_DIR, `${name}.eta`), 'utf8');
};
