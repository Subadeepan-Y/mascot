/* Buddy Electron shell: per-widget overlay windows.
 *
 * Structural fix for the Chrome/hardware-video wars: there is NO fullscreen
 * window anymore. Each widget (mascot, subtitle, game, menu) is a small
 * transparent always-on-top window. Small windows composite cheap and never
 * cover video, so the setShape/fullscreen-shape architecture is gone: the
 * mascot window is click-through on its transparent corners via one static
 * tight rect, taps need no forwarding (nothing else lives under the window
 * that the user can't just click around), and popups are real windows.
 *
 * Coordinate ownership: the mascot renderer owns screen-space layout and
 * sends win-move/win-resize; main only clamps to the arena and relays
 * messages between the mascot brain and the dumb widget windows.
 */
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { clampPos, defaultPos, anchorPopup, subtitleGeom, arenaFor } = require("./winlayout");

app.setName("Bones");

// Exempt from background throttling and efficiency mode
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const APP_ICON = app.isPackaged
  ? path.join(process.resourcesPath, "assets", "buddy.ico")
  : path.join(__dirname, "..", "assets", "buddy.ico");
const BRIDGE_URL = "http://127.0.0.1:17385";
const UPDATE_REPO = "Subadeepan-Y/mascot";

let hiddenParent = null;
function getHiddenParent() {
  if (!hiddenParent || hiddenParent.isDestroyed()) {
    hiddenParent = new BrowserWindow({
      show: false,
      width: 0,
      height: 0,
      skipTaskbar: true,
      focusable: false,
      frame: false,
    });
  }
  return hiddenParent;
}

