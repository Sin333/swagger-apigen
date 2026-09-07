/**
 * Public entry point for `apigen`.
 *
 * Preferred usage — one-shot pipeline that turns an OpenAPI document into a
 * generated tree in a single call:
 *
 *     import { ApiGen } from 'apigen';
 *
 *     await ApiGen.generate({
 *         input:  './swagger.json',            // path or `http(s)://` URL
 *         outDir: './generated',
 *         config: { typePrefix: 'Api', useUnsafeRecord: true },
 *     });
 *
 * Lower-level phases (`parseOpenApiFile`, `buildIr`, `emit`) are also exposed
 * on the namespace for callers that want to inspect the IR, cache the parse,
 * or drive emission from a pre-built model.
 */

import { DEFAULT_CONFIG, withDefaults } from './config.ts';
import { generate as emitFromIr } from './emit/index.ts';
import { buildIr } from './ir/index.ts';
import { parseOpenApi, parseOpenApiFile } from './parse.ts';
import { generate as pipelineGenerate } from './pipeline.ts';

/**
 * Namespaced façade grouping the whole public surface.
 *
 * The high-level `ApiGen.generate({ input, outDir, ... })` does everything at
 * once. The other members exist for advanced callers that want to run a phase
 * in isolation (e.g. inspect the IR or reuse a parsed document).
 */
export const ApiGen = {
    /** Full pipeline: read `input` (path or URL) → parse → build IR → emit. */
    generate: pipelineGenerate,
    /** Low-level emit step: writes files from a pre-built `IrModel`. */
    emit: emitFromIr,
    /** IR construction from a parsed OpenAPI document. */
    buildIr,
    /** Parse an OpenAPI document from a file path. */
    parseOpenApiFile,
    /** Parse an OpenAPI document from a raw string. */
    parseOpenApi,
    /** Neutral defaults for {@link ApigenConfig}. */
    DEFAULT_CONFIG,
    /** Shallow-merge a partial override onto {@link DEFAULT_CONFIG}. */
    withDefaults,
} as const;

// Flat re-exports for callers that prefer `import { generate } from 'apigen'`.
export {
    pipelineGenerate as generate,
    emitFromIr as emit,
    buildIr,
    parseOpenApi,
    parseOpenApiFile,
    DEFAULT_CONFIG,
    withDefaults,
};

// Types.
export type { ApigenConfig } from './config.ts';
export type { Diagnostic } from './errors.ts';
export type { GenerateOptions, GenerateResult } from './emit/index.ts';
export type * from './ir/types.ts';
export type { OpenApiSourceFormat, ParseResult } from './parse.ts';
export type { PipelineOptions, PipelineResult } from './pipeline.ts';
export type { OpenApiDocument, SchemaNode } from './types.ts';
