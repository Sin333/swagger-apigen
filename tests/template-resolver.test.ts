import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveTemplateSources } from '../src/emit/template-resolver.ts';

let workDir: string;

beforeEach(async () => {
    workDir = await mkdtemp(resolve(tmpdir(), 'apigen-tpl-'));
});

afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('resolveTemplateSources', () => {
    it('falls back to library defaults when no overrides are given', () => {
        const sources = resolveTemplateSources();

        expect(sources.typesFile.length).toBeGreaterThan(0);
        expect(sources.endpointsFile).toContain('import');
        expect(sources.endpointCall).toContain('fetchApi');
    });

    it('prefers `dir` overrides when a matching file exists', async () => {
        await writeFile(resolve(workDir, 'endpoint-call.eta'), 'CUSTOM_CALL', 'utf8');

        const sources = resolveTemplateSources({ dir: workDir });

        expect(sources.endpointCall).toBe('CUSTOM_CALL');
        expect(sources.endpointsFile).toContain('import');
    });

    it('prefers explicit per-file paths over `dir`', async () => {
        await writeFile(resolve(workDir, 'endpoint-call.eta'), 'DIR_CALL', 'utf8');
        const explicitPath = resolve(workDir, 'custom.eta');
        await writeFile(explicitPath, 'EXPLICIT_CALL', 'utf8');

        const sources = resolveTemplateSources({ dir: workDir, endpointCall: explicitPath });

        expect(sources.endpointCall).toBe('EXPLICIT_CALL');
    });
});
