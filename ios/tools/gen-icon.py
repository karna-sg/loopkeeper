#!/usr/bin/env python3
"""Generate Loopkeeper's 1024x1024 app icon (opaque RGB PNG, no deps).

A white "loop" ring closed by a checkmark, on the brand gradient.
Usage: python3 ios/tools/gen-icon.py ios/Assets.xcassets/AppIcon.appiconset/icon-1024.png
"""
import sys
import zlib
import struct

SIDE = 1024
CX = CY = 512.0
R = 300.0
RING_HALF = 38.0
CHECK_HALF = 40.0
# Checkmark in image coords (y down): down-right short stroke, then up-right long stroke.
CHECK = [((372, 528), (470, 628)), ((470, 628), (664, 404))]
C0 = (0.30, 0.36, 0.92)  # top-left
C1 = (0.12, 0.50, 0.98)  # bottom-right


def seg_dist(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    qx, qy = ax + t * dx, ay + t * dy
    return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5


def png(path, w, h, rgb):
    def chunk(typ, data):
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw.extend(rgb[y * w * 3:(y + 1) * w * 3])
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "icon-1024.png"
    buf = bytearray(SIDE * SIDE * 3)
    i = 0
    for y in range(SIDE):
        for x in range(SIDE):
            dist = ((x - CX) ** 2 + (y - CY) ** 2) ** 0.5
            white = abs(dist - R) <= RING_HALF
            if not white:
                for a, b in CHECK:
                    if seg_dist(x, y, a, b) <= CHECK_HALF:
                        white = True
                        break
            if white:
                r = g = bl = 255
            else:
                t = (x + y) / (2.0 * SIDE)
                r = int((C0[0] + (C1[0] - C0[0]) * t) * 255)
                g = int((C0[1] + (C1[1] - C0[1]) * t) * 255)
                bl = int((C0[2] + (C1[2] - C0[2]) * t) * 255)
            buf[i] = r; buf[i + 1] = g; buf[i + 2] = bl
            i += 3
    png(out, SIDE, SIDE, buf)
    print("wrote", out)


if __name__ == "__main__":
    main()
