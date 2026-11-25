// Tests for hop.ts. Run with:
//   /opt/homebrew/bin/node --test ~/.config/rex/tabjump/hop.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addTabs,
  HINT_KEYS,
  createState,
  press,
  renamed,
  setGroup,
  toggleStatus,
  view,
  type Row,
  type State,
  type View,
} from "./hop.ts";
import type { Tab } from "./tabs.ts";

function tab(sessionId: string, session: string, title: string, extra: Partial<Tab> = {}): Tab {
  return {
    host: "",
    sessionId,
    session,
    windowId: `${sessionId}-${title}`,
    title,
    renamed: false,
    ownTitle: title,
    status: "",
    kind: "",
    message: "",
    app: "",
    since: 0,
    program: "",
    exit: 0,
    cwd: "",
    branch: "",
    panes: 1,
    floating: 0,
    page: "",
    pageTabs: 0,
    pageLoading: false,
    active: false,
    clients: [],
    current: false,
    label: "",
    focusBlock: "",
    ...extra,
  };
}

// Two sessions. Screen order: "rex main", its three tabs, "dotfiles", its two.
function sample(): Tab[] {
  return [
    tab("s1", "rex main", "claude review"),
    tab("s1", "rex main", "nvim Makefile", { status: "working" }),
    tab("s1", "rex main", "server logs", { current: true }),
    tab("s2", "dotfiles", "zsh aliases"),
    tab("s2", "dotfiles", "make remake"),
  ];
}

function type(state: State, keys: string) {
  let action = null as ReturnType<typeof press>;
  for (const key of keys) action = press(state, key);
  return action;
}

// Every hint on screen, in screen order, with where it sits.
function hints(v: View): { hint: string; text: string; row: Row }[] {
  return v.rows.flatMap((row) =>
    row.segments.filter((s) => s.hint !== "").map((s) => ({ hint: s.hint, text: s.text, row })),
  );
}

function rowText(row: Row): string {
  return row.segments.map((s) => s.text).join("");
}

test("starts in type mode with nothing labelled", () => {
  const v = view(createState(sample()));
  assert.equal(v.mode, "type");
  assert.equal(v.hinting, false);
  assert.equal(hints(v).length, 0);
  assert.equal(v.help, "2 letters + hint jump · ctrl+r rename · tab sessions/status · esc move");
  assert.deepEqual([v.shown, v.total, v.sessions], [5, 5, 2]);
});

test("nothing is labelled after one character", () => {
  const state = createState(sample());
  assert.equal(press(state, "m"), null);
  const v = view(state);
  assert.equal(v.typed, "m");
  assert.equal(v.hinting, false);
  assert.equal(hints(v).length, 0);
  assert.ok(v.rows.every((row) => row.segments.every((s) => !s.match)));
});

test("matches anywhere in a word, case-insensitively", () => {
  const state = createState(sample());
  // "ma": main (session), Makefile, make, remake. Typed in upper case.
  assert.equal(type(state, "MA"), null);
  assert.equal(state.typed, "ma");
  const found = hints(view(state));
  assert.deepEqual(
    found.map((h) => h.text),
    ["ma", "Ma", "ma", "ma"],
  );
});

test("hints follow hop's key order in screen order", () => {
  const state = createState(sample());
  type(state, "ma");
  const found = hints(view(state));
  assert.deepEqual(
    found.map((h) => h.hint),
    Array.from(HINT_KEYS.slice(0, 4)),
  );
  assert.equal(HINT_KEYS, "asdghklqwertyuiopzxcvbnmfj");
  assert.deepEqual(
    found.map((h) => (h.row.kind === "tab" ? h.row.tab.title : h.row.kind === "session" ? h.row.sessionId : h.row.status)),
    ["s1", "nvim Makefile", "make remake", "make remake"],
  );
});

test("typing a hint jumps to its tab", () => {
  const state = createState(sample());
  type(state, "ma");
  const action = press(state, "s");
  assert.deepEqual(action, { type: "jump", tab: state.tabs[1] });
});

test("hint keys are matched whatever their case", () => {
  const state = createState(sample());
  type(state, "ma");
  assert.deepEqual(press(state, "S"), { type: "jump", tab: state.tabs[1] });
});

