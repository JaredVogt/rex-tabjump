#!/usr/bin/env node
// tabjump: a floating panel that lists every tab in every Rex session and
// jumps to one the way hop.nvim does: type two characters of its name, then
// the hint that appears on it. The behaviour lives in ./hop.ts, shared with
// the web panel; this file reads keys and draws.
//
// Opened by the `tabjump_open` action in ./init.lua. Run it by hand with
// `node tabjump.ts --list` to print the rows without the panel.

import { createState, press, renamed, view, type Segment, type State } from "./hop.ts";
import { SELF_BLOCK, appDo, blockCall, jump, loadTabs, rename, type Tab } from "./tabs.ts";

process.title = "rex-tabjump";

// The panel's own colours, set for this pane only (OSC 11 and OSC 10).
const BACKGROUND = "#0b2e1a";
const FOREGROUND = "#e4f1e8";
const TITLE_MAX = 50; // the longest tab name shown
const SELECTED_BG = "48;2;31;90;55"; // the selected row's bar

async function cellHeight(): Promise<number> {
  const size = await blockCall(process.env.REX_SESSION ?? "", SELF_BLOCK, "size");
  return typeof size.cell_height_px === "number" ? size.cell_height_px : 0;
}

// Makes this panel's text bigger. Rex sizes the font per pane and only for
// the focused one, so check the first step landed here and undo it if not.
async function bumpFont(steps: number): Promise<void> {
  if (steps <= 0 || SELF_BLOCK === "") return;
  const before = await cellHeight();
  if (before === 0) return;
  await appDo("client.font.increase");
  let grew = false;
  for (let i = 0; i < 10 && !grew; i++) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    grew = (await cellHeight()) > before;
  }
  if (!grew) return void (await appDo("client.font.decrease"));
  for (let i = 1; i < steps; i++) await appDo("client.font.increase");
}

// ---- The panel -----------------------------------------------------------

const ESC = "\x1b";
const sgr = (codes: string, text: string) => (codes === "" ? text : `${ESC}[${codes}m${text}${ESC}[0m`);

const HINT = "1;30;43"; // a hint: bold black on yellow
const MATCH = "1;97"; // the rest of a matched word
const SESSION = "38;2;140;220;170"; // session headers, mint
const RENAME = "1;33"; // the rename prompt, bold yellow

function statusColor(status: string): string {
  if (status === "working") return "33";
  if (status === "blocked") return "35";
  if (status === "failed" || status === "error") return "31";
  if (status === "done") return SESSION;
  return "2";
}

function clip(text: string, width: number): string {
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  return width <= 1 ? chars.slice(0, width).join("") : chars.slice(0, width - 1).join("") + "…";
}

