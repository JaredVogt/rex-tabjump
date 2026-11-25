// The tab jumper's behaviour, shared by the terminal panel (tabjump.ts) and
// the web panel (panel.html): hop.nvim-style selection. Type two characters,
// every word containing them gets a hint, type the hint to pick it.
//
// Picking a tab in type mode jumps to it. In move mode it only puts the
// selection there: Enter jumps, and "Rename" (Ctrl+R, in either mode) renames
// the selected tab.
//
// Pure: no Node, no DOM, no side effects. The web server serves this file to
// the browser with its types stripped, so keep it to erasable TypeScript.

import type { Tab } from "./tabs.ts";

/** hop.nvim's default hint keys, in its order. */
export const HINT_KEYS = "asdghklqwertyuiopzxcvbnmfj";

export type Mode = "type" | "move";

/** How the list is grouped: under session names, or under status words. */
export type Group = "session" | "status";

/** The status word for a tab with nothing to report. */
export const QUIET = "quiet";

// Status groups and bubbles come in this order: what wants you first. A
// status that isn't listed goes after these; quiet tabs go last.
const STATUS_ORDER = ["blocked", "error", "failed", "working", "done"];

/** The word a tab is grouped and filtered by. */
export function statusOf(tab: Tab): string {
  return tab.status === "" ? QUIET : tab.status;
}

function rank(status: string): number {
  if (status === QUIET) return STATUS_ORDER.length + 1;
  const at = STATUS_ORDER.indexOf(status);
  return at === -1 ? STATUS_ORDER.length : at;
}

export type State = {
  tabs: Tab[];
  mode: Mode;
  typed: string; // 0, 1 or 2 search characters, lower case
  hintTyped: string; // first key of a two-key hint, else ""
  sessionFilter: string; // a sessionId, or "" for all sessions
  statusFilter: string; // a status word, or "" for every status
  group: Group;
  selected: number; // index into the visible tabs
  message: string; // one-line notice such as "No match", or ""
  renaming: Renaming | null; // the name being typed for a tab, if one is
};

/** A rename under way: the tab, and the name typed for it so far. */
export type Renaming = { tab: Tab; text: string };

/** A run of text in a row. Rows are drawn by concatenating their segments. */
export type Segment = {
  text: string;
  /** Part of a word that matched the two typed characters. */
  match: boolean;
  /**
   * Non-empty on exactly one segment per matching word: the segment holding
   * the two matched characters. The front end draws the hint over the start
   * of this segment's text (a one-key hint replaces its first character, a
   * two-key hint both), as hop does.
   */
  hint: string;
};

export type Row =
  | { kind: "session"; sessionId: string; segments: Segment[] }
  | { kind: "status"; status: string; count: number; segments: Segment[] }
  | {
      kind: "tab";
      tab: Tab;
      index: number; // index into the visible tabs
      selected: boolean;
      segments: Segment[]; // the tab's title only
    };

/** One side of the sessions / status switch. */
export type Option = { group: Group; on: boolean; segments: Segment[] };

/** A status with at least one tab: pick it to see only those tabs. */
export type Bubble = { status: string; count: number; on: boolean; segments: Segment[] };

export type View = {
  options: Option[];
  bubbles: Bubble[];
  group: Group;
  statusFilter: string;
  rows: Row[];
  mode: Mode | "rename";
  typed: string; // the search characters; while renaming, the new name
  placeholder: string; // while renaming, the name an empty one goes back to
  hinting: boolean; // hints are showing: dim everything that isn't a match
  filterName: string; // the filtered session's name, or ""
  shown: number; // visible tabs
  total: number; // all tabs
  sessions: number; // all sessions
  help: string; // one-line key help for the current mode
  message: string;
};

/**
 * What the front end must do. For "rename", give the tab the name `title`
 * ("" for the name it would have on its own), then call `renamed`.
 */
export type Action =
  | { type: "jump"; tab: Tab }
  | { type: "rename"; tab: Tab; title: string }
  | { type: "close" }
  | null;

const HELP_TYPE = "2 letters + hint jump · ctrl+r rename · tab sessions/status · esc move";
const HELP_MOVE = "j/k or 2 letters + hint select · enter jump · ctrl+r rename · esc close";
const HELP_RENAME = "enter save · an empty name goes back to the tab's own · esc cancel";

// ---- What is on screen ---------------------------------------------------

type Line =
  | { kind: "option"; group: Group; text: string; searched: boolean }
  | { kind: "bubble"; status: string; count: number; text: string; searched: boolean }
  | { kind: "session"; sessionId: string; text: string; searched: boolean }
  | { kind: "status"; status: string; count: number; text: string; searched: boolean }
  | { kind: "tab"; tab: Tab; index: number; text: string; searched: boolean };

