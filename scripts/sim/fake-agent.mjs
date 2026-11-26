#!/usr/bin/env node
// A scripted fake agent for Paseo, speaking ACP (Agent Client Protocol: JSON-RPC 2.0, one JSON
// object per line, over stdio). Plain Node, no dependencies. The format of the script a prompt
// carries (a `FAKE {...}` line) is in README.md.
//
// Paseo starts one of these per session: it asks `initialize`, then `session/new` (a fresh
// session) or `session/load` (a session it kept, after a restart or a crash), then `session/prompt`
// for each message. How far a script has got lives in $FAKE_STATE_DIR/<sessionId>.json, so a
// message to the same session continues it, even from a new process.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const STATE_DIR = process.env.FAKE_STATE_DIR || path.join(os.homedir(), ".cache", "hk-supervisor", "fake-state");
const ENV_SPEED = Number(process.env.FAKE_SPEED);
const DEFAULT_SPEED = Number.isFinite(ENV_SPEED) && ENV_SPEED > 0 ? ENV_SPEED : 1;
const MIN_TICK_MS = 20; // however fast the script runs, never tick more often than this in real time
const HISTORY_LIMIT = 300; // messages kept to replay on session/load

const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;
const FAKE_LINE = /^[ \t>*-]*FAKE[ \t]+(\{.*\})/m;
const FAKE_LINES = /^[ \t>*-]*FAKE[ \t]+\{.*$/gm;
const STEP_KINDS = ["work", "hang", "ask", "report", "say", "die", "error", "answer"];
const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };

fs.mkdirSync(STATE_DIR, { recursive: true });

// ------------------------------------------------------------------ output and logs

function writeAll(buffer) {
  // Synchronous on purpose: whatever was sent before a `die` step has left the process.
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(1, buffer, offset);
    } catch (error) {
      if (error.code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      } else if (error.code === "EPIPE") {
        process.exit(0); // Paseo is gone
      } else {
        throw error;
      }
    }
  }
}

const send = (message) => writeAll(Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"));

function appendLog(file, entry) {
  try {
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + "\n");
  } catch {
    // a log must never break the agent
  }
}

const processLog = (type, data = {}) => appendLog(path.join(STATE_DIR, "_processes.log"), { type, ...data });

// ------------------------------------------------------------------ the script

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function seconds(value, what) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(String(value));
  if (!match) throw new Error(`${what}: ${JSON.stringify(value)} is not a duration (use 90, 30s, 5m, 10h, 1d)`);
  return Number(match[1]) * UNIT_SECONDS[(match[2] || "s").toLowerCase()];
}

function normalizeStep(step, n) {
  const where = `step ${n}`;
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`${where} must be an object`);
  const kinds = STEP_KINDS.filter((kind) => kind in step);
  if (kinds.length !== 1) throw new Error(`${where} needs exactly one of ${STEP_KINDS.join(", ")}`);
  const kind = kinds[0];
  switch (kind) {
    case "work": {
      const total = seconds(step.work, `${where} work`);
      const every = step.every === undefined ? Math.max(1, total / 10) : seconds(step.every, `${where} every`);
      if (!(every > 0)) throw new Error(`${where}: every must be above zero`);
      return { kind, total, every, phase: String(step.phase ?? "work"), chatter: step.chatter === true };
    }
    case "hang":
      return { kind, total: seconds(step.hang, `${where} hang`), wake: step.wake === true };
    case "ask":
      return { kind, text: String(step.ask) };
    case "report": {
      const status = String(step.report);
      if (!["done", "failed", "needs-you"].includes(status)) throw new Error(`${where}: report is done, failed or needs-you`);
      return { kind, status, text: String(step.text ?? ""), retry: step.retry === undefined ? null : String(step.retry) };
    }
    case "say":
      return { kind, text: String(step.say) };
    case "error":
      return { kind, message: String(step.error), code: Number.isInteger(step.code) ? step.code : -32603 };
    default: // die, answer
      return { kind };
  }
}

function normalizeScript(raw, cwd) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the script must be a JSON object");
  if (!Array.isArray(raw.steps)) throw new Error('the script needs a "steps" array');
  const speed = raw.speed === undefined ? DEFAULT_SPEED : Number(raw.speed);
  if (!(speed > 0) || !Number.isFinite(speed)) throw new Error(`"speed" must be above zero, not ${JSON.stringify(raw.speed)}`);
  const progress = typeof raw.progress === "string" && raw.progress ? path.resolve(cwd || process.cwd(), raw.progress) : null;
  return { speed, progress, steps: raw.steps.map((step, index) => normalizeStep(step, index + 1)) };
}

