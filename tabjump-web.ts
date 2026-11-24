#!/usr/bin/env node
// tabjump-web: the same tab jumper as tabjump.ts, drawn as a web page in a
// rexweb pane.
//
// Opened by the `tabjump_web_open` action in ./init.lua, as the program of a
// floating pane. It serves panel.html and the tab list on a local port, then
// asks RexWeb to draw that page over this pane. When the page asks to jump
// or close, it does so and exits, which closes the pane.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, createReadStream, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { SELF_BLOCK, jump, loadTabs, rename } from "./tabs.ts";

process.title = "rex-tabjump-web";

const PANE =
  process.env.TABJUMP_PANE ??
  join(process.env.HOME ?? "", "Applications/RexWeb.app/Contents/Resources/rexweb-pane");
const PAGE = join(import.meta.dirname, "panel.html");

// The page's background picture, if there is one: a file named background
// with an image extension, beside this script. Animated GIFs play.
const IMAGE_TYPES: Record<string, string> = {
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const BACKGROUND = readdirSync(import.meta.dirname).find((name) =>
  /^background\.(gif|png|jpe?g|webp)$/i.test(name),
);
const HOP = join(import.meta.dirname, "hop.ts");

// stripTypeScriptTypes is experimental and says so on stderr, which is this
// pane. Drop that one warning; every other warning prints as usual.
const printWarning = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("stripTypeScriptTypes")) return;
  for (const print of printWarning) print.call(process, warning);
});

// For measuring: with TABJUMP_TIMING set to a file, each step's time since
// this process started is appended to it. TABJUMP_FOCUS=false opens the panel
// without taking the keyboard.
const TIMING = process.env.TABJUMP_TIMING ?? "";
const FOCUS = process.env.TABJUMP_FOCUS !== "false";
const started = Date.now() - performance.now();
function mark(step: string): void {
  if (TIMING === "") return;
  appendFileSync(TIMING, `${Math.round(Date.now() - started)}ms ${step} (clock ${Date.now()})\n`);
}
mark("node running");

// Only a page that was handed this path can reach the server.
const token = randomBytes(16).toString("hex");
const tabs = loadTabs(); // started now, so it is ready when the page asks
void tabs.then(() => mark("tabs read from rex"), () => {});

// The selection logic the page shares with the terminal panel, as JavaScript.
// Its only import is a type, which stripping removes.
const hopJs = readFile(HOP, "utf8").then((source) => stripTypeScriptTypes(source, { mode: "strip" }));
hopJs.catch(() => {}); // a failure is reported when the page asks for it

// The web view makes RexWeb the active app, and closing the panel doesn't
// hand the keyboard back. Bring Rex forward again so the tab you land on
// takes keys without a click.
const REX_APP = process.env.TABJUMP_REX_APP ?? "com.superlogical.rex";
function finish(code: number): void {
  const exit = () => process.exit(code);
  if (!FOCUS) return exit();
  execFile("/usr/bin/open", ["-b", REX_APP], { timeout: 1000 }, exit);
  setTimeout(exit, 1200).unref();
}

// ---- Talking to RexWeb ---------------------------------------------------

const REXWEB_DIR = join(process.env.HOME ?? "", ".rexweb");

// One call to RexWeb's local API; null when it didn't answer with JSON.
async function rexweb(route: string, data: object, ms: number): Promise<Record<string, unknown> | null> {
  try {
    const [secret, config] = await Promise.all([
      readFile(join(REXWEB_DIR, "token"), "utf8"),
      readFile(join(REXWEB_DIR, "config.json"), "utf8").then((text): unknown => JSON.parse(text), () => ({})),
    ]);
    const settings = typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
    if (settings.engine === "chromium") return null; // the pane holder knows that app
    const apiPort = typeof settings.port === "number" ? settings.port : 18802;
    // Not fetch: it adds the headers a browser sends, and RexWeb turns away
    // anything that looks like a web page calling it.
    const text = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: apiPort, path: route, method: "POST", timeout: ms,
          headers: { "content-type": "application/json", "x-rexweb-token": secret.trim() } },
        (res) => {
          let out = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => { out += chunk; });
          res.on("end", () => resolve(out));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
      req.end(JSON.stringify(data));
    });
    const answer: unknown = JSON.parse(text);
    return typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// rexweb's own pane holder, used only when RexWeb can't be reached directly
