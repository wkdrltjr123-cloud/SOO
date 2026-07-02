const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || process.env.OBS_TIMER_PORT || 17171);
const host = process.env.OBS_TIMER_HOST || process.env.HOST || "0.0.0.0";
const rootDir = __dirname;
const htmlPath = path.join(rootDir, "obs_timer.html");
const roulettePath = path.join(rootDir, "obs_roulette.html");
const tablePath = path.join(rootDir, "obs_table.html");
const controllerPath = path.join(rootDir, "obs_timer_controller.html");
const roomsPath = path.join(rootDir, "obs_timer_rooms.json");
const fontsDir = path.join(rootDir, "fonts");
const fontExtensions = new Set([".woff2", ".woff", ".ttf", ".otf"]);
const rouletteSpinDurations = [2000, 3000, 4000, 5000, 6000, 8000];
const defaultRouletteSpinDuration = 3000;
const rouletteSpinSettleDelay = 900;
const tableRowLimit = 50;
const ssePingInterval = 25000;

const defaults = {
  duration: 0,
  remaining: 0,
  elapsed: 0,
  running: false,
  lastStartedAt: 0,
  updatedAt: 0,
  mode: "down",
  textColor: "#ffffff",
  outlineColor: "#000000",
  outlineWidth: 4,
  fontSize: 180,
  fontFile: "",
  showHours: false,
  solidBg: false,
  bgOpacity: 100,
  outputWidth: 320,
  outputHeight: 140,
  roulette: createDefaultRoulette(),
  table: createDefaultTable()
};

let rooms = loadRooms();
const eventClients = new Map();
const rouletteSettleTimers = new Map();

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
  next.updatedAt = Number(next.updatedAt) || 0;
  next.mode = next.mode === "up" ? "up" : "down";
  next.textColor = normalizeHex(next.textColor, defaults.textColor);
  next.outlineColor = normalizeHex(next.outlineColor, defaults.outlineColor);
  next.outlineWidth = clampNumber(next.outlineWidth, 0, 40, defaults.outlineWidth);
  next.fontSize = clampNumber(next.fontSize, 72, 260, defaults.fontSize);
  next.fontFile = sanitizeFontName(next.fontFile);
  next.showHours = Boolean(next.showHours);
  next.solidBg = Boolean(next.solidBg);
  next.bgOpacity = clampNumber(next.bgOpacity, 0, 100, defaults.bgOpacity);
  next.outputWidth = clampNumber(next.outputWidth, 120, 1920, defaults.outputWidth);
  next.outputHeight = clampNumber(next.outputHeight, 60, 1080, defaults.outputHeight);
  next.roulette = normalizeRoulette(next.roulette);
  next.table = normalizeTable(next.table);
  return next;
}

function clampInt(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function createDefaultRoulette() {
  return {
    step: "count",
    count: 2,
    options: [
      { label: "선택지 1", weight: 1, manualProbability: null },
      { label: "선택지 2", weight: 1, manualProbability: null }
    ],
    visible: false,
    spinning: false,
    rotation: 0,
    spinStartedAt: 0,
    spinDuration: defaultRouletteSpinDuration,
    resultIndex: -1
  };
}

function cleanRouletteLabelText(value) {
  return String(value || "").normalize("NFC").replace(/[\uFFFD\u0000-\u001F\u007F]/g, "").trim();
}

function sliceRouletteLabelText(value) {
  const text = cleanRouletteLabelText(value);
  if (Intl?.Segmenter) {
    const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment).slice(0, 7).join("");
  }
  return Array.from(text).slice(0, 7).join("");
}

function sanitizeRouletteLabel(value, fallback) {
  const label = sliceRouletteLabelText(value);
  return label || fallback;
}

function normalizeManualProbability(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return clampNumber(number, 0, 100, 0);
}

