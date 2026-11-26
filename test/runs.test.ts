// Runs are found by name. Paseo names a workspace after its folder unless it is given a title, and
// hopkins made a new untitled workspace for every run: on 26 Nov 2026 a search in Paseo listed more
// than ten workspaces called "personal", one per run, told apart only by their age, and the run that
// needed an answer could not be found. Each task's runs now share one workspace named after the
// task; a Runs list shows every run; and the runs started before this get their names once.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskSchema, type Task } from "../shared/model";
import { filterRuns, groupRuns, runsHeadline, runTitle, RUN_TITLE_MAX, type Run } from "../shared/runs";
import { PaseoTaskPort, runTabTitle, TASK_LABEL } from "../server/task-port";
import { buildRuns, nameRunWorkspaces, taskTextOf } from "../server/runs";
import { taskCueText } from "../server/prompts";
import { silentLogger } from "../server/log";
import { agentSource, setup, tmpDir } from "./helpers";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startHopkins } from "../server/app";
import { Store } from "../server/store";
import { settingsSchema } from "../shared/settings";
import type { RunsView } from "../shared/runs";

const at = Date.parse("2026-11-26T05:30:00Z");

function task(id: string, text: string, attempts = 1, cwd = "/home/someone/personal"): Task {
  return TaskSchema.parse({
    id,
    text,
    instructions: "Do it and say how it went.",
    scope: "personal",
    state: "running",
    tz: "Asia/Kolkata",
    dueAt: at,
    cwd,
    agentId: null,
    attempts,
    createdAt: at,
    updatedAt: at,
    source: agentSource(at),
  });
}

/**
 * A daemon as far as starting runs goes: opening a folder hands back that folder's one workspace
 * (the one in the sidebar), making it the first time; a missing folder is refused.
 */
function daemon(folders = ["/home/someone/personal", "/home/someone/work"]) {
  const known = new Set(folders);
  const workspaces = new Map<string, { id: string; cwd: string; background: boolean }>();
  const opened: string[] = [];
  const agents: { id: string; workspaceId: string; key: string; title: string; labels: Record<string, string>; metadata: Record<string, unknown>; background: unknown }[] = [];
  let n = 0;
  const api = {
    workspaces: {
      open: (cwd: string) => {
        opened.push(cwd);
        if (!known.has(cwd)) return Promise.reject(new Error(`Directory not found: ${cwd}`));
        const w = workspaces.get(cwd) ?? { id: `wks_${cwd.split("/").pop()}`, cwd, background: false };
        workspaces.set(cwd, w);
        return Promise.resolve({
          id: w.id,
          agents: {
            create: (request: Record<string, unknown>) => {
              const id = `agent-${++n}`;
              agents.push({
                id,
                workspaceId: w.id,
                key: String(request.idempotencyKey),
                title: String(request.title),
                labels: request.labels as Record<string, string>,
                metadata: request.metadata as Record<string, unknown>,
                background: request.background,
              });
              return Promise.resolve({ id, run: () => Promise.resolve({ status: "idle", lastMessage: "done" }) });
            },
          },
        });
      },
    },
    // A bare create made a new hidden workspace, named after the folder, for every run.
    agents: { create: () => Promise.reject(new Error("a bare create makes a hidden workspace for every run")) },
  };
  return { api, workspaces, opened, agents };
}

const run = (d: ReturnType<typeof daemon>, t: Task) => new PaseoTaskPort({ api: d.api } as never).run(t, "do it", setup().config(), () => undefined, 1_000);