function isNewerVersion(remote, local) {
  if (!remote) return false;
  const parse = (v) => (v || "").split(".").map((n) => parseInt(n, 10) || 0);
  const r = parse(remote), l = parse(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0, lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

const wins = { mascot: null, subtitle: null, game: null, menu: null, island: null, hub: null };
let tray = null;
let bridgeProc = null;
let isQuitting = false;
let gameRunning = false;
let shownOnce = false;

function displays() {
  try {
    // workArea is {x,y,width,height}; layout speaks {x,y,w,h}
    return screen.getAllDisplays().map((d) => ({
      x: d.workArea.x, y: d.workArea.y, w: d.workArea.width, h: d.workArea.height,
    }));
  } catch {
    return [{ x: 0, y: 0, w: 1920, h: 1040 }];
  }
}

function arenaAt(x, y) {
  return arenaFor(displays(), x, y);
}

function mkWindow(opts) {
  const parent = getHiddenParent();
  const w = new BrowserWindow({
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    parent: parent,
    icon: APP_ICON,
    title: "Bones",
    resizable: false,
    movable: true, // frameless: user moves only via app-region drag; API moves unaffected
    focusable: opts && opts.focusable === false ? false : true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
    ...opts,
  });
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setFocusable(!(opts && opts.focusable === false));
  // Windows delivers no mouse input at all to a focusable:false window: the
  // press reaches it but no event ever lands in the renderer. So anything the
  // user must press has to be focusable. Showing is always showInactive() so
  // the overlay never grabs focus just by appearing.
  //
  // The mascot must be allowed to hold focus, because app-region drag begins by
  // activating the window: blurring on focus would abort the drag on mousedown.
  // Click-only widgets (game box, menu) blur immediately afterwards, so a
  // click never leaves one of our windows as the foreground window over the
  // user's browser.
  if (opts && opts.blurOnFocus) {
    w.on("focus", () => {
      try { w.blur(); } catch { /* tearing down */ }
    });
  }
  return w;
}

function ensureWindow(widget) {
  if (wins[widget] && !wins[widget].isDestroyed()) return wins[widget];
  const builders = {
    mascot: () => {
      const a = arenaAt(1e9, 1e9); // default park: bottom-right of primary
      // Initial window size accommodates the mascot's full body height (208px at default scale).
      // syncWinSize() in brain.js will snap to the exact art dimensions.
      const p = defaultPos(a, 140, 260);
      const w = mkWindow({ x: p.x, y: p.y, width: 140, height: 260 });
      w.loadFile(path.join(__dirname, "mascot.html"), { query: { widget } });
      // Never destroy the mascot on close — hide it, same pattern as the hub.
      // The mascot is recreated on second-instance / tray toggle if needed.
      w.on("close", (e) => {
        if (!isQuitting) {
          e.preventDefault();
          w.hide();
          ["subtitle", "game", "menu", "island"].forEach((wName) => {
            const childWin = wins[wName];
            if (childWin && !childWin.isDestroyed()) {
              try { childWin.hide(); } catch {}
            }
          });
        }
      });
      return w;
    },
    subtitle: () => {
      const g = subtitleGeom(arenaAt(1e9, 1e9));
      // no buttons here: keep it non-focusable so it can never hold focus
      const w = mkWindow({ x: g.x, y: g.y, width: g.w, height: g.h, focusable: false });
      // Transparent areas of a BrowserWindow still capture mouse events on Windows
      // even when the window is focusable:false. Forward lets real clicks reach
      // the user's apps while the subtitle text still renders on top.
      w.setIgnoreMouseEvents(true, { forward: true });
      w.loadFile(path.join(__dirname, "subtitle.html"), { query: { widget } });
      return w;
    },
    game: () => {
      const w = mkWindow({ x: 0, y: 0, width: 232, height: 160, blurOnFocus: true });
      w.loadFile(path.join(__dirname, "game.html"), { query: { widget } });
      return w;
    },
    menu: () => {
      const w = mkWindow({ x: 0, y: 0, width: 220, height: 300, blurOnFocus: true });
      w.loadFile(path.join(__dirname, "menu.html"), { query: { widget } });
      return w;
    },
    island: () => {
      const w = mkWindow({ x: 0, y: 0, width: 440, height: 120, focusable: false });
      // Same as subtitle: display-only, transparent areas must not block user clicks.
      w.setIgnoreMouseEvents(true, { forward: true });
      w.loadFile(path.join(__dirname, "island.html"), { query: { widget } });
      return w;
    },
    hub: () => {
      const parent = getHiddenParent();
      const w = new BrowserWindow({
        show: false,
        width: 480,
        height: 860,
        title: "Bones",
        backgroundColor: "#0a0a0a",
        icon: APP_ICON,
        resizable: true,
        skipTaskbar: true,
        type: "toolbar",
        parent: parent,
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      w.loadFile(path.join(__dirname, "hub.html"), { query: { widget: "hub" } });
      w.on("minimize", (e) => {
        e.preventDefault();
        w.hide();
      });
      w.on("close", (e) => {
        if (!isQuitting) {
          e.preventDefault();
          w.hide();
        }
      });
      return w;
    },
  };
  const w = builders[widget]();
  w.on("closed", () => { wins[widget] = null; });
  // first-load race: widget-show may arrive before the page boots.
  // Queue the latest msg; the widget pulls it on did-finish-load.
  w.webContents.on("did-finish-load", () => {
    if (pendingMsg[widget]) {
      const m = pendingMsg[widget];
      pendingMsg[widget] = null;
      sendTo(widget, "widget-msg", m);
    }
  });
  wins[widget] = w;
  return w;
}

const pendingMsg = {};

function sendTo(widget, channel, payload) {
  const w = wins[widget];
  if (!w || w.isDestroyed()) return;
  try { w.webContents.send(channel, payload); } catch { /* tearing down */ }
}

async function bridge(pathname, body) {
  try {
    const res = await fetch(BRIDGE_URL + pathname, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function launchBridge() {
  // Packaged build: PyInstaller-frozen bridge.exe lives in resources/bridge/
  // alongside the Electron app. Dev mode falls back to py bridge.py.
  const cwd = app.isPackaged
    ? path.dirname(process.execPath)
    : path.join(__dirname, "..");
  const frozenExe = app.isPackaged
    ? path.join(process.resourcesPath, "bridge", "bridge.exe")
    : path.join(__dirname, "..", "bridge", "bridge.exe");
  const scriptBridge = path.join(__dirname, "..", "bridge.py");
  const useFrozen = app.isPackaged || fs.existsSync(frozenExe);

  // Reuse a bridge that is already up. Only one bridge may own the port, so
  // blindly spawning means a second child dies on bind and the app silently
  // keeps talking to a stale process from an earlier run.
  return fetch(`${BRIDGE_URL}/state`, { signal: AbortSignal.timeout(1200) })
    .then((r) => (r.ok ? true : false))
    .catch(() => false)
    .then((alive) => {
      if (alive) return; // healthy bridge already serving: adopt it
      if (useFrozen) {
        // Packaged: run the self-contained bridge.exe (no Python needed)
        try {
          const proc = spawn(frozenExe, [], { cwd, windowsHide: true });
          proc.on("error", (err) => bridgeLog("Bridge spawn error: " + err));
          proc.stderr.on("data", (d) => bridgeLog(String(d)));
          bridgeProc = proc;
        } catch (err) {
          bridgeLog("Failed to spawn frozen bridge: " + err);
        }
      } else {
        // Dev: try py -3.13 bridge.py, fall back to python / python3
        const candidates = ["py", "python", "python3"];
        const tryNext = (i) => {
          if (i >= candidates.length) return;
          try {
            const args = candidates[i] === "py" ? ["-3.13", scriptBridge] : [scriptBridge];
            const proc = spawn(candidates[i], args, { cwd, windowsHide: true });
            proc.on("error", () => tryNext(i + 1));
            proc.stderr.on("data", (d) => bridgeLog(String(d)));
            bridgeProc = proc;
          } catch {
            tryNext(i + 1);
          }
        };
        tryNext(0);
      }
    });
}


let bridgeLogStream = null;
function bridgeLog(text) {
  // stderr used to be piped into nowhere: a bridge that dies on boot left no
  // trace at all, which is how a 35-minute-old process masqueraded as current.
  try {
    if (!bridgeLogStream) {
      const dir = path.join(__dirname, "..", "work");
      fs.mkdirSync(dir, { recursive: true });
      bridgeLogStream = fs.createWriteStream(path.join(dir, "bridge.log"), { flags: "a" });
    }
    bridgeLogStream.write(`[${new Date().toISOString()}] ${text}`);
  } catch { /* logging must never break startup */ }
}

function setupIpc() {
  // mascot brain -> window geometry (screen coords, clamped to arena unless unconstrained)
  ipcMain.on("win-move", (event, { x, y, unconstrained }) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || w.isDestroyed()) return;
    const [ww, wh] = w.getSize();
    let px = Math.round(x), py = Math.round(y);
    if (!unconstrained) {
      const a = arenaAt(Number(x) || 0, Number(y) || 0);
      const p = clampPos(x, y, ww, wh, a);
      px = p.x; py = p.y;
    }
    try { w.setPosition(px, py); } catch { /* tearing down */ }
    if (!shownOnce && w === wins.mascot) {
      shownOnce = true;
      try { w.show(); } catch { /* tearing down */ }
    }
  });
  ipcMain.on("win-resize", (event, { w, h }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const cw = Math.min(Math.max(Math.round(w) || 200, 40), 900);
    const ch = Math.min(Math.max(Math.round(h) || 200, 40), 1400);
    try { win.setSize(cw, ch); } catch { /* tearing down */ }
    if (!shownOnce && win === wins.mascot) {
      shownOnce = true;
      try { win.show(); } catch { /* tearing down */ }
    }
  });
  ipcMain.on("win-hide", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    try { win.hide(); } catch { /* tearing down */ }
    if (win === wins.mascot) {
      ["subtitle", "game", "menu", "island"].forEach((wName) => {
        const childWin = wins[wName];
        if (childWin && !childWin.isDestroyed()) {
          try { childWin.hide(); } catch {}
        }
      });
    }
  });
  ipcMain.on("win-show", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    try { win.showInactive(); } catch { /* tearing down */ }
  });
  ipcMain.handle("get-arena", (_event, { x, y }) => arenaAt(Number(x) || 0, Number(y) || 0));
  ipcMain.handle("get-pos", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { x: 0, y: 0, w: 0, h: 0 };
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    return { x, y, w, h };
  });
  ipcMain.handle("get-mascot-pos", () => {
    const w = wins.mascot;
    if (!w || w.isDestroyed()) return { x: 0, y: 0, w: 0, h: 0 };
    const [x, y] = w.getPosition();
    const [ww, hh] = w.getSize();
    return { x, y, w: ww, h: hh };
  });

  // widget visibility: mascot brain owns state, main owns windows
  ipcMain.on("widget-show", (_event, { widget, msg }) => {
    if (!["subtitle", "game", "menu", "island", "hub"].includes(widget)) return;
    const mw = wins.mascot;
    if (widget !== "hub" && (!mw || mw.isDestroyed() || !mw.isVisible())) {
      return; // Never show subtitles or companion widgets when mascot is closed/hidden!
    }
    const w = ensureWindow(widget);
    if (msg && msg.anchor && widget !== "island" && (msg.pw || msg.w)) {
      // anchor popups beside the mascot rect, inside the arena
      const m = msg.anchor;
      const a = arenaAt(m.x + m.w / 2, m.y + m.h / 2);
      const pw = msg.pw || msg.w || 232;
      const ph = msg.ph || msg.h || 160;
      const p = anchorPopup(m, pw, ph, a);
      try { w.setSize(pw, ph); } catch { /* tearing down */ }
      try { w.setPosition(p.x, p.y); } catch { /* tearing down */ }
    } else if (widget === "subtitle") {
      // center on mascot's display, not always primary
      let a;
      const mw = wins.mascot;
      if (mw && !mw.isDestroyed()) {
        const [mx, my] = mw.getPosition();
        const [mww, mhh] = mw.getSize();
        a = arenaAt(mx + mww / 2, my + mhh / 2);
      } else {
        a = arenaAt(1e9, 1e9);
      }
      const g = subtitleGeom(a);
      try { w.setPosition(g.x, g.y); w.setSize(g.w, g.h); } catch { /* tearing down */ }
    } else if (widget === "island" && msg && msg.anchor) {
      // top-center of the mascot's arena: notifications never cover video
      const m = msg.anchor;
      const a = arenaAt(m.x + m.w / 2, m.y + m.h / 2);
      try { w.setPosition(Math.round(a.x + (a.w - 440) / 2), a.y + 10); } catch { /* tearing down */ }
    }
    try { if (!w.isVisible()) w.showInactive(); } catch { /* tearing down */ }
    if (msg) {
      if (w.webContents.isLoading()) pendingMsg[widget] = msg;
      else sendTo(widget, "widget-msg", msg);
    }
  });
  ipcMain.on("widget-hide", (_event, { widget }) => {
    const w = wins[widget];
    if (!w || w.isDestroyed()) return;
    try { w.hide(); } catch { /* tearing down */ }
  });

  // widget -> mascot brain relay (menu picks, game choices)
  ipcMain.on("widget-event", (_event, msg) => {
    sendTo("mascot", "mascot-msg", msg || {});
  });

  ipcMain.on("set-ignore-mouse-events", (event, ignore, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.handle("set-login-item", (_event, enabled) => {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: ["--hidden"],
    });
    return true;
  });

  ipcMain.handle("get-login-item", () => {
    return app.getLoginItemSettings({ path: process.execPath, args: ["--hidden"] });
  });

  ipcMain.on("game-running", (_event, on) => {
    gameRunning = !!on;
  });
  ipcMain.on("quit-app", () => {
    quitEntireApp();
  });

  // update system (GitHub Releases)
  ipcMain.handle("get-version", () => app.getVersion());

  ipcMain.handle("check-update", async () => {
    try {
      // Query recent releases so we can find the newest one that actually has a downloadable .exe
      const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases`, {
        headers: { "User-Agent": "Bones-Companion-Updater" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        if (res.status === 404) return { ok: false, error: "No releases found on GitHub yet." };
        return { ok: false, error: `GitHub API error: ${res.status}` };
      }
      const releases = await res.json();
      if (!Array.isArray(releases) || releases.length === 0) {
        return { ok: true, hasUpdate: false };
      }
      // Pick the newest non-draft release that actually contains an .exe installer
      const valid = releases.find((r) => {
        return !r.draft && (r.assets || []).some((a) => (a.name || "").endsWith(".exe"));
      });
      if (!valid) {
        return { ok: true, hasUpdate: false, message: "No release with installer asset found." };
      }
      const latestTag = (valid.tag_name || "").replace(/^v/, "").trim();
      const currentVersion = app.getVersion();
      const hasUpdate = isNewerVersion(latestTag, currentVersion);
      const asset = (valid.assets || []).find((a) => (a.name || "").endsWith(".exe"));
      return {
        ok: true,
        hasUpdate,
        currentVersion,
        latestVersion: latestTag,
        releaseNotes: valid.body || "",
        releaseName: valid.name || `Version ${latestTag}`,
        downloadUrl: asset ? asset.browser_download_url : null,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("start-update", async (event, downloadUrl) => {
    if (!downloadUrl) return { ok: false, error: "No download URL provided" };
    // Unique timestamped filename prevents EPERM lock collisions with prior downloads
    const tempExe = path.join(app.getPath("temp"), `Bones-Update-${Date.now()}.exe`);
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) return { ok: false, error: `Download failed: HTTP ${res.status}` };
      const totalBytes = Number(res.headers.get("content-length")) || 0;
      let downloadedBytes = 0;
      let lastReportedPercent = -1;
      const fileStream = fs.createWriteStream(tempExe);

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        downloadedBytes += value.length;
        fileStream.write(Buffer.from(value));
        if (totalBytes > 0) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          if (percent !== lastReportedPercent) {
            lastReportedPercent = percent;
            try { event.sender.send("update-progress", percent); } catch {}
          }
        }
      }
      fileStream.end();
      await new Promise((resolve, reject) => {
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
      });

      // Kill Python bridge and child processes synchronously before spawning updater
      try {
        if (bridgeProc) bridgeProc.kill("SIGKILL");
        require("child_process").execSync("taskkill /F /T /IM bridge.exe", { stdio: "ignore", windowsHide: true });
      } catch {}

      // Current install dir - force updater to overwrite the exact running directory
      const installDir = path.dirname(process.execPath);
      bridgeLog(`Launching updater ${tempExe} into ${installDir}\n`);

      const proc = spawn(tempExe, [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/FORCECLOSEAPPLICATIONS",
        `/DIR=${installDir}`,
      ], {
        detached: true,
        stdio: "ignore",
      });
      proc.unref();
      isQuitting = true;
      app.exit(0);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  process.on("uncaughtException", (err) => {
    bridgeLog(`Uncaught exception: ${err.stack || err}\n`);
  });
  process.on("unhandledRejection", (err) => {
    bridgeLog(`Unhandled rejection: ${err.stack || err}\n`);
  });
}

function quitEntireApp() {
  isQuitting = true;
  for (const k of Object.keys(wins)) {
    const w = wins[k];
    if (w && !w.isDestroyed()) {
      try { w.hide(); w.destroy(); } catch {}
      wins[k] = null;
    }
  }
  if (hiddenParent && !hiddenParent.isDestroyed()) {
    try { hiddenParent.destroy(); } catch {}
    hiddenParent = null;
  }
  try {
    if (bridgeProc) bridgeProc.kill("SIGKILL");
    require("child_process").execSync("taskkill /F /T /IM bridge.exe", { stdio: "ignore", windowsHide: true });
  } catch {}
  app.exit(0);
}

// right-click context menu: clean, minimal options only
async function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: "Open Master Hub",
      click: () => {
        const hw = ensureWindow("hub");
        if (hw.isMinimized()) hw.restore();
        hw.show();
        hw.setAlwaysOnTop(true);
        hw.focus();
        hw.setAlwaysOnTop(false);
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => { quitEntireApp(); } },
  ]);
  tray.setContextMenu(menu);
}

app.whenReady().then(() => {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    // Ensure mascot is alive and visible
    const mw = ensureWindow("mascot");
    if (!mw.isVisible()) {
      try { mw.show(); } catch { /* tearing down */ }
    }
    // Show the hub dashboard
    const hw = ensureWindow("hub");
    if (hw.isMinimized()) hw.restore();
    hw.show();
    hw.focus();
  });
  launchBridge().then(() => {
    bridge("/exempt", { pid: process.pid }).catch(() => {});
    bridge("/settings").then((s) => {
      const autoStart = s && s.start_at_login !== false;
      app.setLoginItemSettings({
        openAtLogin: autoStart,
        path: process.execPath,
        args: ["--hidden"],
      });
    }).catch(() => {});
  });
  setupIpc();
  ensureWindow("mascot");
  if (process.argv.includes("--show-hub")) {
    const hw = ensureWindow("hub");
    hw.show();
    hw.focus();
  }
  // renderer failed to boot (no geometry reports): show anyway after 3s so
  // the mascot is never silently missing. Small window: harmless fallback.
  setTimeout(() => {
    const w = wins.mascot;
    if (!w || w.isDestroyed() || shownOnce) return;
    shownOnce = true;
    try { w.show(); } catch { /* tearing down */ }
  }, 3000);
  tray = new Tray(nativeImage.createFromPath(APP_ICON));
  tray.setToolTip("Bones");
  tray.on("click", () => {
    const hw = ensureWindow("hub");
    if (hw.isVisible()) {
      hw.hide();
    } else {
      if (hw.isMinimized()) hw.restore();
      hw.show();
      hw.setAlwaysOnTop(true);
      hw.focus();
      hw.setAlwaysOnTop(false);
    }
  });
  tray.on("double-click", () => {
    const hw = ensureWindow("hub");
    if (hw.isMinimized()) hw.restore();
    hw.show();
    hw.setAlwaysOnTop(true);
    hw.focus();
    hw.setAlwaysOnTop(false);
  });
  refreshTray();
  const trayTimer = setInterval(refreshTray, 10000);
  // chase cursor forwarding: raw SCREEN coords (no window offset math: the
  // mascot window moves, the arena doesn't).
  const cursorLoop = setInterval(() => {
    if (!gameRunning) return;
    const w = wins.mascot;
    if (!w || w.isDestroyed()) return;
    try {
      const pt = screen.getCursorScreenPoint();
      w.webContents.send("cursor-pos", { x: pt.x, y: pt.y });
    } catch { /* tearing down */ }
  }, 50);
  app.on("before-quit", () => {
    isQuitting = true;
    clearInterval(trayTimer);
    clearInterval(cursorLoop);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") quitEntireApp();
});

app.on("before-quit", () => {
  if (!isQuitting) quitEntireApp();
});
