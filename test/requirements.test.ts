import fs from "node:fs";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { describe, expect, it } from "vitest";

// Paseo checks requirements.paseo twice: the daemon against its own version before it loads
// hopkins, and every app against ITS OWN version before it runs hopkins's screens. The apps
// update themselves, so they run ahead of the daemon. When the desktop and Android apps moved to
// 0.17.4 while the daemon stayed on 0.16.1, "^0.16.1" (0.16.x only) made both apps drop the
// sidebar entry, the Today screen and the settings, while the conversation went on working.
const manifest = JSON.parse(fs.readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8"));
const check = (runtime: "daemon" | "app", version: string) => () =>
  assertPluginCompatibility({ id: manifest.id, requirements: manifest.requirements, version, runtime });

describe("the Paseo versions hopkins asks for", () => {
  it("let an app that updated itself past the daemon show hopkins", () => {
    for (const version of ["0.16.1", "0.16.2", "0.17.4", "0.18.0"]) expect(check("app", version)).not.toThrow();
  });

  it("still load hopkins on the daemon it is built against", () => {
    expect(check("daemon", "0.16.1")).not.toThrow();
  });

  it("still refuse a Paseo older than the plugin API hopkins uses", () => {
    expect(check("app", "0.15.4")).toThrow("requires Paseo");
    expect(check("daemon", "0.16.0")).toThrow("requires Paseo");
  });
});
