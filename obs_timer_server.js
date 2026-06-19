const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || process.env.OBS_TIMER_PORT || 17171);
const host = process.env.OBS_TIMER_HOST || process.env.HOST || "0.0.0.0";
const rootDir = __dirname;
const htmlPath = path.join(rootDir, "obs_timer.html");
const controllerPath = path.join(rootDir, "obs_timer_controller.html");
const roomsPath = path.join(rootDir, "obs_timer_rooms.json");

const defaults = {
  duration: 600,
  remaining: 600,
  elapsed: 0,
  running: false,
  lastStartedAt: 0,
  mode: "down",
  textColor: "#ffffff",
  outlineColor: "#000000",
  fontSize: 180,
  showHours: false,
  solidBg: false
};

let rooms = loadRooms();

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeHex(value, fallback) {
  const raw = String(value || "").trim();
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  if (/^#[0-9a-fA-F]{3}$/.test(withHash)) {
    return `#${withHash[1]}${withHash[1]}${withHash[2]}${withHash[2]}${withHash[3]}${withHash[3]}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(withHash)) {
    return withHash.toLowerCase();
  }
  return fallback;
}

function normalizeState(value) {
  const next = { ...defaults, ...value };
  next.duration = clampNumber(next.duration, 0, 359999, defaults.duration);
  next.remaining = clampNumber(next.remaining, 0, 359999, defaults.remaining);
  next.elapsed = clampNumber(next.elapsed, 0, 359999, defaults.elapsed);
  next.running = Boolean(next.running);
  next.lastStartedAt = Number(next.lastStartedAt) || 0;
  next.mode = next.mode === "up" ? "up" : "down";
  next.textColor = normalizeHex(next.textColor, defaults.textColor);
  next.outlineColor = normalizeHex(next.outlineColor, defaults.outlineColor);
  next.fontSize = clampNumber(next.fontSize, 72, 260, defaults.fontSize);
  next.showHours = Boolean(next.showHours);
  next.solidBg = Boolean(next.solidBg);
  return next;
}

function loadRooms() {
  try {
    const parsed = JSON.parse(fs.readFileSync(roomsPath, "utf8"));
    return Object.fromEntries(
      Object.entries(parsed).map(([room, roomRecord]) => [sanitizeRoom(room) || "default", normalizeRoomRecord(roomRecord)])
    );
  } catch {
    return {};
  }
}

function saveRooms() {
  fs.writeFileSync(roomsPath, JSON.stringify(rooms, null, 2), "utf8");
}

function sanitizeRoom(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40);
}

function sanitizeKey(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
}

function normalizeRoomRecord(value) {
  if (value && typeof value === "object" && "state" in value) {
    return {
      key: sanitizeKey(value.key),
      state: normalizeState(value.state)
    };
  }

  return {
    key: "",
    state: normalizeState(value)
  };
}

function getRoomName(url) {
  return sanitizeRoom(url.searchParams.get("room") || url.searchParams.get("r")) || "default";
}

function getRoomRecord(room) {
  if (!rooms[room]) {
    rooms[room] = { key: "", state: { ...defaults } };
  }
  return rooms[room];
}

function getRoomState(room) {
  const record = getRoomRecord(room);
  settleCountdown(record);
  return record.state;
}

function settleCountdown(record) {
  const roomState = record.state;
  if (!roomState.running || roomState.mode !== "down" || !roomState.lastStartedAt) return;

  const elapsed = Math.max(0, (Date.now() - roomState.lastStartedAt) / 1000);
  if (elapsed >= roomState.remaining) {
    roomState.remaining = 0;
    roomState.running = false;
    roomState.lastStartedAt = Date.now();
    saveRooms();
  }
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function serveHtml(res, filePath) {
  send(res, 200, fs.readFileSync(filePath, "utf8"), "text/html; charset=utf-8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/control" || url.pathname === "/controller")) {
    serveHtml(res, htmlPath);
    return;
  }

  if (req.method === "GET" && (url.pathname === "/display" || url.pathname === "/obs_timer.html")) {
    serveHtml(res, htmlPath);
    return;
  }

  if (req.method === "GET" && url.pathname === "/obs_timer_controller.html") {
    serveHtml(res, controllerPath);
    return;
  }

  if (req.method === "GET" && url.pathname === "/state") {
    const room = getRoomName(url);
    send(res, 200, JSON.stringify(getRoomState(room)), "application/json; charset=utf-8");
    return;
  }

  if (req.method === "POST" && url.pathname === "/state") {
    try {
      const room = getRoomName(url);
      const key = sanitizeKey(url.searchParams.get("key"));
      const record = getRoomRecord(room);

      if (!key) {
        send(res, 403, JSON.stringify({ error: "Missing control key" }), "application/json; charset=utf-8");
        return;
      }

      if (record.key && record.key !== key) {
        send(res, 403, JSON.stringify({ error: "Invalid control key" }), "application/json; charset=utf-8");
        return;
      }

      if (!record.key && key) {
        record.key = key;
      }

      const body = await readBody(req);
      record.state = normalizeState(JSON.parse(body || "{}"));
      saveRooms();
      send(res, 200, JSON.stringify(record.state), "application/json; charset=utf-8");
    } catch (error) {
      send(res, 400, JSON.stringify({ error: error.message }), "application/json; charset=utf-8");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, "ok");
    return;
  }

  send(res, 404, "Not found");
});

server.listen(port, host, () => {
  console.log(`OBS timer server running`);
  console.log(`Display:    http://127.0.0.1:${port}/display`);
  console.log(`Controller: http://127.0.0.1:${port}/control`);
  console.log(`Listening:  ${host}:${port}`);
});
