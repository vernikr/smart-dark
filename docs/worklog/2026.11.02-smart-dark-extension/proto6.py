"""Final tone model: three content classes, lightness remap, hue and chroma kept."""
import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722])

def to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

def analyze(rgb8, alpha):
    l = np.asarray(Image.fromarray(rgb8.astype(np.uint8)).convert('L').resize((48, 48)), dtype=np.float64) / 255.0
    grid = (np.asarray(Image.fromarray(rgb8.astype(np.uint8)).resize((40, 40))).reshape(-1, 3) // 24)
    colors = int(len(np.unique(grid, axis=0)))
    mid = float(((l > 0.2) & (l < 0.8)).mean())
    opaque = float((alpha > 0.1).mean())
    if opaque < 0.98:
        kind = 'icon'
    elif colors <= 32 or mid < 0.18:
        kind = 'graphic'
    else:
        kind = 'photo'
    return dict(kind=kind, colors=colors, mid=round(mid, 3), opaque=round(opaque, 3))

CURVES = {
    'icon':    dict(flip=False, floor=0.320, ceil=0.880, sat=1.10),
    'graphic': dict(flip=True,  floor=0.130, ceil=0.880, sat=1.20),
    'photo':   dict(flip=False, floor=0.030, ceil=0.620, sat=1.06),
}

def apply(img, info=None):
    rgb = to_lin(img[..., :3] / 255.0)
    alpha = img[..., 3] / 255.0
    info = info or analyze(img[..., :3], alpha)
    p = CURVES[info['kind']]
    y = rgb @ LUMA
    l = np.cbrt(np.maximum(y, 0.0))
    x = (1.0 - l) if p['flip'] else l
    out_l = p['floor'] + (p['ceil'] - p['floor']) * x
    gain = np.where(y > 1e-5, out_l ** 3 / np.maximum(y, 1e-5), 0.0)
    res = np.clip(rgb * gain[..., None], 0, 1)
    grey = res @ LUMA
    res = np.clip(grey[..., None] + (res - grey[..., None]) * p['sat'], 0, 1)
    return np.clip(np.concatenate([to_srgb(res) * 255.0, alpha[..., None] * 255.0], axis=-1), 0, 255).astype(np.uint8), info

if __name__ == '__main__':
    for path in ['/tmp/kiro/quality-stages.png', '/tmp/kiro/fork-isolation.png',
                 '/tmp/kiro/pr-readiness-signal.png', '/tmp/kiro/over-engineering-retrospective.png',
                 '/tmp/photo.jpg', '/tmp/logo.png']:
        im = np.asarray(Image.open(path).convert('RGBA')).astype(np.float64)
        out, info = apply(im)
        dst = '/tmp/z-' + path.split('/')[-1].rsplit('.', 1)[0] + '.png'
        Image.fromarray(out, 'RGBA').save(dst)
        print(path.split('/')[-1][:32].ljust(34), info)
