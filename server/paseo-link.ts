// hopkins's own connection to the daemon.
//
// A plugin's server code gets a Paseo handle only inside hooks and RPC handlers,
// so a reminder due at 7am after a night-time restart would otherwise wait for
// someone to open the app. hopkins opens its own client at startup instead,
// loading the client library from the daemon's own install so it always
// matches the daemon's version (no bundled copy, no extra dependency).

import { createRequire } from "node:module";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { errorText, type Logger } from "./log";

/**
 * The daemon's client API, named through the plugin SDK. Paseo only builds a plugin
 * whose imports it supplies itself or can resolve beside the plugin, and nothing is
 * installed beside an installed copy of hopkins: `import type … from "@getpaseo/client"`
 * built from the repo, where node_modules has it, and failed everywhere else.
 */
export type PaseoApi = PluginHookContext["paseo"];

/** The parts of DaemonClient hopkins uses. */
export interface DaemonLike {
  connect?(): Promise<void>;
  close?(): Promise<void>;
  clearAgentAttention(agentId: string | string[]): Promise<void>;
  /** Ends an agent's current turn (the plugin API has no such call). */
  cancelAgent?(agentId: string): Promise<void>;
}

interface ClientModules {
  createHostClient: (connection: string, config: Record<string, unknown>) => DaemonLike;
  createPaseoApi: (client: DaemonLike) => PaseoApi;
}

function loadClientModules(): ClientModules {
  // In the plugin child, argv[1] is the daemon's plugin-process.js, which resolves the daemon's own packages.
  const mainFile = typeof require !== "undefined" ? require.main?.filename : undefined;
  const bases = [process.argv[1], mainFile, `${process.cwd()}/index.js`].filter((b): b is string => Boolean(b));
  let lastError: unknown;
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const node = req("@getpaseo/client/node") as { createHostClient: ClientModules["createHostClient"] };
      const client = req("@getpaseo/client") as { createPaseoApi: ClientModules["createPaseoApi"] };
      return { createHostClient: node.createHostClient, createPaseoApi: client.createPaseoApi };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`could not load @getpaseo/client from the daemon install (${errorText(lastError)})`);
}

const RETRY_SECONDS = [2, 5, 15, 30, 60];

export class PaseoLink {
  api: PaseoApi | null = null;
  daemon: DaemonLike | null = null;
  /** True when the API came from hopkins's own connection rather than a hook. */
  own = false;
  lastError: string | null = null;
  private stopped = false;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly log: Logger,
    private readonly onReady: () => void,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get connected(): boolean {
    return this.api !== null;
  }

  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.own) return;
    try {
      const listen = this.env.PASEO_LISTEN;
      if (!listen) throw new Error("PASEO_LISTEN is not set in the plugin environment");
      const modules = loadClientModules();
      const daemon = modules.createHostClient(listen, {
        clientId: "hopkins",
        clientType: "cli",
        ...(this.env.PASEO_PASSWORD ? { password: this.env.PASEO_PASSWORD } : {}),
        reconnect: { enabled: true, baseDelayMs: 1_000, maxDelayMs: 30_000 },
        suppressSendErrors: true,
      });
      if (daemon.connect) await daemon.connect();
      if (this.stopped) {
        await daemon.close?.();
        return;
      }
      this.daemon = daemon;
      this.api = modules.createPaseoApi(daemon);
      this.own = true;
      this.lastError = null;
      this.log.info("connected to the daemon");
      this.onReady();
    } catch (err) {
      this.lastError = errorText(err);
      const wait = RETRY_SECONDS[Math.min(this.attempts, RETRY_SECONDS.length - 1)]!;
      this.attempts++;
      this.log.warn("daemon connection failed; retrying", { inSeconds: wait, error: this.lastError });
      this.retry = setTimeout(() => void this.connect(), wait * 1_000);
      (this.retry as { unref?: () => void }).unref?.();
    }
  }

  /** Fallback: use the handle a hook or RPC handler received, until our own connection is up. */
  adopt(api: PaseoApi): void {
    if (this.api || this.stopped) return;
    this.api = api;
    this.log.info("using the plugin host's connection until hopkins's own one is up");
    this.onReady();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.own) {
      try {
        await this.daemon?.close?.();
      } catch {
        // Shutting down anyway.
      }
    }
    this.api = null;
    this.daemon = null;
  }
}
