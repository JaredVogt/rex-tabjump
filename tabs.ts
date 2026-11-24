// Shared by the terminal panel (tabjump.ts) and the web panel
// (tabjump-web.ts): reads every tab in every Rex session, labels them, and
// jumps to one.

import { execFile } from "node:child_process";
import { join } from "node:path";

// Label letters. j and k are left out: they move the selection.
export const ALPHABET = "asdfghlqwertyuiopzxcvbnm";
const REX = process.env.REX_BIN_DIR ? join(process.env.REX_BIN_DIR, "rex") : "rex";
export const SELF_BLOCK = process.env.REX_BLOCK ?? "";
const CLIENT = process.env.TABJUMP_CLIENT ?? "";
const TERMINAL = "com.superlogical.terminal";
const REXWEB =
  process.env.TABJUMP_REXWEB ??
  join(process.env.HOME ?? "", "Applications/RexWeb.app/Contents/Resources/rexweb");

export type Tab = {
  sessionId: string;
  session: string;
  windowId: string;
  title: string;
  renamed: boolean; // the title is a name you gave the tab
  ownTitle: string; // the title it has, or would have, without one
  // What the program in the tab reports, in Rex's words: "working",
  // "blocked", "done" or "error". "failed" when it reports nothing and its last command failed; ""
  // when there is nothing to say.
  status: string;
  // What a blocked program needs from you: "permission", "question" or
  // "auth"; "" when it didn't say or isn't blocked.
  kind: string;
  message: string; // the sentence that came with the status, or ""
  app: string; // who reported it, such as "claude-code", or ""
  since: number; // when the status last changed, in ms since 1970; 0 if unknown
  program: string; // what is running in front: "claude", "zsh", "browser"; or ""
  exit: number; // the last command's exit code; 0 when it passed or isn't known
  cwd: string; // the folder the tab is in, with ~ for home; or ""
  branch: string; // that folder's git branch, or ""
  panes: number;
  floating: number; // how many of those panes float
  page: string; // the page in the tab's browser pane, or ""
  pageTabs: number; // how many tabs that browser pane holds
  pageLoading: boolean;
  active: boolean; // the tab its session shows when you switch to the session
  clients: string[]; // the apps that have the tab's session open, by name
  current: boolean;
  label: string;
  // The pane to focus on arrival, when the tab's own choice would be a
  // rexweb browser pane; empty to leave the choice to Rex.
  focusBlock: string;
};

// ---- Reading Rex ---------------------------------------------------------

export function rex(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(REX, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}
function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj) : [];
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function rexJson(args: string[]): Promise<Json> {
  return obj(JSON.parse(await rex(args)));
}

export async function blockCall(sessionId: string, blockId: string, method: string): Promise<Json> {
  try {
    return await rexJson(["block", "call", "-s", sessionId, "-b", blockId, method]);
  } catch {
    return {};
  }
}

type Page = { title: string; tabs: number; loading: boolean };

// Every rexweb browser pane and the page it shows, by block ID; none if
// rexweb isn't there.
function webPanes(): Promise<Map<string, Page>> {
  return new Promise((resolve) => {
    execFile(REXWEB, ["ls", "--json"], { timeout: 3000 }, (err, stdout) => {
      const panes = new Map<string, Page>();
      if (err) return resolve(panes);
      try {
        for (const p of list(obj(JSON.parse(stdout)).panels)) {
          panes.set(str(p.id), {
            title: str(p.title) || str(p.url),
            tabs: typeof p.tabs === "number" ? p.tabs : 1,
            loading: p.loading === true,
          });
        }
      } catch {
        // Leave whatever was read.
      }
      resolve(panes);
    });
  });
}

// The names of the apps that have each session open, by session ID.
async function sessionClients(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    for (const client of list((await rexJson(["client", "ls", "--json"])).clients)) {
      const info = obj(client.info);
      if (str(info.kind) !== "app" || str(client.connection_state) !== "connected") continue;
      const name = str(info.label) || str(info.name) || str(info.platform);
      if (name === "") continue;
      for (const id of Array.isArray(client.session_ids) ? client.session_ids : []) {
        const names = out.get(str(id)) ?? [];
        if (!names.includes(name)) names.push(name);
        out.set(str(id), names);
      }
    }
  } catch {
    // An older Rex without the listing: show no clients.
  }
  return out;
}

