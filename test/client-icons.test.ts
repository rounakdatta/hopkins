import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CUE_KIND } from "../shared/cue";

// The app looks a string icon up among lucide-react's exports, so it has to be a component
// name such as "BellPlus"; "bell-plus" or "bell" is refused. One refused icon fails the whole
// client bundle: no sidebar item, no screens, no settings (Paseo 0.16.1, desktop and phone).
const root = fileURLToPath(new URL("..", import.meta.url));

function clientFiles(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
    });
  return [path.join(root, "index.client.tsx"), ...walk(path.join(root, "client"))];
}

function iconNames(source: string): string[] {
  return [...source.matchAll(/\bicon\s*[=:]\s*\{?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
}

describe("client icons", () => {
  it("are Lucide component names, the only strings the app accepts", () => {
    const icons = clientFiles().flatMap((file) =>
      iconNames(fs.readFileSync(file, "utf8")).map((name) => ({ file: path.relative(root, file), name })),
    );
    // The scan sees the real code: the sidebar, settings and Today screen all draw icons.
    expect(icons.length).toBeGreaterThanOrEqual(5);
    expect(icons.filter((i) => !/^[A-Z][A-Za-z0-9]*$/.test(i.name))).toEqual([]);
  });

  it("would catch the names that once kept hopkins out of the app", () => {
    expect(iconNames(`client.addSettingsScreen({ id: "settings", icon: "bell" })`)).toEqual(["bell"]);
    expect(iconNames(`<Button icon="bell-plus" />`)).toEqual(["bell-plus"]);
  });
});

// The app also refuses ids and kinds that are not lowercase words joined by hyphens, and it
// refuses the whole client for one bad name, as it does for an icon.
describe("client ids and kinds", () => {
  const appRule = /^[a-z][a-z0-9-]*$/;
  it("follow the app's rule for names", () => {
    const entry = fs.readFileSync(path.join(root, "index.client.tsx"), "utf8");
    const ids = [...entry.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect([...ids, CUE_KIND].filter((name) => !appRule.test(name))).toEqual([]);
  });
});
