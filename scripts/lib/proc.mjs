// Process helpers: find a process tree, kill it for real, check ports.
import { execFileSync } from "node:child_process";
import net from "node:net";

/** All descendants of pid (not including pid), via `ps`. */
export function descendants(pid) {
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const [, p, pp] = m;
    if (!children.has(+pp)) children.set(+pp, []);
    children.get(+pp).push(+p);
  }
  const found = [];
  const stack = [pid];
  while (stack.length) {
    for (const c of children.get(stack.pop()) ?? []) {
      found.push(c);
      stack.push(c);
    }
  }
  return found;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kill pid and everything below it, including children that moved to their own
 * process group. Returns the list of pids that were part of the tree.
 * A process that survives SIGTERM for `graceMs` gets SIGKILL.
 */
export async function killTree(pid, { graceMs = 3000 } = {}) {
  const tree = [pid, ...descendants(pid)];
  const signalAll = (sig) => {
    for (const p of [...tree].reverse()) {
      try {
        process.kill(p, sig);
      } catch {}
    }
    try {
      process.kill(-pid, sig); // the process group, if pid leads one
    } catch {}
  };
  signalAll("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && tree.some(isAlive)) await sleep(100);
  if (tree.some(isAlive)) {
    // a child may have forked again while we waited
    for (const p of tree.filter(isAlive)) for (const d of descendants(p)) if (!tree.includes(d)) tree.push(d);
    signalAll("SIGKILL");
    const hard = Date.now() + 3000;
    while (Date.now() < hard && tree.some(isAlive)) await sleep(50);
  }
  return tree;
}

/** true if nothing accepts connections on 127.0.0.1:port */
export function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

export async function waitPortFree(port, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await portFree(port)) return true;
    await sleep(100);
  }
  return false;
}

export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 100, what = "condition" } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${last.message}` : ""}`);
}
