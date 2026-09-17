import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { renderType } from "../src/emit/decl.ts";

describe("renderType", () => {
  it("emits dictionary schemas as a type alias when interfaces are enabled", () => {
    const source = renderType(
      {
        kind: "object",
        name: "JsonElement",
        properties: [],
        additionalProperties: true,
        extends: [],
        deprecated: false,
      },
      { ...DEFAULT_CONFIG, useInterface: true },
    );

    expect(source).toBe("export type JsonElement = Record<string, unknown>;\n");
  });
});