// ------------------------------------------------------------------ sessions

const stateFile = (id) => path.join(STATE_DIR, `${id}.json`);
const logFile = (id) => path.join(STATE_DIR, `${id}.log`);
const nextId = (state, prefix) => `${state.sessionId}-${prefix}${(state.seq += 1)}`;

function freshState(sessionId, cwd) {
  const now = new Date().toISOString();
  return {
    sessionId,
    cwd: cwd || null,
    created: now,
    updated: now,
    speed: DEFAULT_SPEED,
    progress: null, // file a work step rewrites at each tick
    steps: [], // the script
    next: 0, // index of the first step that is not complete
    cur: null, // {elapsed, ticks}: how far into the current work or hang step
    turns: 0,
    seq: 0, // for message and tool call ids, so they stay unique across restarts
    history: [], // {role, id, text}, replayed on session/load
  };
}

const chunk = (role, messageId, text) => ({
  sessionUpdate: role === "agent" ? "agent_message_chunk" : "user_message_chunk",
  messageId,
  content: { type: "text", text },
});

class Session {
  constructor(state) {
    this.st = state;
    this.turn = null; // {abort, done} while a prompt runs
    this.sleeping = null; // {since, max} while a step waits, so a flush can count the part-way time
  }

  log(type, data = {}) {
    appendLog(logFile(this.st.sessionId), { type, ...data });
  }