function getOptionWeight(option) {
  const weight = Number(option?.weight);
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function applyRouletteProbabilityWeights(options) {
  if (!options.length) return;

  const manualOptions = options.filter((option) => option.manualProbability !== null);
  const autoOptions = options.filter((option) => option.manualProbability === null);

  if (!manualOptions.length) {
    options.forEach((option) => {
      option.weight = 1;
    });
    return;
  }

  const manualSum = manualOptions.reduce((sum, option) => sum + Math.max(0, Number(option.manualProbability) || 0), 0);

  if (manualSum <= 0) {
    options.forEach((option) => {
      option.weight = option.manualProbability === null ? 1 : 0;
    });
  } else if (manualSum >= 100 || !autoOptions.length) {
    options.forEach((option) => {
      option.weight = option.manualProbability === null ? 0 : (Math.max(0, Number(option.manualProbability) || 0) / manualSum) * 100;
    });
  } else {
    const autoShare = (100 - manualSum) / autoOptions.length;
    options.forEach((option) => {
      option.weight = option.manualProbability === null ? autoShare : Math.max(0, Number(option.manualProbability) || 0);
    });
  }

  if (options.reduce((sum, option) => sum + getOptionWeight(option), 0) <= 0) {
    options.forEach((option) => {
      option.weight = 1;
    });
  }
}

function normalizeRouletteSpinDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return defaultRouletteSpinDuration;
  return rouletteSpinDurations.reduce((best, current) => (
    Math.abs(current - number) < Math.abs(best - number) ? current : best
  ), rouletteSpinDurations[0]);
}

function normalizeRoulette(value) {
  const defaultsRoulette = createDefaultRoulette();
  const source = value && typeof value === "object" ? value : {};
  const { history: _history, ...sourceWithoutHistory } = source;
  const count = clampInt(source.count, 1, 15);
  const rawOptions = Array.isArray(source.options) ? source.options : [];
  const options = [];
  const legacyWeightTotal = rawOptions.slice(0, count).reduce((sum, option) => {
    const weight = option && typeof option === "object" ? Number(option.weight) : 1;
    return sum + (Number.isFinite(weight) && weight > 0 ? weight : 0);
  }, 0);
  const hasManualProbability = rawOptions.slice(0, count).some((option) => (
    option && typeof option === "object" && option.manualProbability !== undefined && option.manualProbability !== null && option.manualProbability !== ""
  ));
  const hasLegacyCustomWeight = !hasManualProbability && rawOptions.slice(0, count).some((option) => {
    const weight = option && typeof option === "object" ? Number(option.weight) : 1;
    return Number.isFinite(weight) && Math.abs(weight - 1) > 0.0001;
  });

  for (let index = 0; index < count; index += 1) {
    const option = rawOptions[index] && typeof rawOptions[index] === "object" ? rawOptions[index] : {};
    const legacyWeight = Number(option.weight);
    const manualProbability = hasLegacyCustomWeight && legacyWeightTotal > 0
      ? ((Number.isFinite(legacyWeight) && legacyWeight > 0 ? legacyWeight : 0) / legacyWeightTotal) * 100
      : normalizeManualProbability(option.manualProbability);
    options.push({
      label: sanitizeRouletteLabel(option.label, `선택지 ${index + 1}`),
      weight: 1,
      manualProbability
    });
  }
  applyRouletteProbabilityWeights(options);

  const step = ["count", "options", "spin"].includes(source.step) ? source.step : defaultsRoulette.step;

  return {
    ...defaultsRoulette,
    ...sourceWithoutHistory,
    step,
    count,
    options,
    visible: Boolean(source.visible),
    spinning: Boolean(source.spinning),
    rotation: Number(source.rotation) || 0,
    spinStartedAt: Number(source.spinStartedAt) || 0,
    spinDuration: normalizeRouletteSpinDuration(source.spinDuration),
    resultIndex: clampInt(source.resultIndex, -1, count - 1)
  };
}

function createDefaultTable() {
  return {
    headers: ["이름", "판매성공"],
    sortMode: "sequence",
    rows: Array.from({ length: tableRowLimit }, (_, index) => ({
      enabled: index < 10,
      name: String(index + 1),
      value: "0"
    }))
  };
}

function sliceTableText(value, limit, trim = true) {
  const text = String(value || "")
    .normalize("NFC")
    .replace(/[\uFFFD\u0000-\u001F\u007F]/g, "");
  const normalized = trim ? text.trim() : text;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
    return Array.from(segmenter.segment(normalized), (part) => part.segment).slice(0, limit).join("");
  }
  return Array.from(normalized).slice(0, limit).join("");
}

