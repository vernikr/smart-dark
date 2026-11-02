"""Tone-curve prototype v4: ink-adaptive ceiling for graphics, verified visually."""
import numpy as np
from PIL import Image

def to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

LUMA = np.array([0.2126, 0.7152, 0.0722])

def metrics(rgb8, alpha):
    small = Image.fromarray(rgb8.astype(np.uint8)).convert('L').resize((48, 48))
    l = np.asarray(small, dtype=np.float64) / 255.0
    opaque = alpha > 0.1
    if opaque.all():
        bg = float(np.median(l))
        ink = float((np.abs(l - bg) > 0.12).mean())
        light_bg = 1 if bg > 0.5 else 0
    else:
        ink = float(opaque.mean())
        light_bg = 1
    colors = int(len(np.unique((np.asarray(Image.fromarray(rgb8.astype(np.uint8)).resize((40, 40))).reshape(-1, 3) // 24), axis=0)))
    return dict(ink=ink, light_bg=light_bg, colors=colors)

def curve_for(m):
    if m['colors'] > 900:
        return dict(kind='photo', flip=False, floor=0.03, ceil=0.62, sat=1.06)
    if m['ink'] >= 0.35:
        return dict(kind='graphics', flip=True, floor=0.130, ceil=0.720, sat=1.20)
    if m['ink'] >= 0.12:
        return dict(kind='graphics', flip=True, floor=0.120, ceil=0.820, sat=1.20)
    return dict(kind='graphics', flip=True, floor=0.120, ceil=0.900, sat=1.22)

def apply(img, m=None):
    rgb = to_lin(img[..., :3] / 255.0)
    alpha = img[..., 3] / 255.0
    p = curve_for(m or metrics(img[..., :3], alpha))
    y = rgb @ LUMA
    L = np.cbrt(np.maximum(y, 0.0))
    x = 1.0 - L if p['flip'] else L
    out_l = p['floor'] + (p['ceil'] - p['floor']) * x
    gain = np.where(y > 1e-5, out_l ** 3 / np.maximum(y, 1e-5), 0.0)
    res = np.clip(rgb * gain[..., None], 0, 1)
    grey = res @ LUMA
    res = np.clip(grey[..., None] + (res - grey[..., None]) * p['sat'], 0, 1)
    return np.clip(np.concatenate([to_srgb(res) * 255.0, alpha[..., None] * 255.0], axis=-1), 0, 255).astype(np.uint8), p

if __name__ == '__main__':
    for path in ['/tmp/kiro/quality-stages.png', '/tmp/kiro/fork-isolation.png',
                 '/tmp/kiro/pr-readiness-signal.png', '/tmp/kiro/over-engineering-retrospective.png',
                 '/tmp/photo.jpg', '/tmp/logo.png']:
        im = np.asarray(Image.open(path).convert('RGBA')).astype(np.float64)
        m = metrics(im[..., :3], im[..., 3] / 255.0)
        out, p = apply(im, m)
        dst = '/tmp/y-' + path.split('/')[-1].rsplit('.', 1)[0] + '.png'
        Image.fromarray(out, 'RGBA').save(dst)
        print(path.split('/')[-1], m, '->', p['kind'], 'ceil', p['ceil'], '|', dst)
