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
--     node = "/opt/homebrew/bin/node",  -- the node that runs tabjump.ts (22.18 or later)
--     columns = 84,                     -- the panel's width in characters
--     left = 0.25,                      -- its left edge, as a fraction of the window's width
--     top = 0.12,                       -- its top edge, as a fraction of the window's height
--     height = 0.7,                     -- its height, as a fraction of the window's height
--     font_bump = 4,                    -- font size steps above your terminal font; 0 for none
--     web_key = "cmd+j",                -- open the web version (needs rexweb); false for no shortcut
--     web_width = 0.42,                 -- the web panel's width, as a fraction of the window's width
--     dir = nil,                        -- the folder holding tabjump.ts; found from this file by default
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
local WEB_PANE = os.getenv("HOME") .. "/Applications/RexWeb.app/Contents/Resources/rexweb-pane"

local defaults = {
  key = "cmd+o",
  node = "/opt/homebrew/bin/node",
  columns = 84,
  left = 0.25,
  top = 0.12,
  height = 0.7,
  font_bump = 4,
  web_key = "cmd+j",
  web_width = 0.42,
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

function M.setup(opts)
  opts = opts or {}
  for k, v in pairs(defaults) do
    if opts[k] == nil then opts[k] = v end
  end
  local dir = opts.dir or DIR
  local SCRIPT = dir .. "/tabjump.ts"
  local WEB_SCRIPT = dir .. "/tabjump-web.ts"
  M.dir = dir

  rex.action{
    name = "tabjump_open",
    title = "Jump to Tab",
    description = "List every tab in every session and jump to one: type two characters of its name, then the hint.",
    category = "Navigation",
    keywords = "tab session jump switch go easymotion hop hint navigate",
    run = function(ctx)
      local _, err = rex.session.new_layer{
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
                opts.node,
                SCRIPT,
              },
            },
          },
        },
      }
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
      local w = math.min(0.95, opts.web_width)
      local _, err = rex.session.new_layer{
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
                opts.node,
                WEB_SCRIPT,
              },
            },
          },
        },
      }
      if err ~= nil then error("tabjump: couldn't open the web panel: " .. tostring(err), 0) end
    end,
  }

  if opts.key then
    rex.bind(opts.key, "tabjump_open")
  end
  if opts.web_key then
    rex.bind(opts.web_key, "tabjump_web_open")
  end
end

return M
