/**
 * High-level single-call entry point. Wraps `parse → build IR → emit` so
 * callers can go from a swagger file (or URL) to a generated tree in one line.
 *
 * For advanced use cases the underlying phases are still exported individually
 * from `ApiGen`.
 */

import { readFile } from 'node:fs/promises';

import type { ApigenConfig } from './config.ts';
import type { TemplateOverrides } from './emit/template-resolver.ts';
import { generate as emitIr, type GenerateResult } from './emit/index.ts';
import { buildIr } from './ir/index.ts';
import { parseOpenApi, type OpenApiSourceFormat } from './parse.ts';
import { ParseError, type Diagnostic } from './errors.ts';

/** Inputs to {@link ApiGen.generate}. `input` accepts a filesystem path or an HTTP(S) URL. */
export type PipelineOptions = {
    /**
     * Filesystem path or `http(s)://` URL of an OpenAPI 3.0 document
     * (JSON or YAML). Format is auto-detected from the extension or content.
     */
    readonly input: string;
    /** Target directory for the generated tree. */
    readonly outDir: string;
    /**
     * Per-template overrides. Set `templates.dir` for a folder of `.eta`
     * overrides (missing files fall back to library defaults), or
     * individual absolute paths like `templates.endpointCall` for single-file
     * replacements.
     */
    readonly templates?: TemplateOverrides;
    /** Partial config overrides merged onto `DEFAULT_CONFIG`. */
    readonly config?: Partial<ApigenConfig>;
    /** Force a specific input format instead of auto-detecting. */
    readonly format?: OpenApiSourceFormat;
};

/** Aggregate result of the full pipeline. */
export type PipelineResult = GenerateResult & {
    /** Diagnostics collected during parsing. */
    readonly parseDiagnostics: readonly Diagnostic[];
    /** Diagnostics collected during IR construction. */
    readonly irDiagnostics: readonly Diagnostic[];
};

/**
 * Run the full pipeline: fetch/read `input`, parse, build IR, emit files.
 *
 * Throws {@link ParseError} for hard parse failures (missing OpenAPI marker,
 * malformed JSON/YAML). Non-fatal issues surface as diagnostics on the result.
 */
export const generate = async (options: PipelineOptions): Promise<PipelineResult> => {
    const rawText = await readInput(options.input);
    const parseResult = parseOpenApi(rawText, options.format ?? 'auto');

    const ir = buildIr(parseResult.document);

    const emitOptions = {
        outDir: options.outDir,
        ...(options.templates !== undefined ? { templates: options.templates } : {}),
        ...(options.config !== undefined ? { config: options.config } : {}),
    };
    const emitResult = await emitIr(ir, emitOptions);

    return {
        ...emitResult,
        parseDiagnostics: parseResult.diagnostics,
        irDiagnostics: ir.diagnostics,
    };
};

const readInput = async (input: string): Promise<string> => {
    if (/^https?:\/\//i.test(input)) {
        const response = await fetch(input);
        if (!response.ok) {
            throw new ParseError(
                `Failed to fetch OpenAPI document from ${input}: HTTP ${response.status} ${response.statusText}`,
            );
        }
        return await response.text();
    }
    return await readFile(input, 'utf8');
};