test("two matching words in one title each get a hint and jump to the same tab", () => {
  const state = createState(sample());
  type(state, "ma");
  const found = hints(view(state)).filter((h) => h.row.kind === "tab" && h.row.tab.title === "make remake");
  assert.deepEqual(
    found.map((h) => h.hint),
    ["d", "g"],
  );
  const other = createState(sample());
  type(other, "ma");
  assert.deepEqual(press(state, "d"), { type: "jump", tab: state.tabs[4] });
  assert.deepEqual(press(other, "g"), { type: "jump", tab: other.tabs[4] });
});

test("a single match jumps immediately", () => {
  const state = createState(sample());
  assert.equal(press(state, "z"), null);
  assert.deepEqual(press(state, "s"), { type: "jump", tab: state.tabs[3] });
});

test("two matches in one title jump immediately", () => {
  const tabs = [tab("s1", "one", "make remake"), tab("s1", "one", "other")];
  const state = createState(tabs);
  assert.deepEqual(type(state, "ma"), { type: "jump", tab: tabs[0] });
});

test("a word matching twice counts once, at its first occurrence", () => {
  const tabs = [tab("s1", "one", "xx banana"), tab("s1", "one", "an")];
  const state = createState(tabs);
  assert.equal(type(state, "an"), null);
  const found = hints(view(state));
  assert.equal(found.length, 2);
  const first = view(state).rows[1];
  assert.deepEqual(
    first.segments.map((s) => [s.text, s.match, s.hint]),
    [
      ["xx ", false, ""],
      ["b", true, ""],
      ["an", true, "a"],
      ["ana", true, ""],
    ],
  );
});

test("a session-name match filters to that session and clears typed", () => {
  const state = createState(sample());
  assert.equal(type(state, "do"), null); // only "dotfiles"
  assert.equal(state.sessionFilter, "s2");
  assert.equal(state.typed, "");
  assert.equal(state.mode, "type");
  const v = view(state);
  assert.equal(v.filterName, "dotfiles");
  assert.equal(v.hinting, false);
  assert.deepEqual([v.shown, v.total, v.sessions], [2, 5, 2]);
  assert.deepEqual(
    v.rows.map((row) => row.kind + ":" + rowText(row)),
    ["session:dotfiles", "tab:zsh aliases", "tab:make remake"],
  );
});

test("a session hint filters to that session", () => {
  const state = createState(sample());
  type(state, "ma");
  assert.equal(press(state, "a"), null); // "main" in "rex main"
  assert.equal(state.sessionFilter, "s1");
  assert.equal(state.typed, "");
  assert.equal(view(state).shown, 3);
});

test("the filtered session's own name is not searched", () => {
  const state = createState(sample());
  type(state, "do");
  assert.equal(type(state, "do"), null);
  assert.equal(state.message, "No match");
  assert.equal(state.sessionFilter, "s2");

  // With "main" out of the search, "ma" only finds "Makefile": jump.
  const other = createState(sample());
  type(other, "ma");
  press(other, "a"); // filter to "rex main"
  assert.deepEqual(type(other, "ma"), { type: "jump", tab: other.tabs[1] });
});

test("only visible rows are searched under a filter", () => {
  const state = createState(sample());
  type(state, "do");
  assert.equal(type(state, "cl"), null); // "claude" is in the other session
  assert.equal(state.message, "No match");
});

test("no match sets the message and clears typed", () => {
  const state = createState(sample());
  assert.equal(type(state, "qq"), null);
  assert.equal(state.typed, "");
  assert.equal(state.message, "No match");
  assert.equal(view(state).message, "No match");
  press(state, "m");
  assert.equal(state.message, "");
  assert.equal(state.typed, "m");
});

test("a non-hint key with hints showing starts a new search", () => {
  const state = createState(sample());
  type(state, "ma"); // hints a s d g
  assert.equal(press(state, "z"), null);
  assert.equal(state.typed, "z");
  assert.equal(view(state).hinting, false);
  assert.deepEqual(press(state, "s"), { type: "jump", tab: state.tabs[3] });
});

test("Backspace with hints showing removes one character and the hints", () => {
  const state = createState(sample());
  type(state, "ma");
  assert.equal(view(state).hinting, true);
  assert.equal(press(state, "Backspace"), null);
  assert.equal(state.typed, "m");
  assert.equal(view(state).hinting, false);
  assert.equal(hints(view(state)).length, 0);
});

