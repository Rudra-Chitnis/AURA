"""
AURA Icon Generator
Generates icon.ico and tray-icon.ico in desktop/assets/.
Uses Python stdlib only — no Pillow or other dependencies required.

Run once from the project root:
    python generate-icon.py
"""

import math
import os
import struct


# ── Pixel painter ────────────────────────────────────────────────────────────

def _paint_pixel(x, y, size):
    """
    Return (B, G, R, A) for a pixel at (x, y) in a size×size image.
    Draws a dark glass sphere with a vivid blue ring and subtle inner glow.
    """
    cx = cy = (size - 1) / 2.0
    outer_r  = size / 2.0 - 1.0     # outer edge of sphere
    ring_w   = max(1.5, size * 0.08) # blue ring width (proportional)
    ring_out = outer_r
    ring_in  = outer_r - ring_w
    core_r   = ring_in - max(1.0, size * 0.04)   # dark core radius

    dx   = x - cx
    dy   = y - cy
    dist = math.sqrt(dx * dx + dy * dy)

    if dist > outer_r + 0.5:
        # Outside sphere — fully transparent
        return (0, 0, 0, 0)

    # Anti-alias at the outer edge
    alpha_edge = max(0.0, min(1.0, (outer_r + 0.5 - dist)))

    if dist >= ring_in:
        # ── Blue ring ──────────────────────────────────────────────────
        t = max(0.0, min(1.0, (ring_out - dist) / ring_w))   # 1 at inner edge, 0 at outer
        # Slight brightness variation: top-left lighter (simulates lighting)
        angle  = math.atan2(dy, dx)   # -π..π
        light  = 0.7 + 0.3 * max(0.0, math.cos(angle + math.pi * 0.75))
        b = int(min(255, 255 * light * t))
        g = int(min(255, 158 * light * t))
        r = int(min(255, 74  * light * t))
        a = int(220 * t * alpha_edge)
        return (b, g, r, a)

    if dist <= core_r:
        # ── Dark core with subtle blue ambient glow ────────────────────
        t_glow = 1.0 - dist / core_r   # 1 at center, 0 at edge
        b = int(20 + 28 * t_glow)
        g = int(14 + 16 * t_glow)
        r = int(10 + 10 * t_glow)
        return (b, g, r, 255)

    # ── Gradient transition: core → ring ──────────────────────────────
    span = ring_in - core_r
    t    = (dist - core_r) / span   # 0 at core edge, 1 at ring inner edge
    # Interpolate dark core → blue ring colour
    b = int(20 * (1 - t) + 255 * t)
    g = int(14 * (1 - t) + 158 * t)
    r = int(10 * (1 - t) + 74  * t)
    return (b, g, r, int(255 * alpha_edge))


# ── BMP / ICO assembly ───────────────────────────────────────────────────────

def _make_image_data(size):
    """Build the complete ICO image blob for one size (DIB header + XOR + AND)."""

    # XOR mask: BGRA pixels, bottom-to-top row order (BMP convention)
    xor_pixels = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            xor_pixels.extend(_paint_pixel(x, y, size))

    # AND mask: 1 bit per pixel, rows padded to 4-byte boundary
    # 0 = opaque (show XOR pixel), 1 = transparent
    and_stride = ((size + 31) // 32) * 4
    and_mask   = bytearray()
    for y in range(size - 1, -1, -1):
        row_bits = 0
        for x in range(size):
            b, g, r, a = _paint_pixel(x, y, size)
            bit = 0 if a > 10 else 1   # transparent if nearly fully clear
            row_bits = (row_bits << 1) | bit
        # Pad to and_stride bytes (MSB first, big-endian within each 4-byte group)
        raw = row_bits << (and_stride * 8 - size)
        and_mask.extend(raw.to_bytes(and_stride, "big"))

    # BITMAPINFOHEADER (40 bytes)
    dib = struct.pack(
        "<IiiHHIIiiII",
        40,                    # biSize
        size,                  # biWidth
        size * 2,              # biHeight (×2 = XOR + AND masks)
        1,                     # biPlanes
        32,                    # biBitCount
        0,                     # biCompression (BI_RGB)
        len(xor_pixels),       # biSizeImage
        0, 0,                  # biXPelsPerMeter, biYPelsPerMeter
        0, 0,                  # biClrUsed, biClrImportant
    )

    return dib + bytes(xor_pixels) + bytes(and_mask)


def create_ico(path, sizes):
    """Write a multi-size .ico file to `path`."""
    images = [(s, _make_image_data(s)) for s in sizes]

    # ICO file header (6 bytes)
    ico_header = struct.pack("<HHH", 0, 1, len(images))

    # Directory entries (16 bytes each) + image blobs follow
    # First image data starts after: 6 (header) + 16 * n (dir entries)
    offset = 6 + 16 * len(images)
    dir_entries = b""
    for size, img_data in images:
        w = h = 0 if size == 256 else size   # 0 encodes 256 in ICO format
        dir_entries += struct.pack(
            "<BBBBHHII",
            w, h,             # width, height
            0,                # colour count (0 = 256+)
            0,                # reserved
            1,                # colour planes
            32,               # bits per pixel
            len(img_data),    # size of image data
            offset,           # offset to image data
        )
        offset += len(img_data)

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(ico_header)
        f.write(dir_entries)
        for _, img_data in images:
            f.write(img_data)

    print(f"  [OK] {path}  ({', '.join(str(s) for s in sizes)} px)")


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    root       = os.path.dirname(os.path.abspath(__file__))
    assets_dir = os.path.join(root, "desktop", "assets")

    print("AURA Icon Generator")
    print("===================")

    # Full icon — all sizes for Windows and electron-builder
    create_ico(
        os.path.join(assets_dir, "icon.ico"),
        sizes=[16, 24, 32, 48, 64, 128, 256],
    )

    # Tray icon — smaller sizes only (Windows system tray uses 16/24/32)
    create_ico(
        os.path.join(assets_dir, "tray-icon.ico"),
        sizes=[16, 24, 32],
    )

    print()
    print(f"Icons saved to: {assets_dir}")
    print("Done. You can now run create-shortcut.bat to add AURA to your Desktop.")
