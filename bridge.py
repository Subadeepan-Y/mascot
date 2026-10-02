"""Buddy web bridge: system sensing + dialogue brain for the web frontend.

Reuses the legacy Python modules (context, sensing, quips, chatter, buddy,
settings, sleep) and serves a JSON command stream on localhost. No painting
here: the Electron frontend owns all pixels.

Endpoints (127.0.0.1:17385):
  GET  /state     -> animation, bubble, island, voice, settings, game_offer
  GET  /settings  -> chatter_frequency, voice_enabled, ...
  POST /settings  -> {chatter_frequency?, voice_enabled?, ...}
  POST /ack       -> {action: got_it|snooze|game_done|game_silent, catches?}
  POST /poke      -> cursor touched the mascot (activity + wake)

Run: py bridge.py   (started automatically by the Electron shell)
Legacy fallback untouched: py main.py
"""
from __future__ import annotations

import json
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from buddy import TITLES, Buddy, defaults
from chatter import ChatterScheduler, ChatterSnap
from context import (
    APPS,
    ERROR_WORDS,
    Context,
    ContextTracker,
    Foreground,
    VIDEO_EXES,
    VIDEO_WORDS,
    cinema_should_hide,
    classify,
    has_any,
    identify,
    is_browser,
    read_clipboard,
)
from quips import AMBIENT, EVENTS, QUIPS, QuipDeck
from video_probe import classify as classify_shape
from video_probe import probe
from video_probe import reset_cache as reset_shape_cache
from sensing import InputWatcher, PassiveSensor, battery, click_now, mouse_buttons, process_names
from settings import Settings
from sleep import SleepMachine

HOST, PORT = "127.0.0.1", 17385

# quip category -> dialogue kind. Drives subtitle emphasis + reaction pairing.
# invite/game kinds never occur here: game invites use the floating box.
KIND_MAP = {
    "build_success": "celebrate", "success": "celebrate", "flow": "celebrate",
    "returned": "celebrate", "video_back": "celebrate", "excited": "celebrate",
    "charging": "celebrate", "meeting_end": "celebrate",
    "errors": "error", "error_streak": "error", "crash": "error",
    "confused": "error",
    "battery_low": "alert", "video_farewell": "alert",
    "dragged_a_lot": "alert", "doomscroll_intervention": "alert",
}

# event category -> web one-shot animation (hero sheets only)
EVENT_ANIM = {
    "build_success": "hero_victory", "success": "hero_victory",
    "flow": "hero_victory", "error_streak": "hero_facepalm",
    "errors": "hero_facepalm", "app_hopping": "hero_facepalm",
    "crash": "hero_shock", "returned": "hero_smile",
    "video_back": "hero_smile", "confused": "hero_confused",
    "searching": "hero_confused", "excited": "hero_smile",
    "writing": "hero_talk", "sheets": "hero_smile", "slides": "hero_smile",
    "mail": "hero_talk", "chat": "hero_smile", "social": "hero_sunglasses",
    "design": "hero_victory", "terminal": "hero_sunglasses",
    "system": "hero_confused", "communication": "hero_smile",
    "dragged_a_lot": "hero_shock",
    "doomscroll_intervention": "hero_facepalm",
    # tamil moments: maja grooves, grind triumphs, beautiful swoons,
    # pooja celebrates, track changes nod along
    "tamil_maja": "hero_victory", "tamil_grind": "hero_victory",
    "tamil_beautiful": "hero_smile", "tamil_pooja": "hero_smitten",
    "track": "hero_smile",
    "tamil_coding": "hero_victory", "tamil_music": "hero_red_suit",
    "tamil_video": "hero_smile", "tamil_random": "hero_smile",
    "tamil_wake": "hero_smile", "tamil_idle": "hero_smile",
    "tamil_ignored": "hero_smile",
}

for _l in ("kannada", "telugu", "malayalam", "hindi"):
    EVENT_ANIM[f"{_l}_coding"] = "hero_victory"
    EVENT_ANIM[f"{_l}_poke"] = "hero_smile"
    EVENT_ANIM[f"{_l}_idle"] = "hero_smile"
    EVENT_ANIM[f"{_l}_random"] = "hero_smile"
    EVENT_ANIM[f"{_l}_wake"] = "hero_smile"
    EVENT_ANIM[f"{_l}_catch"] = "hero_victory"

# app arrival pool (app_spotify, app_cursor...) -> hero animation by the
# app's own category, so every named app also moves, not just talks.
_APP_CAT_ANIM = {
    "music": "dance_red", "video": "hero_smile", "coding": "hero_victory",
    "terminal": "hero_sunglasses", "browsing": "hero_smile",
    "chat": "hero_smile", "communication": "hero_smile",
    "writing": "hero_smile", "sheets": "hero_smile", "slides": "hero_smile",
    "mail": "hero_smile", "gaming": "hero_victory", "design": "hero_victory",
    "system": "hero_confused",
}
APP_ANIM = {f"app_{app_id}": _APP_CAT_ANIM.get(cat, "hero_smile")
            for app_id, cat, _exes, _titles in APPS}