type Match = {
  line: number; // index into the lines
  at: number; // where the two matched characters start, in characters of the line's text
  wordStart: number;
  wordEnd: number; // exclusive
  target: string; // matches with the same target do the same thing
  hint: string;
};

function inSession(state: State): Tab[] {
  if (state.sessionFilter === "") return state.tabs;
  return state.tabs.filter((tab) => tab.sessionId === state.sessionFilter);
}

// The tabs in the list, in the order they are drawn.
function visibleTabs(state: State): Tab[] {
  let tabs = inSession(state);
  if (state.statusFilter !== "") tabs = tabs.filter((tab) => statusOf(tab) === state.statusFilter);
  if (state.group === "session") return tabs;
  // Array.prototype.sort is stable, so tabs keep their session order within
  // a status.
  return [...tabs].sort((a, b) => rank(statusOf(a)) - rank(statusOf(b)));
}

// Everything on screen that holds words, in screen order: the switch, the
// status bubbles, then each heading followed by its tabs.
function lines(state: State): Line[] {
  const out: Line[] = [];
  for (const [group, text] of [["session", "Sessions"], ["status", "Status"]] as const) {
    // The side you're already on has nothing to pick.
    out.push({ kind: "option", group, text, searched: state.group !== group });
  }
  const counts = new Map<string, number>();
  for (const tab of inSession(state)) counts.set(statusOf(tab), (counts.get(statusOf(tab)) ?? 0) + 1);
  for (const status of [...counts.keys()].sort((a, b) => rank(a) - rank(b))) {
    out.push({ kind: "bubble", status, count: counts.get(status) ?? 0, text: status, searched: true });
  }

  const tabs = visibleTabs(state);
  let last: string | null = null;
  tabs.forEach((tab, index) => {
    const key = state.group === "session" ? tab.sessionId : statusOf(tab);
    if (key !== last) {
      last = key;
      if (state.group === "session") {
        out.push({
          kind: "session",
          sessionId: tab.sessionId,
          text: tab.session,
          // A session you've already filtered to has nothing left to pick.
          searched: state.sessionFilter === "",
        });
      } else {
        // Its bubble is the thing to pick, so the heading isn't searched.
        const count = tabs.filter((t) => statusOf(t) === key).length;
        out.push({ kind: "status", status: key, count, text: key, searched: false });
      }
    }
    out.push({ kind: "tab", tab, index, text: tab.title, searched: true });
  });
  return out;
}

function targetOf(line: Line): string {
  if (line.kind === "tab") return `tab:${line.index}`;
  if (line.kind === "session") return `session:${line.sessionId}`;
  if (line.kind === "option") return `group:${line.group}`;
  return `status:${line.status}`;
}

// Runs a change to the grouping, keeping the selection on the same tab.
function keepSelected(state: State, change: () => void): void {
  const tab = visibleTabs(state)[state.selected];
  change();
  state.selected = Math.max(0, tab === undefined ? 0 : visibleTabs(state).indexOf(tab));
}

/**
 * Adds tabs that were read late, such as another host's. The selection
 * stays on the tab it was on.
 */
export function addTabs(state: State, tabs: Tab[]): void {
  keepSelected(state, () => state.tabs.push(...tabs));
}

/** Groups the list by session or by status. */
export function setGroup(state: State, group: Group): void {
  keepSelected(state, () => (state.group = group));
}

/** Narrows the list to one status; the same status again shows them all. */
export function toggleStatus(state: State, status: string): void {
  state.statusFilter = state.statusFilter === status ? "" : status;
  state.selected = 0;
}

