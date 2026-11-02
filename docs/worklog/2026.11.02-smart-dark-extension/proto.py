"""Prototype of the image darkening curve, ported to JS after visual check."""
import numpy as np
from PIL import Image
import sys

# --- sRGB <-> linear ---
def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

def rgb_to_oklab(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = np.cbrt(l), np.cbrt(m), np.cbrt(s)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return np.stack([L, a, bb], axis=-1)

def oklab_to_rgb(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return np.stack([r, g, bb], axis=-1)

def darken(img, strength=0.55, sat=1.14, bg=0.10):
    """Pixel transform. accent: 0 = neutral text, 1 = saturated graphic."""
    a = img[..., 3:] / 255.0
    rgb_lin = srgb_to_lin(img[..., :3] / 255.0)
    lab = rgb_to_oklab(rgb_lin)
    L = lab[..., 0]
    C = np.sqrt(lab[..., 1] ** 2 + lab[..., 2] ** 2)
    mx = np.maximum.reduce([rgb_lin[..., 0], rgb_lin[..., 1], rgb_lin[..., 2]])
    mn = np.minimum.reduce([rgb_lin[..., 0], rgb_lin[..., 1], rgb_lin[..., 2]])
    chroma = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    accent = np.clip((chroma - 0.25) / 0.30, 0, 1)
    # map light and dark regions onto a dark band, keep midtones readable
    lo, hi = bg, 1.0 - strength * (1.0 - bg)
    L2 = lo + (hi - lo) * (L ** 1.15)
    # add the accent's own lightness back so coloured graphics keep hierarchy
    L2 = np.clip(L2 + accent * 0.10 * (1 - L), 0, 1)
    a_arr = lab[..., 1] * sat * (1 + 0.25 * accent)
    b_arr = lab[..., 2] * sat * (1 + 0.25 * accent)
    out_lin = oklab_to_rgb(np.stack([L2, a_arr, b_arr], axis=-1))
    out = lin_to_srgb(out_lin)
    return np.concatenate([out * 255.0, a * 255.0], axis=-1)

def show(path, out, **kw):
    im = Image.open(path).convert('RGBA')
    arr = np.asarray(im).astype(np.float64)
    res = darken(arr, **kw)
    Image.fromarray(np.clip(res, 0, 255).astype(np.uint8), 'RGBA').save(out)
    print(out, Image.open(out).size)

if __name__ == '__main__':
    show('/tmp/kiro/quality-stages.png', '/tmp/dark-diagram.png')
    show('/tmp/photo.jpg', '/tmp/dark-photo.png')
    show('/tmp/logo.png', '/tmp/dark-logo.png')