test("Backspace with one character clears it", () => {
  const state = createState(sample());
  type(state, "do");
  press(state, "m");
  press(state, "Backspace");
  assert.equal(state.typed, "");
  assert.equal(state.sessionFilter, "s2");
});

test("Backspace with nothing typed clears the session filter", () => {
  const state = createState(sample());
  type(state, "do");
  press(state, "Backspace");
  assert.equal(state.sessionFilter, "");
  assert.equal(view(state).filterName, "");
  assert.equal(view(state).shown, 5);
  // And with no filter either, it does nothing.
  assert.equal(press(state, "Backspace"), null);
  assert.equal(state.typed, "");
});

test("a row's own details are not searched", () => {
  const panes = createState([tab("s1", "one", "alpha", { panes: 2, program: "zsh", cwd: "~/zshrc" }), tab("s1", "one", "beta")]);
  assert.equal(type(panes, "zs"), null); // the program and the folder
  assert.equal(panes.message, "No match");
  assert.equal(type(panes, "pa"), null); // "2 panes"
  assert.equal(panes.message, "No match");
});

test("space is ignored", () => {
  const state = createState(sample());
  type(state, "m a");
  assert.equal(state.typed, "ma");
  assert.equal(view(state).hinting, true);
});

test("unknown keys are ignored", () => {
  const state = createState(sample());
  press(state, "m");
  for (const key of ["Shift", "ArrowLeft", "F1", "\x01"]) assert.equal(press(state, key), null);
  assert.equal(state.typed, "m");
  assert.equal(state.mode, "type");
});

test("Escape goes to move mode, a second Escape closes", () => {
  const state = createState(sample());
  type(state, "do"); // filter on
  press(state, "m");
  assert.equal(press(state, "Escape"), null);
  assert.equal(state.mode, "move");
  assert.equal(state.typed, "");
  assert.equal(state.sessionFilter, "s2"); // the filter stays
  assert.equal(view(state).help, "j/k or 2 letters + hint select · enter jump · ctrl+r rename · esc close");
  assert.deepEqual(press(state, "Escape"), { type: "close" });
});

test("j, k and the arrows move the selection in move mode, wrapping", () => {
  const state = createState(sample());
  press(state, "Escape");
  assert.equal(state.selected, 2);
  press(state, "j");
  assert.equal(state.selected, 3);
  press(state, "ArrowDown");
  assert.equal(state.selected, 4);
  press(state, "j");
  assert.equal(state.selected, 0); // wrapped
  press(state, "k");
  assert.equal(state.selected, 4); // and back
  press(state, "ArrowUp");
  assert.equal(state.selected, 3);
  assert.equal(state.mode, "move");
  assert.deepEqual(press(state, "Enter"), { type: "jump", tab: state.tabs[3] });
});

test("the selection wraps over the visible tabs only", () => {
  const state = createState(sample());
  type(state, "do");
  press(state, "Escape");
  press(state, "j");
  press(state, "j");
  assert.equal(state.selected, 0);
  press(state, "j");
  assert.deepEqual(press(state, "Enter"), { type: "jump", tab: state.tabs[4] });
});

test("arrows and Enter work in type mode too", () => {
  const state = createState(sample());
  press(state, "ArrowDown");
  assert.equal(state.selected, 3);
  press(state, "ArrowUp");
  press(state, "ArrowUp");
  assert.equal(state.selected, 1);
  assert.equal(state.mode, "type");
  assert.deepEqual(press(state, "Enter"), { type: "jump", tab: state.tabs[1] });
});

test("in move mode a sole match is selected, not jumped to", () => {
  const state = createState(sample());
  press(state, "Escape");
  assert.equal(press(state, "Z"), null);
  assert.equal(state.mode, "move");
  assert.equal(view(state).typed, "z");
  assert.equal(press(state, "s"), null);
  assert.equal(state.mode, "move");
  assert.equal(state.typed, "");
  assert.equal(state.selected, 3);
  assert.deepEqual(press(state, "Enter"), { type: "jump", tab: state.tabs[3] });
});

