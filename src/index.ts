import { resolve } from 'node:path';
import { argv, exit, memoryUsage, stderr, stdout } from 'node:process';

import { generate } from './emit/index.ts';
import { ParseError } from './errors.ts';
import { buildIr, type IrModel, type IrType, type IrTypeExpr } from './ir/index.ts';
import { parseOpenApiFile, type ParseResult } from './parse.ts';
import type { OpenApiDocument, SchemaNode } from './types.ts';

type CliArgs = {
    readonly filePath: string;
    readonly outDir?: string;
    readonly typePrefix: string;
};

const parseCliArgs = (raw: readonly string[]): CliArgs | null => {
    const positional: string[] = [];
    let typePrefix = '';
    for (let i = 0; i < raw.length; i++) {
        const a = raw[i]!;
        if (a === '--type-prefix') {
            const next = raw[i + 1];
            if (next === undefined) return null;
            typePrefix = next;
            i++;
        } else if (a.startsWith('--type-prefix=')) {
            typePrefix = a.slice('--type-prefix='.length);
        } else {
            positional.push(a);
        }
    }
    if (positional.length === 0) return null;
    return {
        filePath: positional[0]!,
        ...(positional[1] ? { outDir: positional[1] } : {}),
        typePrefix,
    };
};

const main = async (): Promise<number> => {
    const args = parseCliArgs(argv.slice(2));
    if (!args) {
        stderr.write(
            'Usage: node src/index.ts <path-to-openapi.(json|yaml)> [outDir] [--type-prefix <p>]\n',
        );
        return 1;
    }

    const absolute = resolve(process.cwd(), args.filePath);
    const memBefore = memoryUsage.rss();

    let parseResult: ParseResult;
    try {
        parseResult = await parseOpenApiFile(absolute);
    } catch (err) {
        if (err instanceof ParseError) {
            stderr.write(`Parse error: ${err.message}\n`);
        } else {
            stderr.write(
                `Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
            );
        }
        return 1;
    }

    const irStart = performance.now();
    const ir = buildIr(parseResult.document);
    const irDuration = performance.now() - irStart;

    let generateDurationMs: number | undefined;
    let writtenFiles: readonly string[] = [];
    if (args.outDir) {
        const absOut = resolve(process.cwd(), args.outDir);
        const result = await generate(ir, {
            outDir: absOut,
            config: { typePrefix: args.typePrefix },
        });
        generateDurationMs = result.durationMs;
        writtenFiles = result.writtenFiles;
    }

    const memAfter = memoryUsage.rss();

    printSummary({
        filePath: absolute,
        parseResult,
        ir,
        typePrefix: args.typePrefix,
        irDurationMs: irDuration,
        generateDurationMs,
        writtenFiles,
        rssDeltaBytes: memAfter - memBefore,
    });

    const parseErrors = parseResult.diagnostics.filter(d => d.severity === 'error').length;
    const irErrors = ir.diagnostics.filter(d => d.severity === 'error').length;
    return parseErrors + irErrors > 0 ? 1 : 0;
};

type SummaryInput = {
    readonly filePath: string;
    readonly parseResult: ParseResult;
    readonly ir: IrModel;
    readonly typePrefix: string;
    readonly irDurationMs: number;
    readonly generateDurationMs?: number;
    readonly writtenFiles: readonly string[];
    readonly rssDeltaBytes: number;
};

const printSummary = (input: SummaryInput): void => {
    const {
        filePath,
        parseResult,
        ir,
        typePrefix,
        irDurationMs,
        generateDurationMs,
        writtenFiles,
        rssDeltaBytes,
    } = input;
    const { document, diagnostics, references, durationMs, format } = parseResult;

    const parseErrors = diagnostics.filter(d => d.severity === 'error');
    const parseWarns = diagnostics.filter(d => d.severity === 'warning');
    const irErrors = ir.diagnostics.filter(d => d.severity === 'error');
    const irWarns = ir.diagnostics.filter(d => d.severity === 'warning');

    const parseCounts = countSchemas(document);
    const irCounts = countIrTypes(ir);
    const inlineStats = countInlineExprs(ir);

    stdout.write(
        [
            `File:                ${filePath}`,
            `Format:              ${format}`,
            `OpenAPI:             ${document.openapi}`,
            `Title:               ${document.info.title} (${document.info.version})`,
            '',
            '=== Parser (Phase 1) ===',
            `Paths:               ${document.paths.size}`,
            `Operations:          ${countOperations(document)}`,
            `Schemas:             ${document.components.schemas.size}`,
            `  objects:           ${parseCounts.object}`,
            `  enums:             ${parseCounts.enum}`,
            `  primitives:        ${parseCounts.primitive}`,
            `  compositions:      ${parseCounts.composition}`,
            `  refs (root):       ${parseCounts.ref}`,
            `  unknown:           ${parseCounts.unknown}`,
            `$refs observed:      ${references.size}`,
            `Diagnostics:         ${parseErrors.length} error(s), ${parseWarns.length} warning(s)`,
            `Parse time:          ${durationMs.toFixed(1)} ms`,
            '',
            '=== IR (Phase 2) ===',
            `Named types:         ${ir.types.size}`,
            `  objects:           ${irCounts.object}`,
            `  enums:             ${irCounts.enum}`,
            `  unions:            ${irCounts.union}`,
            `  aliases:           ${irCounts.alias}`,
            `Endpoints:           ${ir.endpoints.length}`,
            `Inline expressions:  ${inlineStats.total}`,
            `  arrays:            ${inlineStats.array}`,
            `  records:           ${inlineStats.record}`,
            `  nullable-wrapped:  ${inlineStats.nullable}`,
            `Unresolved refs:     ${ir.unresolvedRefs.size}`,
            `Diagnostics:         ${irErrors.length} error(s), ${irWarns.length} warning(s)`,
            `IR build time:       ${irDurationMs.toFixed(1)} ms`,
            ...(generateDurationMs !== undefined
                ? [
                      '',
                      '=== Emit (Phase 3) ===',
                      `Type prefix:         ${typePrefix || '<none>'}`,
                      `Files written:       ${writtenFiles.length}`,
                      ...writtenFiles.map(f => `  ${f}`),
                      `Generate time:       ${generateDurationMs.toFixed(1)} ms`,
                  ]
                : []),
            '',
            `RSS delta (total):   ${formatBytes(rssDeltaBytes)}`,
            '',
        ].join('\n'),
    );

    if (parseErrors.length > 0) {
        stdout.write('--- Parser errors ---\n');
        printDiagnosticList(parseErrors);
    }
    if (irErrors.length > 0) {
        stdout.write('--- IR errors ---\n');
        printDiagnosticList(irErrors);
    }
    if (parseWarns.length > 0 || irWarns.length > 0) {
        stdout.write('--- Warnings ---\n');
        printDiagnosticList([...parseWarns, ...irWarns], 10);
    }
};

const printDiagnosticList = (
    diags: readonly { pointer: string; message: string }[],
    limit: number = 20,
): void => {
    for (const d of diags.slice(0, limit)) {
        stdout.write(`  ${d.pointer || '/'}\n    ${d.message}\n`);
    }
    if (diags.length > limit) stdout.write(`  ... and ${diags.length - limit} more\n`);
};

type SchemaCounts = {
    object: number;
    enum: number;
    primitive: number;
    composition: number;
    ref: number;
    unknown: number;
};

const countSchemas = (document: OpenApiDocument): SchemaCounts => {
    const counts: SchemaCounts = { object: 0, enum: 0, primitive: 0, composition: 0, ref: 0, unknown: 0 };
    for (const schema of document.components.schemas.values()) {
        bumpSchemaCount(counts, schema);
    }
    return counts;
};

const bumpSchemaCount = (counts: SchemaCounts, schema: SchemaNode): void => {
    switch (schema.kind) {
        case 'object':
        case 'array':
            counts.object++;
            break;
        case 'enum':
            counts.enum++;
            break;
        case 'string':
        case 'integer':
        case 'number':
        case 'boolean':
            counts.primitive++;
            break;
        case 'allOf':
        case 'oneOf':
        case 'anyOf':
            counts.composition++;
            break;
        case 'ref':
            counts.ref++;
            break;
        case 'unknown':
            counts.unknown++;
            break;
    }
};

const countOperations = (document: OpenApiDocument): number => {
    let n = 0;
    for (const item of document.paths.values()) n += item.operations.size;
    return n;
};

type IrCounts = { object: number; enum: number; union: number; alias: number };

const countIrTypes = (ir: IrModel): IrCounts => {
    const counts: IrCounts = { object: 0, enum: 0, union: 0, alias: 0 };
    for (const t of ir.types.values()) bumpIrTypeCount(counts, t);
    return counts;
};

const bumpIrTypeCount = (counts: IrCounts, t: IrType): void => {
    switch (t.kind) {
        case 'object':
            counts.object++;
            break;
        case 'enum':
            counts.enum++;
            break;
        case 'union':
            counts.union++;
            break;
        case 'alias':
            counts.alias++;
            break;
    }
};

type InlineStats = { total: number; array: number; record: number; nullable: number };

const countInlineExprs = (ir: IrModel): InlineStats => {
    const stats: InlineStats = { total: 0, array: 0, record: 0, nullable: 0 };
    const visitExpr = (expr: IrTypeExpr): void => {
        stats.total++;
        switch (expr.kind) {
            case 'array':
                stats.array++;
                visitExpr(expr.items);
                break;
            case 'record':
                stats.record++;
                visitExpr(expr.value);
                break;
            case 'nullable':
                stats.nullable++;
                visitExpr(expr.inner);
                break;
            case 'union':
            case 'intersection':
                for (const m of expr.members) visitExpr(m);
                break;
            case 'object-inline':
                for (const p of expr.properties) visitExpr(p.type);
                if (typeof expr.additionalProperties !== 'boolean') {
                    visitExpr(expr.additionalProperties);
                }
                break;
            default:
                break;
        }
    };
    for (const t of ir.types.values()) visitIrType(t, visitExpr);
    for (const e of ir.endpoints) {
        for (const p of e.pathParams) visitExpr(p.type);
        for (const p of e.queryParams) visitExpr(p.type);
        for (const p of e.headerParams) visitExpr(p.type);
        if (e.requestBody) visitExpr(e.requestBody.type);
        for (const r of e.responses) {
            if (r.type) visitExpr(r.type);
        }
    }
    return stats;
};

const visitIrType = (t: IrType, visitExpr: (e: IrTypeExpr) => void): void => {
    switch (t.kind) {
        case 'object':
            for (const p of t.properties) visitExpr(p.type);
            if (typeof t.additionalProperties !== 'boolean') visitExpr(t.additionalProperties);
            break;
        case 'union':
            for (const v of t.variants) visitExpr(v.type);
            break;
        case 'alias':
            visitExpr(t.target);
            break;
        case 'enum':
            break;
    }
};

const formatBytes = (bytes: number): string => {
    const sign = bytes < 0 ? '-' : '';
    const abs = Math.abs(bytes);
    if (abs < 1024) return `${sign}${abs} B`;
    if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KiB`;
    return `${sign}${(abs / 1024 / 1024).toFixed(1)} MiB`;
};

exit(await main());
