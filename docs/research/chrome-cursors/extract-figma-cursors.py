"""Decodes Figma's canvas cursors from its fullscreen wasm (README.md here has the method).

    python3 -I extract-figma-cursors.py <compiled_wasm.wasm> <out dir>

Writes <out>/cursor-<name>.svg for every "cursor-*.svg" resource and <out>/hotspots.json ({name: [w, h, x, y]}: the
box and hot spot Figma's code passes with the name; absent when the code builds the cursor elsewhere — the turned
resize / rotate ones).
"""
import json, os, re, struct, sys

wasm, out = sys.argv[1], sys.argv[2]
data = open(wasm, 'rb').read()
os.makedirs(out, exist_ok=True)


def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7f) << s; s += 7
        if not x & 0x80: return r, i


def sleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7f) << s; s += 7
        if not x & 0x80:
            return (r - (1 << s) if x & 0x40 else r), i


def sleb_enc(v):
    o = bytearray()
    while True:
        b = v & 0x7f; v >>= 7
        if (v == 0 and not b & 0x40) or (v == -1 and b & 0x40): o.append(b); return bytes(o)
        o.append(b | 0x80)


# Sections: the data segments (memory address, file offset, length) and the code section.
segs, code, i = [], None, 8
while i < len(data):
    sid = data[i]; i += 1
    size, i = uleb(data, i)
    if sid == 10: code = (i, i + size)
    if sid == 11:
        n, j = uleb(data, i)
        for _ in range(n):
            flags, j = uleb(data, j)
            mo = None
            if flags in (0, 2):
                if flags == 2: _, j = uleb(data, j)
                op = data[j]; j += 1
                if op in (0x41, 0x42): mo, j = sleb(data, j)
                else: _, j = uleb(data, j)
                j += 1  # end
            ln, j = uleb(data, j)
            segs.append((mo, j, ln)); j += ln
    i += size
# wasm-opt drops zero runs between segments: read the resources from the rebuilt memory image.
mem = bytearray(max(m + l for m, _, l in segs if m is not None) + 16)
for m, f, l in segs:
    if m is not None: mem[m:m + l] = data[f:f + l]


def file_to_mem(fo):
    for m, f, l in segs:
        if m is not None and f <= fo < f + l: return m + fo - f


def svg_of(b, w, h):
    """Resource words: 0 begin path, 1 M x y, 2 L x y, 3 C x1 y1 x2 y2 x y, 4 Z, 5 fill RGBA, 6 stroke RGBA width."""
    n = len(b) // 4
    u = struct.unpack('<%dI' % n, b); f = struct.unpack('<%df' % n, b)
    num = lambda v: (('%.3f' % v).rstrip('0').rstrip('.')).replace('-0', '0') if abs(v) >= 0.0005 else '0'
    rgba = lambda c: ('#%02x%02x%02x' % (c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff), ((c >> 24) & 0xff) / 255)
    paths, d, k = [], [], 0
    while k < n:
        op = u[k]; k += 1
        if op == 0: d = []
        elif op in (1, 2): d.append('%s%s %s' % ('ML'[op - 1], num(f[k]), num(f[k + 1]))); k += 2
        elif op == 3: d.append('C' + ' '.join(num(x) for x in f[k:k + 6])); k += 6
        elif op == 4: d.append('Z')
        elif op == 5:
            c, a = rgba(u[k]); k += 1
            paths.append('<path d="%s" fill="%s"%s/>' % (''.join(d), c, '' if a == 1 else ' fill-opacity="%s"' % num(a)))
        elif op == 6:
            c, a = rgba(u[k]); k += 2
            paths.append('<path d="%s" fill="none" stroke="%s" stroke-width="%s"%s/>' % (''.join(d), c, num(f[k - 1]), '' if a == 1 else ' stroke-opacity="%s"' % num(a)))
        else: raise ValueError('unknown op %d' % op)
    return '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">%s</svg>' % (w, h, w, h, ''.join(paths))


hot = {}
for m in re.finditer(rb'cursor-[a-z0-9-]+\.svg\x00', data):
    name = m.group()[:-1].decode()
    ma = file_to_mem(m.start())
    if ma is None: continue
    # The resource table: (name, width, height, data address, length in words), sorted by name.
    for r in re.finditer(re.escape(struct.pack('<I', ma)), data):
        w, h, dp, ln = struct.unpack_from('<IIII', data, r.start() + 4)
        if 0 < w < 200 and 0 < h < 200 and 0 < ln < 100000 and dp + ln * 4 <= len(mem):
            open(os.path.join(out, name), 'w').write(svg_of(bytes(mem[dp:dp + ln * 4]), w, h))
            break
    # The code that makes the cursor: i32.const name, box w, box h, hot x, hot y.
    at = data.find(b'\x41' + sleb_enc(ma), code[0], code[1])
    if at > 0:
        vals, j = [], at
        for _ in range(5):
            if data[j] != 0x41: break
            v, j = sleb(data, j + 1); vals.append(v)
        if len(vals) == 5 and vals[1] <= 64 and vals[2] <= 64: hot[name[len('cursor-'):-len('.svg')]] = vals[1:]
json.dump(hot, open(os.path.join(out, 'hotspots.json'), 'w'), indent=1, sort_keys=True)
print('svgs', len([f for f in os.listdir(out) if f.endswith('.svg')]), 'hot spots', len(hot))
