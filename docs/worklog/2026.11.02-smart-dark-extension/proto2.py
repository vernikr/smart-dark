"""Tone-curve prototype: neutral-ramp curve per image class, verified visually."""
import numpy as np
from PIL import Image

def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def lin_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

def curve(v, lo, hi, gamma=1.0):
    y = srgb_to_lin(np.asarray(v, dtype=np.float64))
    L = np.cbrt(y)
    L = lo + (hi - lo) * (L ** gamma)
    return lin_to_srgb(L ** 3)

VARIANTS = {
    'graphics': dict(lo=0.055, hi=0.185, gamma=1.0, sat=1.10),
    'balanced': dict(lo=0.045, hi=0.330, gamma=1.10, sat=1.10),
    'photo':    dict(lo=0.030, hi=0.520, gamma=1.15, sat=1.08),
}

def apply(img, name):
    p = VARIANTS[name]
    rgb = img[..., :3] / 255.0
    out = curve(rgb, p['lo'], p['hi'], p['gamma'])
    lum = out @ np.array([0.2126, 0.7152, 0.0722])
    out = np.clip(lum[..., None] + (out - lum[..., None]) * p['sat'], 0, 1)
    res = np.concatenate([out * 255.0, img[..., 3:]], axis=-1)
    return np.clip(res, 0, 255).astype(np.uint8)

def table(name, n=24):
    xs = np.linspace(0, 1, n)
    return [round(float(v), 4) for v in curve(xs, VARIANTS[name]['lo'], VARIANTS[name]['hi'], VARIANTS[name]['gamma'])]

def classify(path):
    im = Image.open(path).convert('RGB').resize((64, 64))
    a = np.asarray(im).astype(np.float64) / 255.0
    lum = a @ np.array([0.2126, 0.7152, 0.0722])
    light = float((lum > 0.86).mean())
    dark = float((lum < 0.14).mean())
    uniq = len({tuple(p) for p in (a * 24).astype(int).reshape(-1, 3)})
    flat = float(uniq / (24 ** 3))
    return dict(lightShare=round(light, 3), darkShare=round(dark, 3), uniq=uniq, flat=round(flat, 3))

if __name__ == '__main__':
    for path, name in [('/tmp/kiro/quality-stages.png', 'graphics'),
                       ('/tmp/kiro/fork-isolation.png', 'graphics'),
                       ('/tmp/photo.jpg', 'photo'),
                       ('/tmp/logo.png', 'graphics')]:
        im = np.asarray(Image.open(path).convert('RGBA')).astype(np.float64)
        out = Image.fromarray(apply(im, name), 'RGBA')
        dst = '/tmp/v-' + name + '-' + path.split('/')[-1].rsplit('.', 1)[0] + '.png'
        out.save(dst)
        print(dst, out.size, classify(path), name)
    print('tables:')
    for n in VARIANTS:
        print(n, table(n))
