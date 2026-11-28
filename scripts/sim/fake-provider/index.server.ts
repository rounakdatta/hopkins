// Plain JavaScript on purpose (Paseo compiles this file as it is, so nothing has to be installed
// beside it). It registers one provider, `fakeagent`, that runs ../fake-agent.mjs as an ACP agent.
//
// A plugin cannot ask where its own folder is, so the daemon passes the agent's path in
// FAKE_AGENT_PATH; scripts/sim/env.sh sets it.
import { existsSync } from "node:fs";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

export default function fakeAgent(server) {
  const agent = process.env.FAKE_AGENT_PATH || "";
  const provider = runAcpProvider({
    id: "fakeagent",
    label: "Fake agent",
    description: "A scripted fake agent, for testing runs without real agents.",
    command: [process.execPath, agent || "fake-agent.mjs"],
  });
  server.registerProvider({
    ...provider,
    // The launch check only looks at node itself; say plainly when the script is missing.
    async status() {
      if (existsSync(agent)) return { available: true };
      return {
        available: false,
        diagnostic: `FAKE_AGENT_PATH is ${agent ? `${agent}, which does not exist` : "not set"}. Start the daemon with scripts/sim/daemon.sh.`,
      };
    },
  });
  return () => {};
}
