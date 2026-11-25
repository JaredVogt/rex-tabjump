-- remote: reads or switches tabs on another Rex host. Run by tabs.ts with
-- `rex do`; Rex's config doesn't load it.
--
-- Connecting to a host takes a couple of seconds, so everything a panel
-- wants from one is fetched here over a single connection:
--
--   rex do remote.lua --args '{"mode":"list","host":"devbox"}'
--   rex do remote.lua --args '{"mode":"select","host":"devbox","session_id":"…","window_id":"…","app":"Mi5"}'
--
-- "list" returns the host's sessions as `rex window ls` prints them, and
-- for each terminal its title, status and process. "select" has the app
-- show a session there; with no host, or one this machine doesn't know by
-- that name, it looks for the session on every host.

local TERMINAL = "com.superlogical.terminal"
local args = rex.args or {}

local function known(label)
  for _, name in ipairs(rex.servers()) do
    if name == label then return true end
  end
  return false
end

-- The app's client on a host: the one named like the app that asked, or
-- failing that any app connected there.
local function app_client(server, want)
  local found = server.call("client.list")
  local first = nil
  for _, client in ipairs((found or {}).clients or {}) do
    local info = client.info or {}
    if info.kind == "app" and client.connection_state == "connected" then
      if want ~= nil and want ~= "" and info.label == want then return client.client_id end
      first = first or client.client_id
    end
  end
  return first
end

local function list(label)
  local server = rex.server(label)
  local found, err = server.call("session.list")
  if found == nil then error(label .. ": " .. tostring(err), 0) end
  local out = {
    sessions = {},
    blocks = {},
    clients = (server.call("client.list") or {}).clients or {},
  }
  for _, session in ipairs(found.sessions or {}) do
    -- A session's view is only given to a connection attached to it.
    local attached = server.session.attach{ session_id = session.session_id }
    local view = attached and attached.view
    if view ~= nil then
      out.sessions[#out.sessions + 1] = { session_id = session.session_id, label = session.label, view = view }
      for _, window in ipairs(view.windows or {}) do
        for _, layer in ipairs(window.layers or {}) do
          for _, block in ipairs(layer.blocks or {}) do
            if block.creator_name == TERMINAL then
              local at = { session_id = session.session_id, block_id = block.block_id }
              out.blocks[block.block_id] = {
                title = server.block.call(TERMINAL, "title", at),
                program_status = server.block.call(TERMINAL, "program_status", at),
                process = server.block.call(TERMINAL, "process", at),
              }
            end
          end
        end
      end
    end
  end
  return out
end

local function holds(label, session_id)
  local found = rex.server(label).call("session.list")
  for _, session in ipairs((found or {}).sessions or {}) do
    if session.session_id == session_id then return true end
  end
  return false
end

local function select(label, session_id, window_id, app)
  if label == nil or label == "" or not known(label) then
    label = nil
    for _, name in ipairs(rex.servers()) do
      if holds(name, session_id) then
        label = name
        break
      end
    end
    if label == nil then error("no host has that session any more", 0) end
  end
  local server = rex.server(label)
  local client = app_client(server, app)
  if client == nil then error("the app isn't connected to " .. label, 0) end
  local _, err = server.call("client.perform", {
    client_id = client,
    action = "session.select",
    args = { session_id = session_id, window_id = window_id },
  })
  if err ~= nil then error(label .. ": " .. tostring(err), 0) end
  return { host = label }
end

if args.mode == "list" then
  return list(args.host)
elseif args.mode == "select" then
  return select(args.host, args.session_id, args.window_id, args.app)
end
error('remote.lua: mode must be "list" or "select"', 0)
