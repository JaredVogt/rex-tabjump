-- tabjump: a floating panel that lists every tab in every session and jumps
-- to one the way hop.nvim does: type two characters of its name, then the
-- hint that appears on it.
--
-- Put this folder (or a link to it) at ~/.config/rex/tabjump, and add this
-- to ~/.config/rex/init.lua:
--
--   require("tabjump").setup{}
--
-- Options, with their defaults:
--
--   require("tabjump").setup{
--     key = "cmd+o",                    -- open the panel; false for no shortcut
--     node = nil,                       -- the node that runs tabjump.ts (22.18 or later); looked for by default
--     columns = 84,                     -- the panel's width in characters
--     left = 0.25,                      -- its left edge, as a fraction of the window's width
--     top = 0.12,                       -- its top edge, as a fraction of the window's height
--     height = 0.7,                     -- its height, as a fraction of the window's height
--     font_bump = 4,                    -- font size steps above your terminal font; 0 for none
--     web_key = "cmd+j",                -- open the web version; false for no shortcut. Unless you
--                                       -- set it yourself, it is bound only when RexWeb is installed
--     web_width = 900,                  -- the web panel's width in pixels; 1 or less is a fraction
--                                       -- of the window's width instead
--     dir = nil,                        -- the folder holding tabjump.ts; found from this file by default
--     rexweb = "~/Applications/RexWeb.app",  -- where RexWeb is, for the web panel
--     rex = nil,                        -- the rex command, used to open the panel from a tab on
--                                       -- another host; looked for by default
--   }
--
-- The terminal panel is tabjump.ts. The web panel is tabjump-web.ts, which
-- serves panel.html into a rexweb pane; restyle it by editing panel.html.

local M = {}

local SHELL = "com.superlogical.terminal.shell"

-- The folder this file is in, which is where the panel's scripts are. Lua
-- reports the file as it was loaded, with "@" in front under stock Lua.
local function own_dir()
  -- Asked about this function, not a stack level: under pcall, level 1 is
  -- pcall itself.
  local ok, info = pcall(debug.getinfo, own_dir, "S")
  local source = ok and type(info) == "table" and info.source or ""
  local dir = tostring(source):gsub("^@", ""):match("^(.*)[/\\][^/\\]*$")
  -- Not loaded from a file with a folder in its path: the usual place.
  return dir or (os.getenv("HOME") .. "/.config/rex/tabjump")
end
local DIR = own_dir()
local HOME = os.getenv("HOME") or ""

local function exists(path)
  local file = io.open(path, "r")
  if file == nil then return false end
  file:close()
  return true
end

-- The node to run the panels with: the first of the usual places that has
-- one, or failing that whichever `node` is on the pane's PATH.
local function find_node()
  for _, path in ipairs{ "/opt/homebrew/bin/node", "/usr/local/bin/node", HOME .. "/.local/bin/node", "/usr/bin/node" } do
    if exists(path) then return path end
  end
  return "node"
end

-- The rex command. Lua asks Rex for most things directly, but from a tab on
-- another host those calls go to that host, and this is the way back to
-- the server on this machine.
local function find_rex()
  local bin = os.getenv("REX_BIN_DIR")
  local places = {
    bin and (bin .. "/rex") or "",
    HOME .. "/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex",
    "/opt/homebrew/bin/rex",
    "/usr/local/bin/rex",
    HOME .. "/.local/bin/rex",
    "/usr/bin/rex",
  }
  for _, path in ipairs(places) do
    if path ~= "" and exists(path) then return path end
  end
  return "rex"
end

local defaults = {
  key = "cmd+o",
  columns = 84,
  left = 0.25,
  top = 0.12,
  height = 0.7,
  font_bump = 4,
  web_key = "cmd+j",
  web_width = 900,
  rexweb = HOME .. "/Applications/RexWeb.app",
}

local TERMINAL = "com.superlogical.terminal"

-- The rect of block `id` in a session view, as { x, y, w, h } window fractions.
local function find_rect(node, id)
  if type(node) ~= "table" then return nil end
  if node.block_id == id and type(node.rect) == "table" then return node.rect end
  for _, child in pairs(node) do
    local rect = find_rect(child, id)
    if rect ~= nil then return rect end
  end
  return nil
end

