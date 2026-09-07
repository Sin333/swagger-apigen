import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseOpenApi, parseOpenApiFile } from '../src/parse.ts';

const here = resolve(fileURLToPath(import.meta.url), '..');
const petstorePath = resolve(here, 'fixtures/petstore.json');

describe('parseOpenApiFile', () => {
    it('parses the petstore fixture without errors', async () => {
        const result = await parseOpenApiFile(petstorePath);

        expect(result.format).toBe('json');
        expect(result.document.openapi).toBe('3.0.0');
        expect(result.document.info.title).toBe('Petstore');
        expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    });

    it('collects the expected paths and schemas', async () => {
        const { document } = await parseOpenApiFile(petstorePath);

        expect(document.paths.size).toBe(3);
        expect([...document.paths.keys()].sort()).toEqual(['/pets', '/pets/{id}', '/status']);
        expect(document.components.schemas.size).toBe(4);
        expect([...document.components.schemas.keys()].sort()).toEqual([
            'NewPet',
            'Pet',
            'PetKind',
            'StatusInfo',
        ]);
    });
});

describe('parseOpenApi (from string)', () => {
    it('accepts an inline JSON document', async () => {
        const raw = JSON.stringify({
            openapi: '3.0.0',
            info: { title: 't', version: '1' },
            paths: {},
            components: { schemas: {} },
        });
        const result = await parseOpenApi(raw);

        expect(result.format).toBe('json');
        expect(result.document.paths.size).toBe(0);
        expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    });
});

describe('OpenAPI 3.1 support', () => {
    const wrap = (schemas: Record<string, unknown>): string =>
        JSON.stringify({
            openapi: '3.1.0',
            info: { title: 't', version: '1' },
            paths: {},
            components: { schemas },
        });

    it('accepts a 3.1.x version string', () => {
        const result = parseOpenApi(wrap({}));
        expect(result.document.openapi).toBe('3.1.0');
        expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    });

    it('rejects versions outside 3.0.x / 3.1.x / 3.2.x', () => {
        expect(() =>
            parseOpenApi(
                JSON.stringify({ openapi: '3.3.0', info: { title: 't', version: '1' }, paths: {} }),
            ),
        ).toThrow(/Only 3\.0\.x, 3\.1\.x and 3\.2\.x/);

        expect(() =>
            parseOpenApi(
                JSON.stringify({ swagger: '2.0', info: { title: 't', version: '1' }, paths: {} }),
            ),
        ).toThrow(/Missing required "openapi"/);
    });

    it('accepts a 3.2.x version string but attaches a warning diagnostic', () => {
        const result = parseOpenApi(
            JSON.stringify({
                openapi: '3.2.0',
                info: { title: 't', version: '1' },
                paths: {},
                components: { schemas: {} },
            }),
        );

        expect(result.document.openapi).toBe('3.2.0');
        expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(
            result.diagnostics.some(
                d => d.severity === 'warning' && d.message.includes('OpenAPI 3.2'),
            ),
        ).toBe(true);
    });

    it('folds `type: ["string", "null"]` into nullable primitive', () => {
        const result = parseOpenApi(wrap({ MaybeName: { type: ['string', 'null'] } }));
        const node = result.document.components.schemas.get('MaybeName');

        expect(node?.kind).toBe('string');
        expect(node?.nullable).toBe(true);
        expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    });

    it('keeps a plain string `type` untouched in 3.1', () => {
        const result = parseOpenApi(wrap({ Name: { type: 'string' } }));
        const node = result.document.components.schemas.get('Name');

        expect(node?.kind).toBe('string');
        expect(node?.nullable).toBe(false);
    });

    it('accepts `type: ["null"]` as a nullable schema', () => {
        const result = parseOpenApi(wrap({ Null: { type: ['null'] } }));
        const node = result.document.components.schemas.get('Null');

        expect(node?.nullable).toBe(true);
    });

    it('warns on primitive type unions and marks the schema nullable if `null` is present', () => {
        const result = parseOpenApi(
            wrap({ Mixed: { type: ['string', 'integer', 'null'] } }),
        );
        const node = result.document.components.schemas.get('Mixed');

        expect(node?.nullable).toBe(true);
        expect(
            result.diagnostics.some(
                d => d.severity === 'warning' && d.message.includes('type union'),
            ),
        ).toBe(true);
    });
});
