// Wires hopkins into the plugin host: settings, the agent tools, the app's
// RPCs, its own daemon connection and the scheduler. Nothing here may throw
// into Paseo: a throwing session-open hook would stop agents from opening.

import fs from "node:fs";
import path from "node:path";
import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import type { TodayView } from "../shared/model";
import { actRpc, answerRpc, backfillRpc, checkinWatch, dayRpc, daysRpc, recapsRpc, runsWatch, suggestionRpc, taskAnswerRpc, taskRpc, todayRpc, todayWatch } from "../shared/rpc";
import type { RunsView } from "../shared/runs";
import { card as checkinCard, CheckIns } from "./checkins";
import { localDateOf, zonedToInstant } from "../shared/time";
import { hopkinsSettings, settingsSchema, type HopkinsSettings } from "../shared/settings";
import { Backfill } from "./backfill";
import { resolveConfig, scopeFor, type Config } from "./config";
import { defaultDeliveryOptions, DeliveryQueue, type RecapSource } from "./delivery";
import { consoleLogger, errorText, type Logger } from "./log";
import { AnthropicLlm, patient, readCredentials, sleepFor } from "./llm";
import { Retries } from "./retry";
import { HopkinsMcpServer, MCP_SERVER_NAME, THREAD_AGENT_MARKER } from "./mcp-server";
import { LiveNoticer, Suggestions } from "./noticing";
import { PaseoLink } from "./paseo-link";
import { Recaps } from "./recaps";
import { Reminders, systemClock, type Clock } from "./reminders";
import { Scheduler } from "./scheduler";
import { PaseoTaskPort, TASK_LABEL } from "./task-port";
import { TaskRunner, Tasks } from "./tasks";
import { fileSignals, hostProbe } from "./signals";
import { HostPrereqs } from "./prereqs";
import { Conditions } from "./conditions";
import { defaultDataDir, Store } from "./store";
import { PaseoThreadPort, paseoTimelineReader, THREAD_LABEL } from "./thread-port";
import { buildDay, buildDays, parseDate } from "./desk";
import { buildToday } from "./today";
import { inQuietHours } from "./delivery";
import { liveOf } from "./supervision-view";
import { zonedParts } from "../shared/time";
import type { Task } from "../shared/model";
import { buildRuns, nameRunWorkspaces, taskTextOf } from "./runs";
import { createTools } from "./tools";

/** Quiet hours when they are set; otherwise 11pm to 7am, when nobody wants a progress note. */
function isNight(cfg: Config, now: number): boolean {
  if (cfg.quiet) return inQuietHours(cfg, now);
  const hour = zonedParts(now, cfg.tz).hour;
  return hour >= 23 || hour < 7;
}

export interface StartOptions {
  dataDir?: string;
  log?: Logger;
  clock?: Clock;
  tickMs?: number;
  /** How long after connecting the earlier runs' workspaces get their names, and the wait before another go (tests make them short). */
  nameRunsAfterMs?: number;
  nameRunsRetryMs?: number;
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
  // Tasks: "at 8pm, do X". They start from the scheduler's tick and report through the queue.
  const tasks = new Tasks(store, reminders, clock, getConfig);
  const taskPort = new PaseoTaskPort(link);
  const runner = new TaskRunner(
    store,
    tasks,
    () => (link.connected ? taskPort : null),
    {
      report: (task, now, retryAt) => {
        queue.enqueueTask(task, now, retryAt);
        changed();
      },
      // News about a run that is not an outcome (it stalled; a limit that lifts only in hours): it can wait out quiet hours.
      note: (text, now) => {
        queue.enqueueNote(text, now, { canWait: true });
        changed();
      },
    },
    clock,
    getConfig,
    log,
  );
  // How runs are watched: their own records, the host's room, and what a task needs before it starts.
  runner.signals = fileSignals;
  runner.host = hostProbe;
  runner.prereqs = new HostPrereqs(dataDir, log, () => clock.now());
  // "Until": the daily checks behind reminders that stop by themselves (they run as tasks of kind "check").
  const conditions = new Conditions(
    store,
    reminders,
    tasks,
    (text, now) => {
      queue.enqueueNote(text, now);
      changed();
    },
    clock,
    getConfig,
    log,
  );
  runner.checks = conditions;
  const scheduler = new Scheduler(reminders, queue, clock, getConfig, log, recaps, {
    tick: (now) => {
      conditions.tick(now);
      runner.tick(now);
      digest(now);
    },
  });