# event animation holds: one-off moments groove briefly, then hand the
# stage back. Default 12s only for the old marquee events.
REACT_HOLD = {
    "tamil_maja": 6.0, "tamil_grind": 6.0, "tamil_beautiful": 6.0,
    "tamil_pooja": 6.0, "track": 6.0,
}
for _l in ("kannada", "telugu", "malayalam", "hindi"):
    REACT_HOLD[f"{_l}_coding"] = 6.0
    REACT_HOLD[f"{_l}_poke"] = 4.0
    REACT_HOLD[f"{_l}_idle"] = 6.0
    REACT_HOLD[f"{_l}_random"] = 6.0
    REACT_HOLD[f"{_l}_wake"] = 4.0
    REACT_HOLD[f"{_l}_catch"] = 6.0

GAME_OFFER_EVERY = 45 * 60
# How long a hub-triggered pulse (tour / peek / catch invite) stays claimable.
# Long enough for the mascot's poll to land, short enough that a stale pulse
# never resurrects an invite after the mascot was closed.
ACTION_TTL = 6.0
# A browser only counts as a film once the picture has stayed landscape this
# long. Long enough that a Short (portrait, under a minute) can never reach it.
BROWSER_MOVIE_SECONDS = 180.0
# Hub cinema button cycles AUTO -> FORCE ON -> FORCE OFF -> AUTO. AUTO must be
# reachable again, otherwise one manual press disables detection for good.
CINEMA_CYCLE = (None, True, False)
GAME_COOLDOWN = 45 * 60
GAME_SILENT = 3 * 60 * 60  # double No: silent for 3h, not 45min
VIBE_EVERY = 25 * 60  # process vibe: one comment per ~25min, never a stream
VIBE_SKIP = {
    "explorer.exe", "systemsettings.exe", "taskmgr.exe", "searchhost.exe",
    "shellexperiencehost.exe", "runtimebroker.exe", "svchost.exe",
    "csrss.exe", "winlogon.exe", "dwm.exe", "smss.exe", "services.exe",
    "lsass.exe", "fontdrvhost.exe", "sihost.exe", "ctfmon.exe",
    "textinputhost.exe", "applicationframehost.exe", "widgets.exe",
    "startmenuexperiencehost.exe", "useroobebroker.exe",
}


def exempt_process_efficiency_mode(pid: int | None = None) -> bool:
    """Exempt a process from Windows EcoQoS/Efficiency Mode and disable execution speed throttling."""
    try:
        import ctypes
        import os
        from ctypes import wintypes
        import sys
        if sys.platform != "win32":
            return False
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        class PROCESS_POWER_THROTTLING_STATE(ctypes.Structure):
            _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]
        state = PROCESS_POWER_THROTTLING_STATE(1, 0x1, 0)
        k32.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k32.SetProcessInformation.restype = wintypes.BOOL
        k32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.SetPriorityClass.restype = wintypes.BOOL

        if pid is None or pid == os.getpid():
            h = k32.GetCurrentProcess()
            k32.SetProcessInformation(h, 4, ctypes.byref(state), ctypes.sizeof(state))
            k32.SetPriorityClass(h, 0x00000020)  # NORMAL_PRIORITY_CLASS
            return True
        else:
            h = k32.OpenProcess(0x0200, False, pid)  # PROCESS_SET_INFORMATION
            if h:
                try:
                    k32.SetProcessInformation(h, 4, ctypes.byref(state), ctypes.sizeof(state))
                    k32.SetPriorityClass(h, 0x00000020)
                finally:
                    k32.CloseHandle(h)
                return True
    except Exception:
        pass
    return False


