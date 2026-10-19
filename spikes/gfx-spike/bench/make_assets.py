#!/usr/bin/env python3
"""Generate the CPU-bench inputs in assets/: a 30 s 1080p25 h264 source, a 620x68
scorebug PNG (bbox), the same on a full 1920x1080 transparent canvas, 25-frame
changing sequences of both (animated case), and a logo for the per-rung watermark."""
import os, subprocess
from PIL import Image, ImageDraw, ImageFont
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
os.makedirs(os.path.join(A, "anim"), exist_ok=True)
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25:duration=30",
                "-f", "lavfi", "-i", "sine=f=440:duration=30:sample_rate=48000", "-c:v", "libx264", "-preset", "veryfast",
                "-b:v", "8M", "-g", "50", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", os.path.join(A, "src1080.mp4")], check=True)
f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
def bug(i, path, full=False):
    im = Image.new("RGBA", (620, 68), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, 619, 67), 10, fill=(10, 20, 60, 220))
    d.text((20, 12), f"HOME {i%10}  -  AWAY {i//3%10}   {i:02d}'", font=f, fill=(255, 255, 255, 255))
    if full:
        c = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0)); c.paste(im, (80, 60)); im = c
    im.save(path)
bug(0, os.path.join(A, "bug.png")); bug(0, os.path.join(A, "bug_full.png"), True)
for i in range(25):
    bug(i, os.path.join(A, "anim", f"a{i:03d}.png")); bug(i, os.path.join(A, "anim", f"f{i:03d}.png"), True)
Image.new("RGBA", (240, 80), (255, 255, 255, 200)).save(os.path.join(A, "logo.png"))
print("assets ready")