function sanitizeTableText(value, fallback, limit) {
  const text = sliceTableText(value, limit, true);
  return text || fallback;
}

function normalizeTable(value) {
  const defaultsTable = createDefaultTable();
  const source = value && typeof value === "object" ? value : {};
  const headers = Array.isArray(source.headers) ? source.headers : [];
  const rows = Array.isArray(source.rows) ? source.rows : [];

  return {
    headers: [
      sanitizeTableText(headers[0], defaultsTable.headers[0], 16),
      sanitizeTableText(headers[1], defaultsTable.headers[1], 16)
    ],
    sortMode: source.sortMode === "rank" ? "rank" : "sequence",
    rows: Array.from({ length: tableRowLimit }, (_, index) => {
      const row = rows[index] && typeof rows[index] === "object" ? rows[index] : {};
      return {
        enabled: row.enabled === undefined ? index < 10 : Boolean(row.enabled),
        name: sanitizeTableText(row.name, String(index + 1), 24),
        value: sanitizeTableText(row.value, "0", 32)
      };
    })
  };
}

function sanitizeFontName(value) {
  const baseName = path.basename(String(value || ""));
  return baseName.replace(/[<>:"|?*\u0000-\u001F]/g, "").slice(0, 160);
}

function getFontMimeType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".woff") return "font/woff";
  if (extension === ".ttf") return "font/ttf";
  if (extension === ".otf") return "font/otf";
  return "application/octet-stream";
}

