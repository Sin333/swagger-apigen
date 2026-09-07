# apigen

Custom OpenAPI 3.0 / 3.1 / 3.2 → TypeScript code generator with pluggable [Eta](https://eta.js.org) templates.

Turns a `swagger.json` / `openapi.yaml` into a tree of typed TS files —
one `*-types.ts` module with every schema, plus one endpoint file per tag
(or a single flat file). Every emitted line is produced by a template you
can override.

- Native Node `.ts` execution — no bundler required.
- Zero runtime dependency on `swagger-typescript-api`, `openapi-typescript`,
  or `openapi-typescript-codegen`.
- Ships ESM + CJS + `.d.ts` bundles.

## Supported inputs

- **OpenAPI 3.0.x** and **OpenAPI 3.1.x** — first-class support. JSON or
  YAML, from a local path or an `http(s)://` URL. Format is auto-detected
  from the file extension and content (override with the
  `format: 'json' | 'yaml'` option). The version is picked up from the
  top-level `openapi` string — no need to tell the parser which one you're
  feeding it.
- **OpenAPI 3.2.x** — optimistic pass-through. The schema-level parser
  reuses the 3.1 code path (since 3.2 keeps JSON Schema draft 2020-12
  unchanged), which is enough for the overwhelming majority of documents.
  Non-schema-level 3.2 additions — the `QUERY` HTTP method, `sessionCookie`
  security scheme, path `arrayItem` serialization style, and other new
  metadata fields — are silently dropped, and the parser attaches a
  warning diagnostic to `/openapi` so the caller can decide whether to
  proceed.
- **3.1-specific**: `type: ["string", "null"]` (and other single-type +
  `"null"` arrays) folds into a single primitive with `nullable: true`, so
  the emitter behaves the same as it does for 3.0's `nullable: true`.
  Multi-primitive unions like `type: ["string", "integer"]` emit a warning
  and fall back to `unknown`.
- **Not supported**: `webhooks` (top-level, ignored), `$dynamicRef`,
  `if`/`then`/`else`, `unevaluatedProperties`, and other JSON Schema
  draft-2020-12 keywords the IR doesn't model. If you hit one of them the
  parse phase surfaces a warning diagnostic; the emit phase silently omits
  the affected constraint.
- **Swagger / OpenAPI 2.0** — **not supported.** A different top-level
  shape (`definitions`, `host + basePath`, `parameters` collections) —
  convert first with a tool like [`swagger2openapi`](https://www.npmjs.com/package/swagger2openapi).

## Install

```sh
npm install apigen
# or
yarn add apigen
# or
pnpm add apigen
```

## Using it in your project

### 1. Add the dependency

```sh
npm install --save-dev apigen
```

### 2. Register a script in `package.json`

```json
{
    "scripts": {
        "apigen": "node scripts/run-apigen.ts"
    }
}
```

Node 24+ runs `.ts` natively. On older Node, either compile the runner
first or wrap it with `tsx` / `ts-node`.

### 3. Create the runner file (`scripts/run-apigen.ts`)

```ts
import { resolve } from 'node:path';
import { ApiGen } from 'apigen';

const result = await ApiGen.generate({
    input: resolve('swagger.json'),                    // path or http(s) URL
    outDir: resolve('src/api/generated'),
    // Point at one of the shipped examples \u2014 or your own folder
    templates: {
        dir: resolve('node_modules/apigen/examples/templates-class'),
    },
    config: {
        typePrefix: 'Api',
        separateEndpointsByTag: true,
        useNullableToOptional: true,
        isNotNullResponse: true,
        typesFileName: 'api-generated-types',
    },
});

const errors = [...result.parseDiagnostics, ...result.irDiagnostics]
    .filter(d => d.severity === 'error');
if (errors.length > 0) {
    for (const d of errors) console.error(`  ${d.pointer}: ${d.message}`);
    process.exit(1);
}

console.info(
    `apigen: wrote ${result.writtenFiles.length} file(s) in ${result.durationMs.toFixed(1)} ms`,
);
```

### 4. Run it

```sh
npm run apigen
```

## Quick start

```ts
import { ApiGen } from 'apigen';

const result = await ApiGen.generate({
    input: './swagger.json',              // path or http(s) URL
    outDir: './src/api/generated',
    config: {
        typePrefix: 'Api',
        separateEndpointsByTag: true,
        useNullableToOptional: true,
        isNotNullResponse: true,
        atomicSwap: true,
        typesFileName: 'api-generated-types',
    },
});

console.log(`wrote ${result.writtenFiles.length} files in ${result.durationMs.toFixed(0)} ms`);
```

Diagnostics from parse + IR stages are surfaced on the result:

```ts
const errors = [...result.parseDiagnostics, ...result.irDiagnostics]
    .filter(d => d.severity === 'error');
if (errors.length > 0) process.exit(1);
```

## Public API

```ts
import { ApiGen } from 'apigen';

ApiGen.generate(options)          // full pipeline: read → parse → IR → emit
ApiGen.parseOpenApiFile(path)     // parse only, returns typed AST + diagnostics
ApiGen.parseOpenApi(rawText)
ApiGen.buildIr(document)          // OpenAPI AST → intermediate representation
ApiGen.emit(ir, options)          // IR → files (used internally by generate)
ApiGen.DEFAULT_CONFIG
ApiGen.withDefaults(partial)      // merge partial config with defaults
```

Flat re-exports of the same functions are also available:
`generate`, `parseOpenApi`, `parseOpenApiFile`, `buildIr`, `emit`.

## Config

`ApigenConfig` — every knob is optional, sensible defaults in `DEFAULT_CONFIG`:

| Field | Default | Purpose |
|---|---|---|
| `typePrefix` | `''` | Prefix added to every generated type name. |
| `typesFileName` | `'types'` | Filename (without extension) for the types module. |
| `sortTypes` | `true` | Alphabetically sort top-level type declarations. |
| `sortRoutes` | `true` | Alphabetically sort endpoints by function name. |
| `sortProperties` | `true` | Alphabetically sort object properties. |
| `useInterfaceForObjects` | `false` | Emit `interface X extends A { … }` instead of `type X = A & { … }`. |
| `useUnsafeRecord` | `false` | Bundle `UnsafeRecord<K,V>` and emit it in place of `Record`. |
| `useNullableToOptional` | `false` | Bundle `NullableToOptional<T>` and wrap request bodies with it. |
| `isNotNullResponse` | `false` | Bundle `RequiredData<T>` and wrap response types with it. |
| `separateEndpointsByTag` | `true` | One file per OpenAPI tag (`false` → single `endpoints.ts`). |
| `atomicSwap` | `true` | Emit to a temp dir, then `rename` over the target — IDE/git see one event and stale files from previous runs are wiped. Set `false` to write directly on top of `outDir` (files still get overwritten in place, only orphans stay behind). |

## Templates

`apigen` ships six default `.eta` templates in the tarball (`dist/templates/`).
Every one of them can be replaced individually or as a set.

```ts
import { resolve } from 'node:path';
import { ApiGen } from 'apigen';

await ApiGen.generate({
    input: './swagger.json',
    outDir: './out',
    templates: {
        // point at a directory — missing files fall back to the shipped defaults
        dir: resolve('./my-templates'),

        // or override individual files (absolute paths, take priority over `dir`)
        endpointDecl: resolve('./my-templates/endpoint-decl.eta'),
        endpointCall: resolve('./my-templates/endpoint-call.eta'),
    },
});
```

### Template contract

| Template | Data (typed as) | Emits |
|---|---|---|
| `types-file.eta` | `TypesFileData` | The single `<typesFileName>.ts` module. |
| `endpoints-file.eta` | `EndpointsFileData` | One endpoint module (per tag or flat). |
| `endpoints-barrel.eta` | `EndpointsBarrelData` | `endpoints/index.ts` re-exporting each module. |
| `root-index.eta` | `RootIndexData` | Top-level `index.ts` for the generated tree. |
| `endpoint-decl.eta` | `EndpointDeclContext` | Shape of a single endpoint declaration. |
| `endpoint-call.eta` | `EndpointCallContext` | The HTTP call expression inside a declaration. |

Every context type is exported from the library. Refer to
[`src/emit/templates.ts`](./src/emit/templates.ts) and
[`src/emit/endpoint.ts`](./src/emit/endpoint.ts) for the exact fields each
template receives.

### Example: functional style

[`examples/templates-functional/`](./examples/templates-functional/) — one
arrow-function per endpoint, sharing an HTTP client you provide:

```ts
import { fetchMyCustom } from './fetch-my-custom';

export const getPets = (query: { limit: number }) =>
    fetchMyCustom<Pet[]>({
        uri: 'pets',
        method: 'GET',
        query,
    });
```

You supply `fetchMyCustom` — a single generic function taking
`{ uri, method, body?, query? }` and returning `Promise<T>`. Nothing else
is imported.

Wire the template set in:

```ts
import { resolve } from 'node:path';
import { ApiGen } from 'apigen';

await ApiGen.generate({
    input: './swagger.json',
    outDir: './out',
    templates: { dir: resolve('./examples/templates-functional') },
});
```

### Example: class with static methods

[`examples/templates-class/`](./examples/templates-class/) — every tag is
wrapped in a class; each method returns `Promise<T>` and delegates to a
single `__request({ method, url, body?, query? })` helper you provide:

```ts
import { request as __request } from './fetch-my-custom';

import type { Pet } from '../api-generated-types';

export class Service {
    public static getPets(query: { limit: number }): Promise<Pet[]> {
        return __request({
            method: 'GET',
            url: 'pets',
            query,
        });
    }
}
```

The barrel re-exports every `Service` class as `<PascalTag>Service`, so
callers do `PetsService.getPets({ limit: 10 })`.

## Runtime helpers

When the corresponding config flag is `true`, one of the following types
is inlined at the top of the generated types module (no runtime dependency
on `apigen` itself):

- `UnsafeRecord<K, V>` — index signature that does not widen missing keys
  to `undefined`.
- `NullableToOptional<T>` — recursively turns `k: T | null` into `k?: T`,
  used on request bodies so callers can skip nullable fields.
- `RequiredData<T>` — recursively strips `null`, used on responses so
  consumers don't have to guard every field.

## Scripts

```sh
npm run build       # rslib build → dist/{esm,cjs,templates}
npm run test        # vitest --watch
npm run test-ci     # vitest run
npm run typecheck   # tsc -b --force
```

`prepublishOnly` runs tests then build; a failing test blocks publish.

## Layout

```
apigen/
  package.json
  rslib.config.ts
  vitest.config.ts
  tsconfig.json
  templates/                 # default `.eta` templates shipped in dist/
  examples/
    templates-functional/    # arrow-function endpoints
    templates-class/         # class with static methods
  src/
    lib.ts                   # public entry point (re-exports ApiGen namespace)
    pipeline.ts              # generate() — one-call parse → IR → emit
    config.ts                # ApigenConfig, DEFAULT_CONFIG, withDefaults
    parse.ts                 # JSON/YAML → typed AST
    ir/                      # OpenAPI AST → IR
    emit/                    # IR → source strings (uses Eta templates)
    runtime/                 # types.ts + region-marker loader for bundled helpers
  tests/                     # vitest suites + petstore.json fixture
  dist/                      # populated by `npm run build`
```

## License

MIT
