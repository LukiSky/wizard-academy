#!/usr/bin/env python3
"""Turn the raw project assets into the handful of files the browser loads.

    python3 build_assets.py            # everything
    python3 build_assets.py --sprites  # just the wizard
    python3 build_assets.py --signs    # just the handshape tiles

Three conversions, each here for a reason the browser forced:

*The wizard is 19 folders of 240 PNGs, and a browser will not fetch 4,560 files.*
Each folder becomes one VP9/WebM clip with a real alpha channel, which `<video>`
plays transparently over the scene. 8 MB for the whole cast, against 1.6 GB of
PNGs.

*Every clip is cropped to the same rectangle.* Cropping each one to its own
content would centre a different part of the character in each file, so the
wizard would jump half a body width every time the animation changed. The crop
is the union of all 19 bounding boxes, measured once and pinned in CROP below,
so the character stays welded to one spot across every switch.

*The alphabet charts are one big PNG each, and the game needs one letter at a
time.* Both charts are drawn on a fixed grid by the scripts in
`sign-language-demo`, so a tile is arithmetic rather than image recognition -
the constants below are copied from `make_handshapes.py` and
`make_auslan_chart.py`. The paper colour is keyed out on the way through, since
a hint card sits on a dark night sky.
"""
import argparse
import json
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FRAMES = ROOT / "video"
DEMO = ROOT / "sign-language-demo"
OUT = HERE / "web" / "assets"

# The union of all 19 alpha bounding boxes, nudged to even numbers because
# yuva420p subsamples chroma 2x2 and will not take an odd size.
CROP = (892, 704, 128, 0)          # w, h, x, y  within the 1280x720 source
SCALE = 0.75                       # 669x528 on disk; the game draws it smaller
FPS = 24

# Chart geometry, copied from the two scripts that draw the charts.
ASL = dict(path=DEMO / "asl_handshapes.png", cell=(208, 228), cols=7, pad=30,
           header=86, letters="ABCDEFGHIJKLMNOPQRSTUVWXYZ")
AUSLAN = dict(path=DEMO / "auslan_chart.png", cell=(214, 236), cols=7, pad=30,
              header=104, letters="ABCDEFGHIKLMNOPQRSTUVWXYZ0123456789")

# Each folder of frames is one thing the wizard can do. The name on the left is
# what the game asks for; the folder on the right is what plays. Loops are the
# poses he can hold; the rest run once and hand back to a loop.
ACTIONS = {
    # --- holds ---------------------------------------------------------
    "idle":        ("Player_walking_in_place",              True),
    "thinking":    ("Character_thinking_gesture",           True),
    "listening":   ("Character_performing_silent_talk",     True),
    "ready":       ("Player_preparing_combat_stance",       True),
    # --- one-shots -----------------------------------------------------
    "hello":       ("Player_waving_hello",                  False),
    "magic":       ("Player_charging_unstable_wand_en",     False),
    "teach":       ("Character_making_silent_talking",      False),
    "call_back":   ("Character_performs_telepathy_ges",     False),
    "correct":     ("Character_performing_surprise_ge",     False),
    "correct_alt": ("Player_performing_surprise_gesture",   False),
    "try_again":   ("Character_gesturing_to_try_again",     False),
    "try_again_alt": ("Character_gesturing_try_again",      False),
    "one_hand":    ("Character_performs_angry_gesture",     False),
    "groan":       ("Character_performing_disgust_ges",     False),
    "fading":      ("Character_performs_sad_gesture",       False),
    "worried":     ("Character_performing_fear_gesture",    False),
    "charge":      ("Player_preparing_for_fight",           False),
    "celebrate":   ("Player_performing_cheer_gesture",      False),
    "laugh":       ("Character_laughing_in_scene",          False),
}


def window(src, seconds=3.4):
    """The stretch of a clip worth playing as a single beat.

    Every clip is ten seconds and the character moves for nearly all of it, so
    playing one end to end would freeze the game for ten seconds to say "not
    quite". But the clips are not ten seconds of *one* gesture either - they
    open and close on the same neutral pose, with the gesture peaking somewhere
    in the middle, and cutting a fixed three seconds off the front catches the
    wind-up and misses the point of half of them.

    So each clip is measured against its own first frame - a slow reach barely
    moves frame to frame but ends far from rest, which is why the reference is
    frame 1 rather than the previous frame - and the window is placed to contain
    the furthest-from-rest moment with a little run-up.
    """
    import numpy as np
    from PIL import Image

    frames = sorted(src.glob("frame_*.png"))[::2]
    def small(p):
        a = np.asarray(Image.open(p).convert("RGBA").resize((160, 90),
                                                            Image.BILINEAR), np.float32)
        return a[..., :3] * (a[..., 3:] / 255.0)      # the empty area is not motion
    ref = small(frames[0])
    diff = np.array([np.abs(small(p) - ref).mean() for p in frames])
    if diff.max() <= 0:
        return 0.0, seconds
    onset = int(np.argmax(diff > diff.max() * 0.18)) * 2 / FPS
    peak = int(np.argmax(diff)) * 2 / FPS
    end = len(frames) * 2 / FPS
    start = min(max(peak - seconds * 0.45, onset), max(end - seconds, 0.0))
    return round(start, 2), round(min(start + seconds, end), 2)