test("in move mode a hint selects its tab", () => {
  const state = createState(sample());
  press(state, "Escape");
  assert.equal(type(state, "ma"), null); // main, Makefile, make, remake
  const found = hints(view(state));
  assert.equal(found.length, 4);
  const makefile = found.find((h) => rowText(h.row) === "nvim Makefile");
  assert.equal(press(state, makefile?.hint ?? ""), null);
  assert.equal(state.mode, "move");
  assert.equal(state.selected, 1);
  assert.equal(view(state).hinting, false);
});

test("in move mode a session name still narrows the list", () => {
  const state = createState(sample());
  press(state, "Escape");
  assert.equal(type(state, "do"), null);
  assert.equal(state.sessionFilter, "s2");
  assert.equal(state.mode, "move");
});

test("in move mode j and k move only while nothing is typed", () => {
  const state = createState([tab("s1", "one", "ajax"), tab("s1", "one", "bjork"), tab("s1", "one", "plain")]);
  press(state, "Escape");
  press(state, "j");
  assert.equal(state.selected, 1);
  assert.equal(state.typed, "");
  press(state, "k");
  assert.equal(state.selected, 0);
  press(state, "j");
  press(state, "j");
  assert.equal(state.selected, 2);
  // As the second character j searches: "aj" is only in ajax.
  type(state, "aj");
  assert.equal(state.selected, 0);
  // So does k: "rk" is only in bjork.
  type(state, "rk");
  assert.equal(state.selected, 1);
});

test("in move mode Escape drops a search before it closes", () => {
  const state = createState(sample());
  press(state, "Escape");
  type(state, "ma");
  assert.equal(view(state).hinting, true);
  assert.equal(press(state, "Escape"), null);
  assert.equal(view(state).hinting, false);
  assert.equal(state.mode, "move");
  assert.deepEqual(press(state, "Escape"), { type: "close" });
});

test("Rename asks for a name for the selected tab, in either mode", () => {
  const state = createState(sample());
  assert.equal(press(state, "Rename"), null);
  let v = view(state);
  assert.equal(v.mode, "rename");
  assert.equal(v.typed, ""); // a name the tab made up isn't offered for editing
  assert.equal(v.placeholder, "server logs");
  assert.equal(v.help, "enter save · an empty name goes back to the tab's own · esc cancel");
  // Every key is part of the name: no search, no moving, no hints.
  type(state, "My jk Tab");
  press(state, "ArrowDown");
  press(state, "Tab");
  v = view(state);
  assert.equal(v.typed, "My jk Tab");
  assert.equal(v.hinting, false);
  assert.equal(state.selected, 2);
  press(state, "Backspace");
  assert.deepEqual(press(state, "Enter"), { type: "rename", tab: state.tabs[2], title: "My jk Ta" });
  assert.equal(view(state).mode, "type");

  press(state, "Escape");
  press(state, "j");
  press(state, "Rename");
  assert.equal(view(state).placeholder, "zsh aliases");
  type(state, "  x ");
  assert.deepEqual(press(state, "Enter"), { type: "rename", tab: state.tabs[3], title: "x" });
  assert.equal(view(state).mode, "move");
});

test("Escape leaves a rename without renaming or closing", () => {
  const state = createState(sample());
  press(state, "Rename");
  type(state, "abc");
  assert.equal(press(state, "Escape"), null);
  assert.equal(view(state).mode, "type");
  assert.equal(view(state).typed, "");
  assert.equal(state.tabs[2].title, "server logs");
});

test("a name you gave is there to edit, and clearing it gives the tab's own back", () => {
  const tabs = sample();
  tabs[2] = tab("s1", "rex main", "logs!", { current: true, renamed: true, ownTitle: "server logs" });
  const state = createState(tabs);
  press(state, "Rename");
  assert.equal(view(state).typed, "logs!");
  assert.equal(press(state, "Enter"), null); // unchanged: nothing to do
  press(state, "Rename");
  press(state, "Clear");
  assert.equal(view(state).typed, "");
  assert.deepEqual(press(state, "Enter"), { type: "rename", tab: tabs[2], title: "" });
  renamed(tabs[2], "");
  assert.equal(tabs[2].title, "server logs");
  assert.equal(tabs[2].renamed, false);
  renamed(tabs[2], "again");
  assert.deepEqual([tabs[2].title, tabs[2].renamed], ["again", true]);
});

