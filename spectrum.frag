#version 440

// Every Spectra style, drawn by one fragment shader over the whole widget.
//
// Positions are worked out in two axes: `along`, across the bands, and
// `depth`, the direction the bands grow in. On a vertical bar the two swap,
// and nothing else changes. Everything is in logical pixels; `aa` is the size
// of one device pixel in those units, which is what every edge is softened by.
//
// Built into spectrum.frag.qsb by tools/build-shader.sh, which the shell loads.

layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;

layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;

    vec2 size;          // the widget's canvas, in logical pixels
    float bands;        // how many bands are drawn
    float pitch;        // from the start of one band to the start of the next
    float thickness;    // how wide a band is
    float span;         // how deep the canvas is
    float vertical;     // 1 on a vertical bar
    float mirrored;     // 1: side A grows up from the centre line, side B down
    float fromFar;      // 1: bands grow from depth = span toward 0
    float style;        // 0 Bars, 1 Dots, 2 Beads, 3 Glow, 4 Spikes, 5 Steps, 6 Wave
    float peakMode;     // 0 Cap, 1 Trail, 2 Off
    float fillAlpha;    // how solid the body under a line is
    float capWidth;     // how thick a cap or a line is
    float cell;         // Dots: how tall a cell is
    float cellPitch;    // Dots: from one cell to the next
    float rows;         // Dots: cells in the ladder
    float paletteMode;  // 0 flat, 1 gradient, 2 spectrum, 3 cover
    float butterfly;    // 1: the bass sits in the middle
    vec4 flatColor;     // the flat colour, and the loud end of Gradient
    vec4 mutedColor;    // the quiet end of Gradient
    vec2 anchor;        // Spectrum: the accent's hue and saturation
    float coverReady;   // Cover: 1 once the album art has loaded

    // One float per band per side, packing the level and the peak: see
    // Model.packBand. Side B is only filled in Mirror.
    vec4 a0; vec4 a1; vec4 a2; vec4 a3; vec4 a4; vec4 a5; vec4 a6; vec4 a7;
    vec4 a8; vec4 a9; vec4 a10; vec4 a11; vec4 a12; vec4 a13; vec4 a14; vec4 a15;
    vec4 b0; vec4 b1; vec4 b2; vec4 b3; vec4 b4; vec4 b5; vec4 b6; vec4 b7;
    vec4 b8; vec4 b9; vec4 b10; vec4 b11; vec4 b12; vec4 b13; vec4 b14; vec4 b15;
};

// The album art, for the Cover palette: a 16px thumbnail of it.
layout(binding = 1) uniform sampler2D cover;

float aa;

float packedA(int i) {
    vec4 v[16] = vec4[16](a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15);
    int q = i / 4;
    return v[q][i - q * 4];
}

float packedB(int i) {
    vec4 v[16] = vec4[16](b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15);
    int q = i / 4;
    return v[q][i - q * 4];
}

int clampBand(int i) {
    return clamp(i, 0, int(bands) - 1);
}

float levelOf(float v) { return mod(v, 4096.0) / 4095.0; }
float peakOf(float v) { return floor(v / 4096.0) / 4095.0; }

// Level and peak of band `i` on one side. Outside Mirror, B is A.
vec2 bandA(int i) { float v = packedA(clampBand(i)); return vec2(levelOf(v), peakOf(v)); }
vec2 bandB(int i) {
    float v = mirrored > 0.5 ? packedB(clampBand(i)) : packedA(clampBand(i));
    return vec2(levelOf(v), peakOf(v));
}

float depthAt(float level, float side) {
    if (mirrored > 0.5) return span * 0.5 + side * level * span * 0.5;
    return fromFar > 0.5 ? span - level * span : level * span;
}

float originDepth() {
    return mirrored > 0.5 ? span * 0.5 : (fromFar > 0.5 ? span : 0.0);
}

float contentWidth() {
    return bands * thickness + max(0.0, bands - 1.0) * (pitch - thickness);
}

// ---- Colour --------------------------------------------------------------

vec3 hsv(float h, float s, float v) {
    vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return v * mix(vec3(1.0), k, s);
}

// Hue swept across the spectrum from the accent, over three quarters of the
// wheel so the two ends stay distinguishable, rather than a stock rainbow.
vec3 spectrum(float t) {
    float hue = mod(anchor.x + clamp(t, 0.0, 1.0) * 0.75, 1.0);
    float saturation = clamp(anchor.y + 0.25, 0.35, 0.85);
    return hsv(hue, saturation, 1.0);
}

vec3 toHsv(vec3 c) {
    vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, k.wz), vec4(c.gb, k.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}