// (it isn't running yet, say): it starts the app and registers the pane.
let holder: ChildProcess | null = null;

let closing = false;
function shutdown(code: number): void {
  if (closing) return;
  closing = true;
  server.close();
  // Rex comes forward only once the panel is gone, so RexWeb can't take the
  // keyboard back.
  if (holder === null) {
    void rexweb("/close", { id: SELF_BLOCK }, 800).then(() => finish(code));
  } else if (holder.exitCode === null) {
    holder.once("exit", () => finish(code));
    holder.kill("SIGTERM"); // its trap tells RexWeb to drop the panel
    setTimeout(() => finish(code), 1500).unref();
  } else {
    finish(code);
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return text === "" ? {} : JSON.parse(text);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const prefix = `/${token}/`;
  const path = (req.url ?? "").split("?")[0];
  if (!path.startsWith(prefix)) return send(res, 404, "text/plain", "not found");
  const route = `${req.method} ${path.slice(prefix.length)}`;

  mark(`request ${route}`);
  if (route === "POST mark") {
    const input = await body(req);
    mark(`page: ${typeof input === "object" && input !== null && "step" in input ? String(input.step) : "?"}`);
    return send(res, 200, "application/json", "{}");
  }
  if (route === "GET ") {
    return send(res, 200, "text/html; charset=utf-8", await readFile(PAGE, "utf8"));
  }
  if (route === "GET background") {
    if (BACKGROUND === undefined) return send(res, 404, "text/plain", "no background");
    const type = IMAGE_TYPES[BACKGROUND.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    createReadStream(join(import.meta.dirname, BACKGROUND)).pipe(res);
    return;
  }
  if (route === "GET hop.js") {
    return send(res, 200, "text/javascript", await hopJs);
  }
  if (route === "GET tabs") {
    return send(res, 200, "application/json", JSON.stringify({ tabs: await tabs }));
  }
  if (route === "POST jump") {
    const input = await body(req);
    const index =
      typeof input === "object" && input !== null && "index" in input ? Number(input.index) : -1;
    const tab = (await tabs)[index];
    if (tab === undefined) return send(res, 400, "application/json", JSON.stringify({ error: "no such tab" }));
    await jump(tab);
    send(res, 200, "application/json", "{}");
    return shutdown(0);
  }
  if (route === "POST rename") {
    const input = await body(req);
    const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const tab = (await tabs)[Number(fields.index ?? -1)];
    if (tab === undefined || typeof fields.title !== "string") {
      return send(res, 400, "application/json", JSON.stringify({ error: "no such tab" }));
    }
    await rename(tab, fields.title);
    return send(res, 200, "application/json", "{}");
  }
  if (route === "POST close") {
    send(res, 200, "application/json", "{}");
    return shutdown(0);
  }
  send(res, 404, "text/plain", "not found");
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) send(res, 500, "application/json", JSON.stringify({ error: message }));
  });
});

const port = await new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve(typeof address === "object" && address !== null ? address.port : 0);
  });
});

const url = `http://127.0.0.1:${port}/${token}/${TIMING === "" ? "" : "?timing"}`;

// Paint this pane the page's colour, so the wait for the web view isn't a flash.
process.stdout.write("\x1b]11;#0b2e1a\x07\x1b[?25l\x1b[2J\x1b[H");

// Registering with RexWeb directly skips the pane holder's start-up, about a
// tenth of a second.
const registered = await rexweb(
  "/register",
  { id: SELF_BLOCK, session: process.env.REX_SESSION ?? "", url, focus: FOCUS },
  1500,
);
if (typeof registered?.id === "string") {
  mark("registered with RexWeb");
} else {
  holder = spawn(PANE, [url], {
    stdio: "inherit",
    env: { ...process.env, REXWEB_FOCUS: FOCUS ? "true" : "false" },
  });
  mark("pane holder started");
  holder.on("error", (err) => {
    console.error(`tabjump-web: couldn't start rexweb (${err.message}). Is RexWeb installed?`);
    setTimeout(() => process.exit(1), 4000);
  });
  holder.on("exit", () => shutdown(0));
}
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => shutdown(0));
