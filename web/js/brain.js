/* Buddy brain (mascot window): polls the Python bridge, drives the pet
 * engine, and owns all screen-space layout. Subtitle, game box, menu, and
 * island are separate small windows driven via main (widget-show/hide);
 * this window only ever shows the pet.
 *
 * Multi-window rules: no fullscreen assumptions. All coords are screen
 * pixels; the arena (display workArea) comes from main. Window moves go
 * through winMove (main clamps); taps are just pokes (nothing lives under
 * this window that needs forwarded clicks).
 */
(() => {
  "use strict";

  const BRIDGE = "http://127.0.0.1:17385";
  const POLL_MS = 700;
  const E = () => window.electron;

  const $ = (id) => document.getElementById(id);
  const mascotEl = $("mascot");
  const petStage = $("pet-stage");

  let petManifest = null;
  let pet = null; // full-body frame cycler (only visual layer)
  let dragOffset = null; // { dx, dy } while dragging the mascot
  let scale = 0.65;

  // window state in SCREEN coords (mirrors main; main clamps on apply)
  const W = { x: 0, y: 0, w: 240, h: 340 };
  let arena = { x: 0, y: 0, w: 1920, h: 1040 };
  let lastSettings = {};

  // bridge animation name -> pet clip. Unknown names fall back to idle.
  const PET_ROUTES = {
    hero_idle: "idle", hero_talk: "talk", hero_sleep: "sleep",
    hero_wake: "wake", hero_smile: "happy", hero_victory: "dance",
    hero_wave: "dance", hero_sunglasses: "shades", hero_shades: "shades",
    hero_surprised: "wake", hero_confused: "idle", hero_facepalm: "idle",
    hero_shock: "wake", hero_blink: "idle", hero_tshirt: "idle",
    hero_red_suit: "dance", dance_red: "dance", hero_smitten: "smitten",
    idle: "idle", talk: "talk", sleep: "sleep", wake: "wake",
    dance: "dance", happy: "happy", shades: "shades", smitten: "smitten",
    run: "run", jump: "jump", flip: "flip", land: "land",
  };
  let lastBubbleId = "";
  let reducedMotion = false;
  let game = null; // { running, ... }
  let cinemaActive = false;

  const GAME_P1_MS = 30000; // phase 1: full speed, arrogant
  const GAME_P2_MS = 75000; // phase 2 cap: then the mascot surrenders
  const GAME_CATCH_INSET = 0.12; // touch = cursor inside padded sprite bounding box

  const BASE_TAUNTS_P1 = [
    "too slow! my legs are premium.",
    "you chase like a screensaver.",
    "i predicted that. and that. and that.",
    "30 seconds of zoomies. keep up.",
    "are you even trying? cute.",
  ];
  const BASE_TAUNTS_P2 = [
    "okay... legs... going spaghetti...",
    "why is the room spinning...",
    "i can hear my own footsteps. scary.",
    "energy low. please be gentle.",
    "don't touch me, i'm fragile.",
  ];

  const LANG_TAUNTS_P1 = {
    tamil: [
      "pudichaa pudichuko!", "dei, varaadha!", "ennaala mudinja odren!",
      "pudikka mudiyuma pa?", "illa illa, inga illa!", "seri, try pannu!", "dei dei dei!",
    ],
    kannada: [
      "ಹಿಡಿದ್ರೆ ಹಿಡಿ!", "ಏಯ್, ಬರಬೇಡ!", "ನನಗೆ ಆಗೋಷ್ಟು ಓಡ್ತೀನಿ!",
      "ಹಿಡಿಯೋಕೆ ಆಗುತ್ತಾ?", "ಇಲ್ಲ ಇಲ್ಲ, ಇಲ್ಲಿ ಇಲ್ಲ!", "ಸರಿ, try ಮಾಡು!", "ಏಯ್ ಏಯ್ ಏಯ್!",
    ],
    telugu: [
      "పట్టుకుంటే పట్టుకో!", "ఏయ్, రావద్దు!", "నాకు చేతనైనంతగా పరిగెడతా!",
      "పట్టుకోగలవా?", "లేదు లేదు, ఇక్కడ లేను!", "సరే, try చేయి!", "ఏయ్ ఏయ్ ఏయ్!",
    ],
    malayalam: [
      "പിടിച്ചാൽ പിടിച്ചോ!", "ഏയ്, വരല്ലേ!", "എനിക്ക് പറ്റുന്ന പോലെ ഓടും!",
      "പിടിക്കാൻ പറ്റുമോ?", "ഇല്ല ഇല്ല, ഇവിടെ ഇല്ല!", "ശരി, try ചെയ്യ്!", "ഏയ് ഏയ് ഏയ്!",
    ],
    hindi: [
      "पकड़ सके तो पकड़!", "अरे, मत आ!", "जितना हो सकेगा उतना भागूँगा!",
      "पकड़ पाएगा?", "नहीं नहीं, यहाँ नहीं हूँ!", "ठीक है, try कर!", "अरे अरे अरे!",
    ],
  };

  const LANG_TAUNTS_P2 = {
    tamil: [
      "seekiram vaa!", "close ah vandhuta!", "ayyo!", "enna da ivlo speed?",
    ],
    kannada: [
      "ಬೇಗ ಬಾ!", "ಹತ್ತಿರ ಬಂದ್ಬಿಟ್ಟೆ!", "ಅಯ್ಯೋ!", "ಏನ್ ಗುರು ಇಷ್ಟು speed?", "ಹಿಡ್ದೇ ಬಿಟ್ಟಿಯಾ?!",
    ],
    telugu: [
      "త్వరగా రా!", "చాలా దగ్గరకి వచ్చేశావు!", "అయ్యో!", "ఏంటి రా ఇంత speed?", "పట్టేసావా?!",
    ],
    malayalam: [
      "വേഗം വാ!", "നീ അടുത്തെത്തി!", "അയ്യോ!", "എന്താടാ ഇത്ര speed?", "പിടിച്ചോ?!",
    ],
    hindi: [
      "जल्दी आ!", "बहुत पास आ गया!", "अरे यार!", "क्या रे, इतनी speed?", "पकड़ लिया?!",
    ],
  };

  const TAUNTS_CRY = [
    "WAAAH. caught. sobbing in the corner.",
    "you win... tiny sobs... too speedy for this world.",
    "crying. tell my corner i was brave.",
    "pudichutiya?!",
    "ಹಿಡ್ದೇ ಬಿಟ್ಟಿಯಾ?!",
    "పట్టేసావా?!",
    "പിടിച്ചോ?!",
    "पकड़ लिया?!",
  ];

  const POKE_LANGS = {
    tamil: [
      "enna pa, enna paakra?", "enna da?", "enna venum?", "dei, summa hover pannadha.",
      "enna touch pannitu poita?", "naan inga dhaan irukken da.", "thottutiya? ippo enna?",
      "enna, check panriya naan irukkena?", "dei, velaiya paaru.", "enna da ipdi paakra?",
      "ennaya kooptiya?", "seri seri, vandhuten.",
    ],
    kannada: [
      "ಏನ್ ಪಾ, ನನ್ನನ್ನೇ ನೋಡ್ತಾ ಇದ್ದೀಯಾ?", "ಏನ್ ಗುರು?", "ಏನ್ ಬೇಕು?", "ಏಯ್, ಸುಮ್ಮನೆ hover ಮಾಡ್ಬೇಡ.",
      "ನನ್ನನ್ನ ಮುಟ್ಟಿ ಹೋದೆ?", "ನಾನು ಇಲ್ಲೇ ಇದ್ದೀನಿ.", "ಮುಟ್ಟಿದಿಯಾ? ಈಗ ಏನ್?",
      "ನಾನು ಇದ್ದೀನೋ ಅಂತ check ಮಾಡ್ತಿದಿಯಾ?", "ಏಯ್, ಕೆಲಸ ನೋಡು.", "ಏನ್ ಗುರು ಹೀಗೆ ನೋಡ್ತಾ ಇದ್ದೀಯಾ?",
      "ನನ್ನನ್ನ ಕರೆದಿಯಾ?", "ಸರಿ ಸರಿ, ಬಂದೆ.",
    ],
    telugu: [
      "ఏంటి రా, నన్నే చూస్తున్నావా?", "ఏంటి రా?", "ఏం కావాలి?", "ఏయ్, ఊరికే hover చేయకు.",
      "నన్ను టచ్ చేసి వెళ్లిపోయావా?", "నేను ఇక్కడే ఉన్నాను.", "టచ్ చేశావా? ఇప్పుడు ఏంటి?",
      "నేను ఉన్నానో లేదో check చేస్తున్నావా?", "ఏయ్, పని చూసుకో.", "ఏంటి రా అలా చూస్తున్నావు?",
      "నన్ను పిలిచావా?", "సరే సరే, వచ్చేశా.",
    ],
    malayalam: [
      "എന്താ, എന്നെത്തന്നെ നോക്കുവാണോ?", "എന്താടാ?", "എന്താ വേണ്ടത്?", "ഏയ്, വെറുതെ hover ചെയ്യല്ലേ.",
      "എന്നെ തൊട്ടിട്ട് പോയോ?", "ഞാൻ ഇവിടെ തന്നെയുണ്ട്.", "തൊട്ടോ? ഇനി എന്താ?",
      "ഞാൻ ഇവിടെ ഉണ്ടോന്ന് check ചെയ്യുവാണോ?", "ഏയ്, ജോലി നോക്ക്.", "എന്താടാ ഇങ്ങനെ നോക്കുന്നത്?",
      "എന്നെ വിളിച്ചോ?", "ശരി ശരി, വന്നേ.",
    ],
    hindi: [
      "क्या रे, मुझे ही देख रहा है?", "क्या रे?", "क्या चाहिए?", "अरे, ऐसे ही hover मत कर.",
      "मुझे touch करके चला गया?", "मैं यहीं हूँ.", "Touch किया? अब क्या?",
      "Check कर रहा है कि मैं हूँ या नहीं?", "अरे, अपना काम कर.", "क्या रे, ऐसे क्यों देख रहा है?",
      "मुझे बुलाया?", "ठीक है ठीक है, आ गया.",
    ],
  };

  let lastPokeLine = 0;

  function getActiveTaunts(phase) {
    const base = phase === 1 ? [...BASE_TAUNTS_P1] : [...BASE_TAUNTS_P2];
    const dict = phase === 1 ? LANG_TAUNTS_P1 : LANG_TAUNTS_P2;
    const s = lastSettings || {};
    for (const [lang, lines] of Object.entries(dict)) {
      if (s[`lang_${lang}`] !== false) {
        base.push(...lines);
      }
    }
    return base;
  }

  function getActivePokes() {
    const s = lastSettings || {};
    const list = [];
    for (const [lang, lines] of Object.entries(POKE_LANGS)) {
      if (s[`lang_${lang}`] !== false) {
        list.push(...lines);
      }
    }
    return list.length ? list : POKE_LANGS.tamil;
  }

  async function api(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(BRIDGE + path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- window geometry (screen coords) ---------- */
  function winMove(x, y, unconstrained = false) {
    let px = Math.round(x), py = Math.round(y);
    if (!unconstrained && window.clampPos) {
      const p = window.clampPos(x, y, W.w, W.h, arena);
      px = p.x; py = p.y;
    }
    W.x = px; W.y = py;
    if (E()) E().winMove(px, py, unconstrained);
    // Instant popup sync during chase: the popup moves on the exact same tick
    if (game && game.running && lastGameMsg && E()) {
      lastGameMsg.anchor = mascotRect();
      E().widgetShow("game", lastGameMsg);
    }
  }
  function winResize(w, h) {
    W.w = Math.round(w); W.h = Math.round(h);
    if (E()) E().winResize(W.w, W.h);
  }
  async function refreshArena() {
    if (!E()) return;
    try {
      arena = await E().getArena(W.x + W.w / 2, W.y + W.h / 2);
    } catch { /* keep last arena */ }
  }
  function mascotRect() {
    return { x: W.x, y: W.y, w: W.w, h: W.h };
  }
  /** Keep the window hugging the live frame aspect (fixed display height).
   *  During Catch & Catch, expands to union of run frames + flip/hop headroom.
   *  Skipped while peek-parked: peek owns the window geometry. */
  function syncWinSize() {
    if (peekParked) return;
    if (!mascotEl) return;
    if (game && game.running) {
      mascotEl.classList.add("mascot--game");
      const gw = Math.round(280 * scale);
      const gh = Math.round(400 * scale);
      if (Math.abs(gw - W.w) > 2 || Math.abs(gh - W.h) > 2) winResize(gw, gh);
      return;
    }
    mascotEl.classList.remove("mascot--game");
    const w = Math.max(16, Math.round(mascotEl.offsetWidth));
    const h = Math.max(16, Math.round(mascotEl.offsetHeight));
    if (w < 8 || h < 8) return; // art not laid out yet
    if (Math.abs(w - W.w) > 2 || Math.abs(h - W.h) > 2) winResize(w, h);
  }

  async function boot() {
    petManifest = await (await fetch("pet.json")).json();
    pet = new PetAnimation(petStage, petManifest);
    pet.update();
    if (E()) {
      try {
        const s = await E().settings();
        applySettings(s);
      } catch { /* bridge down: defaults stand */ }
      try {
        const p = await E().getPos();
        if (p.w > 0) { W.x = p.x; W.y = p.y; W.w = p.w; W.h = p.h; }
        await refreshArena();
      } catch { /* keep defaults */ }
      E().onMascotMsg(onMascotMsg);
    }
    setInterval(poll, POLL_MS);
    poll();
    schedulePeek(); // idle mischief starts a few minutes in
    // QA hook: mascot.html#peek=l|r|t|b forces one peek from that edge
    const peekQa = (window.location.hash || "").match(/^#peek=([lrtb])$/);
    if (peekQa) {
      const qaTimer = setInterval(() => {
        if (peekArmed()) { clearInterval(qaTimer); peekOut(peekQa[1]); }
      }, 500);
    }
    // QA hook: mascot.html#tour auto-starts the animation tour
    if ((window.location.hash || "") === "#tour") {
      const qaTimer = setInterval(() => {
        if (!tourRunning && !dragOffset && !reducedMotion) {
          clearInterval(qaTimer); playAnimationTour();
        }
      }, 500);
    }
  }

  /** Unified clip interface: pet owns the stage, always. */
  function playAnim(name, opts = {}) {
    if (!pet) return false;
    const clip = PET_ROUTES[name] || "idle";
    if (name === "hero_talk" || name === "talk") opts = { ...opts, loop: true };
    let ok = pet.play(clip, opts);
    if (!ok) ok = pet.play("idle", { force: true }); // idle always wins
    syncWinSize();
    return ok;
  }

  function isPlayingAnim(name) {
    if (!pet) return false;
    const clip = PET_ROUTES[name] || "idle";
    return pet.isPlaying(clip);
  }

  function applySettings(s) {
    lastSettings = s || {};
    scale = Math.min(1.0, Math.max(0.01, Number(s.pet_scale) || 0.65));
    document.documentElement.style.setProperty("--scale", String(scale));
    const rm = !!s.reduced_motion;
    if (rm !== reducedMotion) {
      reducedMotion = rm;
      document.body.classList.toggle("reduced-motion", rm);
      if (pet) pet.setReducedMotion(rm);
    }
    syncWinSize();
  }

  /* ---------- subtitle (separate window via main) ----------
   * One surface, one timer. Normal lines queue one-deep behind the dwell;
   * alert lines preempt immediately. */
  let subUntil = 0, subQueued = null, subTimerId = 0;
  function subtitleShow(text, ms, alert = false, game = false) {
    const now = Date.now();
    if (now < subUntil && !alert) { subQueued = { text, ms, alert, game }; return; }
    if (alert) { subQueued = null; clearTimeout(subTimerId); }
    if (E()) E().widgetShow("subtitle", { op: "show", text, alert: !!alert, game: !!game });
    subUntil = now + ms;
    clearTimeout(subTimerId);
    subTimerId = setTimeout(() => {
      subUntil = 0;
      if (subQueued) {
        const q = subQueued; subQueued = null;
        subtitleShow(q.text, q.ms, q.alert, q.game);
      } else if (E()) {
        E().widgetHide("subtitle");
      }
    }, ms);
  }
  function subtitleHideNow() {
    subQueued = null;
    clearTimeout(subTimerId);
    subUntil = 0;
    if (E()) E().widgetHide("subtitle");
  }

  // Buddy dialogue entry: bridge bubble kinds route here. Celebrate and
  // error kinds ride the normal subtitle (the mascot anim carries the
  // excitement); alert gets emphasis. Normal chatter yields to a live
  // chase; alerts always break through.
  function saySubtitle(b) {
    lastBubbleId = b.id;
    const kind = b.kind || "normal";
    if (game && game.running && kind === "normal") return;
    subtitleShow(b.text, b.ms, kind === "alert");
  }

  /* ---------- island (separate top-center window) ---------- */
  let lastIslandSig = "";
  function showIsland(data) {
    if (E()) {
      E().widgetShow("island", {
        op: "show",
        anchor: mascotRect(),
        title: data.title || "",
        text: data.text || "",
        buttons: data.buttons,
      });
    }
  }
  function hideIsland() {
    if (E()) E().widgetHide("island");
  }

  /* ---------- mascot interaction ---------- */
  mascotEl.addEventListener("mouseenter", () => {
    if (game && game.running) {
      catchMascot();
      return;
    }
    api("/poke", {}); // counts as activity: wakes + resets timers
    playAnim("hero_wake");
    // Regional hover poke line, throttled: hover mischief without spam
    const nowPoke = Date.now();
    if (!dragOffset && !tourRunning && nowPoke - lastPokeLine > 40000) {
      lastPokeLine = nowPoke;
      const pokes = getActivePokes();
      subtitleShow(pokes[Math.floor(Math.random() * pokes.length)], 3500, false);
    }
  });
  mascotEl.addEventListener("click", () => api("/poke", {}));
  mascotEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    api("/poke", {});
    playAnim("hero_smile");
  });

  /* ---------- options menu (separate window via main) ---------- */
  const SIZE_STEPS = [0.5, 0.65, 0.85];
  const SIZE_NAMES = { 0.5: "small", 0.65: "normal", 0.85: "large" };
  function sizeName(v) {
    let best = SIZE_STEPS[1], gap = 99;
    for (const s of SIZE_STEPS) {
      const d = Math.abs(s - v);
      if (d < gap) { gap = d; best = s; }
    }
    return SIZE_NAMES[best];
  }
  let menuOpen = false;
  function toggleMenu() {
    if (!E()) return;
    if (menuOpen) {
      menuOpen = false;
      E().widgetHide("menu");
      return;
    }
    const s = lastSettings || {};
    const order = ["quiet", "normal", "chatty"];
    const nextChatter = order[(order.indexOf(s.chatter_frequency) + 1) % order.length] || "normal";
    const curScale = Math.min(1.2, Math.max(0.4, Number(s.pet_scale) || 0.65));
    const curName = sizeName(curScale);
    const nextSize = SIZE_STEPS[(SIZE_STEPS.indexOf(SIZE_STEPS.find(
      (x) => SIZE_NAMES[x] === curName)) + 1) % SIZE_STEPS.length];
    menuOpen = true;
    E().widgetShow("menu", {
      op: "show",
      anchor: mascotRect(),
      pw: 220,
      ph: 210,
      items: [
        { label: `Chatter: ${s.chatter_frequency || "normal"} → ${nextChatter}`, action: "chatter" },
        { label: `Voice: ${s.voice_enabled ? "on" : "off"}`, action: "voice" },
        { label: `Size: ${curName} → ${SIZE_NAMES[nextSize]}`, action: "size" },
        { label: "Play catch and catch", action: "play" },
        { label: "Play all animations", action: "tour" },
        { label: "Quit", action: "quit" },
      ],
    });
  }
  async function menuAction(action) {
    menuOpen = false;
    if (E()) E().widgetHide("menu");
    if (!E()) return;
    if (action === "chatter") {
      const order = ["quiet", "normal", "chatty"];
      const s = lastSettings || {};
      const next = order[(order.indexOf(s.chatter_frequency) + 1) % order.length] || "normal";
      await api("/settings", { chatter_frequency: next });
    } else if (action === "voice") {
      await api("/settings", { voice_enabled: !(lastSettings || {}).voice_enabled });
    } else if (action === "size") {
      const cur = Number((lastSettings || {}).pet_scale) || 0.65;
      let best = 0;
      for (let i = 0; i < SIZE_STEPS.length; i++) {
        if (Math.abs(SIZE_STEPS[i] - cur) < Math.abs(SIZE_STEPS[best] - cur)) best = i;
      }
      await api("/settings", { pet_scale: SIZE_STEPS[(best + 1) % SIZE_STEPS.length] });
    } else if (action === "tour") {
      playAnimationTour();
    } else if (action === "play") {
      try { await api("/ack", { action: "game_request" }); } catch { /* bridge down */ }
    } else if (action === "quit") {
      try { E().quitApp(); } catch { /* tearing down */ }
    }
  }

  // widget -> brain relay (menu picks, game choices, island acks)
  function cancelInFlightActions() {
    if (tourRunning) {
      tourRunning = false;
      playAnim("hero_idle", { force: true });
    }
    if (game && game.running) {
      stopGameLoop();
      game.running = false;
      game.offered = false;
      hideGameBox();
      syncWinSize();
    }
    if (peekParked) {
      peekCancel();
    }
  }

  function executeTriggerAction(action) {
    cancelInFlightActions();
    if (action === "game" || action === "game_request") {
      offerGame();
    } else if (action === "tour") {
      playAnimationTour();
    } else if (action === "poke") {
      api("/poke", {});
      const pokes = getActivePokes();
      const line = pokes[Math.floor(Math.random() * pokes.length)];
      subtitleShow(line, 4000, true);
      playAnim("happy", { force: true });
    } else if (action === "snooze") {
      api("/ack", { action: "snooze" });
      subtitleShow("going quiet for 10m... zzz", 3500, true);
      playAnim("sleep", { force: true, loop: true });
    }
  }

  function onMascotMsg(m) {
    if (!m) return;
    if (m.type === "trigger" && m.action) executeTriggerAction(m.action);
    else if (m.type === "menu-action" && m.action) menuAction(m.action);
    else if (m.type === "menu-closed") menuOpen = false;
    else if (m.type === "game-choice" && m.which) gameChoice(m.which, m);
    else if (m.type === "island-action" && m.action) {
      api("/ack", { action: m.action === "snooze" ? "snooze" : "got_it" });
      hideIsland();
      lastIslandSig = "";
    }
  }

  // animation tour: play every pet clip once, in manifest order.
  // right-click the mascot again while it runs to stop it.
  let tourRunning = false;
  async function playAnimationTour() {
    if (tourRunning) {
      tourRunning = false;
      playAnim("hero_idle");
      return;
    }
    tourRunning = true;
    // "smitten" is the Pooja blush. It is a strict easter egg: it belongs to
    // that one moment and nothing else, so the tour must never walk into it.
    const TOUR_SKIP = new Set(["smitten"]);
    const clips = Object.keys((petManifest && petManifest.clips) || {})
      .filter((name) => !TOUR_SKIP.has(name));
    const PEEK_EDGE = { peek_top: "t", peek_right: "r", peek_bottom: "b", peek_left: "l" };
    for (const name of clips) {
      if (!tourRunning) break;
      const clip = petManifest.clips[name];
      let restore = null;
      if (PEEK_EDGE[name]) {
        // peek clips pop in at their screen edge (vanish-appear, no glide):
        // the drawn bar stays hidden and the tour never travels.
        mascotEl.classList.add("mascot--poof");
        await new Promise((res) => setTimeout(res, PEEK_POOF_MS + 60));
        restore = peekPark(PEEK_EDGE[name]).restore;
        mascotEl.classList.remove("mascot--poof");
      }
      if (pet) pet.play(name, { force: true });
      syncWinSize();
      const dur = (clip && clip.holdMs) || 1200;
      await new Promise((res) => setTimeout(res, dur + 350)); // hold end pose a beat
      if (restore) {
        mascotEl.classList.add("mascot--poof");
        await new Promise((res) => setTimeout(res, PEEK_POOF_MS + 60));
        restore();
        mascotEl.classList.remove("mascot--poof");
      }
    }
    if (tourRunning) playAnim("hero_idle");
    tourRunning = false;
  }

  /* ---------- drag to move (NATIVE: the OS moves the window) ----------
   * -webkit-app-region: drag (see CSS) locks the window to the cursor 1:1:
   * no IPC per move, no throttle, no ghost frames, cursor never outruns
   * the pet. JS only tracks press state (poll yields mid-drag) and taps.
   * No tap forwarding: this window is small, a tap on the pet is a poke. */
  let pressInfo = null;
  let dragStartPos = null;
  let dragHistory = [];

  mascotEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button")) return;
    pressInfo = { x: e.clientX, y: e.clientY, t: performance.now() };
    dragStartPos = { x: W.x, y: W.y };
    api("/poke", {}); // grab counts as activity: wakes + resets timers
    if (game && game.running) return; // chase owns the mascot mid-game
    if (menuOpen) { menuOpen = false; if (E()) E().widgetHide("menu"); }
    refreshArena();
    dragOffset = { held: true };
    // sync W: the OS moves the window under us; re-read on release.
    if (E()) {
      E().getPos().then((p) => {
        if (p && p.w > 0) { W.x = p.x; W.y = p.y; W.w = p.w; W.h = p.h; }
      }).catch(() => {});
    }
  });
  const endDrag = (e) => {
    const press = pressInfo;
    pressInfo = null;
    if (!dragOffset) return;
    dragOffset = null;
    // re-sync: native drag moved the window, adopt the final position.
    if (E()) {
      E().getPos().then((p) => {
        if (p && p.w > 0) {
          const dx = p.x - (dragStartPos ? dragStartPos.x : p.x);
          const dy = p.y - (dragStartPos ? dragStartPos.y : p.y);
          const dist = Math.hypot(dx, dy);
          const now = performance.now();
          const dur = press ? (now - press.t) : 0;
          W.x = p.x; W.y = p.y; W.w = p.w; W.h = p.h;

          // Track continuous drag activity
          if (dist > 30 || dur > 500) {
            dragHistory.push({ t: now, dist, dur });
            dragHistory = dragHistory.filter((d) => now - d.t < 10000);
            const totalDist = dragHistory.reduce((acc, d) => acc + d.dist, 0);
            if (dragHistory.length >= 3 || totalDist > 600 || (dist > 400 && dur > 1600)) {
              dragHistory = [];
              api("/event", { name: "dragged_a_lot" });
              mascotEl.classList.remove("mascot--dizzy");
              void mascotEl.offsetWidth;
              mascotEl.classList.add("mascot--dizzy");
              setTimeout(() => mascotEl.classList.remove("mascot--dizzy"), 3000);
              playAnim("wake", { force: true });
            }
          }
        }
      }).catch(() => {});
    }
    try { mascotEl.releasePointerCapture(e && e.pointerId); } catch { /* already up */ }
    if (E() && E().setIgnoreMouseEvents) {
      E().setIgnoreMouseEvents(true, { forward: true });
    }
  };
  mascotEl.addEventListener("pointerup", endDrag);
  mascotEl.addEventListener("pointercancel", endDrag);
  mascotEl.addEventListener("lostpointercapture", endDrag);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  window.addEventListener("blur", endDrag);

  /* ---------- catch-and-catch: chase the pet ----------
     Phase 1 (30s): fast flee with cursor prediction, arrogant taunts.
     Phase 2: speed decays, mascot tires and scares. Touch = caught,
     mascot cries. Movement is per-frame rAF, never teleports.
     Coords are absolute SCREEN pixels inside the arena; the window
     follows via winMove (throttled to ~30Hz). */
  // readable HUD: taunts queue behind a min dwell so nothing flashes by;
  // energy lives on the game box sub-line and never overwrites a taunt.
  // ALL chase lines go to the subtitle window (never moves).
  function gameSay(text, dwell = 5000, flush = false) {
    if (flush) {
      subQueued = null;
      clearTimeout(subTimerId);
      subUntil = 0;
    }
    subtitleShow(text, dwell, false, true);
  }
  function gameSub(text) {
    if (E()) E().widgetShow("game", { op: "sub", sub: text });
  }
  let lastGameMsg = null;
  function stopGameFollow() {
    // Popup tracking is synchronous with winMove on every tick (no drifting timer)
  }
  function gameShow(state) {
    if (!E()) return;
    lastGameMsg = {
      op: "show",
      anchor: mascotRect(),
      pw: 232,
      ph: state.ph || 190,
      text: state.text || "",
      sub: state.sub || "",
      yesLabel: state.yesLabel || "Yes",
      showYes: state.showYes !== false,
      showNo: state.showNo !== false,
      showExit: !!state.showExit,
    };
    E().widgetShow("game", lastGameMsg);
  }
  function hideGameBox() {
    if (E()) E().widgetHide("game");
    subtitleHideNow();
  }
  // Game offer feelings: offer -> (30s silence) -> sad -> quiet;
  // No -> plead once ("please?") -> No -> silent (long cooldown).
  // Sad reuses the sob shake until dedicated sad art lands.
  let offerPhase = null; // "offer" | "plead" | null
  let offerTimerId = 0;
  let sadHideId = 0;
  function clearOfferTimer() {
    clearTimeout(offerTimerId);
    offerTimerId = 0;
    clearTimeout(sadHideId);
    sadHideId = 0;
  }
  function sadOffer() {
    if (!game || game.running || offerPhase !== "offer") return;
    offerPhase = null;
    game.offered = false; // sad is terminal: later No just dismisses
    // Pure dialogue, no buttons: this belongs in the film subtitles, not in the
    // button box. The box held nothing but an empty panel otherwise, which read
    // as the old speech box the subtitles replaced.
    subtitleShow("oh... never mind. i'll be in my corner.", 5000, false);
    subtitleShow("fine. i didn't want to play anyway. (i did.)", 5000, false);
    hideGameBox();
    mascotEl.classList.add("mascot--caught"); // sob shake doubles as sad
    setTimeout(() => mascotEl.classList.remove("mascot--caught"), 3500);
    sadHideId = setTimeout(() => {
      sadHideId = 0;
      api("/ack", { action: "game_done", catches: 0 });
      game = { running: false, offered: false, declined: true };
    }, 8000);
  }
  function offerGame() {
    if (game && game.running) return; // never interrupt a live chase
    if (game && game.offered && !game.declined) return; // invite already up
    game = { running: false, offered: true }; // re-offerable after No/Exit
    // fresh invite: yes means yes (not rematch), no stale queue behind it.
    subtitleHideNow(); // invite lives in the game box, not subtitles
    gameShow({
      text: "Wanna play catch and catch?",
      sub: "",
      yesLabel: "Yes",
      showYes: true, showNo: true, showExit: false, ph: 190,
    });
    // unanswered invite goes sad after 30s (cleared on Yes/No/start)
    offerPhase = "offer";
    clearOfferTimer();
    offerTimerId = setTimeout(sadOffer, 30000);
  }

  function placeMascotCorner() {
    const p = window.defaultPos
      ? window.defaultPos(arena, W.w, W.h)
      : { x: arena.x + arena.w - W.w - 16, y: arena.y + arena.h - W.h - 16 };
    winMove(p.x, p.y);
  }

  function startGame() {
    const W0 = W.w, H0 = W.h;
    const ax = arena.x, ay = arena.y, aw = arena.w, ah = arena.h;
    // random spawn far from the cursor: at least ~35% of the arena
    // diagonal away, so corner idling never opens trapped.
    const cx0 = (lastCursor && lastCursor.x) ?? (ax + aw / 2);
    const cy0 = (lastCursor && lastCursor.y) ?? (ay + ah / 2);
    const diag = Math.hypot(aw, ah);
    let sx = ax + 20, sy = ay + 90, best = -1;
    for (let i = 0; i < 20; i++) {
      const x = ax + 20 + Math.random() * Math.max(80, aw - W0 - 40);
      const y = ay + 90 + Math.random() * Math.max(80, ah - H0 - 110);
      const d = Math.hypot(x + W0 / 2 - cx0, y + H0 / 2 - cy0);
      if (d > best) { best = d; sx = x; sy = y; }
      if (d >= diag * 0.35) break;
    }
    game.running = true;
    game.phase = 1;
    clearOfferTimer();
    offerPhase = null;
    game.catches = 0;
    game.t0 = performance.now();
    game.last = game.t0;
    game.pos = { x: sx, y: sy };
    game.cursor = { x: cx0, y: cy0, vx: 0, vy: 0, ax: 0, ay: 0, t: game.t0 };
    game.tauntIdx = 0;
    game.lastPct = 100;
    game.lastStunt = 0;
    game.home = { x: W.x, y: W.y }; // exit restores the pre-game parking spot
    game.lastBlink = 0;
    game.lastWinMove = 0;
    // launch at full cruise away from the cursor: zero initial velocity
    // plus steering ramp-up used to gift a standing-still opening catch.
    {
      const ix = sx + W0 / 2 - cx0, iy = sy + H0 / 2 - cy0;
      const il = Math.hypot(ix, iy) || 1;
      game.vel = { x: (ix / il) * 1400, y: (iy / il) * 1400 };
    }
    syncWinSize();
    winMove(sx, sy);
    gameSay("Catch me! 30s of zoomies.", 6000, true); // flush the invite
    gameShow({
      text: "", sub: "Phase 1: full speed",
      showYes: false, showNo: false, showExit: true, ph: 150,
    });
    playAnim("run");
    if (pet) { pet.setFacing(1); pet.setLean(0); pet.setRate(1); }
    gameTaunt(true); // opening line hits subtitles immediately (no pause)
    game.tauntTimer = setInterval(gameTaunt, 7000);
    game.raf = requestAnimationFrame(gameTick);
    if (E() && E().setGameRunning) {
      E().setGameRunning(true);
    }
  }

  function gameTaunt(opening) {
    if (!game || !game.running) return;
    const pool = getActiveTaunts(game.phase);
    game.tauntIdx += 1;
    const line = pool[game.tauntIdx % pool.length];
    gameSay(line, 6000);
    // showboat: stop and face the cursor while talking trash. The line
    // lives on subtitles; the pause is a real catch window, then burst.
    // Never on the opening line: a day-one pause gifts a 1-second catch.
    const now = performance.now();
    if (!opening) game.showboatUntil = now + 1500;
    if (pet) {
      pet.setFacing(game.cursor.x >= game.pos.x + W.w / 2 ? 1 : -1);
      game.lastFaceT = now;
    }
  }

  function gameTick(now) {
    if (!game || !game.running) return;
    try {
      const dt = Math.min(0.05, Math.max(0.001, (now - game.last) / 1000));
      game.last = now;
      const elapsed = now - game.t0;
      const Ww = W.w, Hh = W.h;
      const ax = arena.x, ay = arena.y;
      // Keep the mascot inset from screen edges during the chase so the stunt
      // animations (fliptumble: -72px lift + 1.2× scale; hop: -34px lift) never
      // render outside the display. 90px top gives ample headroom; 20px sides/bottom.
      const GAME_EDGE_PAD_TOP = 90, GAME_EDGE_PAD_SIDE = 20, GAME_EDGE_PAD_BOT = 20;
      const minX = ax + GAME_EDGE_PAD_SIDE, minY = ay + GAME_EDGE_PAD_TOP;
      const maxX = ax + arena.w - Ww - GAME_EDGE_PAD_SIDE;
      const maxY = ay + arena.h - Hh - GAME_EDGE_PAD_BOT;
      // touch first: a real overlap beats that tick's dash escape. (The
      // blink used to move the mascot away before this check ran, eating
      // legitimate touches when the cursor was visibly on the pet.)
      {
        const cx0 = game.cursor.x, cy0 = game.cursor.y;
        if (cx0 > game.pos.x + Ww * GAME_CATCH_INSET && cx0 < game.pos.x + Ww * (1 - GAME_CATCH_INSET)
            && cy0 > game.pos.y + Hh * GAME_CATCH_INSET && cy0 < game.pos.y + Hh * (1 - GAME_CATCH_INSET)) {
          catchMascot();
          return;
        }
      }
    if (game.phase === 1 && elapsed >= GAME_P1_MS) {
      game.phase = 2;
      playAnim("hero_idle", { force: true });
      if (pet) { pet.setLean(0); pet.setRate(1); }
      gameSay("Energy fading... catch me!", 6000);
      gameSub("Phase 2: tiring");
    }
    // cursor state: decay stale velocity, second-order prediction
    // (position + velocity + acceleration) clamped inside the arena.
    const ageS = (now - game.cursor.t) / 1000;
    const damp = Math.exp(-ageS / 0.12);
    const evx = game.cursor.vx * damp, evy = game.cursor.vy * damp;
    const PT = 0.5;
    // cap lookahead: a long fast vector can overshoot past the pet and
    // invert the flee direction (mascot runs AT the cursor). Never let
    // the predicted point cross more than half the gap.
    let pvx = evx * PT + 0.5 * (game.cursor.ax || 0) * PT * PT;
    let pvy = evy * PT + 0.5 * (game.cursor.ay || 0) * PT * PT;
    const rawDx = (game.pos.x + Ww / 2) - game.cursor.x;
    const rawDy = (game.pos.y + Hh / 2) - game.cursor.y;
    const rawDist = Math.hypot(rawDx, rawDy) || 1;
    const pl = Math.hypot(pvx, pvy);
    const cap = rawDist * 0.5;
    if (pl > cap && pl > 0) { pvx *= cap / pl; pvy *= cap / pl; }
    const px = Math.max(minX, Math.min(maxX + Ww, game.cursor.x + pvx));
    const py = Math.max(minY, Math.min(maxY + Hh, game.cursor.y + pvy));
    let dx = (game.pos.x + Ww / 2) - px;
    let dy = (game.pos.y + Hh / 2) - py;
    const dist = Math.hypot(dx, dy) || 1;
    let speed;
    if (game.phase === 1) {
      // separation controller: cruise far (1400), sprint close (to 2600).
      // Smarts (prediction/jink/blink) keep it hard; raw top speed stays
      // readable. Capped, never teleports.
      speed = Math.min(2600, Math.max(1400, 1400 + (560 - dist) * 6));
    } else {
      const k = (elapsed - GAME_P1_MS) / 1000;
      speed = Math.max(110, 640 - k * 26);
      // energy readout steps every 10% on its own line: readable, no churn.
      const pct = Math.max(3, Math.round(100 - k * 4));
      if (game.lastPct === undefined || game.lastPct - pct >= 10) {
        game.lastPct = pct - (pct % 10);
        gameSub(`Energy ${game.lastPct}%... slowing...`);
      }
    }
    if (game.phase === 1 && dist < 130 && now - game.lastBlink > 800) {
      // blink-dash: nearly touched = short hop (visible dash, cooldown).
      // Aimed at open space: the pure away-ray often ends in a wall, so
      // pick the freest of 8 rays (clearance + distance from cursor).
      game.lastBlink = now;
      const mBx = maxX, mBy = maxY;
      const rayT = (ux, uy) => {
        let t = 1e9;
        if (ux > 0.01) t = Math.min(t, (mBx - game.pos.x) / ux);
        else if (ux < -0.01) t = Math.min(t, (game.pos.x - minX) / -ux);
        if (uy > 0.01) t = Math.min(t, (mBy - game.pos.y) / uy);
        else if (uy < -0.01) t = Math.min(t, (game.pos.y - minY) / -uy);
        return t;
      };
      let bux = dx / dist, buy = dy / dist, bs = -1e12;
      for (let a = 0; a < 8; a++) {
        const ux = Math.cos((a / 8) * Math.PI * 2), uy = Math.sin((a / 8) * Math.PI * 2);
        const score = Math.min(rayT(ux, uy), 900)
          + (ux * (game.pos.x + Ww / 2 - px) + uy * (game.pos.y + Hh / 2 - py)) * 0.5;
        if (score > bs) { bs = score; bux = ux; buy = uy; }
      }
      game.pos.x = Math.max(minX, Math.min(mBx, game.pos.x + bux * 380));
      game.pos.y = Math.max(minY, Math.min(mBy, game.pos.y + buy * 380));
      game.vel.x = bux * speed;
      game.vel.y = buy * speed;
      playAnim("jump", { force: true }); // airborne pose for the dash
      mascotEl.classList.remove("mascot--hop");
      void mascotEl.offsetWidth; // restart the hop pop
      mascotEl.classList.add("mascot--hop");
      setTimeout(() => mascotEl.classList.remove("mascot--hop"), 750);
      gameSay("MISS! too slow!", 2500);
    }
    // backflip stunt: pressured and close, phase 1 only. Random
    // so it stays unpredictable; chains flip -> land -> run by itself.
    // Airtime reads: mascot drifts at 45% while flipping/landing.
    if (game.phase === 1 && dist < 200 && now - game.lastStunt > 3000
        && Math.random() < 0.6) {
      game.lastStunt = now;
      playAnim("flip", { force: true });
      mascotEl.classList.remove("mascot--stunt");
      void mascotEl.offsetWidth; // restart the spin
      mascotEl.classList.add("mascot--stunt");
      setTimeout(() => mascotEl.classList.remove("mascot--stunt"), 2000);
      gameSay("did you SEE that?! BACKFLIP!", 5000);
    }
    if (game.phase === 1) {
      const pinnedX0 = game.pos.x < minX + 150 || game.pos.x > maxX - 150;
      const pinnedY0 = game.pos.y < minY + 150 || game.pos.y > maxY - 150;
      if (pinnedX0 && pinnedY0 && dist < 380) {
        const spots = [
          [minX + 100, minY + 100], [maxX - 100, minY + 100],
          [minX + 100, maxY - 100], [maxX - 100, maxY - 100],
          [minX + (maxX - minX) / 2, minY + 100],
          [minX + (maxX - minX) / 2, maxY - 100],
          [minX + 100, minY + (maxY - minY) / 2],
          [maxX - 100, minY + (maxY - minY) / 2],
        ];
        let bx = 0, by = 0, bs = -1e12;
        for (const [tx, ty] of spots) {
          const score = Math.hypot(tx + Ww / 2 - px, ty + Hh / 2 - py)
            - 0.3 * Math.hypot(tx - game.pos.x, ty - game.pos.y);
          if (score > bs) { bs = score; bx = tx; by = ty; }
        }
        dx = bx - game.pos.x;
        dy = by - game.pos.y;
      } else {
        // straight flee: directly away from the cursor, never circling it.
        // Mouse left of mascot = mascot runs right, facing right. Inverse.
        const w = now / 450;
        dx += Math.cos(w) * 35;
        dy += Math.sin(w * 1.3) * 35;
      }
      // jink: unpredictable lateral weave. Sign flips on a random
      // 0.3-0.7s timer; steering smooths it into readable swerves.
      if (game.jinkT === undefined || now >= game.jinkT) {
        if (game.jinkSign === undefined) game.jinkSign = 1;
        else if (Math.random() < 0.8) game.jinkSign *= -1;
        game.jinkT = now + 300 + Math.random() * 400;
      }
      {
        const lat = Math.min(300, dist * 0.8) * game.jinkSign;
        const ox = dx, oy = dy;
        dx += (-oy / dist) * lat;
        dy += (ox / dist) * lat;
      }
      // intercept dodge: cursor closing fast = cut hard perpendicular
      // to the attack line, using the same jink side (no snap).
      {
        const ux = dx / dist, uy = dy / dist;
        const relx = game.vel.x - evx, rely = game.vel.y - evy;
        const closing = -(relx * ux + rely * uy);
        if (closing > 0) {
          const ttc = dist / Math.max(closing, 1);
          if (ttc < 0.35) {
            const side = game.jinkSign || 1;
            dx += -uy * dist * 1.4 * side;
            dy += ux * dist * 1.4 * side;
          }
        }
      }
      if (dist < 340) speed *= 1.7; // dash: cursor gaining, pull away
      if (dist < 160) { // juke: clean perpendicular sidestep, breaks tracking
        const jx = dx, jy = dy;
        dx += (-jy / dist) * dist * 1.0;
        dy += (jx / dist) * dist * 1.0;
      }
    }
    // corner escape: pinned on two walls with cursor close = burst out.
    const pinnedX = game.pos.x < minX + 150 || game.pos.x > maxX - 150;
    const pinnedY = game.pos.y < minY + 150 || game.pos.y > maxY - 150;
    if (pinnedX && pinnedY && dist < 380) speed *= 2.0;
    speed = Math.min(2600, speed); // hard cap: fast, never teleporting
    if (game.showboatUntil && now < game.showboatUntil) {
      speed *= 0.15; // trash-talk pause: readable + catchable, then burst
    }
    if (pet && (pet.current === "flip" || pet.current === "land")) {
      speed *= 0.3; // stunt airtime: drift slow so the flip reads
    }
    if (pet) {
      // stride follows speed (5-8fps): reads as running, not dancing.
      pet.setRate(0.8 + (speed / 2600) * 0.5);
      // locomotion + facing: run cycle while sprinting, face away from
      // the chase (mirrored when heading left), lean into motion.
      // Jump one-shot owns the stage for its 350ms hold.
      if (game.phase === 1 && !pet.isPlaying("jump") && !pet.isPlaying("run")
        && !pet.isPlaying("flip") && !pet.isPlaying("land")) {
        pet.play("run", { force: true });
      }
      // hysteresis: flip only on decisive sustained horizontal motion
      // (600px/s + 800ms between flips), else the mirror transition
      // never lands and the sprite sits squished mid-flip.
      if (Math.abs(game.vel.x) > 600 && now - (game.lastFaceT || 0) > 800
          && pet.setFacing) {
        game.lastFaceT = now;
        pet.setFacing(game.vel.x);
        pet.setLean(game.vel.x * 0.006);
      } else if (pet.setLean) {
        pet.setLean(0);
      }
    }
    // wall bias: strong early push off walls so the chase never grinds
    // along an edge (wide zone, high gain beats the flee-into-wall pull).
    const m = 260;
    if (game.pos.x < minX + m) dx += (minX + m - game.pos.x) * 7;
    if (game.pos.y < minY + m) dy += (minY + m - game.pos.y) * 7;
    if (game.pos.x > maxX - m) dx -= (game.pos.x - (maxX - m)) * 7;
    if (game.pos.y > maxY - m) dy -= (game.pos.y - (maxY - m)) * 7;
    const len = Math.hypot(dx, dy) || 1;
    // steer, don't snap: blend heading toward desired (kills vibration,
    // keeps dash/juke readable as smooth swerves instead of judder).
    const k = 1 - Math.exp(-dt * 22);
    game.vel.x += ((dx / len) * speed - game.vel.x) * k;
    game.vel.y += ((dy / len) * speed - game.vel.y) * k;
    game.pos.x = Math.max(minX, Math.min(maxX, game.pos.x + game.vel.x * dt));
    game.pos.y = Math.max(minY, Math.min(maxY, game.pos.y + game.vel.y * dt));
    // the WINDOW follows the chase (throttled ~30Hz: per-frame IPC churn
    // buys nothing, the eye can't track faster than the sprite anyway).
    if (now - (game.lastWinMove || 0) > 33) {
      game.lastWinMove = now;
      winMove(game.pos.x, game.pos.y);
    }
    // (touch already checked at tick top, pre-dash)
    if (game.phase === 2 && elapsed >= GAME_P1_MS + GAME_P2_MS) {
      giveUp();
      return;
    }
    game.raf = requestAnimationFrame(gameTick);
    } catch (err) {
      console.error("gameTick error:", err);
      giveUp();
    }
  }

  function stopGameLoop() {
    if (!game) return;
    cancelAnimationFrame(game.raf);
    clearInterval(game.tauntTimer);
    stopGameFollow(); // the box stops tracking once the pet stops
    hideIsland();
    winMove(game.pos.x, game.pos.y); // settle on the final spot
    if (E() && E().setGameRunning) {
      E().setGameRunning(false);
    }
  }

  function endGameUI(replayLabel) {
    gameShow({
      text: "", sub: "",
      yesLabel: replayLabel,
      showYes: true, showNo: false, showExit: true, ph: 150,
    });
  }

  function catchMascot() {
    if (!game || !game.running) return;
    const cry = TAUNTS_CRY[Math.floor(Math.random() * TAUNTS_CRY.length)];
    gameSay(cry, 8000); // while still running: lands on the subtitle bar
    gameSub("Caught!");
    stopGameLoop();
    game.running = false;
    game.catches = 1;
    // the invite is spent: clear it so the hub button can offer again later.
    // offerGame() refuses while offered is set and not declined, which would
    // otherwise leave Catch & Catch dead for the rest of the session.
    game.offered = false;
    mascotEl.classList.remove("mascot--stunt");
    mascotEl.classList.remove("mascot--hop");
    mascotEl.classList.remove("mascot--game");
    syncWinSize();
    playAnim("hero_idle", { force: true });
    if (pet) pet.resetPose();
    mascotEl.classList.add("mascot--caught"); // sob shake, removed below
    setTimeout(() => mascotEl.classList.remove("mascot--caught"), 3500);
    endGameUI("Rematch");
    api("/ack", { action: "game_done", catches: 1 });
  }

  function giveUp() {
    if (!game || !game.running) return;
    const line = "fine! you win! too speedy for my own legs...";
    gameSay(line, 8000); // while still running: lands on the subtitle bar
    gameSub("Surrendered");
    stopGameLoop();
    game.running = false;
    game.offered = false; // invite spent, same as a catch
    mascotEl.classList.remove("mascot--stunt");
    mascotEl.classList.remove("mascot--hop");
    mascotEl.classList.remove("mascot--game");
    syncWinSize();
    playAnim("hero_idle", { force: true });
    if (pet) pet.resetPose();
    endGameUI("Rematch");
    api("/ack", { action: "game_done", catches: 0 });
  }

  // game box choices arrive from the game window via main relay
  function gameChoice(which, m) {
    if (which === "yes") {
      if (m && typeof m.x === "number") lastCursor = { x: m.x, y: m.y };
      if (game && !game.running) { clearOfferTimer(); offerPhase = null; startGame(); } // offer accept or rematch
      return;
    }
    if (which === "no") {
      if (offerPhase === "plead" || (game && game.declinedPlead)) {
        // second No: silent. Box gone, no line, long cooldown.
        clearOfferTimer();
        offerPhase = null;
        hideGameBox();
        api("/ack", { action: "game_silent" });
        game = { running: false, offered: false, declined: true };
        return;
      }
      if (offerPhase === "offer" || (game && game.offered)) {
        // first No: plead once, same buttons.
        clearOfferTimer();
        offerPhase = "plead";
        if (game) game.declinedPlead = true;
        gameShow({
          text: "please? 🥺 one quick game?",
          sub: "",
          yesLabel: "Yes",
          showYes: true, showNo: true, showExit: false, ph: 190,
        });
        subtitleShow("pleading protocol activated.", 4000, false);
        return;
      }
      hideGameBox();
      clearOfferTimer();
      api("/ack", { action: "game_done", catches: 0 });
      game = { running: false, offered: false, declined: true };
      return;
    }
    // exit: back where it was before the chase, never stranded
    stopGameLoop();
    subtitleHideNow();
    if (E()) E().widgetHide("game");
    mascotEl.classList.remove("mascot--caught");
    mascotEl.classList.remove("mascot--stunt");
    mascotEl.classList.remove("mascot--hop");
    mascotEl.classList.remove("mascot--game");
    syncWinSize();
    if (game && game.home) {
      winMove(game.home.x, game.home.y);
    } else {
      placeMascotCorner();
    }
    playAnim("hero_idle", { force: true });
    if (pet) pet.resetPose();
    api("/ack", { action: "game_done", catches: 0 });
    game = null;
  }

  // last seen cursor in SCREEN coords (even outside a chase): seeds spawn.
  let lastCursor = null;
  window.addEventListener("mousemove", (e) => {
    lastCursor = { x: W.x + e.clientX, y: W.y + e.clientY };
    feedCursor(lastCursor.x, lastCursor.y);
  });
  // cursor tracker: feeds the flee AI. Local mousemove only fires over this
  // small window; main forwards sampled SCREEN positions at 50ms during a
  // chase so tracking works across the whole desktop.
  function feedCursor(x, y) {
    if (!game || !game.running) return;
    const now = performance.now();
    const dt = Math.max(0.008, (now - game.cursor.t) / 1000);
    let vx = (x - game.cursor.x) / dt;
    let vy = (y - game.cursor.y) / dt;
    const sp = Math.hypot(vx, vy);
    if (sp > 4000) { vx *= 4000 / sp; vy *= 4000 / sp; }
    // smooth raw deltas: kills single-frame spikes that shook the flee vector.
    vx = game.cursor.vx * 0.55 + vx * 0.45;
    vy = game.cursor.vy * 0.55 + vy * 0.45;
    // smoothed acceleration: enables second-order prediction below.
    let ax = (vx - game.cursor.vx) / dt;
    let ay = (vy - game.cursor.vy) / dt;
    const as = Math.hypot(ax, ay);
    if (as > 20000) { ax *= 20000 / as; ay *= 20000 / as; }
    game.cursor.x = x;
    game.cursor.y = y;
    game.cursor.vx = vx;
    game.cursor.vy = vy;
    game.cursor.ax = (game.cursor.ax || 0) * 0.6 + ax * 0.4;
    game.cursor.ay = (game.cursor.ay || 0) * 0.6 + ay * 0.4;
    game.cursor.t = now;
  }
  if (E() && E().onCursorPos) {
    E().onCursorPos((p) => {
      if (p && typeof p.x === "number") feedCursor(p.x, p.y);
    });
  }

  /* ---------- peek-a-boo (frontend-local ambient mischief) ----------
     Every few idle minutes the buddy plants hands on the nearest screen
     edge and rises into view (hands -> tucked -> half -> full head),
     holds, retreats, then pops home. Dedicated peek_top/right/bottom/
     left clips; the drawn edge bar stays parked off-screen so only the
     hands + head ever show. Skipped while gaming, dragging, touring,
     reduced-motion, or mid-chase. The WINDOW moves (no CSS travel). */
  const PEEK_LINES = [
    "psst... over here.",
    "did you miss me? be honest.",
    "peek-a-boo. i win.",
    "just checking the borders. all clear.",
    "hands on. rising up. ta-da.",
  ];
  // frame geometry (w x h, drawn edge-bar thickness in frame px)
  const PEEK_GEO = {
    t: { clip: "peek_top", fw: 500, fh: 461, bar: 74 },
    r: { clip: "peek_right", fw: 372, fh: 500, bar: 80 },
    b: { clip: "peek_bottom", fw: 500, fh: 461, bar: 52 },
    l: { clip: "peek_left", fw: 415, fh: 500, bar: 157 },
  };
  const PEEK_H = 300; // display height px at scale 1
  function peekArmed() {
    if (cinemaActive || reducedMotion || dragOffset || tourRunning) return false;
    if (game && (game.running || (game.offered && !game.declined))) return false;
    if (!pet || !pet.isPlaying("idle")) return false;
    return true;
  }
  function schedulePeek() {
    setTimeout(() => {
      if (peekArmed()) {
        peekOut();
      } else {
        schedulePeek();
      }
    }, (4 + Math.random() * 3) * 60 * 1000);
  }
  // Park the WINDOW for a peek clip: resize to frame aspect, hide the drawn
  // edge bar off-screen. Returns { restore, clip }. Shared by idle peek
  // and the animation tour.
  let peekParked = false;
  function peekPark(edge) {
    const g = PEEK_GEO[edge];
    const home = { x: W.x, y: W.y, w: W.w, h: W.h };
    const dh = PEEK_H * scale;
    const k = dh / g.fh; // frame px -> display px
    const dw = g.fw * k;
    const bar = g.bar * k + 4; // drawn bar parked fully off-screen
    // spread along the edge (middle band, never corners) so peeks visit
    // all four sides instead of camping the mascot's corner
    const bandT = 0.15 + Math.random() * 0.70;
    const p = window.parkGeom
      ? window.parkGeom(edge, arena, dw, dh, bar, bandT)
      : { x: arena.x, y: arena.y };
    peekParked = true;
    mascotEl.dataset.peekEdge = edge;
    winResize(Math.round(dw), Math.round(dh));
    winMove(p.x, p.y, true);
    return {
      clip: g.clip,
      restore: () => {
        peekParked = false;
        delete mascotEl.dataset.peekEdge;
        winResize(home.w, home.h);
        winMove(home.x, home.y);
      },
    };
  }
  const PEEK_POOF_MS = 260; // vanish/appear fade beat
  async function peekOut(forcedEdge) {
    // random edge every time: peeks tour all four sides, never camp corners.
    // vanish-appear: fade out in place, pop in parked at the edge, peek,
    // fade out, pop back home. No cross-screen travel.
    const edge = (forcedEdge && PEEK_GEO[forcedEdge]) ? forcedEdge
      : "lrtb"[Math.floor(Math.random() * 4)];
    const g = PEEK_GEO[edge];
    const line = PEEK_LINES[Math.floor(Math.random() * PEEK_LINES.length)];
    await refreshArena();
    mascotEl.classList.add("mascot--poof"); // beat 1: vanish in place
    setTimeout(() => {
      const { restore } = peekPark(edge); // reposition while invisible
      mascotEl.classList.remove("mascot--poof"); // beat 2: appear at edge
      if (!pet.play(g.clip, { force: true })) { // cooldown race: bail visible
        restore();
        schedulePeek();
        return;
      }
      syncWinSize();
      setTimeout(() => {
        subtitleShow(line, 4000, false);
      }, 1200); // full-head frame lands ~1s in
      setTimeout(() => {
        mascotEl.classList.add("mascot--poof"); // beat 3: vanish at edge
        setTimeout(() => {
          restore(); // home while invisible
          mascotEl.classList.remove("mascot--poof"); // beat 4: reappear
          schedulePeek();
        }, PEEK_POOF_MS + 60);
      }, 4000); // rise (1s) + hold (2s) + retreat (~1s)
    }, PEEK_POOF_MS + 60);
  }

  /* ---------- bridge poll ---------- */
  async function poll() {
    try {
      await pollBody();
    } catch (err) {
      console.log("[poll] " + (err && err.message ? err.message : err));
    }
  }

  async function pollBody() {
    let state;
    try {
      state = await api("/state?who=mascot");
    } catch {
      return; // bridge down: freeze on idle, retry next tick
    }
    applySettings(state.settings || {});

    // Cinema mode: vanish when watching full-screen video (YouTube, VLC, etc.)
    // A chase the user asked for wins over cinema. Hiding mid-game also freezes
    // it: Chromium stops requestAnimationFrame on hidden windows, so the chase
    // would never move and never reach its own 30s timeout.
    const gameWantsUs = !!(game && game.running);
    if (state.cinema_mode && !cinemaActive && !gameWantsUs) {
      cinemaActive = true;
      mascotEl.classList.add("mascot--poof");
      setTimeout(() => {
        if (cinemaActive) {
          mascotEl.style.display = "none";
          if (E() && E().winHide) E().winHide();
        }
      }, 280);
    } else if ((!state.cinema_mode || gameWantsUs) && cinemaActive) {
      cinemaActive = false;
      if (E() && E().winShow) E().winShow();
      mascotEl.style.display = "";
      requestAnimationFrame(() => {
        mascotEl.classList.remove("mascot--poof");
      });
    }

    // Hub-triggered actions
    if (state.request_tour && !tourRunning) {
      playAnimationTour();
    }
    if (state.request_peek && peekArmed()) {
      peekOut(state.request_peek);
    }

    if (tourRunning || dragOffset) {
      if (pet) pet.update();
      return; // tour or drag owns the mascot right now
    }
    // While peek-parked the peek clip owns the stage: bridge clip updates
    // would swap the parked peek art for idle mid-rise (the "standing at
    // the edge" bug). Bubbles, island, voice, and offers still flow.
    if (!peekParked) {
      if (state.animation) {
        if (!isPlayingAnim(state.animation)) playAnim(state.animation);
      } else if (!isPlayingAnim("hero_idle")) {
        playAnim("hero_idle");
      }
    }
    if (state.bubble && state.bubble.id !== lastBubbleId) {
      saySubtitle(state.bubble);
    }
    const sig = state.island ? state.island.title + "\n" + state.island.text : "";
    if (sig && sig !== lastIslandSig) {
      lastIslandSig = sig;
      showIsland(state.island);
    } else if (!sig && lastIslandSig) {
      lastIslandSig = "";
      hideIsland();
    }
    // state.voice deliberately ignored: voice output is off by design.
    if (state.game_offer) offerGame();
    if (pet) pet.update();
    syncWinSize();
  }

  // Voice is OFF by design: the buddy is not a text-to-speech thing.
  // The bridge may still send voice lines; they are deliberately ignored.
  function speak(text) {
    return;
  }

  /* ---------- diagnostics HUD (toggle with Alt+D) ---------- */
  let diagEl = null;
  let diagOn = false;
  const assetFails = [];
  function ensureDiagEl() {
    if (diagEl) return diagEl;
    diagEl = document.createElement("pre");
    diagEl.id = "rig-diag";
    diagEl.style.cssText =
      "position:fixed;left:8px;top:8px;z-index:9999;margin:0;padding:8px 10px;" +
      "background:rgba(0,0,0,.72);color:#7fff9e;font:11px/1.5 Consolas,monospace;" +
      "border-radius:6px;white-space:pre;pointer-events:none;display:none";
    document.body.appendChild(diagEl);
    return diagEl;
  }
  function updateDiag() {
    if (!diagOn || !pet) return;
    const cur = pet.current || "(none)";
    ensureDiagEl().textContent =
      "multi-window brain\n" +
      `anim: ${cur}\n` +
      `win: ${W.w}x${W.h} @ (${W.x},${W.y})\n` +
      `arena: ${arena.w}x${arena.h} @ (${arena.x},${arena.y})\n` +
      `asset failures: ${assetFails.length || "none"}\n` +
      `Alt+D hides this panel`;
  }
  setInterval(updateDiag, 500);
  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "d" || e.key === "D")) {
      diagOn = !diagOn;
      ensureDiagEl().style.display = diagOn ? "" : "none";
    }
  });
  window.addEventListener("error", (e) => {
    if (diagOn) ensureDiagEl();
    assetFails.push(`js: ${e.message}`.slice(0, 80));
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