// A colour from the album art at position `t` across it: the most vivid of
// three samples down the cover, lifted so a dark or washed-out sleeve still
// reads on the bar. Before the art has loaded, it sweeps like Spectrum.
vec3 coverColour(float t) {
    if (coverReady < 0.5) return spectrum(t);
    vec3 best = vec3(0.0);
    float score = -1.0;
    for (int k = 0; k < 3; k++) {
        vec3 c = toHsv(texture(cover, vec2(0.05 + 0.9 * t, 0.25 + 0.25 * float(k))).rgb);
        if (c.y * c.z > score) {
            score = c.y * c.z;
            best = c;
        }
    }
    return hsv(best.x, max(best.y, 0.45), max(best.z, 0.85));
}

// Where position `t` across the widget sits in frequency: Butterfly fans out
// from the bass in the middle.
float frequency(float t) {
    return butterfly > 0.5 ? abs(2.0 * t - 1.0) : t;
}

// A band's colour, which Gradient bases on how loud the band is.
vec3 bandColour(int i, float loudness) {
    if (paletteMode > 2.5) return coverColour(frequency(bands > 1.0 ? float(i) / (bands - 1.0) : 0.0));
    if (paletteMode > 1.5) return spectrum(frequency(bands > 1.0 ? float(i) / (bands - 1.0) : 0.0));
    if (paletteMode > 0.5) return mix(mutedColor.rgb, flatColor.rgb, loudness);
    return flatColor.rgb;
}

// The colour at a position across the widget, for the line styles.
vec3 stopColour(float t) {
    if (paletteMode > 2.5) return coverColour(frequency(t));
    if (paletteMode > 1.5) return spectrum(frequency(t));
    if (paletteMode > 0.5) return mix(mutedColor.rgb, flatColor.rgb, frequency(t));
    return flatColor.rgb;
}

// Premultiplied "over": lay `rgb` at coverage `a` on top of what is there.
vec4 over(vec4 below, vec3 rgb, float a) {
    return vec4(rgb * a, a) + below * (1.0 - a);
}

// ---- Coverage ------------------------------------------------------------

// How much of this pixel a rounded box covers, softened by one device pixel.
float box(vec2 p, vec2 lo, vec2 hi, float radius) {
    vec2 centre = (lo + hi) * 0.5;
    vec2 half_ = max((hi - lo) * 0.5, vec2(0.0));
    float r = min(radius, min(half_.x, half_.y));
    vec2 q = abs(p - centre) - half_ + r;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    return clamp(0.5 - d / aa, 0.0, 1.0);
}

float disc(vec2 p, vec2 centre, float radius) {
    return clamp(0.5 - (length(p - centre) - radius) / aa, 0.0, 1.0);
}

