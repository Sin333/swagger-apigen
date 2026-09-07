/**
 * Loader for the runtime helper types shipped in `./types.ts`.
 *
 * Extracts each declaration by its `// #region NAME` / `// #endregion`
 * delimiters and caches the parsed map so subsequent calls are O(1). Callers
 * ask for a snippet by name; the returned string is TypeScript source ready
 * to inline into the emitted `types` file.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const RUNTIME_TYPES_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'types.ts');

/** Names of runtime helper types apigen can inline. */
export type RuntimeTypeName = 'UnsafeRecord' | 'NullableToOptional' | 'RequiredData';

let cache: ReadonlyMap<string, string> | null = null;

/**
 * Return the TypeScript source of a single runtime helper type, verbatim from
 * `runtime/types.ts`. Throws if the requested name is missing — that means
 * the runtime file has drifted from the loader.
 */
export const loadRuntimeType = (name: RuntimeTypeName): string => {
    const map = ensureCache();
    const source = map.get(name);
    if (!source) {
        throw new Error(
            `apigen runtime type "${name}" not found in ${RUNTIME_TYPES_FILE}. ` +
                'Ensure a `// #region ' +
                name +
                '` block exists.',
        );
    }
    return source;
};

const REGION_RE = /^\/\/ #region (\w+)\s*$([\s\S]*?)^\/\/ #endregion\s*$/gm;

const ensureCache = (): ReadonlyMap<string, string> => {
    if (cache) return cache;
    const text = readFileSync(RUNTIME_TYPES_FILE, 'utf8');
    const parsed = new Map<string, string>();
    for (const match of text.matchAll(REGION_RE)) {
        const name = match[1]!;
        const body = match[2]!.trim();
        parsed.set(name, body);
    }
    cache = parsed;
    return parsed;
};