function getFontLabel(fileName) {
  return sanitizeFontName(fileName)
    .replace(/\.(woff2?|ttf|otf)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

function listFonts() {
  try {
    return fs.readdirSync(fontsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => sanitizeFontName(entry.name))
      .filter((fileName) => fontExtensions.has(path.extname(fileName).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((fileName) => ({
        file: fileName,
        label: getFontLabel(fileName)
      }));
  } catch {
    return [];
  }
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
    rooms[room] = { key: "", state: normalizeState({}) };
  }
  return rooms[room];
}

function markStateUpdated(record, at = Date.now()) {
  record.state.updatedAt = Math.max(Number(record.state.updatedAt) || 0, Number(at) || 0);
}

function isIncomingStateStale(record, incomingState) {
  const currentUpdatedAt = Number(record.state.updatedAt) || 0;
  const incomingUpdatedAt = Number(incomingState.updatedAt) || 0;
  return currentUpdatedAt > 0 && incomingUpdatedAt > 0 && incomingUpdatedAt < currentUpdatedAt;
}

function getRoomState(room) {
  const record = getRoomRecord(room);
  settleCountdown(record);
  if (settleRouletteSpin(record)) {
    saveRooms();
    sendRoomUpdates(room, record, ["roulette", "control"]);
  }
  return record.state;
}

function sanitizeEventView(value) {
  const view = String(value || "").toLowerCase();
  return ["timer", "roulette", "table", "control"].includes(view) ? view : "control";
}

function getTimerSnapshot(state) {
  return {
    duration: state.duration,
    remaining: state.remaining,
    elapsed: state.elapsed,
    running: state.running,
    lastStartedAt: state.lastStartedAt,
    mode: state.mode,
    textColor: state.textColor,
    outlineColor: state.outlineColor,
    outlineWidth: state.outlineWidth,
    fontSize: state.fontSize,
    fontFile: state.fontFile,
    showHours: state.showHours,
    solidBg: state.solidBg,
    bgOpacity: state.bgOpacity,
    outputWidth: state.outputWidth,
    outputHeight: state.outputHeight,
    updatedAt: state.updatedAt
  };
}

function getRouletteSnapshot(state) {
  return state.roulette;
}

function getTableSnapshot(state) {
  return state.table;
}

function getSnapshotForView(state, view) {
  if (view === "timer") return { timer: getTimerSnapshot(state) };
  if (view === "roulette") return { roulette: getRouletteSnapshot(state) };
  if (view === "table") return { table: getTableSnapshot(state) };
  return { state };
}

function addEventClient(room, view, res) {
  if (!eventClients.has(room)) {
    eventClients.set(room, new Set());
  }

  const client = { view, res };
  eventClients.get(room).add(client);
  return client;
}

function removeEventClient(room, client) {
  const clients = eventClients.get(room);
  if (!clients) return;
  clients.delete(client);
  if (!clients.size) {
    eventClients.delete(room);
  }
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendRoomEvent(room, view, event, data) {
  const clients = eventClients.get(room);
  if (!clients) return;

  for (const client of clients) {
    if (client.view !== view) continue;
    writeSseEvent(client.res, event, data);
  }
}

function sendInitialEvent(room, client) {
  const state = getRoomState(room);
  const payload = getSnapshotForView(state, client.view);
  const event = client.view === "control" ? "state" : client.view;
  writeSseEvent(client.res, event, payload);
}

function sendRoomUpdates(room, record, scopes = ["timer", "roulette", "table", "control"]) {
  const state = record.state;
  if (scopes.includes("timer")) {
    sendRoomEvent(room, "timer", "timer", { timer: getTimerSnapshot(state) });
  }
  if (scopes.includes("roulette")) {
    sendRoomEvent(room, "roulette", "roulette", { roulette: getRouletteSnapshot(state) });
  }
  if (scopes.includes("table")) {
    sendRoomEvent(room, "table", "table", { table: getTableSnapshot(state) });
  }
  if (scopes.includes("control")) {
    sendRoomEvent(room, "control", "state", { state });
  }
}

function scheduleRouletteSettle(room, record) {
  const roulette = record.state.roulette;
  if (!roulette.spinning || !roulette.spinStartedAt) return;

  if (rouletteSettleTimers.has(room)) {
    clearTimeout(rouletteSettleTimers.get(room));
  }

  const remaining = Math.max(0, roulette.spinDuration + rouletteSpinSettleDelay - (Date.now() - roulette.spinStartedAt));
  const timer = setTimeout(() => {
    rouletteSettleTimers.delete(room);
    if (settleRouletteSpin(record)) {
      saveRooms();
      sendRoomUpdates(room, record, ["roulette", "control"]);
    }
  }, remaining + 20);
  rouletteSettleTimers.set(room, timer);
}

function settleCountdown(record) {
  const roomState = record.state;
  if (!roomState.running || roomState.mode !== "down" || !roomState.lastStartedAt) return;

  const elapsed = Math.max(0, (Date.now() - roomState.lastStartedAt) / 1000);
  if (elapsed >= roomState.remaining) {
    roomState.remaining = 0;
    roomState.running = false;
    roomState.lastStartedAt = Date.now();
    markStateUpdated(record);
    saveRooms();
  }
}

function freezeTimer(record) {
  const roomState = record.state;
  if (!roomState.running || !roomState.lastStartedAt) return;

  const elapsed = Math.max(0, (Date.now() - roomState.lastStartedAt) / 1000);
  if (roomState.mode === "down") {
    roomState.remaining = Math.max(0, roomState.remaining - elapsed);
    if (roomState.remaining <= 0) {
      roomState.running = false;
    }
  } else {
    roomState.elapsed = Math.max(0, roomState.elapsed + elapsed);
  }
  roomState.lastStartedAt = Date.now();
}

function startTimer(record) {
  const roomState = record.state;
  freezeTimer(record);

  if (roomState.mode === "down") {
    if (roomState.remaining <= 0 && roomState.duration > 0) {
      roomState.remaining = roomState.duration;
    }
    if (roomState.remaining <= 0) {
      roomState.running = false;
      roomState.lastStartedAt = Date.now();
      return { ok: false, status: "not_ready", message: "Timer duration is not set" };
    }
  }

  roomState.running = true;
  roomState.lastStartedAt = Date.now();
  return { ok: true, status: "started" };
}

function pauseTimer(record, status = "paused") {
  freezeTimer(record);
  record.state.running = false;
  record.state.lastStartedAt = Date.now();
  return { ok: true, status };
}

function resetTimer(record) {
  record.state.running = false;
  record.state.duration = 0;
  record.state.remaining = 0;
  record.state.elapsed = 0;
  record.state.lastStartedAt = Date.now();
  return { ok: true, status: "reset" };
}

function jumpTimer(record, seconds) {
  freezeTimer(record);
  const roomState = record.state;
  const delta = clampNumber(seconds, -86400, 86400, 0);

  if (roomState.mode === "down") {
    roomState.remaining = Math.max(0, roomState.remaining + delta);
    roomState.duration = Math.max(roomState.duration, roomState.remaining);
    if (roomState.remaining <= 0) {
      roomState.running = false;
    }
  } else {
    roomState.elapsed = Math.max(0, roomState.elapsed + delta);
  }

  roomState.lastStartedAt = Date.now();
  return { ok: true, status: "jumped", seconds: delta };
}

function applyTimerAction(record, action, url) {
  if (action === "start") return startTimer(record);
  if (action === "pause") return pauseTimer(record, "paused");
  if (action === "stop") return pauseTimer(record, "stopped");
  if (action === "toggle") {
    return record.state.running ? pauseTimer(record, "paused") : startTimer(record);
  }
  if (action === "reset") return resetTimer(record);
  if (action === "jump") return jumpTimer(record, url.searchParams.get("seconds") || url.searchParams.get("delta"));
  return { ok: false, status: "unknown", message: "Unknown timer action" };
}

function getRouletteTotalWeight(roulette) {
  return roulette.options.reduce((sum, option) => sum + getOptionWeight(option), 0);
}

function getRouletteSegmentCenter(roulette, index) {
  const total = getRouletteTotalWeight(roulette);
  let cursor = 0;

  for (let i = 0; i < roulette.options.length; i += 1) {
    const span = (getOptionWeight(roulette.options[i]) / total) * 360;
    if (i === index) return cursor + span / 2;
    cursor += span;
  }

  return 0;
}

function getRouletteVisualCenter(center) {
  return center - 90;
}

function pickRouletteResultIndex(roulette) {
  const total = getRouletteTotalWeight(roulette);
  let target = Math.random() * total;

  for (let index = 0; index < roulette.options.length; index += 1) {
    target -= getOptionWeight(roulette.options[index]);
    if (target <= 0) return index;
  }

  return roulette.options.length - 1;
}

function getRouletteTargetRotation(roulette, resultIndex) {
  const current = Number(roulette.rotation) || 0;
  const currentMod = ((current % 360) + 360) % 360;
  const visualCenter = getRouletteVisualCenter(getRouletteSegmentCenter(roulette, resultIndex));
  const alignDelta = (360 - ((currentMod + visualCenter) % 360)) % 360;
  return current + (360 * 7) + alignDelta;
}

function settleRouletteSpin(record) {
  const roulette = record.state.roulette;
  if (!roulette.spinning || !roulette.spinStartedAt) return false;

  const elapsed = Date.now() - roulette.spinStartedAt;
  if (elapsed < roulette.spinDuration + rouletteSpinSettleDelay) return false;

  roulette.spinning = false;
  markStateUpdated(record);
  return true;
}

function startRouletteSpin(record) {
  settleRouletteSpin(record);

  const roulette = record.state.roulette;
  if (roulette.spinning) {
    return { ok: false, status: "spinning", message: "Roulette is already spinning" };
  }

  if (roulette.step !== "spin") {
    return { ok: false, status: "not_ready", message: "Roulette options are not ready" };
  }

  const resultIndex = pickRouletteResultIndex(roulette);
  roulette.visible = true;
  roulette.spinning = true;
  roulette.spinStartedAt = Date.now();
  roulette.spinDuration = normalizeRouletteSpinDuration(roulette.spinDuration);
  roulette.resultIndex = resultIndex;
  roulette.rotation = getRouletteTargetRotation(roulette, resultIndex);

  return {
    ok: true,
    status: "started",
    resultIndex,
    result: roulette.options[resultIndex]?.label || ""
  };
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

function serveFont(res, fileName) {
  const safeName = sanitizeFontName(fileName);
  const extension = path.extname(safeName).toLowerCase();
  if (!safeName || !fontExtensions.has(extension)) {
    send(res, 404, "Font not found");
    return;
  }

  const fontPath = path.join(fontsDir, safeName);
  if (!fontPath.startsWith(fontsDir) || !fs.existsSync(fontPath)) {
    send(res, 404, "Font not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": getFontMimeType(safeName),
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*"
  });
  fs.createReadStream(fontPath).pipe(res);
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

  if (req.method === "GET" && (url.pathname === "/roulette" || url.pathname === "/roulette-display" || url.pathname === "/obs_roulette.html")) {
    serveHtml(res, roulettePath);
    return;
  }

  if (req.method === "GET" && (url.pathname === "/table" || url.pathname === "/table-display" || url.pathname === "/obs_table.html")) {
    serveHtml(res, tablePath);
    return;
  }

  if (req.method === "GET" && url.pathname === "/obs_timer_controller.html") {
    serveHtml(res, controllerPath);
    return;
  }

  if (req.method === "GET" && url.pathname === "/fonts") {
    send(res, 200, JSON.stringify(listFonts()), "application/json; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/fonts/")) {
    serveFont(res, decodeURIComponent(url.pathname.slice("/fonts/".length)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const room = getRoomName(url);
    const view = sanitizeEventView(url.searchParams.get("view"));

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no"
    });
    res.write(": connected\n\n");

    const client = addEventClient(room, view, res);
    sendInitialEvent(room, client);

    req.on("close", () => {
      removeEventClient(room, client);
    });
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname.startsWith("/timer/")) {
    const room = getRoomName(url);
    const key = sanitizeKey(url.searchParams.get("key"));
    const record = getRoomRecord(room);
    const action = sanitizeRoom(url.pathname.slice("/timer/".length));

    if (!key) {
      send(res, 403, JSON.stringify({ ok: false, error: "Missing control key" }), "application/json; charset=utf-8");
      return;
    }

    if (record.key && record.key !== key) {
      send(res, 403, JSON.stringify({ ok: false, error: "Invalid control key" }), "application/json; charset=utf-8");
      return;
    }

    if (!record.key && key) {
      record.key = key;
    }

    const result = applyTimerAction(record, action, url);
    markStateUpdated(record);
    saveRooms();
    sendRoomUpdates(room, record, ["timer", "control"]);
    send(res, result.ok ? 200 : 400, JSON.stringify({ ...result, state: record.state }), "application/json; charset=utf-8");
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && (url.pathname === "/roulette/spin" || url.pathname === "/roulette-spin")) {
    const room = getRoomName(url);
    const key = sanitizeKey(url.searchParams.get("key"));
    const record = getRoomRecord(room);

    if (!key) {
      send(res, 403, JSON.stringify({ ok: false, error: "Missing control key" }), "application/json; charset=utf-8");
      return;
    }

    if (record.key && record.key !== key) {
      send(res, 403, JSON.stringify({ ok: false, error: "Invalid control key" }), "application/json; charset=utf-8");
      return;
    }

    if (!record.key && key) {
      record.key = key;
    }

    const result = startRouletteSpin(record);
    if (result.ok) {
      markStateUpdated(record);
    }
    saveRooms();
    scheduleRouletteSettle(room, record);
    sendRoomUpdates(room, record, ["roulette", "control"]);
    send(res, 200, JSON.stringify({ ...result, state: record.state }), "application/json; charset=utf-8");
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
      const incomingState = normalizeState(JSON.parse(body || "{}"));
      if (isIncomingStateStale(record, incomingState)) {
        send(res, 200, JSON.stringify(record.state), "application/json; charset=utf-8");
        return;
      }

      record.state = incomingState;
      markStateUpdated(record, record.state.updatedAt || Date.now());
      saveRooms();
      scheduleRouletteSettle(room, record);
      sendRoomUpdates(room, record);
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

const ssePingTimer = setInterval(() => {
  const payload = { at: Date.now() };
  for (const [room, clients] of eventClients.entries()) {
    for (const client of [...clients]) {
      try {
        writeSseEvent(client.res, "ping", payload);
      } catch {
        removeEventClient(room, client);
      }
    }
  }
}, ssePingInterval);

if (typeof ssePingTimer.unref === "function") {
  ssePingTimer.unref();
}

server.listen(port, host, () => {
  console.log(`OBS timer server running`);
  console.log(`Display:    http://127.0.0.1:${port}/display`);
  console.log(`Roulette:   http://127.0.0.1:${port}/roulette`);
  console.log(`Table:      http://127.0.0.1:${port}/table`);
  console.log(`Controller: http://127.0.0.1:${port}/control`);
  console.log(`Listening:  ${host}:${port}`);
});
