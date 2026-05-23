import sys
import time
from typing import Any, cast

import tkinter as tk
from PIL import Image, ImageTk
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
    minimize_delay_ms = float(sys.argv[2]) if len(sys.argv) >= 3 else 125.0
except Exception:
    minimize_delay_ms = 125.0

try:
    capture_delay_seconds = int(round(float(sys.argv[3]))) if len(sys.argv) >= 4 else 3
except Exception:
    capture_delay_seconds = 3

if minimize_delay_ms < 0:
    minimize_delay_ms = 0.0
if minimize_delay_ms > 2000:
    minimize_delay_ms = 2000.0

if capture_delay_seconds < 0:
    capture_delay_seconds = 0
if capture_delay_seconds > 30:
    capture_delay_seconds = 30

OVERLAY_DIM_ALPHA = clamp_overlay_alpha(sys.argv[4]) if len(sys.argv) >= 5 else 150
OVERLAY_DIM_COLOR = sys.argv[5] if len(sys.argv) >= 6 else "#FFFFFF"


def show_countdown(seconds: int, primary: dict[str, int]) -> None:
    if seconds <= 0:
        return

    countdown_root = tk.Tk()
    countdown_root.overrideredirect(True)
    cast(Any, countdown_root).attributes("-topmost", True)
    countdown_root.configure(bg="#222")

    label = tk.Label(
        countdown_root,
        text="",
        bg="#222",
        fg="white",
        font=("Helvetica", 18),
        padx=7,
        pady=3,
    )
    label.pack()

    p_left = int(primary["left"])
    p_top = int(primary["top"])
    p_width = int(primary["width"])

    min_text = f"Capture starts in {seconds}s..."
    label.configure(text=min_text)
    countdown_root.update_idletasks()
    min_width = countdown_root.winfo_width() + 10
    min_height = countdown_root.winfo_height()

    def place(width: int, height: int) -> None:
        pos_x = p_left + max(0, (p_width - width) // 2)
        pos_y = p_top + 24
        countdown_root.geometry(f"{width}x{height}+{pos_x}+{pos_y}")

    place(min_width, min_height)

    for remaining in range(seconds, 0, -1):
        label.configure(text=f"Capture starts in {remaining}s...")
        countdown_root.update()
        time.sleep(1)

    countdown_root.destroy()

minimize_foreground(minimize_delay_ms)

virtual, primary, _ = capture_virtual_screen()
show_countdown(capture_delay_seconds, primary)

virtual, primary, frozen_img = capture_virtual_screen()

V_LEFT: int = int(virtual["left"])
V_TOP: int = int(virtual["top"])
V_WIDTH: int = int(virtual["width"])
V_HEIGHT: int = int(virtual["height"])

P_LEFT: int = int(primary["left"]) - V_LEFT
P_TOP: int = int(primary["top"]) - V_TOP
P_WIDTH: int = int(primary["width"])

start_x = start_y = end_x = end_y = 0
selecting = False
rect_id: int | None = None

root = tk.Tk()
root.overrideredirect(True)
root.geometry(f"{V_WIDTH}x{V_HEIGHT}+{V_LEFT}+{V_TOP}")
cast(Any, root).attributes("-topmost", True)
root.configure(bg="black")

canvas = tk.Canvas(root, cursor="crosshair", bg="black", highlightthickness=0)
canvas.pack(fill=tk.BOTH, expand=True)

# Freeze the screen first, then let the user select on the static frame.
frozen_pil = mss_frame_to_pil(frozen_img)
frozen_rgba = frozen_pil.convert("RGBA")
dim_overlay_rgba = build_dim_overlay(V_WIDTH, V_HEIGHT, OVERLAY_DIM_ALPHA, OVERLAY_DIM_COLOR)
preview_tk: ImageTk.PhotoImage | None = None


def update_preview_with_hole(
    x1: int | None = None,
    y1: int | None = None,
    x2: int | None = None,
    y2: int | None = None,
) -> None:
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
        cast(Any, canvas).create_image(0, 0, image=preview_tk, anchor="nw", tags="bg")


update_preview_with_hole()

label = tk.Label(
    root,
    text="Drag to select region  |  ESC to cancel",
    bg="#222",
    fg="white",
    font=("Helvetica", 14),
)
label.place(x=P_LEFT + P_WIDTH // 2, y=P_TOP + 24, anchor="n")


def on_press(e: Any) -> None:
    global start_x, start_y, selecting, rect_id
    start_x, start_y = e.x, e.y
    selecting = True
    update_preview_with_hole(start_x, start_y, start_x, start_y)
    if rect_id:
        canvas.delete(rect_id)
    rect_id = canvas.create_rectangle(
        start_x, start_y, start_x, start_y, outline="#00ff00", width=2
    )


def on_drag(e: Any) -> None:
    global rect_id
    if selecting and rect_id:
        update_preview_with_hole(start_x, start_y, e.x, e.y)
        canvas.coords(rect_id, start_x, start_y, e.x, e.y)
        canvas.tag_raise(rect_id)


def on_release(e: Any) -> None:
    global end_x, end_y
    end_x, end_y = e.x, e.y
    root.quit()


def on_escape(e: Any) -> None:
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
