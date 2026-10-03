const { contextBridge, ipcRenderer } = require("electron");

const params = new URLSearchParams(window.location.search);
const widget = params.get("widget") || "mascot";

contextBridge.exposeInMainWorld("electron", {
  widget,
  settings: async () => {
    const res = await fetch("http://127.0.0.1:17385/settings");
    return res.json();
  },
  // screen-space window geometry (mascot brain owns layout)
  winMove: (x, y, unconstrained = false) => ipcRenderer.send("win-move", { x, y, unconstrained }),
  winResize: (w, h) => ipcRenderer.send("win-resize", { w, h }),
  winHide: () => ipcRenderer.send("win-hide"),
  winShow: () => ipcRenderer.send("win-show"),
  getArena: (x, y) => ipcRenderer.invoke("get-arena", { x, y }),
  getPos: () => ipcRenderer.invoke("get-pos"),
  getMascotPos: () => ipcRenderer.invoke("get-mascot-pos"),
  // widget windows: brain shows/hides, widgets report back
  widgetShow: (name, msg) => ipcRenderer.send("widget-show", { widget: name, msg }),
  widgetHide: (name) => ipcRenderer.send("widget-hide", { widget: name }),
  widgetEvent: (msg) => ipcRenderer.send("widget-event", msg),
  onWidgetMsg: (cb) => ipcRenderer.on("widget-msg", (_e, m) => cb(m)),
  onMascotMsg: (cb) => ipcRenderer.on("mascot-msg", (_e, m) => cb(m)),
  // chase mode: main forwards raw SCREEN cursor pos at 50ms
  setGameRunning: (on) => ipcRenderer.send("game-running", !!on),
  onCursorPos: (cb) => ipcRenderer.on("cursor-pos", (_e, p) => cb(p)),
  quitApp: () => ipcRenderer.send("quit-app"),
  // mouse click-through for transparent padding
  setIgnoreMouseEvents: (ignore, opts) => ipcRenderer.send("set-ignore-mouse-events", ignore, opts),
  // login item settings
  setLoginItem: (enabled) => ipcRenderer.invoke("set-login-item", enabled),
  getLoginItem: () => ipcRenderer.invoke("get-login-item"),
  // update system (GitHub Releases)
  getVersion: () => ipcRenderer.invoke("get-version"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  startUpdate: (downloadUrl, expectedSha256) => ipcRenderer.invoke("start-update", { downloadUrl, expectedSha256 }),
  onUpdateProgress: (cb) => ipcRenderer.on("update-progress", (_e, p) => cb(p)),
});