  // While anything runs: a short note on each run every few hours (never at night). The clock
  // starts when the first run does, and stops when nothing runs.
  function digest(now: number): void {
    if (config.digestMs <= 0) return;
    const running = store.tasks().filter((t) => t.state === "running" && t.kind !== "check");
    if (running.length === 0) {
      if (store.digestAt() !== undefined) {
        store.setDigestAt(0);
        store.save();
      }
      return;
    }
    const last = store.digestAt() ?? 0;
    if (last === 0) {
      store.setDigestAt(now);
      store.save();
      return;
    }
    if (now - last < config.digestMs || isNight(config, now)) return;
    const waiting = store.tasks().filter((t) => t.state === "scheduled" && t.hold && t.kind !== "check");
    const line = (t: Task) => {
      const live = liveOf(t, config, now);
      return `"${t.text}"${live?.line ? ` (${live.line})` : ""}`;
    };
    const text = [
      `Still at work: ${running.map(line).join("; ")}.`,
      ...(waiting.length ? [`Waiting: ${waiting.map(line).join("; ")}.`] : []),
    ].join(" ");
    store.setDigestAt(now);
    queue.enqueueNote(text, now, { canWait: true });
    changed();
  }

  // --- Noticing and backfill -----------------------------------------------------------

  const llm = new AnthropicLlm(() => ({ model: config.llmModel }), () => readCredentials(dataDir));
  // A failed task is tried again when that could work; the model weighs why it failed.
  // A busy model is waited out briefly; past that, a plain rule decides rather than holding the news.
  runner.retries = new Retries(patient(llm, [15_000, 30_000, 60_000], sleepFor), reminders, clock, getConfig, log);
  const suggestions = new Suggestions(store, reminders, clock, getConfig);
  const noticer = new LiveNoticer(store, suggestions, llm, () => paseoTimelineReader(link), clock, getConfig, log);
  const backfill = new Backfill(store, suggestions, llm, clock, getConfig, log, {
    onFinished: ({ conversations, found }) => {
      queue.enqueueNote(
        found > 0
          ? `I looked through ${conversations} past conversations and your notes. ${found} things look still open; they're under Noticed on the Today screen, where you can keep, close or drop each.`
          : `I looked through ${conversations} past conversations and your notes, and found nothing that still looks open.`,
        clock.now(),
      );
      changed();
    },
    onFailed: (reason) => {
      queue.enqueueNote(`I couldn't finish looking through your past conversations: ${reason}. Ask any agent to look through your history again when you like.`, clock.now());
      changed();
    },
  });
  backfill.recover();

  // Dropping a file named `import-history` into hopkins's data folder runs the history import once,
  // as soon as a model key is available: a way to ask for it on a fresh install, before any app opens.
  const IMPORT_MARKER = path.join(dataDir, "import-history");
  const maybeImport = () => {
    if (!fs.existsSync(IMPORT_MARKER) || !llm.available || !link.connected) return;
    const r = backfill.start();
    if (r.ok || backfill.status().state === "running") {
      try {
        fs.rmSync(IMPORT_MARKER, { force: true });
      } catch (err) {
        log.warn("could not remove the import marker", { error: errorText(err) });
      }
      log.info("history import started from the marker");
    }
  };

  // --- Today view and live watchers ------------------------------------------------

