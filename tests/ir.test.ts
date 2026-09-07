import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildIr } from '../src/ir/index.ts';
import { parseOpenApiFile } from '../src/parse.ts';

const here = resolve(fileURLToPath(import.meta.url), '..');
const petstorePath = resolve(here, 'fixtures/petstore.json');

describe('buildIr', () => {
    it('builds an IR model without errors', async () => {
        const { document } = await parseOpenApiFile(petstorePath);
        const ir = buildIr(document);

        expect(ir.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(ir.unresolvedRefs.size).toBe(0);
    });

    it('collects named types and endpoints', async () => {
        const { document } = await parseOpenApiFile(petstorePath);
        const ir = buildIr(document);

        expect([...ir.types.keys()].sort()).toEqual(['NewPet', 'Pet', 'PetKind', 'StatusInfo']);
        expect(ir.endpoints).toHaveLength(4);

        const methods = ir.endpoints.map(e => `${e.method.toUpperCase()} ${e.path}`).sort();
        expect(methods).toEqual([
            'GET /pets',
            'GET /pets/{id}',
            'GET /status',
            'POST /pets',
        ]);
    });

    it('classifies PetKind as an enum', async () => {
        const { document } = await parseOpenApiFile(petstorePath);
        const ir = buildIr(document);

        const kind = ir.types.get('PetKind');
        expect(kind?.kind).toBe('enum');
    });
});