// The git branch of a folder, or "" when it isn't in a repository. One git
// call per folder, however many tabs are in it.
const branches = new Map<string, Promise<string>>();
function branchOf(dir: string): Promise<string> {
  let branch = branches.get(dir);
  if (branch === undefined) {
    branch = new Promise((resolve) => {
      execFile("git", ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"], { timeout: 800 }, (err, stdout) =>
        resolve(err ? "" : stdout.trim()),
      );
    });
    branches.set(dir, branch);
  }
  return branch;
}

// A command's exit code, however Rex spells it; 0 when there isn't one.
function exitCode(value: unknown): number {
  if (typeof value === "number") return value;
  const record = obj(value);
  for (const key of ["code", "exit_code", "status"]) {
    if (typeof record[key] === "number") return record[key];
  }
  return 0;
}

type Shared = { web: Map<string, Page>; clients: Map<string, string[]>; hostId: string };

async function loadWindow(
  sessionId: string,
  session: string,
  activeWindowId: string,
  win: Json,
  { web, clients, hostId }: Shared,
): Promise<Tab> {
  const layers = list(win.layers);
  const blocks = layers.flatMap((layer) => list(layer.blocks));
  const others = blocks.filter((b) => str(b.block_id) !== SELF_BLOCK);
  const current = SELF_BLOCK !== "" && others.length !== blocks.length;

  // The block that names the tab: the focused one, unless that's this panel.
  const focusedId = str(win.focused_block_id);
  const tiled = layers
    .filter((layer) => str(layer.kind) === "tiled")
    .flatMap((layer) => list(layer.blocks))
    .filter((b) => str(b.block_id) !== SELF_BLOCK);
  const block = others.find((b) => str(b.block_id) === focusedId) ?? tiled[0] ?? others[0];

  // Rex focuses the pane the tab last had focused. A browser pane there would
  // hand the keyboard to RexWeb, so pick the first pane that isn't one: tiled
  // panes in layout order, then floating ones.
  const focused = blocks.find((b) => str(b.block_id) === focusedId);
  const plain = [...tiled, ...others].find((b) => !web.has(str(b.block_id)));
  const focusBlock =
    focused !== undefined && web.has(focusedId) && plain !== undefined ? str(plain.block_id) : "";

  let title = "";
  let status = "";
  let kind = "";
  let message = "";
  let app = "";
  let since = 0;
  let program = "";
  let exit = 0;
  let cwd = "";
  let branch = "";
  if (block !== undefined && str(block.creator_name) === TERMINAL) {
    const named = str(block.block_id);
    // A browser pane names the tab but has nothing to report, so the status,
    // program and folder come from the tab's first ordinary pane.
    const id = web.has(named) && plain !== undefined ? str(plain.block_id) : named;
    const [t, s, p] = await Promise.all([
      blockCall(sessionId, named, "title"),
      blockCall(sessionId, id, "program_status"),
      blockCall(sessionId, id, "process"),
    ]);
    title = str(t.title);
    const record = obj(list(s.records)[0]);
    status = str(record.state);
    kind = status === "blocked" ? str(record.kind) : "";
    message = str(record.msg);
    app = str(record.effective_app) || str(record.app);
    since = Date.parse(str(record.updated_at)) || 0;

    const front = obj(p.foreground);
    // argv0 is what was typed ("claude", "-zsh", a path to node); the
    // process name can be something else, such as "claude.exe".
    program = web.has(id) ? "browser" : (str(front.argv0).split("/").pop() ?? "").replace(/^-/, "") || str(front.name);
    exit = exitCode(p.last_exit);
    const dir = str(front.cwd);
    if (dir !== "" && !web.has(id)) {
      const home = str(p.home);
      cwd = home !== "" && (dir === home || dir.startsWith(home + "/")) ? "~" + dir.slice(home.length) : dir;
      // git runs on this machine, so only for a folder that is on it.
      if (hostId === "" || str(block.host_id) === hostId) branch = await branchOf(dir);
    }
  }
  if (status === "idle") status = "";
  if (status === "" && exit !== 0) status = "failed";

  const floating = layers
    .filter((layer) => str(layer.kind) !== "tiled")
    .flatMap((layer) => list(layer.blocks))
    .filter((b) => str(b.block_id) !== SELF_BLOCK).length;
  const page = others.map((b) => web.get(str(b.block_id))).find((found) => found !== undefined);

  const windowLabel = str(win.label);
  const renamed = windowLabel !== "" && !/^Window [0-9a-f]{8}$/.test(windowLabel);
  const blockLabel = block === undefined ? "" : str(block.label);
  return {
    sessionId,
    session,
    windowId: str(win.window_id),
    title: (renamed ? windowLabel : title || blockLabel || windowLabel) || "(untitled)",
    renamed,
    ownTitle: title || blockLabel || (renamed ? "" : windowLabel) || "(untitled)",
    status,
    kind,
    message,
    app,
    since,
    program,
    exit,
    cwd,
    branch,
    panes: others.length,
    floating,
    page: page?.title ?? "",
    pageTabs: page?.tabs ?? 0,
    pageLoading: page?.loading ?? false,
    active: str(win.window_id) === activeWindowId,
    clients: clients.get(sessionId) ?? [],
    current,
    label: "",
    focusBlock,
  };
}