-- How many of the panel's characters fit across the window. Worked out from
-- the pane the panel opens over (its width in characters over its share of
-- the window), then scaled for the panel's bigger font: each font step adds
-- about half a pixel to a character's width.
local function window_columns(opts, block_id)
  if block_id == nil then return nil end
  local size = rex.block.call(TERMINAL, "size", { block_id = block_id })
  local view = rex.session.view{}
  if type(size) ~= "table" or type(size.columns) ~= "number" or view == nil then return nil end
  local rect = find_rect(view, block_id)
  if rect == nil or type(rect[3]) ~= "number" or rect[3] <= 0 then return nil end
  local cell = type(size.cell_width_px) == "number" and size.cell_width_px > 0 and size.cell_width_px or 9
  return (size.columns / rect[3]) * cell / (cell + 0.5 * opts.font_bump)
end

-- The window's width in pixels, worked out from the pane the panel opens
-- over: its width in characters, times a character's width, over its share
-- of the window.
local function window_pixels(block_id)
  if block_id == nil then return nil end
  local size = rex.block.call(TERMINAL, "size", { block_id = block_id })
  local view = rex.session.view{}
  if type(size) ~= "table" or type(size.columns) ~= "number" or view == nil then return nil end
  local rect = find_rect(view, block_id)
  if rect == nil or type(rect[3]) ~= "number" or rect[3] <= 0 then return nil end
  local cell = type(size.cell_width_px) == "number" and size.cell_width_px > 0 and size.cell_width_px or 9
  return size.columns * cell / rect[3]
end

-- The web panel's width as a fraction of the window. A `web_width` over 1
-- is in pixels, so the panel stays the same size on a wider window; if the
-- window can't be measured, it gets the old 0.42.
local function web_fraction(opts, block_id)
  local want = opts.web_width
  if want > 1 then
    local total = window_pixels(block_id)
    want = (total ~= nil and total > 0) and want / total or 0.42
  end
  return math.min(0.95, want)
end

-- Bounds for a panel `columns` characters wide with its left edge at
-- `left`, pulled back in if it would run off the window's right side.
local function bounds(opts, block_id)
  local total = window_columns(opts, block_id)
  local w = 0.4
  if total ~= nil and total > 0 then
    w = math.min(0.95, (opts.columns + 2) / total)
  end
  local x = math.max(0, math.min(opts.left, 1 - w))
  return { x, opts.top, w, opts.height }
end

