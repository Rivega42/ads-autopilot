"""
Снимает залитую подложку с вырезок: у персонажей она белая, у фото — чёрная.

Заливка идёт от краёв, поэтому белая рубашка внутри силуэта остаётся белой —
прозрачным становится только фон, связанный с границей кадра.

Запуск: python3 docs/campaigns/smartsay/creatives/strip-bg.py
"""

import collections
import glob
import os
import struct
import zlib

SRC_DIR = os.path.join(os.path.dirname(__file__), "source")
OUT_DIR = os.path.join(os.path.dirname(__file__), "source", "cutouts")

# Вырезки приехали с сайта с залитой подложкой, а не с альфой: у персонажей
# она белая, у студийных фото — чёрная. Цвет берём из угла кадра.
TARGETS = [
    "consultant_full_body_headset",
    "girl_full_body_thumbs_up",
    "man_cutout_white_background",
    "student_full_body_pointing_right",
    "image_1766308590715",
    "image_1766308599866",
    "image_1766308608934",
    "image_1766308619051",
]

TOLERANCE = 26
SPREAD_MAX = 26
EDGE_SOFT = 200


def read_png(path):
    data = open(path, "rb").read()
    pos, idat, width, height, depth, color = 8, b"", None, None, None, None
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        kind = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color = struct.unpack(">IIBB", chunk[:10])
        elif kind == b"IDAT":
            idat += chunk
        pos += 12 + length
    if depth != 8 or color not in (2, 6):
        raise ValueError(f"{path}: поддерживаются только 8-битные RGB/RGBA")

    raw = zlib.decompress(idat)
    channels = 3 if color == 2 else 4
    stride = width * channels
    out = bytearray()
    prev = bytearray(stride)
    i = 0

    def paeth(a, b, c):
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        return a if pa <= pb and pa <= pc else (b if pb <= pc else c)

    for _ in range(height):
        f = raw[i]
        i += 1
        line = bytearray(raw[i : i + stride])
        i += stride
        for x in range(stride):
            a = line[x - channels] if x >= channels else 0
            b = prev[x]
            c = prev[x - channels] if x >= channels else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                line[x] = (line[x] + paeth(a, b, c)) & 255
        out += line
        prev = line

    if channels == 3:
        rgba = bytearray(width * height * 4)
        for p in range(width * height):
            rgba[p * 4 : p * 4 + 3] = out[p * 3 : p * 3 + 3]
            rgba[p * 4 + 3] = 255
        out = rgba

    return width, height, out


def write_png(path, width, height, rgba):
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw += rgba[y * stride : (y + 1) * stride]

    def chunk(kind, payload):
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def corner_color(width, height, rgba):
    """Цвет подложки: медиана по четырём углам, чтобы не попасть в шум JPEG-артефактов."""
    corners = [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]
    samples = []
    for x, y in corners:
        i = (y * width + x) * 4
        samples.append((rgba[i], rgba[i + 1], rgba[i + 2]))
    samples.sort(key=sum)
    return samples[len(samples) // 2]


def is_background(rgba, index, ref):
    r, g, b = rgba[index], rgba[index + 1], rgba[index + 2]
    if max(abs(r - ref[0]), abs(g - ref[1]), abs(b - ref[2])) > TOLERANCE:
        return False
    return (max(r, g, b) - min(r, g, b)) <= SPREAD_MAX


def strip(width, height, rgba):
    """Заливка от границ кадра внутрь, пока пиксели совпадают с цветом подложки."""
    ref = corner_color(width, height, rgba)
    seen = bytearray(width * height)
    queue = collections.deque()

    for x in range(width):
        for y in (0, height - 1):
            queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        p = y * width + x
        if seen[p]:
            continue
        if not is_background(rgba, p * 4, ref):
            continue
        seen[p] = 1
        rgba[p * 4 + 3] = 0
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

    # Ореол по границе силуэта: полупрозрачим светлые пиксели рядом с вырезанным фоном.
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            p = y * width + x
            if seen[p] or rgba[p * 4 + 3] == 0:
                continue
            if not any(
                seen[(y + dy) * width + (x + dx)]
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
            ):
                continue
            near = max(abs(rgba[p * 4 + c] - ref[c]) for c in range(3))
            if near <= EDGE_SOFT // 4:
                rgba[p * 4 + 3] = 90

    return sum(seen)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for prefix in TARGETS:
        matches = glob.glob(os.path.join(SRC_DIR, prefix + "*.png"))
        if not matches:
            print(f"пропуск: {prefix} не найден")
            continue
        src = matches[0]
        width, height, rgba = read_png(src)
        cleared = strip(width, height, rgba)
        dst = os.path.join(OUT_DIR, prefix + ".png")
        write_png(dst, width, height, rgba)
        share = cleared / (width * height) * 100
        print(f"{prefix:36s} {width}x{height}  фон снят: {share:.1f}%")


main()
