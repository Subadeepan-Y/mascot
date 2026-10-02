import ctypes
import sys
import time
from ctypes import wintypes
from dataclasses import dataclass


@dataclass(frozen=True)
class InputEdge:
    """One poll of raw input signals. Any True = real user activity."""
    cursor_moved: bool = False
    key_or_click: bool = False  # input tick advanced, cursor stayed: keypress/click
    window_changed: bool = False
    generation: int = 0  # monotonic counter: increments on any edge

    @property
    def any(self) -> bool:
        return self.cursor_moved or self.key_or_click or self.window_changed


@dataclass(frozen=True)
class Activity:
    category: str
    idle_seconds: float
    available: bool = True


def classify_title(title: str) -> str:
    title = title.casefold()
    groups = (
        ("coding", ("visual studio", "vscode", "pycharm", "terminal", "powershell", "opencode")),
        ("music", ("spotify", "music", "foobar")),
        ("video", ("youtube", "netflix", "vlc")),
        ("social_media", ("instagram", "tiktok", "reddit", "twitter", "x.com", "facebook", "threads", "shorts", "reels")),
        ("reading", ("acrobat", ".pdf", "kindle", "notepad", "word")),
        ("browsing", ("chrome", "firefox", "edge", "brave")),
    )
    for category, words in groups:
        if any(word in title for word in words):
            return category
    return "desktop"


def close_window(hwnd: int) -> bool:
    """Gracefully close a window via WM_CLOSE (same as clicking X). Never raises."""
    try:
        if sys.platform != "win32" or not hwnd:
            return False
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        WM_CLOSE = 0x0010
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        return True
    except OSError:
        return False


def close_foreground_window() -> bool:
    """Close the current foreground window gracefully."""
    try:
        if sys.platform != "win32":
            return False
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        hwnd = user32.GetForegroundWindow()
        if hwnd:
            return close_window(hwnd)
        return False
    except OSError:
        return False


def find_and_close_social_window() -> bool:
    """Find and close the social media or video window gracefully via WM_CLOSE."""
    try:
        if sys.platform != "win32":
            return False
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        social_words = ("instagram", "tiktok", "reddit", "twitter", "x.com", "facebook", "threads", "shorts", "reels", "youtube", "youtu.be")
        
        # Check active foreground window first
        fg = user32.GetForegroundWindow()
        if fg:
            buf = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(fg, buf, len(buf))
            title_low = buf.value.lower()
            if any(w in title_low for w in social_words):
                return close_window(fg)

        # Fallback: scan visible windows to find the social media window
        target_hwnd = None
        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def enum_cb(h, _l):
            nonlocal target_hwnd
            if user32.IsWindowVisible(h):
                buf = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(h, buf, len(buf))
                title_low = buf.value.lower()
                if any(w in title_low for w in social_words):
                    target_hwnd = h
                    return False
            return True
        user32.EnumWindows(WNDENUMPROC(enum_cb), 0)
        if target_hwnd:
            return close_window(target_hwnd)
        if fg:
            return close_window(fg)
        return False
    except Exception:
        return False


def elapsed_seconds(now: int, last: int) -> float:
    return ((now - last) & 0xFFFFFFFF) / 1000.0


def mouse_buttons() -> dict[str, bool]:
    """Live left/right button state via GetAsyncKeyState. Fail-soft False."""
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        left = bool(user32.GetAsyncKeyState(0x01) & 0x8000)
        right = bool(user32.GetAsyncKeyState(0x02) & 0x8000)
        return {"left": left, "right": right}
    except OSError:
        return {"left": False, "right": False}


def click_now() -> None:
    """Synthesize a left click at the current cursor position."""
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        pt = Point()
        if not user32.GetCursorPos(ctypes.byref(pt)):
            return
        user32.SetCursorPos(pt.x, pt.y)
        user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
        user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    except OSError:
        pass


class PowerStatus(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", ctypes.c_byte),
        ("BatteryFlag", ctypes.c_byte),
        ("BatteryLifePercent", ctypes.c_byte),
        ("SystemStatusFlag", ctypes.c_byte),
        ("BatteryLifeTime", wintypes.DWORD),
        ("BatteryFullLifeTime", wintypes.DWORD),
    ]


def battery() -> tuple[int | None, bool]:
    """Return (percent or None, charging). Windows only, never raises."""
    try:
        if sys.platform != "win32":
            return None, False
        status = PowerStatus()
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        if not kernel32.GetSystemPowerStatus(ctypes.byref(status)):
            return None, False
        percent = int(status.BatteryLifePercent)
        if percent < 0 or percent > 100:
            return None, False
        return percent, status.ACLineStatus == 1
    except OSError:
        return None, False


class LastInputInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


class Point(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


@dataclass
class InputWatcher:
    """Edge-triggered activity detection from local input signals.

    Polls Windows last-input tick + cursor position + foreground window.
    An *edge* (tick advanced, cursor moved, window changed) means a real
    human did something. Background timers and animation never touch
    these counters, so false wakeups stay rare. Never raises.
    """

    available: bool = False
    last_tick: int = 0
    last_pos: tuple[int, int] = (0, 0)
    last_window: int = 0
    last_input_time: float = 0.0
    generation: int = 0
    initialized: bool = False

    def __post_init__(self) -> None:
        if sys.platform != "win32":
            return
        try:
            self.user32 = ctypes.WinDLL("user32", use_last_error=True)  # type: ignore[attr-defined]
            self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
            self.available = True
        except OSError:
            self.available = False

    def _tick(self) -> int | None:
        try:
            info = LastInputInfo()
            info.cbSize = ctypes.sizeof(info)
            if not self.user32.GetLastInputInfo(ctypes.byref(info)):
                return None
            return int(info.dwTime)
        except OSError:
            return None

    def _cursor(self) -> tuple[int, int] | None:
        try:
            pt = Point()
            if not self.user32.GetCursorPos(ctypes.byref(pt)):
                return None
            return (int(pt.x), int(pt.y))
        except OSError:
            return None

    def _window(self) -> int:
        try:
            return int(self.user32.GetForegroundWindow() or 0)
        except OSError:
            return 0

    def poll(self, now: float | None = None) -> InputEdge:
        """Sample signals. First call only calibrates (no phantom wake)."""
        now = time.time() if now is None else now
        if not self.available:
            return InputEdge()
        tick = self._tick()
        pos = self._cursor()
        window = self._window()
        if not self.initialized:
            self.initialized = True
            if tick is not None:
                self.last_tick = tick
            if pos is not None:
                self.last_pos = pos
            self.last_window = window
            self.last_input_time = now
            return InputEdge()
        moved = pos is not None and pos != self.last_pos
        advanced = tick is not None and tick != self.last_tick
        switched = window != 0 and window != self.last_window
        if tick is not None:
            self.last_tick = tick
        if pos is not None:
            self.last_pos = pos
        if window != 0:
            self.last_window = window
        edge = InputEdge(
            cursor_moved=moved,
            key_or_click=advanced and not moved,
            window_changed=switched and not moved,
            generation=self.generation + (1 if (moved or advanced or switched) else 0),
        )
        if edge.any:
            self.generation = edge.generation
            self.last_input_time = now
        return edge


class ProcessEntry(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_ulonglong),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.CHAR * 260)]


def process_names() -> list[str]:
    """Snapshot of running exe names (lowercase). Fail-soft: [] on error."""
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        snap = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
        if snap == wintypes.HANDLE(-1).value:
            return []
        try:
            entry = ProcessEntry()
            entry.dwSize = ctypes.sizeof(entry)
            names: list[str] = []
            kernel32.Process32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
            kernel32.Process32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
            if kernel32.Process32First(snap, ctypes.byref(entry)):
                names.append(entry.szExeFile.decode(errors="ignore").lower())
                while kernel32.Process32Next(snap, ctypes.byref(entry)):
                    names.append(entry.szExeFile.decode(errors="ignore").lower())
            return names
        finally:
            kernel32.CloseHandle(snap)
    except OSError:
        return []


class PassiveSensor:
    def __init__(self) -> None:
        self.available = sys.platform == "win32"
        if not self.available:
            return
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user32.GetForegroundWindow.argtypes = []
        self.user32.GetForegroundWindow.restype = wintypes.HWND
        self.user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.user32.GetWindowTextW.restype = ctypes.c_int
        self.user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LastInputInfo)]
        self.user32.GetLastInputInfo.restype = wintypes.BOOL
        self.kernel32.GetTickCount.argtypes = []
        self.kernel32.GetTickCount.restype = wintypes.DWORD

    def sample(self) -> Activity:
        if not self.available:
            return Activity("desktop", 0, False)
        info = LastInputInfo()
        info.cbSize = ctypes.sizeof(info)
        if not self.user32.GetLastInputInfo(ctypes.byref(info)):
            return Activity("desktop", 0, False)
        buffer = ctypes.create_unicode_buffer(512)
        handle = self.user32.GetForegroundWindow()
        if handle:
            self.user32.GetWindowTextW(handle, buffer, len(buffer))
        category = classify_title(buffer.value)
        return Activity(category, elapsed_seconds(self.kernel32.GetTickCount(), info.dwTime))