class Brain:
    """One tick per second, mirroring the legacy sense() policy."""
    last_intervention: dict | None = None

    def __init__(self) -> None:
        self.settings = Settings.load()
        self.sensor = PassiveSensor()
        self.fg = Foreground()
        self.tracker = ContextTracker()
        self.tracker.social_threshold = float(getattr(self.settings, "doomscroll_threshold_min", 15)) * 60.0
        self.last_intervention: dict | None = None
        self.deck = QuipDeck()
        self.watcher = InputWatcher()
        self.sleep_machine = SleepMachine()
        self.buddy = Buddy(defaults())
        self.chatter = ChatterScheduler(
            frequency=self.settings.chatter_frequency, now=time.monotonic())
        self.screen_reactions = self.settings.screen_reactions
        self.quiet_mode = self.settings.quiet_mode
        self.clipboard_optin = self.settings.clipboard_optin
        self.lock = threading.RLock()  # reentrant: update_settings calls state()
        # outbound command state
        self.animation = "hero_idle"
        self.anim_until = 0.0
        self.bubble_id = 0
        self.bubble_text = ""
        self.bubble_kind = "normal"
        self.bubble_until = 0.0
        self.island: dict | None = None
        self.island_until = 0.0
        self.voice_text: str | None = None
        self.game_offer = False
        self.last_game_offer = 0.0
        self.game_cooldown_until = 0.0
        self.last_vibe = 0.0
        self.last_vibe_name = ""
        self.cinema_mode = False
        self.cinema_override: bool | None = None
        # when a fullscreen browser video first looked like a film (monotonic)
        self.browser_movie_since: float | None = None
        self.request_peek: str | None = None
        self.request_tour: bool = False
        # Pulses the mascot must see. They are NOT consumed by state() on
        # sight: the hub polls /state faster than the mascot does, and a
        # hub that ignores request_tour must not swallow it. Each pulse
        # therefore expires on its own and is cleared only when the mascot
        # itself reads state (who="mascot").
        self.request_peek_until = 0.0
        self.request_tour_until = 0.0
        self.game_offer_until = 0.0
        # wall-clock end of the hub's Snooze window (0 = not snoozed)
        self.snooze_until = 0.0

    # -- helpers --
    def snoozed(self, now: float | None = None) -> bool:
        """True while the hub's Snooze window is still open."""
        return (time.time() if now is None else now) < self.snooze_until

    def snooze(self, minutes: int = 10) -> bool:
        """Go quiet for a while. Returns True if it started, False if it woke.

        This used to only nudge the Buddy visit scheduler, which silenced one
        of the speech sources and left chatter, reactions and game taunts
        talking. The window is enforced in say()/pop_island() instead, so one
        switch covers everything the mascot can say.
        """
        with self.lock:
            if self.snoozed():
                self.snooze_until = 0.0
                self.say("back! sorry about that.", 3.0, force=True)
                return False
            self.snooze_until = time.time() + minutes * 60
            self.buddy.snooze(minutes)
            self.say(f"ok, quiet for {minutes}m", 3.0, force=True)
            return True

    def wake(self) -> None:
        """Cancel an open snooze. A poke means the user is here and wants a reply."""
        if self.snooze_until > time.time():
            self.snooze_until = 0.0

    def say(self, text: str, duration: float = 4.0, kind: str = "normal",
            force: bool = False) -> None:
        if not force and self.snoozed():
            return  # snoozed: the buddy keeps its thoughts to itself
        self.bubble_id += 1
        self.bubble_text = text
        self.bubble_kind = kind
        self.bubble_until = time.monotonic() + duration

    def play(self, name: str, duration: float = 3.0) -> None:
        self.animation = name
        self.anim_until = time.monotonic() + duration

    def pop_island(self, title: str, text: str, duration: float = 8.0) -> None:
        if self.snoozed():
            return  # snoozed: no popups either
        self.island = {"title": title, "text": text, "buttons": True}
        self.island_until = time.monotonic() + duration

    # -- main tick --
    def tick(self) -> None:
        with self.lock:
            self._tick()

    def _tick(self) -> None:
        activity = self.sensor.sample()
        now_wall = time.time()
        mono = time.monotonic()
        pct, charging = battery()
        exe, title = self.fg.exe_and_title()
        if not title:
            title = getattr(activity, "title", "")
        category = classify(exe, title)
        fullscreen = self.fg.is_fullscreen()
        meeting = category == "meeting"
        suppressed = fullscreen or meeting
        ctx = Context(
            exe=exe, title=title, category=category, app=identify(exe, title),
            idle_seconds=activity.idle_seconds, fullscreen=fullscreen,
            meeting=meeting, hour=time.localtime(now_wall).tm_hour,
            battery_pct=pct, charging=charging,
            clipboard=read_clipboard() if self.clipboard_optin else None,
        )
        if activity.idle_seconds < 2:
            self.tracker.note_activity(now_wall)
        edge = self.watcher.poll(now_wall)
        self.sleep_machine.update(activity.idle_seconds, edge.any, now_wall)
        if mono > self.anim_until and self.animation != "hero_idle":
            self.animation = "hero_sleep" if self.sleep_machine.sleeping else "hero_idle"
        if self.sleep_machine.sleeping:
            self.animation = "hero_sleep"
        if self.sleep_machine.consume_reaction():
            self.on_wake()
        events = self.tracker.update(ctx, now_wall) if self.screen_reactions else []
        low_title = title.casefold()
        low_exe = exe.casefold()
        is_video = (category == "video"
                    or any(w in low_title for w in VIDEO_WORDS)
                    or any(w in low_exe for w in VIDEO_EXES)
                    or "vlc" in low_exe or "vlc" in low_title
                    or "youtube" in low_title or "youtu.be" in low_title)
        if self.cinema_override is not None:
            self.cinema_mode = self.cinema_override
        else:
            self.cinema_mode = self._cinema(is_video, fullscreen, exe, title, mono)

        if ("video_farewell" in events and not self.quiet_mode):
            line = "cinema mode activated,will see ya after the film ends!"
            self.say(line, 6.0, "alert")
            self.chatter.mark_event(mono)
        if ("video_back" in events and not self.quiet_mode
                and not suppressed):
            back_line = self.deck.pick("video_back", now_wall) or "back from the big screen, i see."
            self.say(back_line, 5.0, "normal")
            self.chatter.mark_event(mono)
        moment = self.buddy.tick(now_wall, activity.idle_seconds, pct, charging)
        if moment is not None and not self.quiet_mode:
            self.say(moment.text, 6.0)
            self.chatter.mark_event(mono)
            if not suppressed:
                self.pop_island(TITLES.get(moment.kind, ""), moment.text)
                if self.settings.voice_enabled:
                    self.voice_text = moment.text
        if (self.screen_reactions and not self.quiet_mode
                and not suppressed):
            self.react_to_screen(ctx, now_wall, events)
        if (self.screen_reactions and not self.quiet_mode and suppressed
                and not meeting):
            # title moments punch through fullscreen: a Pooja Hegde video
            # or a gorgeous song deserves its hearts even in cinema mode.
            # Meetings stay sacred: nothing fires mid-call.
            self.react_to_screen(
                ctx, now_wall,
                [e for e in events if e in ("pooja", "beautiful")])
        self.tick_chatter(ctx, now_wall, events, pct)
        self.offer_game(now_wall, mono, suppressed)
        self.tick_vibe(now_wall, mono, suppressed)

    def active_languages(self) -> list[str]:
        langs = []
        if getattr(self.settings, "lang_tamil", True):
            langs.append("tamil")
        if getattr(self.settings, "lang_kannada", True):
            langs.append("kannada")
        if getattr(self.settings, "lang_telugu", True):
            langs.append("telugu")
        if getattr(self.settings, "lang_malayalam", True):
            langs.append("malayalam")
        if getattr(self.settings, "lang_hindi", True):
            langs.append("hindi")
        return langs

    def react(self, line: str, category: str, now_wall: float,
              use_island: bool = False, use_voice: bool = False) -> None:
        if self.quiet_mode:
            return
        self.chatter.mark_event(time.monotonic())
        anim = EVENT_ANIM.get(category) or APP_ANIM.get(category)
        if anim:
            hold = REACT_HOLD.get(category, 12.0)
            self.play(anim, hold)
        kind = KIND_MAP.get(category, "normal")
        if use_island:
            self.say(line, 6.0, kind)
            self.pop_island("", line)
        else:
            self.say(line, 5.0, kind)

    def react_to_screen(self, ctx: Context, now_wall: float, events: list[str]) -> None:
        if self.island is not None:
            return
        if ctx.clipboard and has_any(ctx.clipboard, ERROR_WORDS):
            line = self.deck.pick("errors", now_wall)
            if line:
                self.react(line, "errors", now_wall)
            return
        for event in events:
            if event in ("video_farewell", "video_back"):
                continue
            if event == "app_arrival" and ctx.app:
                pool = f"app_{ctx.app}"
                if pool not in QUIPS:
                    entered = EVENTS.get(f"entered_{ctx.category}")
                    pool = entered[0] if entered else ctx.category
                line = self.deck.pick_event(pool, now_wall)
                if line is None:
                    continue
                self.react(line, pool, now_wall)
                return
            if event == "track_change":
                track = ctx.title.split(" - YouTube")[0].split(" | Spotify")[0].strip()
                if len(track) > 48:
                    track = track[:47].rstrip() + "…"
                line = self.deck.pick_event("track", now_wall)
                if line is None:
                    continue
                self.react(line.format(track=track), "track", now_wall)
                return
            if event == "pooja":
                # Pooja Hegde on screen: ALWAYS ON, regardless of language setting!
                line = self.deck.pick_event("tamil_pooja", now_wall)
                if line is None:
                    continue
                self.react(line, "tamil_pooja", now_wall)
                return
            if event == "beautiful":
                if getattr(self.settings, "lang_tamil", True):
                    line = self.deck.pick_event("tamil_beautiful", now_wall)
                    if line is None:
                        continue
                    self.react(line, "tamil_beautiful", now_wall)
                    return
            if event == "doomscroll_intervention":
                if not getattr(self.settings, "doomscroll_guard", False):
                    continue
                from sensing import close_foreground_window
                closed = close_foreground_window()
                line = self.deck.pick_event("doomscroll_intervention", now_wall) or "alright, that's enough doomscrolling! closing this!"
                self.react(line, "doomscroll_intervention", now_wall, use_island=True)
                self.last_intervention = {"app": ctx.title or "social media", "closed": closed, "time": now_wall}
                return
            mapping = EVENTS.get(event)
            if mapping is None:
                continue
            category, use_island, _use_voice = mapping
            active_langs = self.active_languages()
            has_tamil = "tamil" in active_langs
            if event == "entered_music" and has_tamil:
                r = random.random()
                if r < 0.25:
                    category, use_island = "tamil_maja", False
                elif r < 0.5:
                    category, use_island = "tamil_music", False
            elif event == "entered_video" and has_tamil and random.random() < 0.4:
                category, use_island = "tamil_video", False
            elif event == "entered_coding" and active_langs and random.random() < 0.5:
                lang = random.choice(active_langs)
                category, use_island = f"{lang}_coding", False
            elif event in ("flow", "staring") and has_tamil and random.random() < 0.5:
                category, use_island = "tamil_grind", False
            elif event == "idle" and active_langs and random.random() < 0.4:
                lang = random.choice(active_langs)
                category, use_island = f"{lang}_idle", False
            elif event == "idle_long" and has_tamil and random.random() < 0.5:
                category, use_island = "tamil_ignored", False
            line = self.deck.pick_event(category, now_wall)
            if line is None:
                continue
            self.react(line, category, now_wall, use_island)
            return
        active_langs = self.active_languages()
        has_tamil = "tamil" in active_langs
        ambient = AMBIENT.get(ctx.category)
        if ambient == "music" and has_tamil and random.random() < 0.3:
            ambient = "tamil_music"
        elif ambient == "video" and has_tamil and random.random() < 0.3:
            ambient = "tamil_video"
        if ambient and ctx.idle_seconds < 60 and random.random() < 0.10:
            line = self.deck.pick(ambient, now_wall)
            if line:
                self.react(line, ambient, now_wall)

    def tick_chatter(self, ctx: Context, now_wall: float,
                     events: list[str], battery_pct: int | None) -> None:
        mono = time.monotonic()
        snap = ChatterSnap(
            category=ctx.category,
            idle_seconds=ctx.idle_seconds,
            hour=ctx.hour,
            battery_low=battery_pct is not None and battery_pct <= 15,
            error_now=self.tracker.error_streak >= 1
            and now_wall - self.tracker.last_error < 120,
            error_streak=self.tracker.error_streak >= 3,
            app_switching=len(self.tracker.switches) >= 4,
            returned="returned" in events,
            quiet_mode=self.quiet_mode or self.snoozed(),
            meeting=ctx.meeting,
            fullscreen_video=ctx.fullscreen and ctx.category == "video",
            sleeping=self.sleep_machine.sleeping,
            waking=self.sleep_machine.state == "waking",
            island_visible=self.island is not None,
            user_anim_active=False,
            dragging=False,
            bubble_visible=mono <= self.bubble_until,
        )
        result = self.chatter.tick(snap, QUIPS, mono)
        if result.delivered:
            active_langs = self.active_languages()
            if result.category in ("general", "meta") and active_langs and random.random() < 0.35:
                lang = random.choice(active_langs)
                pool = f"{lang}_random"
                alt = self.deck.pick_event(pool, now_wall)
                if alt:
                    self.say(alt, 6.0)
                    return
            self.say(result.line, 6.0)

    def on_wake(self) -> None:
        mono = time.monotonic()
        self.play("hero_wake", 3.0)
        self.chatter.mark_event(mono)
        if self.quiet_mode:
            return
        active_langs = self.active_languages()
        if active_langs and random.random() < 0.6:
            lang = random.choice(active_langs)
            line = self.deck.pick(f"{lang}_wake")
        else:
            line = self.deck.pick("returned")
        if line:
            # delay one beat so the wake animation finishes first
            self.say(line, 4.0)

    def offer_game(self, now_wall: float, mono: float, suppressed: bool) -> None:
        if (self.quiet_mode or suppressed
                or self.sleep_machine.sleeping):
            return
        if mono < self.game_cooldown_until:
            return
        if now_wall - self.last_game_offer >= GAME_OFFER_EVERY:
            self.last_game_offer = now_wall
            self.game_cooldown_until = mono + GAME_COOLDOWN
            self.game_offer = True

    def tick_vibe(self, now_wall: float, mono: float, suppressed: bool) -> None:
        """Glance at the process list ~every 25min and comment once."""
        if (self.quiet_mode or suppressed
                or self.sleep_machine.sleeping):
            return
        if mono - self.last_vibe < VIBE_EVERY:
            return
        self.last_vibe = mono
        names = process_names()
        if not names:
            return
        counts: dict[str, int] = {}
        for n in names:
            if n in VIBE_SKIP or n == self.tracker.last_exe:
                continue
            counts[n] = counts.get(n, 0) + 1
        if not counts:
            return
        top = max(counts, key=lambda n: counts[n])
        if top == self.last_vibe_name:
            return
        template = self.deck.pick("processes", now_wall)
        if template is None:
            return
        self.last_vibe_name = top
        nice = top[:-4] if top.endswith(".exe") else top
        nice = nice.replace("_", " ").replace("-", " ")
        self.say(template.format(name=nice, count=len(names)), 6.0)
        self.chatter.mark_event(mono)

    def on_event(self, event_name: str, now_wall: float | None = None) -> None:
        if now_wall is None:
            now_wall = time.time()
        line = self.deck.pick_event(event_name, now_wall) or "whoa whoa put me down! dizzy dizzy!"
        self.react(line, event_name, now_wall, use_island=False)

    # -- HTTP surface --
    def state(self, who: str = "") -> dict:
        with self.lock:
            mono = time.monotonic()
            bubble = None
            if mono <= self.bubble_until:
                bubble = {"id": self.bubble_id, "text": self.bubble_text,
                          "kind": self.bubble_kind,
                          "ms": int((self.bubble_until - mono) * 1000)}
            island = self.island if mono <= self.island_until else None
            if island is None:
                self.island = None
            voice, self.voice_text = self.voice_text, None
            offer = self.game_offer and mono < self.game_offer_until
            animation = self.animation
            if self.bubble_text and mono <= self.bubble_until and animation == "hero_idle":
                animation = "hero_talk"  # talk while the bubble is up
            peek = self.request_peek if mono < self.request_peek_until else None
            tour = self.request_tour and mono < self.request_tour_until
            if who == "mascot":
                # the mascot owns these pulses: reading them clears them
                self.game_offer = False
                self.request_peek = None
                self.request_tour = False
            return {
                "animation": animation,
                "bubble": bubble,
                "island": island,
                "voice": None,
                "game_offer": offer,
                "cinema_mode": self.cinema_mode,
                "cinema_override": ("forced_off" if self.cinema_override is False
                                    else ("forced_on" if self.cinema_override else "auto")),
                "snooze_left": (max(0, int(self.snooze_until - time.time()))
                                if self.snoozed() else 0),
                "request_peek": peek,
                "request_tour": tour,
                "last_intervention": getattr(self, "last_intervention", None),
                "settings": {
                    "chatter_frequency": self.chatter.chatter_frequency,
                    "voice_enabled": False,
                    "reduced_motion": self.settings.reduced_motion,
                    "pet_scale": self.settings.pet_scale,
                    "start_at_login": getattr(self.settings, "start_at_login", True),
                    "doomscroll_guard": getattr(self.settings, "doomscroll_guard", False),
                    "doomscroll_threshold_min": getattr(self.settings, "doomscroll_threshold_min", 15),
                    "lang_tamil": getattr(self.settings, "lang_tamil", True),
                    "lang_kannada": getattr(self.settings, "lang_kannada", True),
                    "lang_telugu": getattr(self.settings, "lang_telugu", True),
                    "lang_malayalam": getattr(self.settings, "lang_malayalam", True),
                    "lang_hindi": getattr(self.settings, "lang_hindi", True),
                },
            }

    def restart_mascot(self) -> None:
        cmd = (
            'powershell -ExecutionPolicy Bypass -Command "'
            'Get-Process -Name Bones, electron -ErrorAction SilentlyContinue | Stop-Process -Force; '
            'Start-Sleep -Seconds 2; '
            'Start-Process -FilePath \\"D:\\New folder (4)\\mascot\\web\\node_modules\\electron\\dist\\electron.exe\\" '
            '-ArgumentList \\".\\" -WorkingDirectory \\"D:\\New folder (4)\\mascot\\web\\""'
        )
        import subprocess
        subprocess.Popen(cmd, shell=True)

    def stop_mascot(self) -> None:
        cmd = 'powershell -ExecutionPolicy Bypass -Command "Get-Process -Name Bones, electron -ErrorAction SilentlyContinue | Stop-Process -Force"'
        import subprocess
        subprocess.Popen(cmd, shell=True)

    def detect_cinema(self, is_video: bool, fullscreen: bool, exe: str, title: str) -> bool:
        """Instant cases only (real players, theatre windows)."""
        return cinema_should_hide(fullscreen=fullscreen, is_video=is_video,
                                  exe=exe, title=title)

    def _cinema(self, is_video: bool, fullscreen: bool, exe: str, title: str,
                mono: float) -> bool:
        """Should the buddy get out of the way right now?

        A browser fullscreen video hides only after BOTH signals agree for the
        whole watch: the picture is landscape (a film, not a Short) and the
        screen has been in that state for BROWSER_MOVIE_SECONDS. A Short is
        portrait and short, so it can never reach the timer, and anything
        unreadable resets the timer instead of hiding the buddy.
        """
        if self.cinema_override is not None:
            return self.cinema_override
        if self.detect_cinema(is_video, fullscreen, exe, title):
            self.browser_movie_since = None
            reset_shape_cache()
            return True
        if not (is_browser(exe, title) and is_video and fullscreen):
            self.browser_movie_since = None
            reset_shape_cache()
            return False

        shape = classify_shape(probe())
        if shape != "landscape":
            self.browser_movie_since = None
            return False
        if self.browser_movie_since is None:
            self.browser_movie_since = mono
        return (mono - self.browser_movie_since) >= BROWSER_MOVIE_SECONDS

    def toggle_cinema(self) -> bool:
        with self.lock:
            cur = self.cinema_override
            nxt = CINEMA_CYCLE[(CINEMA_CYCLE.index(cur) + 1) % len(CINEMA_CYCLE)] if cur in CINEMA_CYCLE else True
            self.cinema_override = nxt
            if nxt is None:
                # back to AUTO: re-read the world on the next tick
                self.cinema_mode = False
                self.say("cinema mode back on auto, i'll judge the screen myself.", 4.0)
            elif nxt:
                self.cinema_mode = True
                self.say("cinema mode activated,will see ya after the film ends!", 6.0, "alert")
            else:
                self.cinema_mode = False
                self.say("cinema mode off, i'm sticking around.", 4.0, "normal")
            return self.cinema_mode

    def update_settings(self, patch: dict) -> dict:
        with self.lock:
            if "reduced_motion" in patch:
                self.settings.reduced_motion = bool(patch["reduced_motion"])
            if "pet_scale" in patch:
                try:
                    v = float(patch["pet_scale"])
                except (TypeError, ValueError):
                    v = self.settings.pet_scale
                self.settings.pet_scale = min(1.0, max(0.01, v))
            if "start_at_login" in patch:
                self.settings.start_at_login = bool(patch["start_at_login"])
            if "doomscroll_guard" in patch:
                self.settings.doomscroll_guard = bool(patch["doomscroll_guard"])
            if "doomscroll_threshold_min" in patch:
                try:
                    self.settings.doomscroll_threshold_min = max(1, min(120, int(patch["doomscroll_threshold_min"])))
                except (TypeError, ValueError):
                    pass
                self.tracker.social_threshold = float(self.settings.doomscroll_threshold_min) * 60.0
            if "chatter_frequency" in patch:
                self.chatter.set_frequency(
                    str(patch["chatter_frequency"]), time.monotonic())
            for lang_key in ("lang_tamil", "lang_kannada", "lang_telugu", "lang_malayalam", "lang_hindi"):
                if lang_key in patch:
                    setattr(self.settings, lang_key, bool(patch[lang_key]))
            self.settings.voice_enabled = False
            self.settings.chatter_frequency = self.chatter.chatter_frequency
            self.settings.screen_reactions = self.screen_reactions
            self.settings.quiet_mode = self.quiet_mode
            self.settings.mascot = "hero"
            self.settings.save()
            return self.state()["settings"]

    def ack(self, action: str) -> None:
        with self.lock:
            if action == "snooze":
                self.snooze(10)
            elif action == "got_it":
                self.buddy.acknowledge()
                self.island = None
            elif action == "game_done":
                self.game_cooldown_until = time.monotonic() + GAME_COOLDOWN
            elif action == "game_silent":
                # double-declined: go quiet for a long while, no pleading
                self.game_cooldown_until = time.monotonic() + GAME_SILENT
                self.game_offer = False
            elif action == "game_request":
                self.game_offer = True  # manual start from the mascot menu
                self.game_offer_until = time.monotonic() + ACTION_TTL

    def poke(self) -> None:
        with self.lock:
            self.wake()  # a poke means "I am here": answer even mid-snooze
            self.sleep_machine.update(0, True)
            now_wall = time.time()
            self.tracker.note_activity(now_wall)
            self.chatter.mark_event(time.monotonic())
            active_langs = self.active_languages()
            if active_langs and not self.quiet_mode:
                lang = random.choice(active_langs)
                line = self.deck.pick_manual(f"{lang}_poke")
                if line:
                    self.say(line, 4.0)

    def mouse(self) -> dict:
        return mouse_buttons()

    def backdrop(self, path: str) -> dict:
        """Mean brightness behind a screen rect (subtitle auto-contrast).
        Query: /backdrop?x=&y=&w=&h=. Returns {"dark": bool}. Local pixels
        only, never stored. Fail-soft: assume dark (white Netflix text)."""
        try:
            from urllib.parse import parse_qs, urlsplit
            from PIL import ImageGrab

            q = parse_qs(urlsplit(path).query)
            num = lambda k: max(0, int(float(q.get(k, [0])[0])))
            x, y, w, h = num("x"), num("y"), num("w"), num("h")
            if w < 8 or h < 8 or w > 3000 or h > 2000:
                return {"dark": True}
            img = ImageGrab.grab(bbox=(x, y, x + w, y + h)).convert("L")
            px = list(img.getdata())
            mean = sum(px) / max(1, len(px))
            return {"dark": mean < 128}
        except Exception:  # noqa: BLE001 - contrast must never break dialogue
            return {"dark": True}

    def clickthrough(self) -> None:
        """Re-inject a left click at the cursor after a beat, so a tap on
        the (hover-captured) mascot body lands in the app below it."""

        def fire() -> None:
            time.sleep(0.08)
            try:
                click_now()
            except Exception:  # noqa: BLE001 - synthetic click is best-effort
                pass

        threading.Thread(target=fire, daemon=True).start()