-- Runs the rex command on this machine and returns what it printed as a
-- table, or nil and why not.
local function rex_json(rex_bin, args)
  local argv = { rex_bin }
  for _, arg in ipairs(args) do argv[#argv + 1] = arg end
  local result, err = rex.exec(argv, { timeout = 8 })
  if result == nil then return nil, tostring(err) end
  if not result.ok then return nil, (result.stderr ~= nil and result.stderr ~= "") and result.stderr or "rex failed" end
  local ok, value = pcall(rex.json.decode, result.stdout)
  if not ok or type(value) ~= "table" then return nil, "rex printed something that isn't JSON" end
  return value
end

-- A session on this machine to open the panel in: one the app that asked
-- has open, or failing that any app's, or any at all.
local function local_session(rex_bin, client_id)
  local found = rex_json(rex_bin, { "client", "ls", "--json" })
  local fallback = nil
  for _, client in ipairs((found or {}).clients or {}) do
    local first = type(client.session_ids) == "table" and client.session_ids[1] or nil
    if first ~= nil then
      if client.client_id == client_id then return first end
      if fallback == nil and type(client.info) == "table" and client.info.kind == "app" then fallback = first end
    end
  end
  if fallback ~= nil then return fallback end
  local sessions = rex_json(rex_bin, { "ls", "--json" })
  local any = ((sessions or {}).sessions or {})[1]
  return any and any.session_id or nil
end

-- Opens the panel's layer, and returns nil or what went wrong.
--
-- A pane runs on its session's host. From a tab on another host that is a
-- machine with no tabjump and maybe no node, so the panel opens in a
-- session on this machine instead and the app is switched to it. The panel
-- is told where it came from, to go back if it closes without a jump.
local function open_layer(rex_bin, ctx, layer)
  if ctx.server == nil then
    local _, err = rex.session.new_layer(layer)
    return err
  end
  local session = local_session(rex_bin, ctx.client_id)
  if session == nil then return "there is no session on this machine to open it in" end
  layer.session_id = session
  local command = layer.layout.block.options.command
  table.insert(command, 2, "TABJUMP_RETURN=" .. tostring(ctx.session_id or ""))
  table.insert(command, 3, "TABJUMP_RETURN_HOST=" .. tostring(ctx.server))
  local _, err = rex_json(rex_bin, { "api", "call", "session.new_layer", rex.json.encode(layer) })
  if err ~= nil then return err end
  -- Run by the app once this action returns. Without an app to ask (a CLI
  -- call, say) the panel is still there, in the session it opened in.
  pcall(rex.client.queue, "session.select", { session_id = session })
  return nil
end

function M.setup(opts)
  opts = opts or {}
  -- A shortcut you asked for is bound as asked; the default one only when
  -- there is a RexWeb for it to open.
  local web_key_given = opts.web_key ~= nil
  for k, v in pairs(defaults) do
    if opts[k] == nil then opts[k] = v end
  end
  local dir = opts.dir or DIR
  local SCRIPT = dir .. "/tabjump.ts"
  local WEB_SCRIPT = dir .. "/tabjump-web.ts"
  M.dir = dir
  if opts.node == nil then opts.node = find_node() end
  local REX = opts.rex or find_rex()
  local rexweb = tostring(opts.rexweb):gsub("^~", HOME)
  local WEB_PANE = rexweb .. "/Contents/Resources/rexweb-pane"
  local REXWEB_CLI = rexweb .. "/Contents/Resources/rexweb"
  local has_rexweb = exists(WEB_PANE)

  rex.action{
    name = "tabjump_open",
    title = "Jump to Tab",
    description = "List every tab in every session and jump to one: type two characters of its name, then the hint.",
    category = "Navigation",
    keywords = "tab session jump switch go easymotion hop hint navigate",
    run = function(ctx)
      local err = open_layer(REX, ctx, {
        bounds = bounds(opts, ctx.block_id),
        focus = true,
        layout = {
          block = {
            flavor = SHELL,
            label = "Jump to Tab",
            options = {
              command = {
                "/usr/bin/env",
                -- Jump in the app that asked; a CLI caller has no tabs to switch.
                "TABJUMP_CLIENT=" .. ((ctx.origin ~= "cli" and ctx.client_id) or ""),
                "TABJUMP_FONT_BUMP=" .. tostring(opts.font_bump),
                "TABJUMP_REXWEB=" .. REXWEB_CLI,
                opts.node,
                SCRIPT,
              },
            },
          },
        },
      })
      if err ~= nil then error("tabjump: couldn't open the panel: " .. tostring(err), 0) end
    end,
  }

  rex.action{
    name = "tabjump_web_open",
    title = "Jump to Tab (Web)",
    description = "The tab jumper drawn as a web page in a rexweb pane.",
    category = "Navigation",
    keywords = "tab session jump switch go easymotion hop hint navigate web rexweb",
    run = function(ctx)
      if not exists(WEB_PANE) then
        error("tabjump: the web panel needs RexWeb, and there is none at " .. rexweb .. ". Use Jump to Tab instead.", 0)
      end
      local w = web_fraction(opts, ctx.block_id)
      local err = open_layer(REX, ctx, {
        bounds = { math.max(0, math.min(opts.left, 1 - w)), opts.top, w, opts.height },
        focus = true,
        layout = {
          block = {
            flavor = SHELL,
            label = "Jump to Tab",
            options = {
              command = {
                "/usr/bin/env",
                "TABJUMP_CLIENT=" .. ((ctx.origin ~= "cli" and ctx.client_id) or ""),
                "TABJUMP_PANE=" .. WEB_PANE,
                "TABJUMP_REXWEB=" .. REXWEB_CLI,
                opts.node,
                WEB_SCRIPT,
              },
            },
          },
        },
      })
      if err ~= nil then error("tabjump: couldn't open the web panel: " .. tostring(err), 0) end
    end,
  }

  if opts.key then
    rex.bind(opts.key, "tabjump_open")
  end
  if opts.web_key and (web_key_given or has_rexweb) then
    rex.bind(opts.web_key, "tabjump_web_open")
  end
end

return M
