import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Paseo builds a plugin from its directory and supplies only these packages itself
// (its compiler's runtime boundary). Anything else must be installed beside the
// plugin, and an installed copy of hopkins, a git checkout or a Nix store path, has
// no node_modules. That holds for `import type` too: Paseo resolves type imports.
const SUPPLIED = [
  /^@getpaseo\/plugin(\/server(\/(provider|usage|acp))?|\/client(\/(ui|react-native))?)?$/,
  /^(zod|react|react-native|@tanstack\/react-query)(\/|$)/,
  /^node:/,
];

const root = fileURLToPath(new URL("..", import.meta.url));

function pluginSources(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
    });
  return [
    path.join(root, "index.server.ts"),
    path.join(root, "index.client.tsx"),
    ...["server", "shared", "client"].flatMap((d) => walk(path.join(root, d))),
  ];
}

/** Package specifiers the file imports (static, type-only, re-exports, dynamic), as TypeScript reads them. */
function packageImports(source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((f) => f.fileName)
    .filter((s) => !s.startsWith(".") && !path.isAbsolute(s));
}

describe("what the plugin imports", () => {
  it("is only what Paseo supplies, so a copy with no node_modules still builds", () => {
    const files = pluginSources();
    const imports = files.flatMap((file) =>
      packageImports(fs.readFileSync(file, "utf8")).map((spec) => ({ file: path.relative(root, file), spec })),
    );
    // The scan sees the real code: the server SDK is imported somewhere, so an empty result means the scan broke.
    expect(files.length).toBeGreaterThan(20);
    expect(imports.some((i) => i.spec === "@getpaseo/plugin/server")).toBe(true);

    const notSupplied = imports.filter((i) => !SUPPLIED.some((r) => r.test(i.spec)) && !builtinModules.includes(i.spec));
    expect(notSupplied).toEqual([]);
  });

  it("would catch the type import that once kept hopkins from loading", () => {
    expect(packageImports(`import type { PaseoApi } from "@getpaseo/client";`)).toEqual(["@getpaseo/client"]);
    expect(packageImports(`// import type { PaseoApi } from "@getpaseo/client";`)).toEqual([]);
  });
});
