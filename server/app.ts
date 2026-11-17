// Wires hopkins into the plugin host: settings, the agent tools, the app's
// RPCs, its own daemon connection and the scheduler. Nothing here may throw
// into Paseo: a throwing session-open hook would stop agents from opening.

import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import type { TodayView } from "../shared/model";
import { actRpc, todayRpc, todayWatch } from "../shared/rpc";
import { hopkinsSettings, settingsSchema, type HopkinsSettings } from "../shared/settings";
import { resolveConfig, type Config } from "./config";
import { DeliveryQueue } from "./delivery";
import { consoleLogger, errorText, type Logger } from "./log";
import { HopkinsMcpServer, MCP_SERVER_NAME } from "./mcp-server";
import { PaseoLink } from "./paseo-link";
import { Reminders, systemClock, type Clock } from "./reminders";
import { Scheduler } from "./scheduler";
import { defaultDataDir, Store } from "./store";
import { PaseoThreadPort } from "./thread-port";
import { buildToday } from "./today";
import { createTools } from "./tools";

export interface StartOptions {
  dataDir?: string;
  log?: Logger;
  clock?: Clock;
  tickMs?: number;
}

export function startHopkins(server: PluginServerContext, options: StartOptions = {}): () => void {
  const log = options.log ?? consoleLogger;
  const clock = options.clock ?? systemClock;
  const dataDir = options.dataDir ?? defaultDataDir();

  const store = new Store(dataDir, log);
  store.load();

  let config: Config = resolveConfig(settingsSchema.parse({}), dataDir);
  const getConfig = () => config;

  const reminders = new Reminders(store, clock, getConfig);
  const link = new PaseoLink(log, () => onConnected());
  const port = new PaseoThreadPort(link, store, getConfig, log);
  const queue = new DeliveryQueue(store, reminders, () => (link.connected ? port : null), clock, getConfig, log);
  const scheduler = new Scheduler(reminders, queue, clock, getConfig, log);

  // --- Today view and live watchers ------------------------------------------------

  const watchers = new Set<(view: TodayView) => void>();
  const problems = (): string[] => [
    ...(link.connected ? [] : [`Not connected to Paseo yet${link.lastError ? ` (${link.lastError})` : ""}.`]),
    ...(link.connected && !link.own ? ["Running on a fallback connection: a reminder may not buzz while an earlier one is unread."] : []),
    ...queue.problems(clock.now()),
    ...(config.paused ? ["Paused: reminders are held until you resume them in settings."] : []),
  ];
  const today = (): TodayView =>
    buildToday(store, reminders, config, clock.now(), {
      running: scheduler.running,
      lastTickAt: scheduler.lastTickAt,
      connected: link.connected,
      problems: problems(),
    });
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  const notifyWatchers = () => {
    if (notifyTimer || watchers.size === 0) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      const view = today();
      for (const push of watchers) push(view);
    }, 100);
  };
  const changed = () => {
    void scheduler.tick().then(notifyWatchers);
    notifyWatchers();
  };

  // --- Settings ------------------------------------------------------------------

  const applySettings = (state: PluginSettingsState<typeof settingsSchema>) => {
    if (state.status === "ready") {
      config = resolveConfig(state.values as HopkinsSettings, dataDir);
    } else {
      log.warn("settings are invalid; keeping the previous ones", { error: state.error });
    }
  };
  const settings = server.registerSettings(hopkinsSettings);
  void settings
    .read()
    .then((state) => {
      applySettings(state);
      changed();
    })
    .catch((err) => log.warn("could not read settings", { error: errorText(err) }));
  const unsubscribeSettings = settings.subscribe((state) => {
    applySettings(state);
    changed();
  });

  // --- Connection ----------------------------------------------------------------

  let threadChecked = false;
  function onConnected(): void {
    if (!threadChecked) {
      threadChecked = true;
      // Create the hopkins conversation up front, so it is there before the first reminder.
      void port
        .ensureThread()
        .then(() => notifyWatchers())
        .catch((err) => {
          threadChecked = false;
          log.warn("could not set up the hopkins conversation yet", { error: errorText(err) });
        });
    }
    changed();
  }

  // --- Agent tools -----------------------------------------------------------------

  const tools = createTools({
    reminders,
    config: getConfig,
    clock,
    isThread: (agentId) => agentId === store.threadAgentId(),
    changed,
  });

  // Providers whose sessions take an extra MCP server. Pi refuses MCP servers (the open
  // would fail) and Antigravity takes none, so they are left alone.
  const MCP_PROVIDERS = new Set(["claude", "codex", "opencode"]);
  const mcp = new HopkinsMcpServer(tools, log, () => link.api);
  void mcp
    .start()
    .then(() => log.info("tools ready", { port: mcp.port }))
    .catch((err) => log.error("could not start the tools server", { error: errorText(err) }));

  server.addHook("agent.open.before", async ({ request }, context) => {
    // Never throws: a failing session-open hook stops the agent from opening.
    try {
      link.adopt(context.paseo);
      if (request.purpose !== "interactive") return request;
      mcp.remember({ id: request.agentId, workspaceId: request.workspaceId, cwd: request.cwd, title: request.title, provider: request.provider });
      if (!MCP_PROVIDERS.has(request.provider) || !mcp.ready || request.mcpServers[MCP_SERVER_NAME]) return request;
      request.mcpServers[MCP_SERVER_NAME] = mcp.configFor(request.agentId);
      return request;
    } catch (err) {
      log.error("could not attach the hopkins tools", { error: errorText(err) });
      return undefined;
    }
  });

  // --- App RPCs ------------------------------------------------------------------------

  server.handle(todayRpc, async (_input, context) => {
    link.adopt(context.paseo);
    return today();
  });

  server.handle(actRpc, async (input, context) => {
    link.adopt(context.paseo);
    const result =
      input.action === "snooze"
        ? reminders.change(input.id, { when: input.until?.trim() || "in 1h" })
        : reminders.close(input.id, input.action === "done" ? "done" : "dropped");
    if (!result.ok) return { ok: false, message: result.error };
    changed();
    return { ok: true, message: result.confirmation };
  });

  server.handle(todayWatch, async (_input, context) => {
    link.adopt(context.paseo);
    const push = (view: TodayView) => {
      void context.push(view).catch(() => watchers.delete(push));
    };
    watchers.add(push);
    push(today());
    context.signal.addEventListener("abort", () => watchers.delete(push), { once: true });
  });

  // --- Start ----------------------------------------------------------------------------

  link.start();
  scheduler.start(options.tickMs ?? 15_000);
  const refresh = setInterval(notifyWatchers, 30_000);
  (refresh as { unref?: () => void }).unref?.();
  log.info("started", { reminders: store.reminders().length });

  return () => {
    scheduler.stop();
    mcp.stop();
    clearInterval(refresh);
    if (notifyTimer) clearTimeout(notifyTimer);
    unsubscribeSettings();
    watchers.clear();
    void link.stop();
    try {
      store.save();
    } catch (err) {
      log.error("final save failed", { error: errorText(err) });
    }
  };
}