  save(extraElapsed = 0) {
    const state = this.st;
    state.updated = new Date().toISOString();
    const body = extraElapsed && state.cur ? { ...state, cur: { ...state.cur, elapsed: state.cur.elapsed + extraElapsed } } : state;
    const tmp = `${stateFile(state.sessionId)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, stateFile(state.sessionId));
  }

  // Persists now, counting the time a waiting step has already spent: the process may be about to go.
  flush() {
    const waited = this.sleeping ? Math.min(this.sleeping.max, ((Date.now() - this.sleeping.since) * this.st.speed) / 1000) : 0;
    this.save(waited);
  }

  update(update) {
    this.log("event", { update });
    send({ method: "session/update", params: { sessionId: this.st.sessionId, update } });
  }

  message(text) {
    const id = nextId(this.st, "m");
    this.update(chunk("agent", id, text));
    this.remember("agent", id, text);
  }

  remember(role, id, text) {
    this.st.history.push({ role, id, text });
    if (this.st.history.length > HISTORY_LIMIT) this.st.history.splice(0, this.st.history.length - HISTORY_LIMIT);
  }

  // What session/load does: send the conversation again, as an ACP agent that kept it would.
  replay() {
    for (const { role, id, text } of this.st.history) {
      send({ method: "session/update", params: { sessionId: this.st.sessionId, update: chunk(role, id, text) } });
    }
  }

  // Waits `scriptSeconds` of script time. Resolves with the script time that passed:
  // all of it, or less when the turn is cancelled first.
  wait(scriptSeconds, signal) {
    const speed = this.st.speed;
    const since = Date.now();
    return new Promise((resolve) => {
      const finish = (cancelled) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.sleeping = null;
        resolve(cancelled ? Math.min(scriptSeconds, ((Date.now() - since) * speed) / 1000) : scriptSeconds);
      };
      const onAbort = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(MIN_TICK_MS, (scriptSeconds * 1000) / speed));
      signal.addEventListener("abort", onAbort, { once: true });
      this.sleeping = { since, max: scriptSeconds };
      if (signal.aborted) onAbort();
    });
  }

  completeStep() {
    this.st.next += 1;
    this.st.cur = null;
  }

  // The turn ends with these words, and the step that said them is done: a later message continues after it.
  endWith(text) {
    this.completeStep();
    return this.finish(text);
  }

  finish(text) {
    this.message(text);
    this.save();
    return { stopReason: "end_turn" };
  }

  tick(step, n, of) {
    const id = nextId(this.st, "t");
    this.update({
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: `${step.phase}: step ${n} of ${of}`,
      name: "Work",
      kind: "execute",
      status: "in_progress",
      rawInput: { phase: step.phase, step: n, of },
    });
    this.update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { ok: true } });
    if (step.chatter) this.message(`${step.phase}: step ${n} of ${of}`);
    if (this.st.progress) writeProgress(this.st.progress, step.phase, n, of);
  }

  // Ticks sit on a grid of `every`: tick n opens the n-th interval. A step picked up part-way (after a
  // cancel or a restart) shows the tick of the interval it is in at once, then keeps to the grid.
  async work(step, signal) {
    const cur = (this.st.cur ??= { elapsed: 0, ticks: 0 });
    const of = Math.max(1, Math.ceil(step.total / step.every - 1e-9));
    while (cur.elapsed < step.total) {
      if (signal.aborted) return "cancelled";
      const n = Math.min(of, Math.floor(cur.elapsed / step.every + 1e-9) + 1);
      cur.ticks = n;
      this.tick(step, n, of);
      this.save();
      const intervalEnd = Math.min(n * step.every, step.total);
      const asked = intervalEnd - cur.elapsed;
      const waited = await this.wait(asked, signal);
      cur.elapsed = waited >= asked ? intervalEnd : cur.elapsed + waited;
      this.save();
    }
    this.completeStep();
    return "done";
  }

  async hang(step, signal) {
    const cur = (this.st.cur ??= { elapsed: 0, ticks: 0 });
    this.save();
    while (cur.elapsed < step.total) {
      if (signal.aborted) {
        if (step.wake) this.completeStep(); // a message ended the hang
        return "cancelled";
      }
      const waited = await this.wait(step.total - cur.elapsed, signal);
      cur.elapsed += waited;
      this.save();
    }
    this.completeStep();
    return "done";
  }

  // Runs the script from the first step that is not complete, until a step ends the turn.
  async run(text, signal) {
    const state = this.st;
    state.turns += 1;
    this.remember("user", nextId(state, "u"), text);

    const line = FAKE_LINE.exec(text);
    if (line) {
      let script;
      try {
        script = normalizeScript(JSON.parse(line[1]), state.cwd);
      } catch (error) {
        this.save();
        throw new RpcError(-32602, `FAKE script rejected: ${error.message}`);
      }
      Object.assign(state, { speed: script.speed, progress: script.progress, steps: script.steps, next: 0, cur: null });
      this.log("script", { speed: script.speed, progress: script.progress, steps: script.steps });
    }
    this.save();

    while (!signal.aborted) {
      const step = state.steps[state.next];
      if (!step) {
        return this.finish(
          state.steps.length
            ? "(fake agent: the script has no steps left)"
            : "(fake agent: no script yet; put a `FAKE {...}` line in the prompt)",
        );
      }
      switch (step.kind) {
        case "work":
          if ((await this.work(step, signal)) === "cancelled") return { stopReason: "cancelled" };
          break;
        case "hang":
          if ((await this.hang(step, signal)) === "cancelled") return { stopReason: "cancelled" };
          break;
        case "ask":
          return this.endWith(`Done so far.\n<hopkins-report status="needs-you">\n${step.text}\n</hopkins-report>`);
        case "report": {
          const retry = step.retry === null ? "" : ` retry="${step.retry}"`;
          return this.endWith(`<hopkins-report status="${step.status}"${retry}>\n${step.text}\n</hopkins-report>`);
        }
        case "say":
          return this.endWith(step.text);
        case "answer": {
          const said = text.replace(FAKE_LINES, "").trim();
          return this.endWith(`You said: ${said}\n<hopkins-report status="done">\nGot your answer: ${said}\n</hopkins-report>`);
        }
        case "error":
          this.completeStep();
          this.save();
          throw new RpcError(step.code, step.message);
        case "die":
          this.completeStep(); // a resume continues after it
          this.save();
          this.log("die");
          processLog("die", { sessionId: state.sessionId });
          process.exit(1);
      }
    }
    return { stopReason: "cancelled" };
  }
}

function writeProgress(file, phase, n, of) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `# ${phase}\nstep ${n} of ${of} at ${new Date().toISOString()}\n`);
    fs.renameSync(tmp, file); // a reader never sees half a file
  } catch (error) {
    processLog("progress-error", { file, error: String(error) });
  }
}

// ------------------------------------------------------------------ ACP methods

const sessions = new Map();

function requireSession(id) {
  const session = sessions.get(id);
  if (!session) throw new RpcError(-32602, `Unknown session: ${id}`);
  return session;
}

const promptText = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("\n");

/** The one model a fake agent offers: Paseo reads it as the session's model option. */
const CONFIG_OPTIONS = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fake", options: [{ value: "fake", name: "Fake" }] }];