// Distance from `p` to the segment from `s0` to `s1`.
float segment(vec2 p, vec2 s0, vec2 s1) {
    vec2 d = s1 - s0;
    float t = clamp(dot(p - s0, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
    return length(p - s0 - d * t);
}

// A band's extent along the depth axis, from `near` to `far`: from the origin
// out to its level, or in Mirror from side A's level to side B's.
vec2 extent(float levelA, float levelB) {
    float near;
    float far;
    if (mirrored > 0.5) {
        near = depthAt(levelA, -1.0);
        far = depthAt(levelB, 1.0);
    } else {
        near = min(depthAt(levelA, -1.0), originDepth());
        far = max(depthAt(levelA, -1.0), originDepth());
    }
    // A band is always at least a hairline: an empty bar reads as a quiet
    // channel rather than a broken widget.
    if (far - near < 1.0) {
        float mid = mirrored > 0.5 ? span * 0.5 : (fromFar > 0.5 ? span - 0.5 : 0.5);
        near = mid - 0.5;
        far = mid + 0.5;
    }
    return vec2(near, far);
}

// A peak cap's extent: its outer edge on the peak, the rest inside it.
vec2 capAt(float peak, float side, float thick) {
    float d = depthAt(peak, side);
    bool growsUp = mirrored > 0.5 ? side < 0.0 : fromFar > 0.5;
    vec2 cap = growsUp ? vec2(d, d + thick) : vec2(d - thick, d);
    return clamp(cap, 0.0, span);
}

// ---- The banded styles: Bars, Dots, Beads, Glow --------------------------

vec4 banded(float along, float depth) {
    int i = int(floor(along / pitch));
    float within = along - float(i) * pitch;
    if (i < 0 || i >= int(bands) || within > thickness + aa) return vec4(0.0);

    vec2 a = bandA(i);
    vec2 b = bandB(i);
    float loudest = max(a.x, b.x);
    vec3 rgb = bandColour(i, loudest);
    vec2 p = vec2(within, depth);
    float radius = min(thickness, 5.0) * 0.5;
    vec4 colour = vec4(0.0);

    if (style < 0.5) {
        // Bars, with a translucent ghost still falling from the last peak
        // behind them when trailing, or a cap on the peak.
        if (peakMode > 0.5 && peakMode < 1.5) {
            vec2 ghost = extent(a.y, b.y);
            colour = over(colour, rgb, 0.22 * box(p, vec2(0.0, ghost.x), vec2(thickness, ghost.y), radius));
        }
        vec2 body = extent(a.x, b.x);
        colour = over(colour, rgb, (0.35 + 0.65 * loudest)
                      * box(p, vec2(0.0, body.x), vec2(thickness, body.y), radius));
        if (peakMode < 0.5) {
            vec2 capA = capAt(a.y, -1.0, capWidth);
            colour = over(colour, rgb, 0.9 * box(p, vec2(0.0, capA.x), vec2(thickness, capA.y), 1.0));
            if (mirrored > 0.5) {
                vec2 capB = capAt(b.y, 1.0, capWidth);
                colour = over(colour, rgb, 0.9 * box(p, vec2(0.0, capB.x), vec2(thickness, capB.y), 1.0));
            }
        }
    } else if (style < 1.5) {
        // Dots: a ladder of cells lit outward from the origin. In Mirror the
        // rungs pair up around the centre line and each half shows one side.
        float centreRow = (rows - 1.0) * 0.5;
        float r;
        float cellCentre;
        if (mirrored > 0.5) {
            r = floor((depth - span * 0.5) / cellPitch + centreRow + 0.5);
            cellCentre = span * 0.5 + (r - centreRow) * cellPitch;
        } else {
            float h = fromFar > 0.5 ? span - depth : depth;
            r = floor(h / cellPitch);
            float mid = r * cellPitch + cell * 0.5;
            cellCentre = fromFar > 0.5 ? span - mid : mid;
        }
        if (r < 0.0 || r > rows - 1.0) return vec4(0.0);

        float rungs = mirrored > 0.5 ? rows * 0.5 : rows;
        float reach = mirrored > 0.5 ? abs(r - centreRow) : r;
        float at = (reach + 0.5) / rungs;
        float side = mirrored < 0.5 || abs(r - centreRow) < 0.25 ? 0.0 : (r < centreRow ? -1.0 : 1.0);
        float level = side < 0.0 ? a.x : (side > 0.0 ? b.x : loudest);
        float peak = side < 0.0 ? a.y : (side > 0.0 ? b.y : max(a.y, b.y));
        bool lit = at <= level;
        bool cap = peakMode < 1.5 && at <= peak && at + 1.0 / rungs > peak;
        float alpha = cap ? 1.0 : (lit ? 0.5 + 0.4 * level : 0.07);
        colour = over(colour, rgb, alpha * box(p, vec2(0.0, cellCentre - cell * 0.5),
                                               vec2(thickness, cellCentre + cell * 0.5),
                                               min(thickness, cell) / 3.0));
    } else if (style < 2.5) {
        // Beads: a disc riding where the top of the bar would be, capped with
        // a smaller one at the peak.
        float size_ = max(2.0, thickness);
        float bead = max(2.0, thickness * 0.6);
        for (int s = 0; s < 2; s++) {
            if (s == 1 && mirrored < 0.5) break;
            float side = s == 0 ? -1.0 : 1.0;
            vec2 v = s == 0 ? a : b;
            float d = clamp(depthAt(v.x, side), size_ * 0.5, span - size_ * 0.5);
            colour = over(colour, rgb, (0.45 + 0.55 * v.x) * disc(p, vec2(thickness * 0.5, d), size_ * 0.5));
            if (peakMode < 1.5) {
                vec2 cap = capAt(v.y, side, bead);
                colour = over(colour, rgb, 0.9 * disc(p, vec2(thickness * 0.5, (cap.x + cap.y) * 0.5), bead * 0.5));
            }
        }
    } else {
        // Glow: no height at all. The band is a full-depth cell and the level
        // reads as brightness, with a floor so a quiet room still shows a row
        // of cells, and a curve that keeps the quiet bands from vanishing.
        colour = over(colour, rgb, (0.14 + 0.86 * pow(loudest, 0.65))
                      * box(p, vec2(0.0, 0.0), vec2(thickness, span), radius));
    }
    return colour;
}

// ---- The line styles: Spikes, Steps, Wave --------------------------------

// Where band `i`'s line sits on one side.
float lineDepth(int i, float side) {
    return depthAt(side < 0.0 ? bandA(i).x : bandB(i).x, side);
}

// The depth of the line at `along`, and its distance from `p`, for one side.
vec2 line(vec2 p, float side) {
    float along = p.x;
    float floorDepth = depthAt(0.0, side);
    int i = clampBand(int(floor(along / pitch)));

    if (style < 4.5) {
        // Spikes: down to the baseline between each band, up to a point at
        // its centre.
        float best = 1e9;
        float at = floorDepth;
        for (int k = -1; k <= 1; k++) {
            int j = i + k;
            if (j < 0 || j >= int(bands)) continue;
            float left = float(j) * pitch;
            vec2 tip = vec2(left + thickness * 0.5, lineDepth(j, side));
            vec2 l = vec2(left, floorDepth);
            vec2 r = vec2(left + thickness, floorDepth);
            best = min(best, min(segment(p, l, tip), segment(p, tip, r)));
            if (j + 1 < int(bands)) best = min(best, segment(p, r, vec2(float(j + 1) * pitch, floorDepth)));
            if (along >= l.x && along <= r.x) {
                float t = abs(along - tip.x) / (thickness * 0.5);
                at = mix(tip.y, floorDepth, clamp(t, 0.0, 1.0));
            }
        }
        return vec2(at, best);
    }

    if (style < 5.5) {
        // Steps: held flat across each band, straight across each gap.
        float best = 1e9;
        float at = lineDepth(i, side);
        for (int k = -1; k <= 1; k++) {
            int j = i + k;
            if (j < 0 || j >= int(bands)) continue;
            float left = float(j) * pitch;
            float d = lineDepth(j, side);
            best = min(best, segment(p, vec2(left, d), vec2(left + thickness, d)));
            if (j + 1 < int(bands)) {
                vec2 next = vec2(float(j + 1) * pitch, lineDepth(j + 1, side));
                best = min(best, segment(p, vec2(left + thickness, d), next));
                if (along > left + thickness && along < next.x)
                    at = mix(d, next.y, (along - left - thickness) / max(next.x - left - thickness, 1e-3));
            }
        }
        return vec2(at, best);
    }

    // Wave: a Catmull-Rom curve through the band centres, flat out to each
    // edge. The distance is the vertical one corrected for the slope, which is
    // exact for a straight stretch and close enough on a gentle curve.
    float c = (along - thickness * 0.5) / pitch;
    int k = int(floor(c));
    float y;
    float slope;
    if (c <= 0.0) {
        y = lineDepth(0, side);
        slope = 0.0;
    } else if (k >= int(bands) - 1) {
        y = lineDepth(int(bands) - 1, side);
        slope = 0.0;
    } else {
        float t = c - float(k);
        float p0 = lineDepth(k - 1, side);
        float p1 = lineDepth(k, side);
        float p2 = lineDepth(k + 1, side);
        float p3 = lineDepth(k + 2, side);
        float t2 = t * t;
        y = 0.5 * (2.0 * p1 + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                   + (3.0 * p1 - p0 - 3.0 * p2 + p3) * t2 * t);
        slope = 0.5 * ((p2 - p0) + 2.0 * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t
                       + 3.0 * (3.0 * p1 - p0 - 3.0 * p2 + p3) * t2) / pitch;
    }
    y = clamp(y, 0.0, span);
    return vec2(y, abs(p.y - y) / sqrt(1.0 + slope * slope));
}

vec4 shaped(float along, float depth) {
    vec2 p = vec2(along, depth);
    vec3 rgb = stopColour(along / max(contentWidth(), 1.0));
    vec2 top = line(p, -1.0);
    float coverage = clamp((capWidth * 0.5 - top.y) / aa + 0.5, 0.0, 1.0);

    // The body lies between the line and the origin, or in Mirror between
    // the two sides' lines.
    float inside;
    if (mirrored > 0.5) {
        vec2 bottom = line(p, 1.0);
        coverage = max(coverage, clamp((capWidth * 0.5 - bottom.y) / aa + 0.5, 0.0, 1.0));
        inside = step(top.x, depth) * step(depth, bottom.x);
    } else {
        float origin = originDepth();
        inside = step(min(top.x, origin), depth) * step(depth, max(top.x, origin));
    }

    vec4 colour = over(vec4(0.0), rgb, fillAlpha * inside);
    return over(colour, rgb, coverage);
}

void main() {
    vec2 px = qt_TexCoord0 * size;
    float along = vertical > 0.5 ? px.y : px.x;
    float depth = vertical > 0.5 ? px.x : px.y;
    aa = max(fwidth(along), 1e-3);
    vec4 colour = style > 3.5 ? shaped(along, depth) : banded(along, depth);
    fragColor = colour * qt_Opacity;
}
