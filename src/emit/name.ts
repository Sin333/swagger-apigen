/**
 * Canonicalize a schema name into a TypeScript identifier:
 *   - strip `_` separators
 *   - PascalCase each segment
 *   - prepend `typePrefix` (unless the result already starts with it)
 *
 * Examples:
 *   canonicalTypeName('ApiResponse_IReadOnlyCollection_Foo', 'Api')
 *     → 'ApiResponseIReadOnlyCollectionFoo'
 *   canonicalTypeName('Foo',                                'Api')
 *     → 'ApiFoo'
 */

import type { ApigenConfig } from '../config.ts';

export const canonicalTypeName = (rawName: string, config: ApigenConfig): string => {
    const parts = rawName.split('_').filter(p => p.length > 0);
    const base =
        parts.length === 0
            ? '_'
            : parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
    if (!config.typePrefix || base.startsWith(config.typePrefix)) return base;
    return config.typePrefix + base;
};