export async function loadTabs(): Promise<Tab[]> {
  const [listing, web, clients, who] = await Promise.all([
    rexJson(["ls", "--json"]),
    webPanes(),
    sessionClients(),
    rexJson(["whoami", "--json"]).catch((): Json => ({})),
  ]);
  const shared: Shared = { web, clients, hostId: str(who.host_id) };
  const sessions = list(listing.sessions);
  const perSession = await Promise.all(
    sessions.map(async (s) => {
      const id = str(s.session_id);
      const name = str(s.label) || id.slice(-6);
      const view = await rexJson(["window", "ls", "-s", id, "--json"]);
      const active = str(view.active_window_id);
      return Promise.all(list(view.windows).map((w) => loadWindow(id, name, active, w, shared)));
    }),
  );

  // Labels: first letter picks the session, second the tab within it. When
  // that doesn't fit, fall back to plain sequential pairs.
  const fits =
    perSession.length <= ALPHABET.length && perSession.every((t) => t.length <= ALPHABET.length);
  let n = 0;
  perSession.forEach((tabs, si) => {
    tabs.forEach((tab, ti) => {
      tab.label = fits
        ? ALPHABET[si] + ALPHABET[ti]
        : ALPHABET[Math.floor(n / ALPHABET.length) % ALPHABET.length] + ALPHABET[n % ALPHABET.length];
      n++;
    });
  });
  return perSession.flat();
}

// Performs one of the app's actions, in the app that opened the panel.
export async function appDo(...args: string[]): Promise<void> {
  if (CLIENT === "") return void (await rex(["do", ...args]));
  try {
    await rex(["do", ...args, "-C", CLIENT]);
  } catch {
    // The client that opened the panel is gone (a one-off CLI call, say);
    // let Rex pick the app.
    await rex(["do", ...args]);
  }
}

export async function jump(tab: Tab): Promise<void> {
  if (!tab.current) await appDo("session.select", `session_id=${tab.sessionId}`, `window_id=${tab.windowId}`);
  // After the switch, not before: on showing a tab the app focuses the pane
  // it last had focused there, which would undo a focus set first.
  if (tab.focusBlock !== "") {
    await rex(["block", "focus", "-s", tab.sessionId, tab.focusBlock]).catch(() => {});
  }
}

// Names a tab, or with "" gives it back the name it would have on its own.
export async function rename(tab: Tab, title: string): Promise<void> {
  // After "--", so a name that starts with a dash isn't read as a flag.
  await rex(["window", "rename", "-s", tab.sessionId, "--", tab.windowId, title]);
}