BRAIN = Brain()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def _json(self, payload: dict, code: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    @staticmethod
    def _query(url: str) -> dict[str, str]:
        try:
            from urllib.parse import parse_qs, urlsplit

            return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        except Exception:
            return {}

    def do_GET(self) -> None:
        clean_path = self.path.split("?")[0]
        if clean_path in ("/hub", "/hub.html"):
            hub_path = Path(__file__).resolve().parent / "web" / "hub.html"
            if hub_path.exists():
                data = hub_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self._json({"error": "hub not found"}, 404)
            return
        if clean_path == "/state":
            self._json(BRAIN.state(who=self._query(self.path).get("who", "")))
        elif self.path == "/settings":
            self._json(BRAIN.state()["settings"])
        elif self.path == "/mouse":
            self._json(BRAIN.mouse())
        elif self.path.startswith("/backdrop"):
            self._json(BRAIN.backdrop(self.path))
        else:
            self._json({"error": "unknown"}, 404)

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", 0))
            patch = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            patch = {}
        if self.path == "/settings":
            self._json(BRAIN.update_settings(patch))
        elif self.path == "/clickthrough":
            BRAIN.clickthrough()
            self._json({"ok": True})
        elif self.path == "/ack":
            BRAIN.ack(str(patch.get("action", "")))
            self._json({"ok": True})
        elif self.path == "/poke":
            BRAIN.poke()
            self._json({"ok": True})
        elif self.path == "/action":
            act = str(patch.get("action", ""))
            if act == "restart_mascot":
                BRAIN.restart_mascot()
                self._json({"ok": True})
            elif act == "stop_mascot":
                BRAIN.stop_mascot()
                self._json({"ok": True})
            elif act == "cinema_toggle":
                cur = BRAIN.toggle_cinema()
                self._json({"ok": True, "cinema_mode": cur})
            elif act == "peek":
                edge = str(patch.get("edge", "r"))
                BRAIN.request_peek = edge
                BRAIN.request_peek_until = time.monotonic() + ACTION_TTL
                self._json({"ok": True, "edge": edge})
            elif act == "tour":
                BRAIN.request_tour = True
                BRAIN.request_tour_until = time.monotonic() + ACTION_TTL
                self._json({"ok": True})
            else:
                BRAIN.ack(act)
                self._json({"ok": True})
        elif self.path == "/event":
            evt_name = str(patch.get("name", ""))
            BRAIN.on_event(evt_name)
            self._json({"ok": True})
        elif self.path == "/exempt":
            pid = patch.get("pid")
            exempt_process_efficiency_mode(int(pid) if pid else None)
            self._json({"ok": True})
        else:
            self._json({"error": "unknown"}, 404)


def main() -> int:
    # Exempt bridge and parent (Electron) from Windows EcoQoS/Efficiency Mode
    try:
        import os
        exempt_process_efficiency_mode(os.getpid())
        if hasattr(os, "getppid"):
            exempt_process_efficiency_mode(os.getppid())
    except Exception:
        pass

    # single instance: two bridges on one port split traffic (SO_REUSEADDR)
    # and the renderer gets alternating brains = doubled lines, flipped
    # animations, phantom behavior. The lock dies with the process, so a
    # crash can never wedge a stale lock.
    try:
        import msvcrt
        import os
        import sys

        if getattr(sys, "frozen", False):
            _lock_dir = Path(os.getenv("APPDATA", str(Path.home()))) / "Bones"
            _lock_dir.mkdir(parents=True, exist_ok=True)
            _lock_path = _lock_dir / "bridge.lock"
        else:
            _lock_path = Path(__file__).resolve().parent / "bridge.lock"

        lock_fh = open(_lock_path, "w")
        msvcrt.locking(lock_fh.fileno(), msvcrt.LK_NBLCK, 1)
    except (OSError, ImportError):
        print("bridge already running: lock held, exiting")
        return 0
    server = ThreadingHTTPServer((HOST, PORT), Handler)

    def loop() -> None:
        while True:
            try:
                BRAIN.tick()
            except Exception:  # noqa: BLE001, S110 - sensing must never kill the bridge
                pass
            time.sleep(1.0)

    threading.Thread(target=loop, daemon=True).start()
    print(f"bridge on {HOST}:{PORT}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