describe("a run's name", () => {
  it("is its task, in the user's words", () => {
    expect(runTitle("check last night's backup")).toBe("check last night's backup");
    expect(runTitle("  web check-in\n for the   Goa flight ")).toBe("web check-in for the Goa flight");
  });

  it("is cut at a whole word when the task is long, never mid-word", () => {
    const long = "take everything left over from yesterday to the finish line: merge, deploy, verify, and tell me what is still open";
    const title = runTitle(long);
    expect(title.length).toBeLessThanOrEqual(RUN_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(long.charAt(title.length - 1)).toMatch(/[\s,;:.]/); // the word before the ellipsis is whole
    expect(title).not.toMatch(/[,:;]…$/);
  });

  it("still has a name when the task is one long word or nothing at all", () => {
    expect(runTitle("x".repeat(200))).toHaveLength(RUN_TITLE_MAX);
    expect(runTitle("   ")).toBe("hopkins task");
  });
});

describe("starting runs", () => {
  it("puts several runs in their folder's one workspace, as tabs with distinct names from their tasks", async () => {
    const d = daemon();
    const tasks = [
      task("t_one", "web check-in for the Goa flight"),
      task("t_two", "check last night's backup"),
      task("t_three", "buy towerofhn.com and link it up beside the tower site"),
    ];
    for (const t of tasks) await run(d, t);

    expect(d.opened).toEqual(tasks.map((t) => t.cwd));
    expect(d.workspaces.size).toBe(1); // one workspace for the folder, not one per run
    expect(new Set(d.agents.map((a) => a.workspaceId))).toEqual(new Set(["wks_personal"]));
    expect(d.agents.map((a) => a.title)).toEqual(tasks.map((t) => t.text));
    expect(new Set(d.agents.map((a) => a.title)).size).toBe(tasks.length);
    expect(d.agents.map((a) => a.title)).not.toContain("personal");
    // A background agent is never opened as a tab and is left out of History: a run is not one.
    expect(d.agents.every((a) => a.background === false)).toBe(true);
    expect(d.agents.map((a) => a.labels)).toEqual(tasks.map((t) => ({ "hopkins.role": "task", [TASK_LABEL]: t.id })));
    expect(d.agents.map((a) => a.metadata)).toEqual(tasks.map((t) => ({ [TASK_LABEL]: t.id })));
    expect(d.agents.map((a) => a.key)).toEqual(tasks.map((t) => `hopkins-task-${t.id}-1`));
  });

  it("starts a retry as a new tab beside the first, saying which try it is", async () => {
    const d = daemon();
    await run(d, task("t_web", "web check-in for the Goa flight", 1));
    await run(d, task("t_web", "web check-in for the Goa flight", 2));
    expect(d.agents.map((a) => a.title)).toEqual(["web check-in for the Goa flight", "web check-in for the Goa flight · try 2"]);
    expect(new Set(d.agents.map((a) => a.workspaceId)).size).toBe(1);
    expect(d.agents.map((a) => a.key)).toEqual(["hopkins-task-t_web-1", "hopkins-task-t_web-2"]);
  });

  it("puts a run in another folder in that folder's workspace", async () => {
    const d = daemon();
    await run(d, task("t_home", "check last night's backup"));
    await run(d, task("t_work", "sum up the sprint", 1, "/home/someone/work"));
    expect(d.agents.map((a) => a.workspaceId)).toEqual(["wks_personal", "wks_work"]);
  });

  it("gives a long task a tab title cut at a whole word", async () => {
    const d = daemon();
    const long = "take everything left over from yesterday to the finish line: merge, deploy, verify, and tell me what is still open";
    await run(d, task("t_long", long));
    expect(d.agents[0]!.title).toBe(runTitle(long));
    expect(runTabTitle({ text: long, attempts: 3 })).toBe(`${runTitle(long)} · try 3`);
  });

  it("keeps a reminder's daily check out of sight, in the folder's workspace rather than a window of its own", async () => {
    const d = daemon();
    await run(d, { ...task("t_check", "Check: go to bed"), kind: "check", reminderId: "r_1" });
    expect(d.agents).toHaveLength(1);
    expect(d.agents[0]).toMatchObject({ workspaceId: "wks_personal", background: true });
  });

  it("starts nothing when the task's folder is gone", async () => {
    const d = daemon([]);
    await expect(run(d, task("t_web", "web check-in"))).rejects.toThrow(/Directory not found/);
    expect(d.agents).toHaveLength(0);
  });
});

function runOf(partial: Partial<Run> & Pick<Run, "id" | "state" | "at">): Run {
  return { title: partial.id, agentId: `a-${partial.id}`, when: "today 9am", time: "9am", day: "Today", report: null, scope: "personal", ...partial };
}

describe("the Runs list", () => {
  it("shows what needs you first, then what is working, then the rest, newest first in each", () => {
    const runs = [
      runOf({ id: "old-done", state: "done", at: 1 }),
      runOf({ id: "asks", state: "needs-you", at: 2 }),
      runOf({ id: "works", state: "running", at: 3 }),
      runOf({ id: "new-fail", state: "failed", at: 4 }),
      runOf({ id: "asks-newer", state: "needs-you", at: 5 }),
      runOf({ id: "missed", state: "missed", at: 6 }),
    ];
    const g = groupRuns(runs);
    expect(g.needsYou.map((r) => r.id)).toEqual(["asks-newer", "asks"]);
    expect(g.working.map((r) => r.id)).toEqual(["works"]);
    expect(g.finished.map((r) => r.id)).toEqual(["missed", "new-fail", "old-done"]);
  });

  it("finds a run by any words of its name or report, in any order", () => {
    const runs = [
      runOf({ id: "a", state: "done", at: 1, title: "Tower of HN launch readiness", report: "Voices are instant now." }),
      runOf({ id: "b", state: "done", at: 2, title: "check last night's backup" }),
    ];
    expect(filterRuns(runs, "launch tower").map((r) => r.id)).toEqual(["a"]);
    expect(filterRuns(runs, "INSTANT").map((r) => r.id)).toEqual(["a"]);
    expect(filterRuns(runs, "  ").map((r) => r.id)).toEqual(["a", "b"]);
    expect(filterRuns(runs, "tower backup")).toEqual([]);
  });

  it("says in one sentence whether a run needs you, counting what the list shows", () => {
    const one = runOf({ id: "a", state: "needs-you", at: 1 });
    const working = [runOf({ id: "b", state: "running", at: 2 }), runOf({ id: "c", state: "running", at: 3 })];
    expect(runsHeadline(groupRuns([one, ...working]))).toEqual({ title: "A run needs you.", detail: "Two more are working." });
    expect(runsHeadline(groupRuns(working))).toEqual({ title: "Two runs are working.", detail: null });
    expect(runsHeadline(groupRuns([runOf({ id: "d", state: "done", at: 1 })])).title).toBe("Nothing is running.");
    expect(runsHeadline(groupRuns([])).title).toBe("No runs yet.");
  });

  it("lists every task's run, kept or archived, but not checks or tasks that have not started", () => {
    const env = setup("2026-11-26T06:00:00Z");
    const now = env.clock.now();
    const put = (t: Partial<Task> & Pick<Task, "id" | "text" | "state">) =>
      env.store.putTask({ ...task(t.id, t.text), ...t, startedAt: t.startedAt ?? now - 60_000 } as Task);
    put({ id: "t_ask", text: "buy towerofhn.com", state: "needs-you", agentId: "a1", report: "Which card should I use?" });
    put({ id: "t_quiet", text: "check the sync", state: "needs-you", agentId: "a2", unreported: true, report: "It stopped without saying whether it worked." });
    put({ id: "t_later", text: "renew the library books", state: "scheduled", agentId: null });
    put({ id: "t_check", text: "Check: go to bed", state: "done", agentId: "a3", kind: "check" });
    (env.store as unknown as { state: { archive: unknown[] } }).state.archive.push({ id: "t_old", text: "web check-in for the Goa flight", state: "done", scope: "personal", dueAt: now - 3 * 86_400_000, finishedAt: now - 3 * 86_400_000 + 600_000, agentId: "a0" });

    const view = buildRuns(env.store, env.config(), now);
    expect(view.runs.map((r) => r.id)).toEqual(["t_ask", "t_quiet", "t_old"]);
    expect(view.runs.find((r) => r.id === "t_quiet")).toMatchObject({ unreported: true, state: "needs-you" });
    expect(view.runs.find((r) => r.id === "t_ask")).toMatchObject({ title: "buy towerofhn.com", agentId: "a1", report: "Which card should I use?", day: "Today" });
    expect(view.runs.find((r) => r.id === "t_old")).toMatchObject({ agentId: "a0", day: "Mon 23 Nov" });
    expect(JSON.stringify(view)).not.toContain("Do it and say how it went"); // the brief stays on the host
  });
});

describe("naming the runs started before runs had names", () => {
  function host(workspaces: { id: string; title: string | null; background: boolean }[], agents: { workspaceId: string; task?: string; title: string; role?: string }[], options: { pageSize?: number; failOn?: string } = {}) {
    const titled: Record<string, string> = {};
    const size = options.pageSize ?? 200;
    const page = <T,>(all: T[], cursor: string | undefined) => {
      const from = cursor ? Number(cursor) : 0;
      const next = from + size;
      return Promise.resolve({ entries: all.slice(from, next), pageInfo: { hasMore: next < all.length, nextCursor: next < all.length ? String(next) : null } });
    };
    const api = {
      workspaces: {
        list: (o: { page?: { cursor?: string } }) => page(workspaces, o.page?.cursor),
        ref: (id: string) => ({
          setTitle: (title: string) => {
            if (id === options.failOn) return Promise.reject(new Error("refused"));
            titled[id] = title;
            return Promise.resolve({ title });
          },
        }),
      },
      agents: {
        list: (o: { filter?: { labels?: Record<string, string> }; page?: { cursor?: string } }) => {
          const wanted = o.filter?.labels?.["hopkins.role"];
          const matching = agents
            .filter((a) => (a.role ?? "task") === wanted)
            .map((a) => ({ agent: { id: `${a.workspaceId}-${a.task}`, workspaceId: a.workspaceId, title: a.title, labels: { "hopkins.role": a.role ?? "task", ...(a.task ? { [TASK_LABEL]: a.task } : {}) } } }));
          return page(matching, o.page?.cursor);
        },
      },
    };
    return { api: api as never, titled };
  }

  it("names each untitled run workspace after its task, in the task's own full words", async () => {
    const env = setup();
    const long = "take everything left over from yesterday to the finish line: merge, deploy, verify, and report";
    env.store.putTask({ ...task("t_long", long), agentId: "x" });
    const { api, titled } = host(
      [
        { id: "wks_a", title: null, background: true },
        { id: "wks_b", title: null, background: true },
      ],
      [
        { workspaceId: "wks_a", task: "t_long", title: long.slice(0, 80) },
        { workspaceId: "wks_b", task: "t_gone", title: "check last night's backup" },
      ],
    );
    const result = await nameRunWorkspaces(api, taskTextOf(env.store), silentLogger);
    expect(titled).toEqual({ wks_a: runTitle(long), wks_b: "check last night's backup" });
    expect(result).toEqual({ named: 2, left: 0 });
  });

  it("never replaces a title someone gave, and leaves alone what is not one task's run window", async () => {
    const env = setup();
    const { api, titled } = host(
      [
        { id: "wks_named", title: "my Zepp work", background: true },
        { id: "wks_main", title: null, background: false }, // the folder's own workspace, in the sidebar
        { id: "wks_two", title: null, background: true }, // runs of two tasks: whose name would it be?
        { id: "wks_mine", title: null, background: true }, // nothing of hopkins's in it
        { id: "wks_thread", title: null, background: true }, // the hopkins conversation, not a run
      ],
      [
        { workspaceId: "wks_named", task: "t_1", title: "check the Zepp sync" },
        { workspaceId: "wks_main", task: "t_2", title: "renew the books" },
        { workspaceId: "wks_two", task: "t_3", title: "one" },
        { workspaceId: "wks_two", task: "t_4", title: "two" },
        { workspaceId: "wks_thread", title: "hopkins", role: "thread" },
      ],
    );
    const result = await nameRunWorkspaces(api, taskTextOf(env.store), silentLogger);
    expect(titled).toEqual({});
    expect(result).toEqual({ named: 0, left: 3 });
  });

  it("reads every page of a long history, and one refusal does not stop the rest", async () => {
    const env = setup();
    const workspaces = Array.from({ length: 7 }, (_, i) => ({ id: `wks_${i}`, title: null, background: true }));
    const agents = workspaces.map((w, i) => ({ workspaceId: w.id, task: `t_${i}`, title: `task number ${i}` }));
    const { api, titled } = host(workspaces, agents, { pageSize: 3, failOn: "wks_4" });
    const result = await nameRunWorkspaces(api, taskTextOf(env.store), silentLogger);
    expect(Object.keys(titled).sort()).toEqual(["wks_0", "wks_1", "wks_2", "wks_3", "wks_5", "wks_6"]);
    expect(result).toEqual({ named: 6, left: 1 });
  });
});

describe("telling the user where a run is", () => {
  it("names the run the way Paseo's search finds it, and where Runs is, when it needs them", () => {
    const env = setup();
    const t: Task = { ...task("t_web", "buy towerofhn.com and link it up beside the tower site"), state: "needs-you", agentId: "a1", report: "Which card should I use?" };
    const cue = taskCueText({ id: "d_1", reminderIds: [], kind: "note", task: { id: t.id, state: "needs-you" }, createdAt: 0, state: "sending", attempts: 1 }, t, env.clock.now(), env.config());
    expect(cue).toContain(`"${runTitle(t.text)}"`);
    expect(cue).toContain("under Runs in hopkins's sidebar entry");
    expect(cue).not.toContain("under Tasks"); // the Today screen has had no Tasks section since the desk
  });
});

describe("the whole plugin, once it connects", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    // This shell may be inside a real Paseo: never let the test reach that daemon.
    for (const key of ["PASEO_LISTEN", "PASEO_PASSWORD", "PASEO_HOME"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  });

  it("names the earlier runs' windows, and keeps the Runs screen live", async () => {
    expect(process.env.PASEO_LISTEN).toBeUndefined();
    const dir = tmpDir();
    const seed = new Store(dir, silentLogger);
    seed.load();
    seed.putTask({ ...task("t_old", "check that last night's photo backup finished"), state: "done", agentId: "run-old", report: "Backed up 312 photos.", startedAt: at });
    seed.save();

    const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
    const host = {
      registerSettings: () => ({ read: async () => ({ status: "ready", revision: "1", values: settingsSchema.parse({ timezone: "Asia/Kolkata" }) }), subscribe: () => () => undefined }),
      addHook: () => () => undefined,
      handle: (contract: { name: string }, handler: (input: unknown, ctx: unknown) => unknown) => void handlers.set(contract.name, handler),
      on: () => () => undefined,
      before: () => () => undefined,
      registerProvider: () => undefined,
      registerUsageSource: () => undefined,
    } as unknown as PluginServerContext;
    const titled: Record<string, string> = {};
    const nothing = () => Promise.reject(new Error("not in this test"));
    const paseo = {
      workspaces: {
        list: () => Promise.resolve({ entries: [{ id: "wks_old", title: null, background: true }], pageInfo: { hasMore: false, nextCursor: null } }),
        ref: (id: string) => ({ setTitle: (title: string) => ((titled[id] = title), Promise.resolve({ title })) }),
        open: nothing,
      },
      agents: {
        list: () =>
          Promise.resolve({
            entries: [{ agent: { id: "run-old", workspaceId: "wks_old", title: "check that last night's photo backup fini", labels: { "hopkins.role": "task", [TASK_LABEL]: "t_old" } } }],
            pageInfo: { hasMore: false, nextCursor: null },
          }),
        ref: () => ({ refresh: nothing, waitForFinish: nothing }),
        create: nothing,
      },
    };
    const views: RunsView[] = [];
    const subscription = new AbortController();
    const stop = startHopkins(host, { dataDir: dir, log: silentLogger, tickMs: 3_600_000, nameRunsAfterMs: 10 });
    try {
      void handlers.get("hopkins.runs.watch")!({}, { paseo, signal: subscription.signal, push: async (v: RunsView) => void views.push(v) });
      for (let i = 0; i < 100 && !titled.wks_old; i++) await new Promise((r) => setTimeout(r, 20));
      expect(titled).toEqual({ wks_old: "check that last night's photo backup finished" });
      expect(views[0]!.runs.map((r) => ({ id: r.id, state: r.state, agentId: r.agentId }))).toEqual([{ id: "t_old", state: "done", agentId: "run-old" }]);
    } finally {
      subscription.abort();
      stop();
    }
  });
});
