// Wires hopkins into the plugin host: settings, the agent tools, the app's
// RPCs, its own daemon connection and the scheduler. Nothing here may throw
// into Paseo: a throwing session-open hook would stop agents from opening.

import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import type { TodayView } from "../shared/model";
import { actRpc, backfillRpc, recapsRpc, suggestionRpc, todayRpc, todayWatch } from "../shared/rpc";
import { localDateOf, zonedToInstant } from "../shared/time";
import { hopkinsSettings, settingsSchema, type HopkinsSettings } from "../shared/settings";
import { Backfill } from "./backfill";
import { resolveConfig, scopeFor, type Config } from "./config";
import { defaultDeliveryOptions, DeliveryQueue, type RecapSource } from "./delivery";
import { consoleLogger, errorText, type Logger } from "./log";
import { AnthropicLlm, readKey } from "./llm";
import { HopkinsMcpServer, MCP_SERVER_NAME } from "./mcp-server";
import { LiveNoticer, Suggestions } from "./noticing";
import { PaseoLink } from "./paseo-link";
import { Recaps } from "./recaps";
import { Reminders, systemClock, type Clock } from "./reminders";
import { Scheduler } from "./scheduler";
import { defaultDataDir, Store } from "./store";
import { PaseoThreadPort, paseoTimelineReader } from "./thread-port";
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
  const recaps = new Recaps(store, reminders, clock, getConfig);
  const recapSource: RecapSource = {
    enabled: (kind) => recaps.enabled(kind),
    compose: async (kind, now) => {
      const startOfToday = zonedToInstant({ ...localDateOf(now, config.tz), hour: 0, minute: 0 }, config.tz);
      const workedOn = kind === "evening" ? await port.recentTitles(startOfToday) : [];
      return recaps.compose(kind, now, workedOn);
    },
    markSent: (kind, date) => recaps.markSent(kind, date),
  };
  const queue = new DeliveryQueue(store, reminders, () => (link.connected ? port : null), clock, getConfig, log, defaultDeliveryOptions, recapSource);
  const scheduler = new Scheduler(reminders, queue, clock, getConfig, log, recaps);

  // --- Noticing and backfill -----------------------------------------------------------

  const llm = new AnthropicLlm(() => ({ baseUrl: config.llmBaseUrl, model: config.llmModel }), () => readKey(dataDir));
  const suggestions = new Suggestions(store, reminders, clock, getConfig);
  const noticer = new LiveNoticer(store, suggestions, llm, () => paseoTimelineReader(link), clock, getConfig, log);
  const backfill = new Backfill(store, suggestions, llm, clock, getConfig, log);
  backfill.recover();

  // --- Today view and live watchers ------------------------------------------------

  const watchers = new Set<(view: TodayView) => void>();
  const problems = (): string[] => [
    ...(link.connected ? [] : [`Not connected to Paseo yet${link.lastError ? ` (${link.lastError})` : ""}.`]),
    ...(link.connected && !link.own ? ["Running on a fallback connection: a reminder may not buzz while an earlier one is unread."] : []),
    ...queue.problems(clock.now()),
    ...(config.paused ? ["Paused: reminders are held until you resume them in settings."] : []),
  ];
  const today = (): TodayView =>
    buildToday(
      store,
      reminders,
      config,
      clock.now(),
      { running: scheduler.running, lastTickAt: scheduler.lastTickAt, connected: link.connected, problems: problems() },
      { suggestions, available: llm.available && config.noticing, backfill: backfill.status() },
    );
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
    recaps,
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

  // A conversation finished a turn: note it, so noticing reads it once it settles.
  server.addHook("agent.turn.after", async ({ agent, outcome }) => {
    try {
      if (outcome.kind === "canceled" || agent.parentAgentId || agent.background || agent.id === store.threadAgentId()) return;
      noticer.touch(agent.id, scopeFor(agent.cwd, config.workRoots));
    } catch (err) {
      log.warn("could not note a finished turn", { error: errorText(err) });
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

  server.handle(recapsRpc, async (input, context) => {
    link.adopt(context.paseo);
    const result = recaps.set(input);
    if (!result.ok) return { ok: false, message: result.error };
    changed();
    return { ok: true, message: result.confirmation };
  });

  server.handle(suggestionRpc, async (input, context) => {
    link.adopt(context.paseo);
    const result = suggestions.act(input.id, input.action, input.when);
    if (!result.ok) return { ok: false, message: result.error, ...(result.needsTime ? { needsTime: true } : {}) };
    changed();
    return { ok: true, message: result.message };
  });

  server.handle(backfillRpc, async (input, context) => {
    link.adopt(context.paseo);
    if (input.action === "cancel") {
      backfill.cancel();
      return { ok: true, message: "Stopping." };
    }
    const result = backfill.start();
    notifyWatchers();
    return result.ok ? { ok: true, message: result.message } : { ok: false, message: result.error };
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
  const refresh = setInterval(() => {
    notifyWatchers();
    void noticer.maybeRun().then(notifyWatchers);
  }, 30_000);
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