// How many characters of `text` show on screen, escape codes aside.
function shown(text: string): number {
  return Array.from(text.replace(/\x1b\[[0-9;]*m/g, "")).length;
}

// Paints a row on the selection colour, edge to edge.
function bar(row: string, width: number): string {
  const on = `${ESC}[${SELECTED_BG}m`;
  const fill = " ".repeat(Math.max(0, width - shown(row)));
  return on + row.replaceAll(`${ESC}[0m`, `${ESC}[0m${on}`) + fill + `${ESC}[0m`;
}

// Draws a title or session name from its segments, cut to `max` characters.
// Each hint is drawn over the start of its segment, as hop does.
function draw(segments: Segment[], max: number, plain: string): { text: string; length: number } {
  const cells: { ch: string; codes: string }[] = [];
  for (const segment of segments) {
    const hint = Array.from(segment.hint);
    Array.from(segment.text).forEach((ch, i) => {
      if (i < hint.length) cells.push({ ch: hint[i], codes: HINT });
      else cells.push({ ch, codes: segment.match ? MATCH : plain });
    });
  }
  if (cells.length > max) {
    cells.length = Math.max(0, max - 1);
    if (max >= 1) cells.push({ ch: "…", codes: plain });
  }
  let text = "";
  for (let i = 0; i < cells.length; ) {
    let run = "";
    const codes = cells[i].codes;
    for (; i < cells.length && cells[i].codes === codes; i++) run += cells[i].ch;
    text += sgr(codes, run);
  }
  return { text, length: cells.length };
}

export function frame(state: State, cols: number, rows: number): string {
  const v = view(state);
  const width = Math.max(20, cols - 2);
  const out: string[] = [];
  // With hints up, everything that isn't a match steps back.
  const dim = v.hinting;

  const count = `${v.shown}/${v.total} tabs · ${v.sessions} sessions`;
  const heading = "Jump to tab";
  out.push(
    " " +
      sgr(dim ? "2" : "1", heading) +
      " ".repeat(Math.max(1, width - heading.length - count.length)) +
      sgr("2", clip(count, Math.max(0, width - heading.length - 1))),
  );

  // What you've typed, and the session the list is narrowed to. A name
  // being typed takes the whole line, showing its end if it is too long.
  const cursor = sgr("7", " ");
  let prompt: string;
  if (v.mode === "rename") {
    const label = "rename › ";
    const name = Array.from(v.typed).slice(-Math.max(1, width - label.length - 1)).join("");
    const rest = v.typed === "" ? sgr("2", clip(v.placeholder, Math.max(0, width - label.length - 1))) : "";
    prompt = sgr(RENAME, label) + name + cursor + rest;
  } else if (v.mode === "type") {
    prompt = sgr("36", "› ") + v.typed + cursor;
  } else {
    prompt = sgr("2", "› move") + (v.typed === "" ? "" : "  " + v.typed + cursor);
  }
  const filter =
    v.filterName === "" || v.mode === "rename"
      ? ""
      : "  " + sgr("2", "in ") + sgr(`1;${SESSION}`, clip(v.filterName, Math.max(4, width - shown(prompt) - 5)));
  out.push(" " + prompt + filter);

  // The sessions / status switch, then a bubble for each status in the list.
  const switches = v.options.map((option) => draw(option.segments, width, dim ? "2" : option.on ? "1;7" : "2").text);
  const bubbles = v.bubbles.map(
    (bubble) =>
      draw(bubble.segments, width, dim ? "2" : `${bubble.on ? "1;4;" : ""}${statusColor(bubble.status)}`).text +
      sgr("2", ` ${bubble.count}`),
  );
  out.push(" " + switches.join(" ") + "   " + bubbles.join("  "));

  // Body lines, each tagged with the tab index it shows (or -1 for headers).
  const body: { text: string; index: number }[] = [];
  for (const row of v.rows) {
    if (row.kind === "session" || row.kind === "status") {
      if (body.length > 0) body.push({ text: "", index: -1 });
      const color = row.kind === "session" ? SESSION : statusColor(row.status);
      const count = row.kind === "status" ? sgr("2", ` ${row.count}`) : "";
      body.push({ text: " " + draw(row.segments, width, `${dim ? "2" : "1"};${color}`).text + count, index: -1 });
      continue;
    }
    const tab = row.tab;
    // Under a status heading the session isn't above the row, so it goes here.
    const extras = [v.group === "status" ? tab.session : "", tab.status, tab.panes > 1 ? `${tab.panes} panes` : ""]
      .filter(Boolean)
      .join(" · ");
    const marker = tab.current ? "•" : " ";
    const room = width - 2 - 2 - (extras ? Array.from(extras).length + 2 : 0);
    const title = draw(row.segments, Math.max(4, Math.min(TITLE_MAX, room)), dim ? "2" : row.selected ? "1" : "");
    const pad = " ".repeat(Math.max(0, room - title.length));
    const tail = extras ? "  " + sgr(dim ? "2" : statusColor(tab.status), extras) : "";
    const pointer = row.selected ? sgr(dim ? "2;36" : "36", "›") : " ";
    const line = `${pointer} ${dim ? sgr("2", marker) : marker} ${title.text}${pad}${tail}`;
    body.push({ text: " " + (row.selected ? bar(line, width) : line), index: row.index });
  }
  if (v.shown === 0) body.push({ text: " " + sgr("2", "No tabs."), index: -1 });

  // Scroll so the selected row stays in view.
  const room = Math.max(1, rows - out.length - 2);
  let top = 0;
  const selLine = body.findIndex((line) => line.index >= 0 && line.index === state.selected);
  if (body.length > room && selLine >= 0) {
    top = Math.min(Math.max(0, selLine - Math.floor(room / 2)), body.length - room);
  }
  for (const line of body.slice(top, top + room)) out.push(line.text);
  while (out.length < rows - 1) out.push("");

  out.push(" " + (v.message ? sgr("31", clip(v.message, width)) : sgr("2", clip(v.help, width))));

  return out
    .slice(0, rows)
    .map((line) => line + `${ESC}[K`)
    .join("\r\n");
}

// Splits raw terminal input into the key names hop.ts expects, plus "close"
// for Ctrl+C. Ctrl+R is "Rename" and Ctrl+U "Clear". Escape sequences other
// than the up and down arrows are dropped.
export function keysOf(chunk: string): string[] {
  const keys: string[] = [];
  const chars = Array.from(chunk);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ESC) {
      const next = chars[i + 1];
      if (next === undefined || next === ESC) {
        keys.push("Escape");
      } else if (next === "[" || next === "O") {
        // A control sequence: parameters, then one final character.
        let end = i + 2;
        while (end < chars.length && next === "[" && /[0-9;:<=>? !"#$%&'()*+,\-./]/.test(chars[end])) end++;
        const sequence = chars.slice(i + 2, end + 1).join("");
        if (sequence === "A") keys.push("ArrowUp");
        else if (sequence === "B") keys.push("ArrowDown");
        i = end;
      } else {
        i++; // Alt+key
      }
    } else if (ch === "\x03") keys.push("close");
    else if (ch === "\r") keys.push("Enter");
    else if (ch === "\t") keys.push("Tab");
    else if (ch === "\x7f" || ch === "\b") keys.push("Backspace");
    else if (ch === "\x10") keys.push("ArrowUp");
    else if (ch === "\x0e") keys.push("ArrowDown");
    else if (ch === "\x12") keys.push("Rename");
    else if (ch === "\x15") keys.push("Clear");
    else if (ch >= " ") keys.push(ch);
  }
  return keys;
}

function runPanel(tabs: Tab[]): void {
  const state = createState(tabs);
  const out = process.stdout;
  const stdin = process.stdin;
  let last = "";
  let busy = false;

  // Paint only when the frame actually changed.
  const paint = () => {
    const next = frame(state, out.columns || 80, out.rows || 24);
    if (next === last) return;
    last = next;
    out.write(`${ESC}[H${next}`);
  };

  const close = (code: number) => {
    out.write(`${ESC}[?25h${ESC}[?1049l`);
    if (stdin.isTTY) stdin.setRawMode(false);
    process.exit(code);
  };

  const go = async (tab: Tab) => {
    busy = true;
    try {
      await jump(tab);
      close(0);
    } catch (err) {
      busy = false;
      state.message = `Couldn't jump: ${err instanceof Error ? err.message : String(err)}`;
      paint();
    }
  };

  // Renames the tab and stays open, with the new name in the list.
  const name = async (tab: Tab, title: string) => {
    busy = true;
    try {
      await rename(tab, title);
      renamed(tab, title);
    } catch (err) {
      state.message = `Couldn't rename: ${err instanceof Error ? err.message : String(err)}`;
    }
    busy = false;
    paint();
  };

  out.write(`${ESC}]11;${BACKGROUND}\x07${ESC}]10;${FOREGROUND}\x07`);
  out.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    for (const key of keysOf(chunk)) {
      if (key === "close") return close(0);
      if (busy) break; // a jump or rename is under way
      const action = press(state, key);
      if (action === null) continue;
      if (action.type === "close") return close(0);
      if (action.type === "rename") void name(action.tab, action.title);
      else void go(action.tab);
      break;
    }
    paint();
  });
  out.on("resize", () => {
    last = "";
    out.write(`${ESC}[2J`);
    paint();
  });
  paint();
}

