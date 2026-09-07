/**
 * Eta engine factory.
 *
 * Templates are no longer looked up by name from a `views` directory —
 * source strings are loaded via {@link resolveTemplateSources} and rendered
 * with `eta.renderStringAsync`. This lets users override any single
 * template file without providing a full replacement directory.
 *
 * Call sites go through the typed wrappers in `./templates.ts`.
 */

import { Eta } from 'eta';

export const createEta = (): Eta =>
    new Eta({
        cache: false,
        autoTrim: false,
        autoEscape: false,
        useWith: false,
    });