test("an empty name for a tab that has none of yours does nothing", () => {
  const state = createState(sample());
  press(state, "Rename");
  assert.equal(press(state, "Enter"), null);
  assert.equal(view(state).mode, "type");
});

test("more than 26 matches get prefix-free two-key hints", () => {
  const tabs = Array.from({ length: 30 }, (_, i) => tab("s1", "one", `xy${i}`));
  const state = createState(tabs);
  assert.equal(type(state, "xy"), null);
  const found = hints(view(state)).map((h) => h.hint);
  assert.equal(found.length, 30);
  assert.ok(found.every((h) => h.length === 2));
  assert.equal(new Set(found).size, 30);
  assert.deepEqual(found.slice(0, 3), ["aa", "as", "ad"]);
  assert.equal(found[26], "sa");
  for (const a of found) for (const b of found) assert.ok(a === b || !b.startsWith(a));
  for (const h of found) assert.ok(Array.from(h).every((key) => HINT_KEYS.includes(key)));
});

test("a two-key hint is completed with two key presses", () => {
  const tabs = Array.from({ length: 30 }, (_, i) => tab("s1", "one", `xy${i}`));
  const state = createState(tabs);
  type(state, "xy");
  assert.equal(press(state, "s"), null);
  assert.equal(state.hintTyped, "s");
  assert.equal(state.typed, "xy");
  // Only the hints starting with "s" stay up, showing what's left to type.
  const left = hints(view(state));
  assert.deepEqual(
    left.map((h) => h.hint),
    ["a", "s", "d", "g"],
  );
  assert.equal(view(state).hinting, true);
  assert.deepEqual(press(state, "d"), { type: "jump", tab: tabs[28] });

  const first = createState(tabs);
  type(first, "xy");
  assert.deepEqual(type(first, "aa"), { type: "jump", tab: tabs[0] });
});

test("Backspace after the first key of a two-key hint takes that key back", () => {
  const tabs = Array.from({ length: 30 }, (_, i) => tab("s1", "one", `xy${i}`));
  const state = createState(tabs);
  type(state, "xys");
  press(state, "Backspace");
  assert.equal(state.hintTyped, "");
  assert.equal(state.typed, "xy");
  assert.equal(hints(view(state)).length, 30);
});

test("a key that completes no two-key hint starts a new search", () => {
  const tabs = Array.from({ length: 30 }, (_, i) => tab("s1", "one", `xy${i}`));
  const state = createState(tabs);
  type(state, "xys"); // "s" then only a, s, d, g complete a hint
  assert.equal(press(state, "x"), null);
  assert.equal(state.hintTyped, "");
  assert.equal(state.typed, "x");
});

test("segments concatenate back to the full title and session name", () => {
  const state = createState(sample());
  const expected = ["rex main", "claude review", "nvim Makefile", "server logs", "dotfiles", "zsh aliases", "make remake"];
  for (const keys of ["", "m", "ma", "er"]) {
    const s = createState(sample());
    type(s, keys);
    assert.deepEqual(view(s).rows.map(rowText), expected, `after typing "${keys}"`);
  }
  assert.deepEqual(view(state).rows.map(rowText), expected);
});

test("one segment per matching word carries the hint and covers the two matched characters", () => {
  const state = createState(sample());
  type(state, "ma");
  const v = view(state);
  const row = v.rows[v.rows.length - 1]; // "make remake"
  assert.deepEqual(
    row.segments.map((s) => [s.text, s.match, s.hint]),
    [
      ["ma", true, "d"],
      ["ke", true, ""],
      [" ", false, ""],
      ["re", true, ""],
      ["ma", true, "g"],
      ["ke", true, ""],
    ],
  );
  for (const r of v.rows) {
    // Split each row back into words and count hints per matched word.
    let word: typeof r.segments = [];
    const words: (typeof r.segments)[] = [];
    for (const s of r.segments) {
      if (s.match) word.push(s);
      else if (word.length > 0) (words.push(word), (word = []));
    }
    if (word.length > 0) words.push(word);
    for (const w of words) {
      const hinted = w.filter((s) => s.hint !== "");
      assert.equal(hinted.length, 1);
      assert.equal(hinted[0].text.toLowerCase(), "ma");
    }
    assert.ok(r.segments.every((s) => s.match || s.hint === ""));
  }
});