  const watchers = new Set<(view: TodayView) => void>();
  // The Runs screen: every run, live.
  const runWatchers = new Set<(view: RunsView) => void>();
  // Each check-in card in the conversation follows its own reminder.
  const cardWatchers = new Set<() => void>();
  const checkins = new CheckIns(store, clock);
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
      tasks,
    );
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  const notifyWatchers = () => {
    if (notifyTimer || watchers.size + runWatchers.size + cardWatchers.size === 0) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      if (watchers.size > 0) {
        const view = today();
        for (const push of watchers) push(view);
      }
      if (runWatchers.size > 0) {
        const view = buildRuns(store, config, clock.now());
        for (const push of runWatchers) push(view);
      }
      for (const push of cardWatchers) push();
    }, 100);
  };
  const changed = () => {
    void scheduler.tick().then(notifyWatchers);
    notifyWatchers();
  };
  // Every saved change reaches open screens, whichever path made it: a task starting or being
  // answered, a reminder going out, a message being read. One state, one way out to every view.
  const unsubscribeStore = store.onChange(notifyWatchers);

  // --- Settings ------------------------------------------------------------------

  const applySettings = (state: PluginSettingsState<typeof settingsSchema>) => {
    if (state.status === "ready") {
      config = resolveConfig(state.values as HopkinsSettings, dataDir);
    } else {
      log.warn("settings are invalid; keeping the previous ones", { error: state.error });
    }
  };
  const settings = server.registerSettings(hopkinsSettings);
  // The scheduler starts only once the user's settings are known (zone, paused), or after 5 s at worst.
  const settingsReady = Promise.race([
    settings
      .read()
      .then((state) => applySettings(state))
      .catch((err) => log.warn("could not read settings", { error: errorText(err) })),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.()),
  ]);
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
    // Pick up any task run that was under way when hopkins (or its connection) went away.
    runner.recover();
    changed();
    nameOldRuns();
  }

  // Runs started before runs had names sit in workspaces called after their folder ("personal").
  // Once per start, a minute in (out of the way of everything a start does), each gets its task's
  // name. Only untitled run workspaces are touched, and only their title. A busy daemon that does
  // not answer gets two more goes, ten minutes apart.
  let naming: "idle" | "waiting" | "done" = "idle";
  let namingTries = 0;
  function nameOldRuns(delay = options.nameRunsAfterMs ?? 60_000): void {
    if (naming !== "idle") return;
    naming = "waiting";
    const timer = setTimeout(() => {
      const api = link.api;
      if (stopped || !api) {
        naming = "idle";
        return;
      }
      namingTries += 1;
      void nameRunWorkspaces(api, taskTextOf(store), log)
        .then(({ named, left }) => {
          naming = "done";
          if (named > 0) log.info("named the workspaces of earlier runs", { named, left });
        })
        .catch((err) => {
          naming = "idle";
          log.warn("could not name the workspaces of earlier runs", { error: errorText(err), tries: namingTries });
          if (namingTries < 3) nameOldRuns(options.nameRunsRetryMs ?? 600_000);
        });
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  }

  // --- Agent tools -----------------------------------------------------------------

  const tools = createTools({
    reminders,
    recaps,
    suggestions,
    backfill,
    tasks,
    runner,
    conditions,
    checkins,
    config: getConfig,
    clock,
    isThread: (agentId) => agentId === store.threadAgentId(),
    changed,
  });

  // Providers whose sessions take an extra MCP server. Pi refuses MCP servers (the open
  // would fail) and Antigravity takes none, so they are left alone.
  const MCP_PROVIDERS = new Set(["claude", "codex", "opencode"]);
  port.toolNames = tools.map((t) => t.name);
  const mcp = new HopkinsMcpServer(tools, log, () => link.api, dataDir, () => store.threadAgentId());
  const mcpReady = mcp
    .start()
    .then(() => {
      log.info("tools ready", { port: mcp.port });
      return true;
    })
    .catch((err) => {
      log.error("could not start the tools server", { error: errorText(err) });
      return false;
    });
  port.threadMcpServer = async () => ((await mcpReady) ? mcp.configFor(THREAD_AGENT_MARKER) : null);

  server.addHook("agent.open.before", async ({ request }, context) => {
    // Never throws: a failing session-open hook stops the agent from opening.
    try {
      link.adopt(context.paseo);
      if (request.purpose !== "interactive") return request;
      // The hopkins conversation carries its own entry from creation; adding ours would collide.
      // (A hook only sees what plugins add, not the agent's saved servers, so check the label.)
      if (request.labels?.[THREAD_LABEL] === "thread") return request;
      mcp.remember({ id: request.agentId, workspaceId: request.workspaceId, cwd: request.cwd, title: request.title, provider: request.provider });
      if (!MCP_PROVIDERS.has(request.provider) || !mcp.ready || request.mcpServers[MCP_SERVER_NAME]) return request;
      request.mcpServers[MCP_SERVER_NAME] = mcp.configFor(request.agentId);
      return request;
    } catch (err) {
      log.error("could not attach the hopkins tools", { error: errorText(err) });
      return undefined;
    }
  });

  // A task's run is working again, from now: it started a turn (the user answered it there), or the
  // user settled its permission prompt (that carries on in the same turn, so no turn starts).
  const resumed = (retell: boolean) => async ({ agent }: { agent: { id: string } }) => {
    try {
      if (runner.isTaskAgent(agent.id)) runner.onResumed(agent.id, retell);
    } catch (err) {
      log.warn("could not note a resumed run", { error: errorText(err) });
    }
  };
  server.addHook("agent.turn.before", resumed(false));
  // A second permission prompt reads the same as the first, yet it is news: tell it again.
  server.addHook("agent.permission.after", resumed(true));

  // A conversation finished a turn: note it, so noticing reads it once it settles.
  server.addHook("agent.turn.after", async ({ agent, outcome }) => {
    try {
      // A finished turn anywhere proves its provider's sign-in works: a run waiting on it can go on.
      if (outcome.kind === "completed") runner.providerWorks(agent.provider);
      // A task's run finished a turn (the user answered it there): its outcome may have changed.
      if (runner.isTaskAgent(agent.id)) {
        runner.onTurnFinished(agent.id, outcome.kind === "canceled");
        return;
      }
      // A run (even an old one whose task is no longer kept) is hopkins's own work, not a conversation to notice in.
      if (outcome.kind === "canceled" || agent.parentAgentId || agent.background || agent.metadata?.[TASK_LABEL] !== undefined || agent.id === store.threadAgentId()) return;
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

  server.handle(daysRpc, async (input, context) => {
    link.adopt(context.paseo);
    const from = parseDate(input.from);
    if (!from) throw new Error(`not a date: ${input.from}`);
    return buildDays(store, reminders, config, clock.now(), backfill.status(), from, input.days);
  });

  server.handle(dayRpc, async (input, context) => {
    link.adopt(context.paseo);
    const date = parseDate(input.date);
    if (!date) throw new Error(`not a date: ${input.date}`);
    return buildDay(store, reminders, config, clock.now(), date);
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

  server.handle(taskRpc, async (input, context) => {
    link.adopt(context.paseo);
    const act = {
      cancel: () => runner.cancel(input.id),
      "run-now": () => runner.runNow(input.id),
      stop: () => runner.stop(input.id),
      pause: () => runner.pause(input.id),
      resume: () => runner.resumeNow(input.id),
      nudge: () => runner.nudge(input.id),
    }[input.action];
    const result = await act();
    changed();
    return result;
  });

  // An answer typed on Today: passed into the run as their own message.
  server.handle(taskAnswerRpc, async (input, context) => {
    link.adopt(context.paseo);
    const result = await runner.answer(input.id, input.text, "today");
    changed();
    return result;
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

  server.handle(answerRpc, async (input, context) => {
    link.adopt(context.paseo);
    const result = checkins.answer(input.id, input.value, {
      via: input.via,
      ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    if (!result.ok) return { ok: false, message: result.error };
    changed();
    return { ok: true, message: result.confirmation };
  });

  server.handle(checkinWatch, async (input, context) => {
    link.adopt(context.paseo);
    const push = () => {
      void context.push(checkinCard(store.get(input.id), input.occurrence, clock.now())).catch(() => cardWatchers.delete(push));
    };
    cardWatchers.add(push);
    push();
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    cardWatchers.delete(push);
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

  server.handle(runsWatch, async (_input, context) => {
    link.adopt(context.paseo);
    const push = (view: RunsView) => {
      void context.push(view).catch(() => runWatchers.delete(push));
    };
    runWatchers.add(push);
    push(buildRuns(store, config, clock.now()));
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    runWatchers.delete(push);
  });

  server.handle(todayWatch, async (_input, context) => {
    link.adopt(context.paseo);
    const push = (view: TodayView) => {
      void context.push(view).catch(() => watchers.delete(push));
    };
    watchers.add(push);
    push(today());
    // The subscription lives as long as this promise is pending: settle it only when the app lets go.
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    watchers.delete(push);
  });

  // --- Start ----------------------------------------------------------------------------

  queue.recover();
  link.start();
  let stopped = false;
  void settingsReady.then(() => {
    if (!stopped) scheduler.start(options.tickMs ?? 15_000);
  });
  const refresh = setInterval(() => {
    notifyWatchers();
    maybeImport();
    void noticer
      .maybeRun()
      .then(notifyWatchers)
      .catch((err) => log.warn("noticing failed", { error: errorText(err) }));
  }, 30_000);
  (refresh as { unref?: () => void }).unref?.();
  log.info("started", { reminders: store.reminders().length });

  return () => {
    stopped = true;
    scheduler.stop();
    mcp.stop();
    clearInterval(refresh);
    if (notifyTimer) clearTimeout(notifyTimer);
    unsubscribeStore();
    unsubscribeSettings();
    watchers.clear();
    runWatchers.clear();
    void link.stop();
    try {
      store.save();
    } catch (err) {
      log.error("final save failed", { error: errorText(err) });
    }
  };
}
