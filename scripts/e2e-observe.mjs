// Prints the dev daemon's attention events (the events that trigger phone
// pushes) with the notification text, so a test run can prove that every
// reminder would buzz. Usage: node scripts/e2e-observe.mjs <paseo-install-dir>
import { createRequire } from "node:module";
import path from "node:path";

const install = process.argv[2];
if (!install) {
  console.error("usage: node scripts/e2e-observe.mjs <dir containing node_modules/@getpaseo>");
  process.exit(2);
}
const req = createRequire(path.join(install, "node_modules", "@getpaseo", "cli", "package.json"));
const { createHostClient } = req("@getpaseo/client/node");
const { createPaseoApi } = req("@getpaseo/client");

const client = createHostClient(process.env.PASEO_LISTEN, {
  clientId: "hopkins-e2e-observer",
  clientType: "cli",
  password: process.env.PASEO_PASSWORD,
  reconnect: { enabled: true },
});
await client.connect();
const api = createPaseoApi(client);
void api;
const stamp = () => new Date().toISOString().slice(11, 19);
console.log(`${stamp()} observing ${process.env.PASEO_LISTEN}`);
client.onAgentAttentionRequired((p) => {
  console.log(`${stamp()} attention agent=${String(p.agentId).slice(0, 7)} reason=${p.reason} shouldNotify=${p.shouldNotify} title=${JSON.stringify(p.notification?.title ?? null)} body=${JSON.stringify(p.notification?.body ?? null)}`);
});
// Ask the daemon to send attention events to this client, as the apps do.
api.observeEvents(["agent_attention_required"], { notifications: true });
setInterval(() => {}, 60_000);