test("selected starts on the current tab", () => {
  const state = createState(sample());
  assert.equal(state.selected, 2);
  const rows = view(state).rows.filter((row) => row.kind === "tab");
  assert.deepEqual(
    rows.map((row) => row.selected),
    [false, false, true, false, false],
  );
  assert.deepEqual(
    rows.map((row) => row.index),
    [0, 1, 2, 3, 4],
  );
  assert.equal(createState([tab("s1", "one", "a"), tab("s1", "one", "b")]).selected, 0);
});

test("selected resets to the first visible tab when the filter changes", () => {
  const state = createState(sample());
  press(state, "ArrowDown");
  press(state, "ArrowDown");
  assert.equal(state.selected, 4);
  type(state, "do");
  assert.equal(state.selected, 0);
  const rows = view(state).rows.filter((row) => row.kind === "tab");
  assert.deepEqual(
    rows.map((row) => row.selected),
    [true, false],
  );
  press(state, "ArrowDown");
  assert.equal(state.selected, 1);
  press(state, "Backspace"); // filter off
  assert.equal(state.selected, 0);
});

test("view does not mutate the state", () => {
  const state = createState(sample());
  type(state, "ma");
  const before = JSON.stringify(state);
  view(state);
  assert.equal(JSON.stringify(state), before);
});

test("an empty tab list is harmless", () => {
  const state = createState([]);
  assert.equal(type(state, "ab"), null);
  assert.equal(state.message, "No match");
  assert.equal(press(state, "Enter"), null);
  assert.equal(press(state, "ArrowDown"), null);
  assert.deepEqual(view(state).rows, []);
});

// ---- Grouping and filtering by status ------------------------------------

// Two sessions, every kind of status. Session order: build, tests, notes,
// deploy, logs.
function busy(): Tab[] {
  return [
    tab("s1", "alpha", "build", { status: "working" }),
    tab("s1", "alpha", "tests", { status: "failed" }),
    tab("s1", "alpha", "notes", { current: true }),
    tab("s2", "beta", "deploy", { status: "blocked" }),
    tab("s2", "beta", "logs", { status: "done" }),
  ];
}

const titles = (v: View) => v.rows.flatMap((row) => (row.kind === "tab" ? [row.tab.title] : []));
const text = (segments: { text: string }[]) => segments.map((s) => s.text).join("");

test("the switch starts on sessions and the bubbles count each status, most urgent first", () => {
  const v = view(createState(busy()));
  assert.equal(v.group, "session");
  assert.deepEqual(v.options.map((o) => [text(o.segments), o.on]), [["Sessions", true], ["Status", false]]);
  assert.deepEqual(
    v.bubbles.map((b) => [b.status, b.count]),
    [["blocked", 1], ["failed", 1], ["working", 1], ["done", 1], ["quiet", 1]],
  );
});

test("a status with no tabs has no bubble, and an unknown status goes before quiet", () => {
  const v = view(createState([tab("s1", "a", "one", { status: "paused" }), tab("s1", "a", "two"), tab("s1", "a", "three", { status: "working" })]));
  assert.deepEqual(v.bubbles.map((b) => b.status), ["working", "paused", "quiet"]);
});

test("Tab regroups by status and back, keeping the selection on the same tab", () => {
  const state = createState(busy());
  assert.equal(view(state).rows.find((row) => row.kind === "tab" && row.selected)?.kind, "tab");
  press(state, "Tab");
  const v = view(state);
  assert.equal(v.group, "status");
  assert.deepEqual(titles(v), ["deploy", "tests", "build", "logs", "notes"]);
  assert.deepEqual(
    v.rows.flatMap((row) => (row.kind === "status" ? [[row.status, row.count]] : [])),
    [["blocked", 1], ["failed", 1], ["working", 1], ["done", 1], ["quiet", 1]],
  );
  assert.equal(v.rows.some((row) => row.kind === "session"), false);
  const selected = v.rows.find((row) => row.kind === "tab" && row.selected);
  assert.equal(selected?.kind === "tab" && selected.tab.title, "notes");
  press(state, "Tab");
  assert.deepEqual(titles(view(state)), ["build", "tests", "notes", "deploy", "logs"]);
  assert.equal(state.selected, 2);
});

