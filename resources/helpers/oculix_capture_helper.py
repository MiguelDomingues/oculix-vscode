import sys
import time

if len(sys.argv) < 2:
    print("missing output path", file=sys.stderr)
    sys.exit(2)

OUTPUT_PATH = sys.argv[1]

try:
    MINIMIZE_DELAY_MS = float(sys.argv[2]) if len(sys.argv) >= 3 else 125.0
except Exception:
    MINIMIZE_DELAY_MS = 125.0

if MINIMIZE_DELAY_MS < 0:
    MINIMIZE_DELAY_MS = 0.0
if MINIMIZE_DELAY_MS > 2000:
    MINIMIZE_DELAY_MS = 2000.0

if sys.platform == "win32":
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            windll.user32.SetProcessDPIAware()
        except Exception:
            pass

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
    time.sleep(MINIMIZE_DELAY_MS / 1000.0)


def restore_foreground():
    if sys.platform != "win32" or not saved_hwnd:
        return
    u = _user32()
    u.ShowWindow(saved_hwnd, 9)  # SW_RESTORE
    u.SetForegroundWindow(saved_hwnd)


minimize_foreground()

import tkinter as tk
import mss
import mss.tools

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

start_x = start_y = end_x = end_y = 0
selecting = False
rect_id = None

root = tk.Tk()
root.overrideredirect(True)
root.geometry(f"{V_WIDTH}x{V_HEIGHT}+{V_LEFT}+{V_TOP}")
root.attributes("-alpha", 0.25)
root.attributes("-topmost", True)
root.configure(bg="black")

canvas = tk.Canvas(root, cursor="crosshair", bg="black", highlightthickness=0)
canvas.pack(fill=tk.BOTH, expand=True)

label = tk.Label(
    root,
    text="Drag to select region  |  ESC to cancel",
    bg="#222",
    fg="white",
    font=("Helvetica", 14),
)
label.place(x=P_LEFT + P_WIDTH // 2, y=P_TOP + 24, anchor="n")


def on_press(e):
    global start_x, start_y, selecting, rect_id
    start_x, start_y = e.x, e.y
    selecting = True
    if rect_id:
        canvas.delete(rect_id)
    rect_id = canvas.create_rectangle(
        start_x, start_y, start_x, start_y, outline="#00ff00", width=2
    )


def on_drag(e):
    global rect_id
    if selecting and rect_id:
        canvas.coords(rect_id, start_x, start_y, e.x, e.y)


def on_release(e):
    global end_x, end_y
    end_x, end_y = e.x, e.y
    root.quit()


def on_escape(e):
    global start_x, start_y, end_x, end_y
    start_x = start_y = end_x = end_y = 0
    root.quit()


canvas.bind("<ButtonPress-1>", on_press)
canvas.bind("<B1-Motion>", on_drag)
canvas.bind("<ButtonRelease-1>", on_release)
root.bind("<Escape>", on_escape)

root.focus_force()
root.mainloop()
root.destroy()

if end_x == 0 and end_y == 0:
    restore_foreground()
    print("cancelled")
    sys.exit(1)

x1, x2 = sorted([start_x, end_x])
y1, y2 = sorted([start_y, end_y])

if x2 - x1 < 5 or y2 - y1 < 5:
    restore_foreground()
    print("selection too small")
    sys.exit(1)

abs_left = V_LEFT + x1
abs_top = V_TOP + y1
width = x2 - x1
height = y2 - y1

with mss.mss() as sct:
    region = {"top": abs_top, "left": abs_left, "width": width, "height": height}
    sct_img = sct.grab(region)
    mss.tools.to_png(sct_img.rgb, sct_img.size, output=OUTPUT_PATH)

restore_foreground()
print("ok")