// ---- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  try {
    const tabs = await loadTabs();
    if (process.argv.includes("--list")) {
      for (const tab of tabs) {
        const extras = [
          tab.current ? "current" : "",
          tab.renamed ? "renamed" : "",
          tab.status,
          tab.kind,
          tab.message,
          tab.program,
          tab.cwd,
          tab.branch,
          tab.exit !== 0 ? `exit ${tab.exit}` : "",
          tab.panes > 1 ? `${tab.panes} panes` : "",
          tab.floating > 0 ? `${tab.floating} floating` : "",
          tab.page ? `page "${tab.page}"` : "",
          tab.active ? "active" : "",
          tab.focusBlock ? `focus ${tab.focusBlock.slice(-6)} not the browser` : "",
        ];
        console.log([tab.session, tab.title, extras.filter(Boolean).join(", ")].join("\t"));
      }
    } else {
      runPanel(tabs);
      bumpFont(Number.parseInt(process.env.TABJUMP_FONT_BUMP ?? "0", 10) || 0).catch(() => {});
    }
  } catch (err) {
    console.error(`tabjump: ${err instanceof Error ? err.message : String(err)}`);
    // Keep the panel open long enough to read the error.
    if (!process.argv.includes("--list")) await new Promise((resolve) => setTimeout(resolve, 4000));
    process.exit(1);
  }
}

// Only when run, not when imported to draw a frame somewhere else.
if (import.meta.main) await main();
