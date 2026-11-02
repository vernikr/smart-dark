"""Tone-curve prototype v3: linear-light luma remap, hue and chroma kept."""
import numpy as np
from PIL import Image

def to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

LUMA = np.array([0.2126, 0.7152, 0.0722])

# out_lo = lightness for the brightest input, out_hi = for the darkest input
VARIANTS = {
    'graphics': dict(flip=True,  out_lo=0.255, out_hi=0.880, sat=1.22),
    'balanced': dict(flip=True,  out_lo=0.290, out_hi=0.820, sat=1.16),
    'photo':    dict(flip=False, out_lo=0.030, out_hi=0.620, sat=1.06),
}

def curve(name, n=17):
    p = VARIANTS[name]
    ls = np.linspace(0, 1, n) ** 3          # linear Y samples
    return [round(float(np.cbrt(remap_y(y, p))), 3) for y in ls]

def remap_y(y, p):
    L = np.cbrt(np.maximum(y, 0.0))
    x = 1.0 - L if p['flip'] else L
    out_l = p['out_lo'] + (p['out_hi'] - p['out_lo']) * x
    return out_l ** 3

def apply(img, name):
    p = VARIANTS[name]
    rgb = to_lin(img[..., :3] / 255.0)
    a = img[..., 3:] / 255.0
    y = rgb @ LUMA
    gain = np.where(y > 1e-5, remap_y(y, p) / np.maximum(y, 1e-5), 0.0)
    res = np.clip(rgb * gain[..., None], 0, 1)
    grey = res @ LUMA
    res = np.clip(grey[..., None] + (res - grey[..., None]) * p['sat'], 0, 1)
    return np.clip(np.concatenate([to_srgb(res) * 255.0, a * 255.0], axis=-1), 0, 255).astype(np.uint8)

if __name__ == '__main__':
    for path, name in [('/tmp/kiro/quality-stages.png', 'graphics'),
                       ('/tmp/kiro/fork-isolation.png', 'graphics'),
                       ('/tmp/kiro/pr-readiness-signal.png', 'balanced'),
                       ('/tmp/photo.jpg', 'photo'),
                       ('/tmp/logo.png', 'graphics')]:
        im = np.asarray(Image.open(path).convert('RGBA')).astype(np.float64)
        out = Image.fromarray(apply(im, name), 'RGBA')
        dst = '/tmp/x-' + name + '-' + path.split('/')[-1].rsplit('.', 1)[0] + '.png'
        out.save(dst)
        print(dst)
    for n in VARIANTS:
        print(n, curve(n))
