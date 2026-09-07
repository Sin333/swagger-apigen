import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generate } from '../src/pipeline.ts';

const here = resolve(fileURLToPath(import.meta.url), '..');
const petstorePath = resolve(here, 'fixtures/petstore.json');

let outDir: string;

beforeAll(async () => {
    outDir = await mkdtemp(resolve(tmpdir(), 'apigen-pipeline-'));
});

afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe('generate (end-to-end)', () => {
    it('writes a types file, endpoints bundle, and root index', async () => {
        const result = await generate({
            input: petstorePath,
            outDir,
            config: {
                typePrefix: 'Api',
                separateEndpointsByTag: true,
                sortRoutes: true,
                sortTypes: true,
                useNullableToOptional: true,
                isNotNullResponse: true,
                typesFileName: 'types',
            },
        });

        expect(result.parseDiagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(result.irDiagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(result.writtenFiles.length).toBeGreaterThan(0);

        const written = result.writtenFiles.map(f => f.replaceAll('\\', '/'));
        expect(written.some(f => f.endsWith('/types.ts'))).toBe(true);
        expect(written.some(f => f.endsWith('/index.ts'))).toBe(true);
        expect(written.some(f => f.endsWith('/endpoints/index.ts'))).toBe(true);
    });

    it('emits ApiPet with the typePrefix and preserves enum members', async () => {
        const typesSrc = await readFile(resolve(outDir, 'types.ts'), 'utf8');

        expect(typesSrc).toContain('ApiPet');
        expect(typesSrc).toContain('ApiPetKind');
        expect(typesSrc).toMatch(/Dog|dog/);
    });

    it('emits both Pets and System tag files with expected function names', async () => {
        const petsSrc = await readFile(resolve(outDir, 'endpoints/Pets.ts'), 'utf8');
        const sysSrc = await readFile(resolve(outDir, 'endpoints/System.ts'), 'utf8');

        expect(petsSrc).toContain('getApiListPets');
        expect(petsSrc).toContain('postApiCreatePet');
        expect(petsSrc).toContain('getApiGetPetById');
        expect(sysSrc).toContain('getApiGetStatus');
    });
});