test("Tab clears what was typed", () => {
  const state = createState(busy());
  press(state, "b");
  press(state, "Tab");
  assert.equal(state.typed, "");
});

test("tabs keep their session order within a status", () => {
  const state = createState([
    tab("s1", "a", "one"),
    tab("s1", "a", "two", { status: "working" }),
    tab("s2", "b", "three"),
    tab("s2", "b", "four", { status: "working" }),
  ]);
  setGroup(state, "status");
  assert.deepEqual(titles(view(state)), ["two", "four", "one", "three"]);
});

test("the two letters of 'Status' flip the grouping when nothing else matches", () => {
  const state = createState(busy());
  assert.equal(type(state, "tu"), null); // only "Status" holds "tu"
  assert.equal(state.group, "status");
  assert.equal(state.typed, "");
});

test("the side of the switch you are on is not searched", () => {
  const state = createState(busy());
  assert.equal(type(state, "ss"), null); // "Sessions"
  assert.equal(state.message, "No match");
  setGroup(state, "status");
  assert.equal(type(state, "ss"), null);
  assert.equal(state.group, "session");
});

test("a bubble's hint narrows the list to that status, and again clears it", () => {
  const state = createState(busy());
  assert.equal(type(state, "bl"), null); // only "blocked"
  assert.equal(state.statusFilter, "blocked");
  let v = view(state);
  assert.deepEqual(titles(v), ["deploy"]);
  assert.deepEqual([v.shown, v.total], [1, 5]);
  assert.equal(v.bubbles.find((b) => b.status === "blocked")?.on, true);
  assert.equal(v.bubbles.length, 5); // the other bubbles stay, to move to
  assert.equal(type(state, "bl"), null);
  assert.equal(state.statusFilter, "");
  assert.equal(titles(view(state)).length, 5);
});

test("a bubble and a tab holding the same letters both get hints, bubble first", () => {
  const state = createState([tab("s1", "a", "block list"), tab("s1", "a", "other", { status: "blocked" })]);
  type(state, "bl");
  const v = view(state);
  assert.equal(v.hinting, true);
  assert.equal(v.bubbles.find((b) => b.status === "blocked")?.segments.find((s) => s.hint !== "")?.hint, HINT_KEYS[0]);
  assert.equal(hints(v)[0].hint, HINT_KEYS[1]);
  press(state, HINT_KEYS[0]);
  assert.equal(state.statusFilter, "blocked");
});

test("status headings are not searched, only their bubbles", () => {
  const state = createState(busy());
  setGroup(state, "status");
  type(state, "wo"); // "working": the bubble, not the heading
  assert.equal(state.statusFilter, "working");
});

test("bubbles count only the filtered session's tabs", () => {
  const state = createState(busy());
  state.sessionFilter = "s2";
  assert.deepEqual(view(state).bubbles.map((b) => [b.status, b.count]), [["blocked", 1], ["done", 1]]);
});

test("the status filter and the session filter combine", () => {
  const state = createState(busy());
  state.sessionFilter = "s1";
  toggleStatus(state, "failed");
  assert.deepEqual(titles(view(state)), ["tests"]);
});

test("Backspace with nothing typed clears the status filter before the session filter", () => {
  const state = createState(busy());
  state.sessionFilter = "s1";
  toggleStatus(state, "failed");
  press(state, "Backspace");
  assert.deepEqual([state.statusFilter, state.sessionFilter], ["", "s1"]);
  press(state, "Backspace");
  assert.equal(state.sessionFilter, "");
});

test("Enter jumps to the selected tab in status order", () => {
  const state = createState(busy());
  setGroup(state, "status");
  state.selected = 0;
  const action = press(state, "Enter");
  assert.equal(action?.type === "jump" && action.tab.title, "deploy");
});

test("tabs added late join the list and leave the selection on its tab", () => {
  const state = createState(sample());
  const selected = state.tabs[state.selected];
  addTabs(state, [tab("s3", "logs @devbox", "tail errors", { host: "devbox" })]);
  assert.equal(state.tabs[state.selected], selected);
  const v = view(state);
  assert.equal(v.total, 6);
  assert.equal(v.sessions, 3);
  assert.equal(titles(v).at(-1), "tail errors");
});