def encode(job):
    name, folder = job
    src = FRAMES / folder
    dst = OUT / "wizard" / f"{name}.webm"
    if not src.is_dir():
        return name, None, f"no folder {folder}"
    w, h, x, y = CROP
    sw, sh = int(w * SCALE) // 2 * 2, int(h * SCALE) // 2 * 2
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-framerate", str(FPS), "-i", str(src / "frame_%04d.png"),
        "-vf", f"crop={w}:{h}:{x}:{y},scale={sw}:{sh}:flags=lanczos",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        "-crf", "34", "-b:v", "0", "-row-mt", "1", "-cpu-used", "2",
        "-auto-alt-ref", "0",          # alt-ref frames drop the alpha plane
        "-an", str(dst),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return name, None, r.stderr.strip().splitlines()[-1:] or ["ffmpeg failed"]
    n = len(list(src.glob("frame_*.png")))
    meta = dict(file=f"wizard/{name}.webm", frames=n, seconds=round(n / FPS, 2),
                source=folder, bytes=dst.stat().st_size)
    if not ACTIONS[name][1]:                       # a hold plays whole and loops
        meta["in"], meta["out"] = window(src)
    return name, meta, None


def build_sprites():
    (OUT / "wizard").mkdir(parents=True, exist_ok=True)
    jobs = [(name, folder) for name, (folder, _) in ACTIONS.items()]
    manifest, total = {}, 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        for name, meta, err in pool.map(encode, jobs):
            if err:
                print(f"  {name:14s} SKIPPED  {err}")
                continue
            meta["loop"] = ACTIONS[name][1]
            manifest[name] = meta
            total += meta["bytes"]
            beat = ("loops whole" if meta["loop"]
                    else f"plays {meta['in']:4.1f}-{meta['out']:4.1f}s")
            print(f"  {name:14s} {meta['bytes']/1024:6.0f} KB  {beat}"
                  f"   <- {meta['source']}")
    print(f"  {'':14s} {'':5s}  {total/2**20:6.1f} MB total")

    # One still of the idle pose, so the scene is never an empty rectangle
    # while the first clip is still arriving over the wire.
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-c:v", "libvpx-vp9",
                    "-i", str(OUT / "wizard" / "idle.webm"),
                    "-vframes", "1", "-pix_fmt", "rgba",
                    str(OUT / "wizard" / "poster.png")], check=False)
    return manifest


def key_paper(tile):
    """Remove the chart's paper, and only the paper.

    Keying on whiteness alone takes the joints with it. Every knuckle in these
    charts is a white disc with a coloured ring, and a plain colour key punches
    all of them through - which is invisible on the white chart and, on the
    game's night sky, turns every joint into a black hole.

    So whiteness only counts as background if it can be reached from the edge of
    the tile. The coloured ring seals each joint off from the outside, exactly
    as the ink outline seals the wizard's eyes in `extract_frames.py`, and the
    palm patch is too grey to be caught at all.
    """
    from PIL import Image, ImageDraw

    px = tile.convert("RGB").load()
    w, h = tile.size
    m = Image.new("L", (w, h))
    mp = m.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            mp[x, y] = min(r, g, b)

    # A tile can be cropped a pixel inside the cell border, which would wall the
    # flood off from the paper. One row of guaranteed paper around the edge
    # gives it somewhere to start.
    d = ImageDraw.Draw(m)
    d.rectangle([0, 0, w - 1, h - 1], outline=255)
    ImageDraw.floodfill(m, (0, 0), 0, thresh=23)        # 255 - 23 = 232
    bg = m.load()

    out = tile.convert("RGBA")
    op = out.load()
    for y in range(h):
        for x in range(w):
            if bg[x, y] != 0:
                continue                               # sealed in: leave it alone
            r, g, b, _ = op[x, y]
            v = min(r, g, b)
            if v >= 248:
                op[x, y] = (r, g, b, 0)
            else:                                      # its antialiased edge
                op[x, y] = (r, g, b, int((248 - v) / 16 * 255))
    return out


def build_signs(spec, folder, title):
    """Slice one chart into per-letter PNGs with the paper keyed out."""
    from PIL import Image

    src = spec["path"]
    if not src.exists():
        print(f"  {title}: no {src.name}, skipped")
        return {}

    out = OUT / "signs" / folder
    out.mkdir(parents=True, exist_ok=True)
    chart = Image.open(src).convert("RGB")
    cw, ch = spec["cell"]
    made = {}
    for n, letter in enumerate(spec["letters"]):
        cx = spec["pad"] + (n % spec["cols"]) * cw
        cy = spec["pad"] + spec["header"] + (n // spec["cols"]) * ch
        # Inside the cell border and below the printed letter: the game draws
        # its own label, and a second one baked into the tile reads as a typo.
        tile = chart.crop((cx + 3, cy + 36, cx + cw - 9, cy + ch - 9))
        key_paper(tile).save(out / f"{letter}.png")
        made[letter] = f"signs/{folder}/{letter}.png"
    print(f"  {title:8s} {len(made):2d} tiles  ({''.join(made)})")
    return made


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sprites", action="store_true")
    ap.add_argument("--signs", action="store_true")
    a = ap.parse_args()
    everything = not (a.sprites or a.signs)

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is not installed, and the sprites are video")

    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    if everything or a.sprites:
        print("wizard sprites:")
        manifest["actions"] = build_sprites()
    if everything or a.signs:
        print("handshape tiles:")
        manifest["signs"] = {
            "asl": build_signs(ASL, "asl", "ASL"),
            "auslan": build_signs(AUSLAN, "auslan", "Auslan"),
        }

    manifest["crop"] = dict(zip(("w", "h", "x", "y"), CROP))
    manifest["fps"] = FPS
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"\nwrote {manifest_path.relative_to(HERE)}")


if __name__ == "__main__":
    main()
