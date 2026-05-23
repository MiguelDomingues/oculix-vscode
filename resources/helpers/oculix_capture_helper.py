import sys
import os

HELPER_DIR = os.path.dirname(os.path.abspath(__file__))
if HELPER_DIR not in sys.path:
    sys.path.insert(0, HELPER_DIR)

from oculix_screen_runtime import (
    build_dim_overlay,
    capture_virtual_screen,
    clamp_overlay_alpha,
    minimize_foreground,
    mss_frame_to_pil,
    restore_foreground,
)

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

OVERLAY_DIM_ALPHA = clamp_overlay_alpha(sys.argv[3]) if len(sys.argv) >= 4 else 150
OVERLAY_DIM_COLOR = sys.argv[4] if len(sys.argv) >= 5 else "#FFFFFF"

minimize_foreground(MINIMIZE_DELAY_MS)

import tkinter as tk
from PIL import Image, ImageTk

virtual, primary, frozen_img = capture_virtual_screen()

V_LEFT = virtual["left"]
V_TOP = virtual["top"]
V_WIDTH = virtual["width"]
V_HEIGHT = virtual["height"]

P_LEFT = primary["left"] - V_LEFT
P_TOP = primary["top"] - V_TOP
P_WIDTH = primary["width"]

start_x = start_y = end_x = end_y = 0
selecting = False
rect_id = None

root = tk.Tk()
root.overrideredirect(True)
root.geometry(f"{V_WIDTH}x{V_HEIGHT}+{V_LEFT}+{V_TOP}")
root.attributes("-topmost", True)
root.configure(bg="black")

canvas = tk.Canvas(root, cursor="crosshair", bg="black", highlightthickness=0)
canvas.pack(fill=tk.BOTH, expand=True)

# Freeze the screen first, then let the user select on the static frame.
frozen_pil = mss_frame_to_pil(frozen_img)
frozen_rgba = frozen_pil.convert("RGBA")
dim_overlay_rgba = build_dim_overlay(V_WIDTH, V_HEIGHT, OVERLAY_DIM_ALPHA, OVERLAY_DIM_COLOR)
preview_tk = None


def update_preview_with_hole(x1=None, y1=None, x2=None, y2=None):
    global preview_tk
    preview = Image.alpha_composite(frozen_rgba, dim_overlay_rgba)

    if x1 is not None and y1 is not None and x2 is not None and y2 is not None:
        sx1, sx2 = sorted([x1, x2])
        sy1, sy2 = sorted([y1, y2])
        sx1 = max(0, min(V_WIDTH, sx1))
        sx2 = max(0, min(V_WIDTH, sx2))
        sy1 = max(0, min(V_HEIGHT, sy1))
        sy2 = max(0, min(V_HEIGHT, sy2))

        if sx2 > sx1 and sy2 > sy1:
            clear_region = frozen_rgba.crop((sx1, sy1, sx2, sy2))
            preview.paste(clear_region, (sx1, sy1))

    preview_tk = ImageTk.PhotoImage(preview.convert("RGB"))
    bg = canvas.find_withtag("bg")
    if bg:
        canvas.itemconfigure(bg[0], image=preview_tk)
    else:
        canvas.create_image(0, 0, image=preview_tk, anchor="nw", tags="bg")


update_preview_with_hole()

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
    update_preview_with_hole(start_x, start_y, start_x, start_y)
    if rect_id:
        canvas.delete(rect_id)
    rect_id = canvas.create_rectangle(
        start_x, start_y, start_x, start_y, outline="#00ff00", width=2
    )


def on_drag(e):
    global rect_id
    if selecting and rect_id:
        update_preview_with_hole(start_x, start_y, e.x, e.y)
        canvas.coords(rect_id, start_x, start_y, e.x, e.y)
        canvas.tag_raise(rect_id)


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

# Crop from the frozen full-screen frame for deterministic captures.
region = (x1, y1, x2, y2)
frozen_pil.crop(region).save(OUTPUT_PATH, format="PNG")

restore_foreground()
print("ok")
