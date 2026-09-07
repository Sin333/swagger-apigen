/**
 * Function name and URI derivation for API endpoints, mirroring the current
 * generator's conventions.
 *
 * Function names follow `{method}Api{RouteName}[ById]` with a numeric suffix
 * for duplicates. URI is emitted as a template literal when the path contains
 * `{param}` segments, else as a single-quoted string; leading `/` is dropped.
 */

import type { HttpMethod } from '../types.ts';
import type { IrEndpoint } from '../ir/types.ts';
import { toIdent } from './ident.ts';

const METHOD_SUFFIXES: Record<HttpMethod, readonly string[]> = {
    get: ['List', 'Detail'],
    post: ['Create'],
    put: ['Update'],
    delete: ['Delete'],
    patch: [],
    options: [],
    head: [],
    trace: [],
};

const PATH_PARAM_RE = /\{([^}]+)\}/g;

/** Stateful name generator with per-run duplicate tracking. */
export class RouteNamer {
    private readonly seen = new Map<string, number>();

    name(endpoint: IrEndpoint): string {
        const routeName = deriveRouteName(endpoint);
        const suffixed = trimMethodSuffix(routeName, endpoint.method);
        const byId = hasLiteralIdParam(endpoint.path) ? 'ById' : '';
        const base = `${endpoint.method}Api${pascal(suffixed)}${byId}`;

        const prev = this.seen.get(base);
        if (prev === undefined) {
            this.seen.set(base, 1);
            return base;
        }
        this.seen.set(base, prev + 1);
        return `${base}${prev + 1}`;
    }
}

/**
 * Render the URI expression for a fetch call: template literal when there
 * are path params, plain string otherwise. The leading `/` is dropped.
 */
export const renderUri = (endpoint: IrEndpoint): string => {
    const stripped = endpoint.path.startsWith('/') ? endpoint.path.slice(1) : endpoint.path;
    if (!stripped.includes('{')) return `'${stripped}'`;
    const templated = stripped.replaceAll(PATH_PARAM_RE, (_m, name: string) => `\${${toIdent(name, 'camel')}}`);
    return `\`${templated}\``;
};

const deriveRouteName = (endpoint: IrEndpoint): string => {
    if (endpoint.operationId) return endpoint.operationId;
    // Synthesize from path: keep alphanumeric non-`api` non-parameter segments.
    const parts = endpoint.path
        .split('/')
        .map(seg => seg.trim())
        .filter(seg => seg.length > 0 && !seg.startsWith('{') && seg.toLowerCase() !== 'api');
    return parts.map(pascal).join('');
};

/** Match the current generator's suffix-stripping (`getFooList` → `getFoo`). */
const trimMethodSuffix = (routeName: string, method: HttpMethod): string => {
    for (const suffix of METHOD_SUFFIXES[method] ?? []) {
        if (routeName.endsWith(suffix)) return routeName.slice(0, -suffix.length);
    }
    return routeName;
};

const hasLiteralIdParam = (path: string): boolean => path.includes('{id}');

const pascal = (raw: string): string => {
    const cleaned = toIdent(raw, 'pascal');
    return cleaned;
};
