import sys
import time
import re

_saved_hwnd = 0
DEFAULT_OVERLAY_DIM_ALPHA = 200
DEFAULT_OVERLAY_DIM_COLOR_HEX = "#000000"


def configure_dpi_awareness() -> None:
    if sys.platform != "win32":
        return
    try:
        from ctypes import windll

        windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            from ctypes import windll

            windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def _user32():
    import ctypes

    return ctypes.windll.user32


def minimize_foreground(delay_ms: float = 125.0) -> None:
    global _saved_hwnd
    if sys.platform != "win32":
        return

    try:
        safe_delay = float(delay_ms)
    except Exception:
        safe_delay = 125.0
    safe_delay = max(0.0, min(2000.0, safe_delay))

    u = _user32()
    _saved_hwnd = u.GetForegroundWindow()
    if _saved_hwnd:
        u.ShowWindow(_saved_hwnd, 6)  # SW_MINIMIZE
    time.sleep(safe_delay / 1000.0)


def restore_foreground() -> None:
    if sys.platform != "win32" or not _saved_hwnd:
        return
    u = _user32()
    u.ShowWindow(_saved_hwnd, 9)  # SW_RESTORE
    u.SetForegroundWindow(_saved_hwnd)


def capture_virtual_screen():
    import mss

    with mss.mss() as sct:
        monitors = sct.monitors
        virtual = monitors[0]
        primary = monitors[1] if len(monitors) > 1 else virtual
        frame = sct.grab(virtual)

    return virtual, primary, frame


def mss_frame_to_pil(frame):
    from PIL import Image

    return Image.frombytes("RGB", frame.size, frame.rgb)


def clamp_overlay_alpha(value, default: int = DEFAULT_OVERLAY_DIM_ALPHA) -> int:
    try:
        numeric = int(round(float(value)))
    except Exception:
        numeric = default
    return max(0, min(255, numeric))


def parse_overlay_color_hex(value, default: str = DEFAULT_OVERLAY_DIM_COLOR_HEX):
    candidate = value if isinstance(value, str) else ""
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", candidate):
        candidate = default
    return (
        int(candidate[1:3], 16),
        int(candidate[3:5], 16),
        int(candidate[5:7], 16),
    )


def build_dim_overlay(
    width: int,
    height: int,
    alpha: int = DEFAULT_OVERLAY_DIM_ALPHA,
    color_hex: str = DEFAULT_OVERLAY_DIM_COLOR_HEX,
):
    from PIL import Image

    safe_alpha = clamp_overlay_alpha(alpha)
    red, green, blue = parse_overlay_color_hex(color_hex)
    return Image.new("RGBA", (width, height), (red, green, blue, safe_alpha))


configure_dpi_awareness()