const METHODS = {
  initialize() {
    processLog("initialize");
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true, // Paseo reopens a session after a restart or a crash with session/load
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: "fake-agent", title: "Fake agent", version: "1.0.0" },
      authMethods: [],
    };
  },

  "session/new"(params) {
    const sessionId = `fake-${crypto.randomBytes(6).toString("hex")}`;
    const session = new Session(freshState(sessionId, params.cwd));
    sessions.set(sessionId, session);
    session.save();
    session.log("session/new", { cwd: params.cwd, mcpServers: (params.mcpServers ?? []).map((server) => server.name) });
    // One model, so a create that names "fakeagent/fake" (Paseo needs provider/model) is accepted.
    return { sessionId, configOptions: CONFIG_OPTIONS };
  },

  "session/set_config_option"(params) {
    if (params.configId !== "model" || params.value !== "fake") throw new RpcError(-32602, `Unknown option ${params.configId}=${params.value}`);
    return { configOptions: CONFIG_OPTIONS };
  },

  "session/load"(params) {
    const sessionId = String(params.sessionId);
    if (!SAFE_ID.test(sessionId)) throw new RpcError(-32602, `Bad session id: ${sessionId}`);
    let session = sessions.get(sessionId);
    if (!session) {
      let state;
      try {
        state = JSON.parse(fs.readFileSync(stateFile(sessionId), "utf8"));
      } catch {
        throw new RpcError(-32002, `Session not found: ${sessionId} (no state in ${STATE_DIR})`);
      }
      session = new Session(state);
      sessions.set(sessionId, session);
    }
    if (params.cwd) session.st.cwd = params.cwd;
    session.replay();
    const { next, steps, cur, turns } = session.st;
    session.log("session/load", { replayed: session.st.history.length, next, of: steps.length, cur, turns });
    return { configOptions: CONFIG_OPTIONS };
  },

  async "session/prompt"(params) {
    const session = requireSession(params.sessionId);
    if (session.turn) {
      // Paseo cancels first, but never run two turns of one session at once.
      session.turn.abort.abort();
      await session.turn.done.catch(() => undefined);
    }
    const text = promptText(params.prompt);
    session.log("prompt", { text });
    const abort = new AbortController();
    const turn = { abort };
    turn.done = session.run(text, abort.signal).finally(() => {
      if (session.turn === turn) session.turn = null;
    });
    session.turn = turn;
    try {
      const result = await turn.done;
      session.log("turn_end", result);
      return result;
    } catch (error) {
      session.log("turn_error", { code: error.code, message: error.message });
      throw error;
    }
  },

  async "session/close"(params) {
    const session = sessions.get(params.sessionId);
    if (!session) return {};
    if (session.turn) {
      session.turn.abort.abort();
      await session.turn.done.catch(() => undefined);
    }
    session.flush();
    session.log("session/close");
    sessions.delete(params.sessionId);
    if (session.st.turns === 0) {
      // Paseo opens a session to read the catalogue and closes it again: leave nothing behind.
      for (const file of [stateFile(params.sessionId), logFile(params.sessionId)]) fs.rmSync(file, { force: true });
    }
    return {};
  },

  authenticate: () => ({}),
};

// Notifications (no id, no answer).
const NOTIFICATIONS = {
  "session/cancel"(params) {
    const session = sessions.get(params.sessionId);
    if (!session) return;
    session.log("session/cancel", { running: Boolean(session.turn) });
    session.turn?.abort.abort();
  },
};

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = "id" in message && id !== null && id !== undefined;
  if (method === undefined) return; // a response to something we never asked
  try {
    const run = isRequest ? METHODS[method] : NOTIFICATIONS[method];
    if (!run) {
      if (isRequest) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    const result = await run(params ?? {});
    if (isRequest) send({ id, result: result ?? {} });
  } catch (error) {
    processLog("error", { method, message: error.message, stack: error.code === undefined ? error.stack : undefined });
    if (isRequest) {
      send({ id, error: { code: error.code ?? -32603, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } });
    }
  }
}

// ------------------------------------------------------------------ process

function shutdown(reason) {
  for (const session of sessions.values()) {
    try {
      session.flush();
    } catch {
      // nothing more can be done
    }
  }
  processLog("exit", { reason });
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown(`signal ${signal}`));
process.on("uncaughtException", (error) => {
  processLog("crash", { message: error.message, stack: error.stack });
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  processLog("crash", { message: String(error?.message ?? error), stack: error?.stack });
  process.exit(1);
});

processLog("start", { stateDir: STATE_DIR, speed: DEFAULT_SPEED, ppid: process.ppid });

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  pending += data;
  for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
    const line = pending.slice(0, end).trim();
    pending = pending.slice(end + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    void handle(message);
  }
});
process.stdin.on("end", () => shutdown("stdin closed")); // Paseo went away
