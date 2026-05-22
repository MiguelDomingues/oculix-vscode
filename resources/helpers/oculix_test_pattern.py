import sys
import time

if sys.platform == "win32":
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            windll.user32.SetProcessDPIAware()
        except Exception:
            pass

import tkinter as tk
import mss
import cv2
import numpy as np

if len(sys.argv) < 3:
    print("error: missing args", file=sys.stderr)
    sys.exit(2)

PATTERN_PATH = sys.argv[1]
INITIAL_SIM = float(sys.argv[2])

saved_hwnd = 0


def _user32():
    import ctypes
    return ctypes.windll.user32


def minimize_foreground():
    global saved_hwnd
    if sys.platform != "win32":
        return
    u = _user32()
    saved_hwnd = u.GetForegroundWindow()
    if saved_hwnd:
        u.ShowWindow(saved_hwnd, 6)  # SW_MINIMIZE
        time.sleep(0.25)


def restore_foreground():
    if sys.platform != "win32" or not saved_hwnd:
        return
    u = _user32()
    u.ShowWindow(saved_hwnd, 9)  # SW_RESTORE
    u.SetForegroundWindow(saved_hwnd)


minimize_foreground()

with mss.mss() as sct:
    monitors = sct.monitors
    virtual = monitors[0]
    V_LEFT = virtual["left"]
    V_TOP = virtual["top"]
    V_WIDTH = virtual["width"]
    V_HEIGHT = virtual["height"]
    primary = monitors[1] if len(monitors) > 1 else virtual
    P_LEFT = primary["left"] - V_LEFT
    P_TOP = primary["top"] - V_TOP
    P_WIDTH = primary["width"]
    sct_img = sct.grab(virtual)

screen = np.array(sct_img)
screen_bgr = cv2.cvtColor(screen, cv2.COLOR_BGRA2BGR)

pattern = cv2.imread(PATTERN_PATH, cv2.IMREAD_COLOR)
if pattern is None:
    print("error: could not load pattern", file=sys.stderr)
    sys.exit(2)

PH, PW = pattern.shape[:2]
if PH > V_HEIGHT or PW > V_WIDTH:
    print("error: pattern is larger than the virtual screen", file=sys.stderr)
    sys.exit(2)

result = cv2.matchTemplate(screen_bgr, pattern, cv2.TM_CCOEFF_NORMED)
RH, RW = result.shape

print("ready", flush=True)


def find_matches(threshold, max_matches=50):
    work = result.copy()
    matches = []
    while len(matches) < max_matches:
        _, max_val, _, max_loc = cv2.minMaxLoc(work)
        if max_val < threshold:
            break
        x, y = max_loc
        matches.append((x, y, float(max_val)))
        y1 = max(0, y - PH // 2)
        y2 = min(RH, y + PH // 2)
        x1 = max(0, x - PW // 2)
        x2 = min(RW, x + PW // 2)
        work[y1:y2, x1:x2] = -1
    return matches


current_threshold = INITIAL_SIM
applied = False

root = tk.Tk()
root.overrideredirect(True)
root.geometry(f"{V_WIDTH}x{V_HEIGHT}+{V_LEFT}+{V_TOP}")
root.attributes("-topmost", True)
root.attributes("-alpha", 0.35)
root.attributes("-fullscreen", False)
root.configure(bg="black")

canvas = tk.Canvas(root, bg="black", highlightthickness=0)
canvas.pack(fill=tk.BOTH, expand=True)

status = tk.Label(
    root, text="", bg="#222", fg="white", font=("Helvetica", 13), padx=14, pady=5
)
status.place(x=P_LEFT + P_WIDTH // 2, y=P_TOP + 24, anchor="n")


def redraw():
    canvas.delete("match")
    matches = find_matches(current_threshold)
    for x, y, score in matches:
        canvas.create_rectangle(
            x, y, x + PW, y + PH, outline="#ffcc00", width=3, tags="match"
        )
        pct = f"{int(round(score * 100))}%"
        text_id = canvas.create_text(
            x + PW - 6,
            y + 6,
            anchor="ne",
            text=pct,
            fill="#ffffff",
            font=("Helvetica", 11, "bold"),
            tags="match",
        )
        bbox = canvas.bbox(text_id)
        if bbox:
            bg_id = canvas.create_rectangle(
                bbox[0] - 5,
                bbox[1] - 2,
                bbox[2] + 5,
                bbox[3] + 2,
                fill="#000000",
                outline="",
                tags="match",
            )
            canvas.tag_raise(text_id, bg_id)

    n = len(matches)
    plural = "matches" if n != 1 else "match"
    status.config(
        text=(
            f"similar: {int(round(current_threshold * 100))}%  |  {n} {plural}  |  "
            "Scroll: adjust  .  Shift: fine  .  Enter: apply  .  ESC: cancel"
        )
    )


def step_threshold(direction, fine=False):
    global current_threshold
    step = 0.01 if fine else 0.05
    new_val = max(0.0, min(1.0, current_threshold + direction * step))
    current_threshold = round(new_val * 100) / 100
    redraw()


def on_wheel(e):
    direction = 1 if e.delta > 0 else -1
    step_threshold(direction, fine=bool(e.state & 0x1))


def on_wheel_up(e):
    step_threshold(1)


def on_wheel_down(e):
    step_threshold(-1)


def on_escape(e):
    root.quit()


def on_enter(e):
    global applied
    applied = True
    root.quit()


root.bind("<Escape>", on_escape)
root.bind("<Return>", on_enter)
root.bind("<KP_Enter>", on_enter)
root.bind("<MouseWheel>", on_wheel)
root.bind("<Button-4>", on_wheel_up)
root.bind("<Button-5>", on_wheel_down)
canvas.bind("<Escape>", on_escape)
canvas.bind("<Return>", on_enter)
canvas.bind("<KP_Enter>", on_enter)
canvas.bind("<MouseWheel>", on_wheel)
canvas.bind("<Button-4>", on_wheel_up)
canvas.bind("<Button-5>", on_wheel_down)
root.bind_all("<Escape>", on_escape)
root.bind_all("<Return>", on_enter)
root.bind_all("<KP_Enter>", on_enter)

redraw()


def force_overlay_focus():
    try:
        root.deiconify()
        root.state("normal")
        root.lift()
        root.attributes("-topmost", True)
        canvas.focus_set()
        canvas.focus_force()
        root.focus_force()
        root.focus_set()
        root.grab_set()
    except Exception:
        pass

    if sys.platform == "win32":
        try:
            import ctypes

            user32 = ctypes.windll.user32
            hwnd = user32.GetAncestor(root.winfo_id(), 2)
            user32.ShowWindow(hwnd, 1)
            user32.BringWindowToTop(hwnd)
            user32.SetActiveWindow(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.SetFocus(hwnd)
        except Exception:
            pass


root.update_idletasks()
force_overlay_focus()
root.after(40, force_overlay_focus)
root.after(120, force_overlay_focus)
root.after(280, force_overlay_focus)
root.mainloop()
root.destroy()
restore_foreground()

if applied:
    print(f"apply {current_threshold}")
else:
    print("cancel")
