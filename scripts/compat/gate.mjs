// Paseo's own plugin gate, taken from the installed @getpaseo/protocol (the release under test) and
// run on hopkins's manifest the way that release's daemon and apps run it.
//
//   node scripts/compat/gate.mjs <paseo version>
//
// Exit 0: both welcome hopkins. Exit 2: only the declared range is in the way; a wider one would be
// welcome, and it is printed as `range=<…>` (for $GITHUB_OUTPUT). Exit 1: refused for another reason.
import { readFileSync } from "node:fs";
import { assertPluginCompatibility, validatePluginRequirements } from "@getpaseo/protocol/plugin-requirements";

const version = process.argv[2];
if (!version) {
  console.error("usage: gate.mjs <paseo version>");
  process.exit(64);
}
const manifest = JSON.parse(readFileSync(new URL("../../paseo-plugin.json", import.meta.url), "utf8"));

function refusal(requirements) {
  try {
    validatePluginRequirements(requirements);
    for (const runtime of ["daemon", "app"]) assertPluginCompatibility({ id: manifest.id, requirements, version, runtime });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const declared = manifest.requirements?.paseo;
const why = refusal(manifest.requirements);
if (!why) {
  console.log(`Paseo ${version} (daemon and apps) accepts hopkins (requires paseo ${declared}).`);
  process.exit(0);
}
// Open-ended from the same minimum, as `paseo plugin init` writes it.
const min = String(declared ?? "").match(/\d+\.\d+\.\d+/)?.[0];
const wider = min ? `>=${min}` : null;
if (wider && wider !== declared && !refusal({ ...manifest.requirements, paseo: wider })) {
  console.log(`Paseo ${version} refuses hopkins only because of its declared range (${declared}): ${why}`);
  console.log(`range=${wider}`);
  process.exit(2);
}
console.log(`Paseo ${version} refuses hopkins: ${why}`);
process.exit(1);
