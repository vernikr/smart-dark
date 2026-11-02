"""Tone-curve prototype v2: lightness remap in OKLab, hue/chroma preserved."""
import numpy as np
from PIL import Image

def lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

def l_of(v):
    return np.cbrt(lin(np.asarray(v, dtype=np.float64)))

VARIANTS = {
    # polarity flip, band compressed into dark-mode range
    'graphics': dict(flip=True, lo=0.235, hi=0.875, gamma=1.00, s=0.35, sat=1.18),
    # no flip, gentle downward scale in lightness space
    'photo':    dict(flip=False, lo=0.03, hi=0.62, gamma=1.00, s=0.00, sat=1.06),
    'balanced': dict(flip=True, lo=0.22, hi=0.80, gamma=1.05, s=0.25, sat=1.14),
}

def remap(L, p):
    if p['flip']:
        x = 1.0 - L
    else:
        x = L
    out = p['lo'] + (p['hi'] - p['lo']) * x
    if p['s']:  # mild S-curve around the middle to restore local contrast
        out = np.clip(out + p['s'] * (out - 0.5) * (1 - abs(2 * out - 1)), 0, 1)
        out = p['lo'] + (p['hi'] - p['lo']) * (out - out.min()) / max(1e-6, out.max() - out.min())
    return np.clip(out, 0, 1)

def apply(img, name):
    p = VARIANTS[name]
    rgb = img[..., :3] / 255.0
    a = img[..., 3:] / 255.0
    lin_rgb = lin(rgb)
    L = np.cbrt(lin_rgb @ np.array([0.2126, 0.7152, 0.0722]))
    outL = remap(L, p)
    # keep hue, scale chroma with lightness so dark areas stay readable
    ratio = np.where(L > 1e-4, outL / np.maximum(L, 1e-4), 0.0)
    chroma_gain = p['sat'] * np.clip(0.55 + 0.75 * outL, 0.5, 1.35)
    mixed = lin_rgb * np.where(L[..., None] > 1e-4, ratio[..., None], 1.0)
    res = np.clip(mixed, 0, 1)
    grey = res @ np.array([0.2126, 0.7152, 0.0722])
    res = np.clip(grey[..., None] + (res - grey[..., None]) * chroma_gain[..., None], 0, 1)
    return np.clip(np.concatenate([srgb(res) * 255.0, a * 255.0], axis=-1), 0, 255).astype(np.uint8)

def table(name, n=17):
    xs = np.linspace(0, 1, n)
    return [round(float(v), 3) for v in remap(l_of(xs), VARIANTS[name])]

if __name__ == '__main__':
    for path, name in [('/tmp/kiro/quality-stages.png', 'graphics'),
                       ('/tmp/kiro/fork-isolation.png', 'graphics'),
                       ('/tmp/photo.jpg', 'photo'),
                       ('/tmp/logo.png', 'graphics')]:
        im = np.asarray(Image.open(path).convert('RGBA')).astype(np.float64)
        out = Image.fromarray(apply(im, name), 'RGBA')
        dst = '/tmp/w-' + name + '-' + path.split('/')[-1].rsplit('.', 1)[0] + '.png'
        out.save(dst)
        print(dst)
    for n in VARIANTS:
        print(n, 'input 0..1 ->', table(n))
