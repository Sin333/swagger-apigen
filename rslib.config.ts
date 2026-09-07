import { defineConfig } from '@rslib/core';

/**
 * ESM stays the primary format (Node 24+, native), CJS is the fallback for
 * legacy consumers. Templates and `runtime/types.ts` ship as static files so
 * the same file-based lookup used in dev keeps working after build.
 */
export default defineConfig({
    source: {
        entry: {
            index: ['./src/**/*.ts', '!./src/**/*.test.ts'],
        },
    },
    output: {
        target: 'node',
        externals: ['eta', 'yaml'],
        cleanDistPath: true,
    },
    syntax: 'es2022',
    bundle: false,
    shims: { esm: { __dirname: true, __filename: true } },
    lib: [
        {
            format: 'esm',
            dts: { bundle: false },
            output: {
                distPath: { root: 'dist/esm' },
                copy: [
                    { from: './templates', to: '../templates' },
                    { from: './src/runtime/types.ts', to: './runtime/types.ts' },
                ],
            },
        },
        {
            format: 'cjs',
            dts: false,
            output: {
                distPath: { root: 'dist/cjs' },
                copy: [{ from: './src/runtime/types.ts', to: './runtime/types.ts' }],
            },
        },
    ],
});
