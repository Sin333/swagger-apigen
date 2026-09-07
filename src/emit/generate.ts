/**
 * Top-level generator. Materializes an `IrModel` into a directory tree.
 *
 * Optimizations:
 *   - Everything is written to a temp directory first, then swapped into
 *     `outDir` via a single `rm + rename`. IDE/git see one change, not
 *     hundreds.
 *   - Cross-device rename (EXDEV) falls back to `cp -r`.
 */

import { mkdir, mkdtemp, cp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';

import { withDefaults, type ApigenConfig } from '../config.ts';
import type { IrEndpoint, IrModel } from '../ir/index.ts';
import { loadRuntimeType } from '../runtime/loader.ts';
import { renderType } from './decl.ts';
import { renderEndpoint } from './endpoint.ts';
import { createEta } from './eta.ts';
import { toIdent } from './ident.ts';
import { canonicalTypeName } from './name.ts';
import { RouteNamer } from './routing.ts';
import {
    renderEndpointsBarrel,
    renderEndpointsFile,
    renderRootIndex,
    renderTypesFile,
} from './templates.ts';
import {
    resolveTemplateSources,
    type ResolvedTemplateSources,
    type TemplateOverrides,
} from './template-resolver.ts';

/**
 * Inputs to {@link generate}. Only `outDir` is required; the rest apply
 * conservative defaults suitable for a first run.
 */
export type GenerateOptions = {
    /**
     * Absolute or CWD-relative path of the directory to receive the output
     * tree. Overwritten atomically when `config.atomicSwap` is `true`.
     */
    readonly outDir: string;
    /**
     * Per-template overrides. Set `templates.dir` to a directory containing
     * any subset of `types-file.eta`, `endpoints-file.eta`,
     * `endpoints-barrel.eta`, `root-index.eta`, `endpoint-call.eta` —
     * missing files fall back to the library defaults. Individual absolute
     * paths (`templates.endpointCall = '/abs/path.eta'`) take priority over
     * `templates.dir` so a single template can be replaced in isolation.
     */
    readonly templates?: TemplateOverrides;
    /** Partial overrides merged onto {@link DEFAULT_CONFIG}. */
    readonly config?: Partial<ApigenConfig>;
};

/**
 * Outcome of a single {@link generate} run. Timing and file lists are
 * suitable for CLI logging and CI reporting.
 */
export type GenerateResult = {
    /** Absolute paths of every file written into `outDir` after the swap. */
    readonly writtenFiles: readonly string[];
    /** Wall-clock time between `generate()` entry and file-tree finalization. */
    readonly durationMs: number;
    /**
     * Directory where files were materialized before being moved into
     * `outDir`. Same as `outDir` when `atomicSwap` is off.
     */
    readonly stagingDir: string;
};

/**
 * Emit the full TypeScript output tree for a parsed IR.
 *
 * Pipeline:
 *   1. Render types into `<outDir>/<typesFileName>.ts` (sorted per config).
 *   2. Render endpoints — one file per first tag under `<outDir>/endpoints/`
 *      when `separateEndpointsByTag` is on, otherwise a flat `endpoints.ts`.
 *   3. Emit a root `index.ts` barrel that re-exports everything.
 *
 * When `config.atomicSwap` is enabled (default), all writes happen in a
 * `tmpdir()` scratch directory first, then the entire tree is swapped into
 * `outDir` via a single `rename`. IDE watchers and Git see one event.
 *
 * @param ir      Result of {@link buildIr}.
 * @param options Output location and per-run overrides.
 */
export const generate = async (
    ir: IrModel,
    options: GenerateOptions,
): Promise<GenerateResult> => {
    const started = performance.now();
    const config = withDefaults(options.config);
    const eta = createEta();
    const sources = resolveTemplateSources(options.templates);

    const outDirAbs = resolve(options.outDir);
    const stagingDir = config.atomicSwap
        ? await mkdtemp(resolve(tmpdir(), 'apigen-'))
        : outDirAbs;
    if (!config.atomicSwap) {
        await mkdir(stagingDir, { recursive: true });
    }

    const writtenFiles: string[] = [];

    // ------- types file ---------
    const typesFileName = `${config.typesFileName}.ts`;
    const typesSource = await renderTypesFileContent(ir, config, eta, sources);
    await writeStaged(stagingDir, typesFileName, typesSource, writtenFiles);

    // ------- endpoints ---------
    if (config.separateEndpointsByTag) {
        await emitTagBundle(ir, config, eta, sources, stagingDir, writtenFiles);
    } else {
        await emitFlatEndpoints(ir, config, eta, sources, stagingDir, writtenFiles);
    }

    // ------- root index ---------
    const typesModule = `./${config.typesFileName}`;
    const endpointsModule = './endpoints';
    const rootIndex = await renderRootIndex(eta, sources.rootIndex, { typesModule, endpointsModule });
    await writeStaged(stagingDir, 'index.ts', rootIndex, writtenFiles);

    if (config.atomicSwap) {
        await atomicSwap(stagingDir, outDirAbs);
    }

    return {
        writtenFiles: writtenFiles.map(f => (config.atomicSwap ? f.replace(stagingDir, outDirAbs) : f)),
        durationMs: performance.now() - started,
        stagingDir,
    };
};

// --------------------------- File builders --------------------------------

const renderTypesFileContent = async (
    ir: IrModel,
    config: ApigenConfig,
    eta: ReturnType<typeof createEta>,
    sources: ResolvedTemplateSources,
): Promise<string> => {
    const types = [...ir.types.values()];
    const sorted = config.sortTypes
        ? [...types].sort((a, b) =>
              canonicalTypeName(a.name, config) < canonicalTypeName(b.name, config) ? -1 : 1,
          )
        : types;
    const declarations = sorted.map(t => renderType(t, config));
    const bundledTypes: string[] = [];
    if (config.useUnsafeRecord) bundledTypes.push(loadRuntimeType('UnsafeRecord'));
    if (config.useNullableToOptional) bundledTypes.push(loadRuntimeType('NullableToOptional'));
    if (config.isNotNullResponse) bundledTypes.push(loadRuntimeType('RequiredData'));
    return renderTypesFile(eta, sources.typesFile, { config, bundledTypes, declarations });
};

const emitTagBundle = async (
    ir: IrModel,
    config: ApigenConfig,
    eta: ReturnType<typeof createEta>,
    sources: ResolvedTemplateSources,
    stagingDir: string,
    writtenFiles: string[],
): Promise<void> => {
    const byTag = groupByFirstTag(ir.endpoints);
    const endpointsDir = resolve(stagingDir, 'endpoints');
    await mkdir(endpointsDir, { recursive: true });

    const modules: { tag: string; alias: string }[] = [];
    const typesImportFrom = `../${config.typesFileName}`;
    const bundledTypeImports = collectBundledImports(config);

    // One RouteNamer per whole run to keep dedup consistent across files.
    const namer = new RouteNamer();

    for (const [tag, list] of [...byTag.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const fileName = normalizeTagIdent(tag);
        const rendered = list.map(e =>
            renderEndpoint(e, namer, config, eta, sources.endpointCall, sources.endpointDecl),
        );
        const orderedRendered = config.sortRoutes
            ? [...rendered].sort((a, b) => (a.functionName < b.functionName ? -1 : 1))
            : rendered;

        const typeRefs = new Set<string>();
        for (const r of orderedRendered) for (const t of r.typeRefs) typeRefs.add(t);
        const typeImports = [...typeRefs].sort();

        const source = await renderEndpointsFile(eta, sources.endpointsFile, {
            config,
            typeImports,
            bundledTypeImports,
            typesImportFrom,
            endpoints: orderedRendered.map(r => r.source),
        });

        const alias = toIdent(fileName, 'camel');
        modules.push({ tag: fileName, alias });
        await writeStaged(endpointsDir, `${fileName}.ts`, source, writtenFiles);
    }

    const barrel = await renderEndpointsBarrel(eta, sources.endpointsBarrel, { modules });
    await writeStaged(endpointsDir, 'index.ts', barrel, writtenFiles);
};

const emitFlatEndpoints = async (
    ir: IrModel,
    config: ApigenConfig,
    eta: ReturnType<typeof createEta>,
    sources: ResolvedTemplateSources,
    stagingDir: string,
    writtenFiles: string[],
): Promise<void> => {
    const namer = new RouteNamer();
    const rendered = ir.endpoints.map(e =>
        renderEndpoint(e, namer, config, eta, sources.endpointCall, sources.endpointDecl),
    );
    const orderedRendered = config.sortRoutes
        ? [...rendered].sort((a, b) => (a.functionName < b.functionName ? -1 : 1))
        : rendered;
    const typeRefs = new Set<string>();
    for (const r of orderedRendered) for (const t of r.typeRefs) typeRefs.add(t);

    const source = await renderEndpointsFile(eta, sources.endpointsFile, {
        config,
        typeImports: [...typeRefs].sort(),
        bundledTypeImports: collectBundledImports(config),
        typesImportFrom: `./${config.typesFileName}`,
        endpoints: orderedRendered.map(r => r.source),
    });
    await writeStaged(stagingDir, 'endpoints.ts', source, writtenFiles);
};

const collectBundledImports = (config: ApigenConfig): readonly string[] => {
    const names: string[] = [];
    if (config.useNullableToOptional) names.push('NullableToOptional');
    if (config.isNotNullResponse) names.push('RequiredData');
    return names;
};

// ----------------------------- Utilities ----------------------------------

const groupByFirstTag = (
    endpoints: readonly IrEndpoint[],
): ReadonlyMap<string, readonly IrEndpoint[]> => {
    const out = new Map<string, IrEndpoint[]>();
    for (const e of endpoints) {
        const tag = e.tag || 'Default';
        let list = out.get(tag);
        if (!list) {
            list = [];
            out.set(tag, list);
        }
        list.push(e);
    }
    return out;
};

/**
 * `FSLogix` → `FsLogix`, `CPCConfig` → `CpcConfig`. Any run of 2+ uppercase
 * letters immediately followed by a lowercase letter is downcased except for
 * the first letter of the run. Preserves trailing acronyms (`CPC` stays `CPC`).
 */
const normalizeTagIdent = (tag: string): string =>
    tag.replaceAll(/([A-Z])([A-Z]+)([a-z])/g, (_m, first, middle, lower) => {
        const middleLower = (middle as string).slice(0, -1).toLowerCase();
        const carryover = (middle as string).slice(-1);
        return `${first}${middleLower}${carryover}${lower}`;
    });

const writeStaged = async (
    dir: string,
    fileName: string,
    contents: string,
    written: string[],
): Promise<void> => {
    const abs = resolve(dir, fileName);
    await writeFile(abs, contents, 'utf8');
    written.push(abs);
};

const atomicSwap = async (stagingDir: string, outDir: string): Promise<void> => {
    // rename() requires the parent directory to exist.
    await mkdir(dirname(outDir), { recursive: true });
    await rm(outDir, { recursive: true, force: true });
    try {
        await rename(stagingDir, outDir);
    } catch (err) {
        // Cross-device (EXDEV) — copy then remove the source.
        if (isEXDEV(err)) {
            await cp(stagingDir, outDir, { recursive: true });
            await rm(stagingDir, { recursive: true, force: true });
            return;
        }
        throw err;
    }
};

const isEXDEV = (err: unknown): boolean =>
    typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'EXDEV';
