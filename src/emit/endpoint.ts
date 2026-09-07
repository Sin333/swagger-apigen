/**
 * Render a single API endpoint function.
 *
 * The endpoint shell (JSDoc, signature, args, request body wrapping, response
 * type wrapping) is produced programmatically here. The actual HTTP call
 * expression is delegated to the `endpoint-call.eta` template so users can
 * swap `fetchApi(...)` for an axios call, a custom client, or richer logic.
 */

import type { Eta } from 'eta';

import type { ApigenConfig } from '../config.ts';
import type { IrEndpoint, IrEndpointParameter, IrTypeExpr } from '../ir/types.ts';
import { renderExpr } from './expr.ts';
import { jsDocFormat, renderJsDocBlock } from './format.ts';
import { toIdent } from './ident.ts';
import { canonicalTypeName } from './name.ts';
import { renderUri, RouteNamer } from './routing.ts';

export type RenderedEndpoint = {
    readonly source: string;
    readonly functionName: string;
    /** Canonical type names that appear in this endpoint's args/response. */
    readonly typeRefs: readonly string[];
};

/** Context passed to the `endpoint-call.eta` template for a single endpoint. */
export type EndpointCallContext = {
    /** TS type of the call's `Promise<T>` — e.g. `RequiredData<ApiFoo>` or `void`. */
    readonly responseType: string;
    /** URI expression as it appears in code — `'api/foo'` or `` `api/foo/${id}` ``. */
    readonly uri: string;
    /** Uppercased HTTP method, without quotes — e.g. `GET`. */
    readonly method: string;
    /** Identifier of the body argument (`data`) or `null` when none. */
    readonly body: string | null;
    /** Identifier of the query argument (`query`) or `null` when none. */
    readonly query: string | null;
};

/** Context passed to the `endpoint-decl.eta` template for a single endpoint. */
export type EndpointDeclContext = {
    /** JSDoc block (may be empty), already terminated by a newline. */
    readonly doc: string;
    /** Emitted function/method name. */
    readonly functionName: string;
    /** Rendered argument list (destructured path params, `query`, `data`). */
    readonly argSignature: string;
    /** TS type of the returned value \u2014 e.g. `RequiredData<ApiFoo>` or `void`. */
    readonly responseType: string;
    /** HTTP call expression \u2014 rendered from `endpoint-call.eta`. */
    readonly callExpression: string;
};

export const renderEndpoint = (
    endpoint: IrEndpoint,
    namer: RouteNamer,
    config: ApigenConfig,
    eta: Eta,
    endpointCallSource: string,
    endpointDeclSource: string,
): RenderedEndpoint => {
    const functionName = namer.name(endpoint);
    const responseType = pickResponseType(endpoint, config);
    const args = buildArgSignatures(endpoint, config);
    const uri = renderUri(endpoint);
    const method = endpoint.method.toUpperCase();

    const argSignature = renderArgsList(args);

    const callCtx: EndpointCallContext = {
        responseType,
        uri,
        method,
        body: endpoint.requestBody ? 'data' : null,
        query: endpoint.queryParams.length > 0 ? 'query' : null,
    };
    const callExpression = indentContinuation(
        eta.renderString(endpointCallSource, callCtx).trimEnd(),
        '    ',
    );

    const doc = renderEndpointJsDoc(endpoint);

    const declCtx: EndpointDeclContext = {
        doc,
        functionName,
        argSignature,
        responseType,
        callExpression,
    };
    const source = eta.renderString(endpointDeclSource, declCtx);

    return {
        source,
        functionName,
        typeRefs: collectTypeRefs(endpoint, config),
    };
};

/**
 * Reindent the second and later lines of a multi-line block so they align
 * with the leading indent used at the call site.
 */
const indentContinuation = (block: string, indent: string): string => {
    const lines = block.split('\n');
    if (lines.length <= 1) return block;
    return [lines[0], ...lines.slice(1).map(l => (l.length > 0 ? indent + l : l))].join('\n');
};

const renderEndpointJsDoc = (endpoint: IrEndpoint): string => {
    const templatePath = endpoint.path.replaceAll(
        /\{([^}]+)\}/g,
        (_m, name: string) => `\${${toIdent(name, 'camel')}}`,
    );
    const summaryLine = `${endpoint.method.toUpperCase()} \`${templatePath}\``;
    const lines = [` * ${summaryLine}`];
    const extra = endpoint.description ?? endpoint.summary;
    if (extra) {
        for (const line of extra.trim().split(/\r?\n/)) lines.push(` * ${line}`);
    }
    if (endpoint.deprecated) lines.push(' * @deprecated');
    return `/**\n${lines.join('\n')}\n */\n`;
};

// --------------------------- Signature ------------------------------------

type ArgSig = { readonly body: string; readonly multiline: boolean };