// Lower case, unless that would turn one character into several.
function fold(ch: string): string {
  const lower = ch.toLowerCase();
  return Array.from(lower).length === 1 ? lower : ch;
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

function isPrintable(key: string): boolean {
  return Array.from(key).length === 1 && key >= " " && key !== "\x7f";
}

// Every word on screen containing the two typed characters, in screen order,
// with its hint.
function findMatches(state: State, all: Line[]): Match[] {
  const typed = Array.from(state.typed);
  if (typed.length !== 2) return [];
  const [first, second] = typed;
  const found: Match[] = [];
  all.forEach((line, lineIndex) => {
    if (!line.searched) return;
    const target = targetOf(line);
    const chars = Array.from(line.text);
    let i = 0;
    while (i < chars.length) {
      if (isSpace(chars[i])) {
        i++;
        continue;
      }
      let end = i;
      while (end < chars.length && !isSpace(chars[end])) end++;
      for (let at = i; at + 1 < end; at++) {
        if (fold(chars[at]) === first && fold(chars[at + 1]) === second) {
          found.push({ line: lineIndex, at, wordStart: i, wordEnd: end, target, hint: "" });
          break;
        }
      }
      i = end;
    }
  });

  const keys = HINT_KEYS.length;
  if (found.length <= keys) {
    found.forEach((match, n) => (match.hint = HINT_KEYS[n]));
    return found;
  }
  // Too many for one key each: two keys for everyone, so no hint is the
  // start of another. Anything past the last pair goes unlabelled.
  const labelled = found.slice(0, keys * keys);
  labelled.forEach((match, n) => (match.hint = HINT_KEYS[Math.floor(n / keys)] + HINT_KEYS[n % keys]));
  return labelled;
}

// ---- Keys ----------------------------------------------------------------

export function createState(tabs: Tab[]): State {
  return {
    tabs,
    mode: "type",
    typed: "",
    hintTyped: "",
    sessionFilter: "",
    statusFilter: "",
    group: "session",
    selected: Math.max(
      0,
      tabs.findIndex((tab) => tab.current),
    ),
    message: "",
    renaming: null,
  };
}

/**
 * Records that `tab` now has the name `title`, or with "" its own name
 * again. For the front end to call once Rex has renamed it.
 */
export function renamed(tab: Tab, title: string): void {
  tab.renamed = title !== "";
  tab.title = title === "" ? tab.ownTitle : title;
}

function move(state: State, delta: number): void {
  const n = visibleTabs(state).length;
  if (n === 0) return;
  const from = Math.min(Math.max(0, state.selected), n - 1);
  state.selected = (from + delta + n) % n;
}

function jumpSelected(state: State): Action {
  const tab = visibleTabs(state)[state.selected];
  if (tab === undefined) return null;
  state.typed = "";
  state.hintTyped = "";
  return { type: "jump", tab };
}

function act(state: State, all: Line[], match: Match): Action {
  const line = all[match.line];
  state.typed = "";
  state.hintTyped = "";
  if (line.kind === "tab") {
    if (state.mode === "type") return { type: "jump", tab: line.tab };
    state.selected = line.index;
    return null;
  }
  if (line.kind === "option") setGroup(state, line.group);
  else if (line.kind === "bubble" || line.kind === "status") toggleStatus(state, line.status);
  else {
    state.sessionFilter = line.sessionId;
    state.selected = 0;
  }
  return null;
}

// Adds a search character; with the second one, finds the matches.
function search(state: State, key: string): Action {
  state.hintTyped = "";
  state.typed += fold(key);
  if (Array.from(state.typed).length < 2) return null;
  const all = lines(state);
  const matches = findMatches(state, all);
  if (matches.length === 0) {
    state.typed = "";
    state.message = "No match";
    return null;
  }
  if (matches.every((match) => match.target === matches[0].target)) return act(state, all, matches[0]);
  return null;
}

// Starts a rename of the selected tab. A name you gave it is there to edit;
// one the tab came up with itself is not.
function startRename(state: State): void {
  const tab = visibleTabs(state)[state.selected];
  if (tab === undefined) return;
  state.typed = "";
  state.hintTyped = "";
  state.renaming = { tab, text: tab.renamed ? tab.title : "" };
}

function pressRenaming(state: State, renaming: Renaming, key: string): Action {
  if (key === "Escape") {
    state.renaming = null;
  } else if (key === "Enter") {
    state.renaming = null;
    const title = renaming.text.trim();
    const { tab } = renaming;
    // Nothing to do when the name is the one it already has.
    if (title !== (tab.renamed ? tab.title : "")) return { type: "rename", tab, title };
  } else if (key === "Backspace") {
    renaming.text = Array.from(renaming.text).slice(0, -1).join("");
  } else if (key === "Clear") {
    renaming.text = "";
  } else if (isPrintable(key)) {
    renaming.text += key;
  }
  return null;
}

/**
 * Applies one key and returns what the front end must do, if anything.
 * Mutates `state`. `key` is a single printable character, or one of
 * "Escape", "Enter", "Backspace", "Tab", "ArrowUp", "ArrowDown" (the names the DOM
 * uses for `KeyboardEvent.key`), "Rename" (Ctrl+R) or "Clear" (Ctrl+U).
 * Unknown keys are ignored.
 */
export function press(state: State, key: string): Action {
  state.message = "";

  if (state.renaming !== null) return pressRenaming(state, state.renaming, key);

  if (key === "ArrowUp" || key === "ArrowDown") {
    move(state, key === "ArrowDown" ? 1 : -1);
    return null;
  }
  if (key === "Enter") return jumpSelected(state);
  if (key === "Rename") {
    startRename(state);
    return null;
  }
  if (key === "Tab") {
    state.typed = "";
    state.hintTyped = "";
    setGroup(state, state.group === "session" ? "status" : "session");
    return null;
  }

  if (key === "Escape") {
    // In move mode Escape first drops a search that is under way.
    if (state.mode === "move" && state.typed === "") return { type: "close" };
    state.mode = "move";
    state.typed = "";
    state.hintTyped = "";
    return null;
  }
  // j and k move only while nothing is typed: after that they are search
  // characters and hint keys like any other.
  if (state.mode === "move" && state.typed === "" && (key === "j" || key === "k")) {
    move(state, key === "j" ? 1 : -1);
    return null;
  }
  if (key === "Backspace") {
    if (state.hintTyped !== "") {
      state.hintTyped = "";
    } else if (state.typed !== "") {
      state.typed = Array.from(state.typed).slice(0, -1).join("");
    } else if (state.statusFilter !== "") {
      state.statusFilter = "";
      state.selected = 0;
    } else if (state.sessionFilter !== "") {
      state.sessionFilter = "";
      state.selected = 0;
    }
    return null;
  }
  if (!isPrintable(key) || key === " ") return null;

  if (Array.from(state.typed).length === 2) {
    // Hints are showing.
    const all = lines(state);
    const matches = findMatches(state, all);
    const wanted = state.hintTyped + fold(key);
    const hit = matches.find((match) => match.hint === wanted);
    if (hit !== undefined) return act(state, all, hit);
    if (state.hintTyped === "" && matches.some((match) => match.hint.startsWith(wanted))) {
      state.hintTyped = wanted;
      return null;
    }
    state.typed = "";
  }
  return search(state, key);
}

// ---- Drawing -------------------------------------------------------------

function segmentsOf(text: string, matches: Match[]): Segment[] {
  const chars = Array.from(text);
  const out: Segment[] = [];
  const push = (from: number, to: number, match: boolean, hint: string) => {
    if (to > from) out.push({ text: chars.slice(from, to).join(""), match, hint });
  };
  let at = 0;
  for (const match of matches) {
    push(at, match.wordStart, false, "");
    push(match.wordStart, match.at, true, "");
    push(match.at, match.at + 2, true, match.hint);
    push(match.at + 2, match.wordEnd, true, "");
    at = match.wordEnd;
  }
  push(at, chars.length, false, "");
  return out;
}

/** What to draw for `state`. Pure; does not mutate. */
export function view(state: State): View {
  const all = lines(state);
  // After the first key of a two-key hint, only the hints it could still
  // become stay up, showing the key that's left.
  const matches = findMatches(state, all)
    .filter((match) => match.hint.startsWith(state.hintTyped))
    .map((match) => ({ ...match, hint: match.hint.slice(state.hintTyped.length) }));
  const shown = visibleTabs(state).length;
  const selected = Math.min(Math.max(0, state.selected), Math.max(0, shown - 1));

  const options: Option[] = [];
  const bubbles: Bubble[] = [];
  const rows: Row[] = [];
  all.forEach((line, lineIndex) => {
    const segments = segmentsOf(
      line.text,
      matches.filter((match) => match.line === lineIndex),
    );
    if (line.kind === "option") options.push({ group: line.group, on: state.group === line.group, segments });
    else if (line.kind === "bubble") {
      bubbles.push({ status: line.status, count: line.count, on: state.statusFilter === line.status, segments });
    } else if (line.kind === "session") rows.push({ kind: "session", sessionId: line.sessionId, segments });
    else if (line.kind === "status") rows.push({ kind: "status", status: line.status, count: line.count, segments });
    else rows.push({ kind: "tab", tab: line.tab, index: line.index, selected: line.index === selected, segments });
  });

  const filtered = state.tabs.find((tab) => tab.sessionId === state.sessionFilter);
  return {
    options,
    bubbles,
    group: state.group,
    statusFilter: state.statusFilter,
    rows,
    mode: state.renaming === null ? state.mode : "rename",
    typed: state.renaming === null ? state.typed : state.renaming.text,
    placeholder: state.renaming === null ? "" : state.renaming.tab.ownTitle,
    hinting: matches.length > 0,
    filterName: state.sessionFilter === "" || filtered === undefined ? "" : filtered.session,
    shown,
    total: state.tabs.length,
    sessions: new Set(state.tabs.map((tab) => tab.sessionId)).size,
    help: state.renaming !== null ? HELP_RENAME : state.mode === "type" ? HELP_TYPE : HELP_MOVE,
    message: state.message,
  };
}