const renderArgsList = (args: readonly ArgSig[]): string => {
    if (args.length === 0) return '';
    if (args.length === 1 && !args[0]!.multiline) return args[0]!.body;
    if (args.length === 1) return args[0]!.body;
    // Multi-arg: each arg indented by 4, trailing comma, closing `)` on own line.
    const indented = args.map(a => indentAll(a.body, '    '));
    return '\n' + indented.map(a => `${a},`).join('\n') + '\n';
};

const indentAll = (src: string, indent: string): string =>
    src.split('\n').map(l => indent + l).join('\n');

const buildArgSignatures = (endpoint: IrEndpoint, config: ApigenConfig): readonly ArgSig[] => {
    const args: ArgSig[] = [];
    const firstArg = buildFirstArg(endpoint, config);
    if (firstArg) args.push(firstArg);
    if (endpoint.requestBody) args.push(buildBodyArg(endpoint.requestBody.type, config));
    return args;
};

const buildFirstArg = (endpoint: IrEndpoint, config: ApigenConfig): ArgSig | null => {
    const hasPath = endpoint.pathParams.length > 0;
    const hasQuery = endpoint.queryParams.length > 0;

    if (!hasPath && !hasQuery) return null;

    if (hasQuery && hasPath) {
        const pathNames = endpoint.pathParams.map(p => toIdent(p.name, 'camel'));
        const shape = renderShape([...endpoint.pathParams, ...endpoint.queryParams], config);
        const destructure = `{\n${pathNames.map(n => `    ${n},`).join('\n')}\n    ...query\n}`;
        return { body: `${destructure}: ${shape}`, multiline: true };
    }
    if (hasQuery) {
        const shape = renderShape(endpoint.queryParams, config);
        return { body: `query: ${shape}`, multiline: true };
    }
    const pathNames = endpoint.pathParams.map(p => toIdent(p.name, 'camel'));
    const shape = renderShape(endpoint.pathParams, config);
    const destructure = `{\n${pathNames.map(n => `    ${n},`).join('\n')}\n}`;
    return { body: `${destructure}: ${shape}`, multiline: true };
};

const buildBodyArg = (bodyType: IrTypeExpr, config: ApigenConfig): ArgSig => {
    const inner = renderExpr(bodyType, config);
    const wrapped = config.useNullableToOptional ? `NullableToOptional<${inner}>` : inner;
    return { body: `data: ${wrapped}`, multiline: false };
};

const renderShape = (
    params: readonly IrEndpointParameter[],
    config: ApigenConfig,
): string => {
    const ordered = config.sortProperties
        ? [...params].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        : params;
    const lines = ordered.map(p => {
        const doc = renderJsDocBlock(
            {
                ...(p.description ? { description: p.description } : {}),
                format: jsDocFormat(p.type),
            },
            '    ',
        );
        return `${doc}    ${toIdent(p.name, 'camel')}: ${renderExpr(p.type, config)};`;
    });
    return `{\n${lines.join('\n')}\n}`;
};

// ---------------------------- Response ------------------------------------

const RESPONSE_STATUS_PREFERENCE: readonly string[] = ['200', '201', '204'];

const pickResponseType = (endpoint: IrEndpoint, config: ApigenConfig): string => {
    const inner = pickResponseInner(endpoint, config);
    if (!inner || inner === 'void') return inner ?? 'unknown';
    if (config.isNotNullResponse) {
        return `RequiredData<${inner}>`;
    }
    return inner;
};

const pickResponseInner = (endpoint: IrEndpoint, config: ApigenConfig): string | null => {
    for (const status of RESPONSE_STATUS_PREFERENCE) {
        const hit = endpoint.responses.find(r => r.statusCode === status);
        if (hit) return hit.type ? renderExpr(hit.type, config) : 'void';
    }
    const first = endpoint.responses.find(r => /^2\d\d$/.test(r.statusCode));
    if (first) return first.type ? renderExpr(first.type, config) : 'void';
    return null;
};

// ---------------------------- Doc / Refs ----------------------------------

const collectTypeRefs = (endpoint: IrEndpoint, config: ApigenConfig): readonly string[] => {
    const refs = new Set<string>();
    const visit = (expr: IrTypeExpr): void => {
        switch (expr.kind) {
            case 'ref':
                refs.add(canonicalTypeName(expr.name, config));
                return;
            case 'array':
                visit(expr.items);
                return;
            case 'record':
                visit(expr.value);
                return;
            case 'nullable':
                visit(expr.inner);
                return;
            case 'union':
            case 'intersection':
                for (const m of expr.members) visit(m);
                return;
            case 'object-inline':
                for (const p of expr.properties) visit(p.type);
                if (typeof expr.additionalProperties !== 'boolean') visit(expr.additionalProperties);
                return;
            default:
                return;
        }
    };
    for (const p of endpoint.pathParams) visit(p.type);
    for (const p of endpoint.queryParams) visit(p.type);
    for (const p of endpoint.headerParams) visit(p.type);
    if (endpoint.requestBody) visit(endpoint.requestBody.type);
    for (const r of endpoint.responses) if (r.type) visit(r.type);
    return [...refs];
};
