// Tests for Model.js, everything that can be checked without a compositor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Model } from "./model.mjs";

const defaults = {
  bars: 24, framerate: 60, noiseReduction: 45,
  quietDelay: 2000, sleepDelay: 6000, source: "",
};

// A stereo frame is the left channel treble-first, then the right bass-first —
// cava's own terminal layout. Both come back bass-first.
test("parseFrame splits a stereo frame into two bass-first channels", () => {
  const frame = Model.parseFrame("300;200;100;400;500;600;", 3, 1000);
  assert.deepEqual(frame.left, [0.1, 0.2, 0.3]);
  assert.deepEqual(frame.right, [0.4, 0.5, 0.6]);
  assert.equal(frame.peak, 0.6);
});

test("parseFrame pads a short frame and clamps a long band", () => {
  const frame = Model.parseFrame("2000;", 2, 1000);
  assert.deepEqual(frame.left, [0, 1]);
  assert.deepEqual(frame.right, [0, 0]);
});

test("parseFrame rejects empty input rather than reporting silence", () => {
  assert.equal(Model.parseFrame("", 4, 1000), null);
  assert.equal(Model.parseFrame("   ", 4, 1000), null);
  assert.equal(Model.parseFrame(null, 4, 1000), null);
});

test("parseFrame treats unparseable bands as zero", () => {
  const frame = Model.parseFrame("abc;500;", 1, 1000);
  assert.deepEqual(frame.left, [0]);
  assert.deepEqual(frame.right, [0.5]);
});

// The bug this suite exists for: a widget drawing fewer bands than the shared
// capture produces used to read the first n entries, i.e. the bass only.
test("resample folds a wide capture down without losing the top end", () => {
  const captured = [0, 0, 0, 0, 0, 0, 0, 1];
  assert.deepEqual(Model.resample(captured, 2), [0, 1]);
});

test("resample keeps the loudest band in each bin", () => {
  assert.deepEqual(Model.resample([0.1, 0.9, 0.2, 0.3], 2), [0.9, 0.3]);
});

test("resample interpolates when asked for more bands than captured", () => {
  assert.deepEqual(Model.resample([0, 1], 3), [0, 0.5, 1]);
});

test("resample handles the degenerate inputs", () => {
  assert.deepEqual(Model.resample([], 3), [0, 0, 0]);
  assert.deepEqual(Model.resample([0.5], 3), [0.5, 0.5, 0.5]);
  assert.deepEqual(Model.resample([0.5, 0.5], 0), []);
});

test("resample fills a reused buffer and returns it", () => {
  const buffer = [9, 9, 9, 9, 9];
  const out = Model.resample([0.1, 0.9, 0.2, 0.3], 2, buffer);
  assert.equal(out, buffer, "should write into the buffer it was given");
  assert.deepEqual(out, [0.9, 0.3]);
});

test("resample's reused and allocated paths agree", () => {
  const captured = [0.2, 0.7, 0.1, 0.4, 0.9, 0.3];
  for (const count of [1, 2, 3, 4, 5, 6, 7, 12]) {
    assert.deepEqual(
      Model.resample(captured, count, [1, 2, 3]),
      Model.resample(captured, count),
      `count ${count}`,
    );
  }
});

test("oneOf accepts an exact or differently-cased spelling", () => {
  const styles = ["Bars", "Dots", "Wave", "Area"];
  assert.equal(Model.oneOf("Wave", styles, "Bars"), "Wave");
  assert.equal(Model.oneOf("wave", styles, "Bars"), "Wave");
  assert.equal(Model.oneOf("WAVE", styles, "Bars"), "Wave");
});

test("oneOf falls back rather than passing a value nothing renders", () => {
  const styles = ["Bars", "Dots", "Wave", "Area"];
  assert.equal(Model.oneOf("Squiggle", styles, "Bars"), "Bars");
  assert.equal(Model.oneOf(undefined, styles, "Bars"), "Bars");
  assert.equal(Model.oneOf(null, styles, "Bars"), "Bars");
});

test("mergeAsks returns the fallback when no widget is asking", () => {
  assert.deepEqual(Model.mergeAsks({}, defaults), defaults);
  assert.deepEqual(Model.mergeAsks({ a: null }, defaults), defaults);
});

test("mergeAsks takes the most generous numeric request", () => {
  const merged = Model.mergeAsks({
    a: { bars: 16, framerate: 30, noiseReduction: 10, quietDelay: 1000, sleepDelay: 3000 },
    b: { bars: 48, framerate: 90, noiseReduction: 70, quietDelay: 5000, sleepDelay: 9000 },
  }, defaults);
  assert.equal(merged.bars, 48);
  assert.equal(merged.framerate, 90);
  assert.equal(merged.noiseReduction, 70);
  assert.equal(merged.quietDelay, 5000);
  assert.equal(merged.sleepDelay, 9000);
});

test("mergeAsks clamps a request outside the supported range", () => {
  const merged = Model.mergeAsks({ a: { bars: 999, framerate: 999 } }, defaults);
  assert.equal(merged.bars, 64);
  assert.equal(merged.framerate, 144);
});

test("mergeAsks picks the same source whatever order the widgets loaded in", () => {
  const one = Model.mergeAsks({ b: { source: "beta" }, a: { source: "alpha" } }, defaults);
  const two = Model.mergeAsks({ a: { source: "alpha" }, b: { source: "beta" } }, defaults);
  assert.equal(one.source, two.source);
  assert.equal(one.source, "alpha");
});

test("mergeAsks ignores an empty source in favour of a named one", () => {
  const merged = Model.mergeAsks({ a: { source: "" }, b: { source: "alsa.monitor" } }, defaults);
  assert.equal(merged.source, "alsa.monitor");
});

test("smoothSpatial leaves the bins alone at zero strength", () => {
  const values = [0, 1, 0];
  assert.deepEqual(Model.smoothSpatial(values, 0), values);
});

test("smoothSpatial spreads a peak into its neighbours", () => {
  const out = Model.smoothSpatial([0, 0, 1, 0, 0], 0.5);
  assert.equal(out[2], 1);
  assert.ok(out[1] > 0 && out[1] < 1);
  assert.ok(out[3] > 0 && out[3] < 1);
  assert.ok(out[1] > out[0], "closer bands should get more of the peak");
});

test("smoothSpatial never exceeds the peak it spread", () => {
  const out = Model.smoothSpatial([0.2, 0.8, 0.3], 0.9);
  for (const value of out) assert.ok(value <= 0.8 + 1e-12);
});

test("smoothSpatial's reused and allocated paths agree", () => {
  const values = [0.1, 0.6, 0.2, 0.9, 0.05];
  for (const strength of [0, 0.35, 1]) {
    assert.deepEqual(
      Model.smoothSpatial(values, strength, [7, 7]),
      Model.smoothSpatial(values, strength).slice(),
      `strength ${strength}`,
    );
  }
});

test("smoothSpatial reads its input, not a stale reused buffer", () => {
  const stale = [5, 5, 5, 5, 5];
  const out = Model.smoothSpatial([0, 0, 1, 0, 0], 0.5, stale);
  for (const value of out) assert.ok(value <= 1, "a stale value must not leak through");
});

test("curve lifts the quiet end without moving the ends", () => {
  assert.equal(Model.curve(0, 0.7), 0);
  assert.equal(Model.curve(1, 0.7), 1);
  assert.ok(Model.curve(0.25, 0.7) > 0.25);
  assert.equal(Model.curve(0.4, 1), 0.4);
});

test("advance moves toward the target and stops there", () => {
  assert.ok(Model.advance(0, 1, 0.016, 26, 9) > 0);
  assert.ok(Model.advance(0, 1, 0.016, 26, 9) < 1);
  assert.equal(Model.advance(0.5, 0.5, 0.016, 26, 9), 0.5);
});

test("advance rises faster than it falls at the same distance", () => {
  const up = Model.advance(0.5, 1, 0.016, 26, 9) - 0.5;
  const down = 0.5 - Model.advance(0.5, 0, 0.016, 26, 9);
  assert.ok(up > down, "attack should outrun release");
});

test("advance is framerate-independent over the same elapsed time", () => {
  let slow = Model.advance(0, 1, 1 / 60, 26, 9);
  for (let i = 1; i < 60; i++) slow = Model.advance(slow, 1, 1 / 60, 26, 9);
  let fast = Model.advance(0, 1, 1 / 144, 26, 9);
  for (let i = 1; i < 144; i++) fast = Model.advance(fast, 1, 1 / 144, 26, 9);
  assert.ok(Math.abs(slow - fast) < 0.002, `${slow} vs ${fast}`);
});

test("advancePeak snaps up to a new peak and starts the hang", () => {
  const cap = Model.advancePeak(0.2, 0.8, 0.016, 0, 0.9);
  assert.equal(cap.value, 0.8);
  assert.equal(cap.hang, 0.35);
});

test("advancePeak holds still while the hang lasts, then slides", () => {
  const held = Model.advancePeak(0.8, 0.1, 0.016, 0.2, 0.9);
  assert.equal(held.value, 0.8);
  assert.ok(held.hang < 0.2);

  const sliding = Model.advancePeak(0.8, 0.1, 0.1, 0, 0.9);
  assert.ok(sliding.value < 0.8);
  assert.equal(sliding.hang, 0);
});

test("advancePeak never falls below the band it caps", () => {
  const cap = Model.advancePeak(0.5, 0.45, 10, 0, 0.9);
  assert.equal(cap.value, 0.45);
});

test("advancePeak fills a supplied object instead of allocating", () => {
  const out = { value: 0, hang: 0 };
  const returned = Model.advancePeak(0.2, 0.8, 0.016, 0, 0.9, out);
  assert.equal(returned, out);
  assert.equal(out.value, 0.8);
});

test("isPlaybackStream needs a stream, and takes either signal", () => {
  assert.equal(Model.isPlaybackStream(null), false);
  assert.equal(Model.isPlaybackStream({ isStream: false, isSink: true }), false);
  assert.equal(Model.isPlaybackStream({ isStream: true, isSink: true }), true);
  assert.equal(Model.isPlaybackStream({ isStream: true, type: "Stream/Output/Audio" }), true);
  assert.equal(Model.isPlaybackStream({ isStream: true, type: "Stream/Input/Audio" }), false);
});

test("cavaConfig emits the raw ascii contract the parser expects", () => {
  const config = Model.cavaConfig(24, 60, 45, "");
  assert.match(config, /^bars = 48$/m, "bars is per channel, and the capture is stereo");
  assert.match(config, /^framerate = 60$/m);
  assert.match(config, /^data_format = ascii$/m);
  assert.match(config, /^channels = stereo$/m);
  assert.match(config, new RegExp(`^ascii_max_range = ${Model.asciiRange}$`, "m"));
  assert.match(config, /^raw_target = \/dev\/stdout$/m);
});

test("cavaConfig scales noise reduction into cava's 0..1", () => {
  assert.match(Model.cavaConfig(24, 60, 45, ""), /^noise_reduction = 0\.45$/m);
  assert.match(Model.cavaConfig(24, 60, 0, ""), /^noise_reduction = 0\.00$/m);
  assert.match(Model.cavaConfig(24, 60, 100, ""), /^noise_reduction = 1\.00$/m);
});

test("cavaConfig falls back to auto and trims a named source", () => {
  assert.match(Model.cavaConfig(24, 60, 45, ""), /^source = auto$/m);
  assert.match(Model.cavaConfig(24, 60, 45, "   "), /^source = auto$/m);
  assert.match(Model.cavaConfig(24, 60, 45, " sink.monitor "), /^source = sink\.monitor$/m);
});

test("clamp holds the ends", () => {
  assert.equal(Model.clamp(-1, 0, 1), 0);
  assert.equal(Model.clamp(2, 0, 1), 1);
  assert.equal(Model.clamp(0.5, 0, 1), 0.5);
});

test("truncate resizes a buffer in place", () => {
  const buffer = [1, 2, 3];
  assert.equal(Model.truncate(buffer, 5), buffer);
  assert.deepEqual(buffer, [1, 2, 3, 0, 0]);
  Model.truncate(buffer, 2);
  assert.deepEqual(buffer, [1, 2]);
});

test("resolve fills in every default from an empty entry", () => {
  const look = Model.resolve({});
  assert.equal(look.style, "Bars");
  assert.equal(look.mode, "Bottom");
  assert.equal(look.palette, "Accent");
  assert.equal(look.peak, "Cap");
  assert.equal(look.filled, false);
  assert.equal(look.bars, 28);
  assert.equal(look.device, "");
  assert.equal(Model.resolve(null).style, "Bars");
});

test("resolve carries 1.4's retired styles forward as options", () => {
  assert.deepEqual(pickLook(Model.resolve({ style: "Area" })), { style: "Wave", filled: true, peak: "Cap" });
  assert.deepEqual(pickLook(Model.resolve({ style: "ridge" })), { style: "Steps", filled: true, peak: "Cap" });
  assert.deepEqual(pickLook(Model.resolve({ style: "Trail" })), { style: "Bars", filled: false, peak: "Trail" });
});

test("resolve maps the old peakHold switch onto peak", () => {
  assert.equal(Model.resolve({ peakHold: false }).peak, "Off");
  assert.equal(Model.resolve({ peakHold: true }).peak, "Cap");
  assert.equal(Model.resolve({ peakHold: false, peak: "Trail" }).peak, "Trail");
});

test("resolve takes a feel preset, and lets a raw knob override it", () => {
  const smooth = Model.resolve({ feel: "Smooth" });
  const punchy = Model.resolve({ feel: "punchy" });
  assert.ok(smooth.fallRate < punchy.fallRate, "Smooth should sink slower than Punchy");
  assert.ok(smooth.smoothing > punchy.smoothing);
  const overridden = Model.resolve({ feel: "Smooth", release: 100 });
  assert.equal(overridden.fallRate, 2 + 100 * 0.28);
  assert.equal(Model.resolve({ feel: "Wobbly" }).riseRate, Model.resolve({}).riseRate);
});

test("resolve clamps numbers and accepts them written as strings", () => {
  assert.equal(Model.resolve({ bars: 999 }).bars, 64);
  assert.equal(Model.resolve({ bars: "16" }).bars, 16);
  assert.equal(Model.resolve({ bars: "lots" }).bars, 28);
  assert.equal(Model.resolve({ device: "  sink.monitor " }).device, "sink.monitor");
});

test("Butterfly draws an even number of bands, half captured per channel", () => {
  assert.equal(Model.drawnBands(27, "Butterfly"), 28);
  assert.equal(Model.capturedBands(27, "Butterfly"), 14);
  assert.equal(Model.drawnBands(27, "Mirror"), 27);
  assert.equal(Model.capturedBands(27, "Mirror"), 27);
});

test("arrange keeps the channels apart in Mirror", () => {
  const a = [], b = [];
  Model.arrange([0.1, 0.2], [0.8, 0.9], 2, "Mirror", a, b, []);
  assert.deepEqual(a, [0.1, 0.2]);
  assert.deepEqual(b, [0.8, 0.9]);
});

test("arrange puts the bass in the middle for Butterfly", () => {
  const a = [];
  Model.arrange([0.1, 0.2], [0.3, 0.4], 4, "Butterfly", a, [], []);
  assert.deepEqual(a, [0.2, 0.1, 0.3, 0.4]);
});

test("arrange draws the louder channel everywhere else", () => {
  const a = [];
  Model.arrange([0.1, 0.9], [0.5, 0.2], 2, "Bottom", a, [], []);
  assert.deepEqual(a, [0.5, 0.9]);
});

test("animate moves a side toward its targets and raises the caps", () => {
  const side = { level: [], peak: [], hang: [] };
  const scratch = { shaped: [], smoothed: [], cap: { value: 0, hang: 0 } };
  const look = Model.resolve({});
  for (let i = 0; i < 30; i++) Model.animate(side, [0, 1, 0], 1 / 60, look, scratch);
  assert.ok(side.level[1] > 0.9, `${side.level[1]}`);
  assert.ok(side.level[0] > 0 && side.level[0] < side.level[1], "smoothing should spread the peak");
  assert.ok(side.peak[1] >= side.level[1]);
});

test("moved skips a frame that lands on the same pixels", () => {
  const keys = [];
  assert.equal(Model.moved(keys, [[0.5, 0.25]], 20), true, "the first frame is always new");
  assert.equal(Model.moved(keys, [[0.51, 0.24]], 20), false, "under half a pixel either way");
  assert.equal(Model.moved(keys, [[0.6, 0.24]], 20), true);
  assert.deepEqual(keys, [12, 5]);
});

test("moved notices a change in shape as well as in value", () => {
  const keys = [];
  Model.moved(keys, [[0.5, 0.5]], 10);
  assert.equal(Model.moved(keys, [[0.5]], 10), true);
  assert.equal(Model.moved(keys, [[0.5], [0]], 10), true);
});

// spectrum.frag unpacks with mod and floor; this is the same arithmetic.
test("packBand round-trips a level and a peak through one float", () => {
  const unpack = (v) => [(v % 4096) / 4095, Math.floor(v / 4096) / 4095];
  for (const [level, peak] of [[0, 0], [1, 1], [0.5, 0.25], [0.001, 0.999]]) {
    const [l, p] = unpack(Model.packBand(level, peak));
    assert.ok(Math.abs(l - level) <= 0.5 / 4095 + 1e-12, `level ${level} -> ${l}`);
    assert.ok(Math.abs(p - peak) <= 0.5 / 4095 + 1e-12, `peak ${peak} -> ${p}`);
  }
  assert.ok(Model.packBand(1, 1) < 2 ** 24, "must stay inside a float's exact integers");
  assert.equal(Model.packBand(undefined, undefined), 0);
  assert.equal(Model.packBand(2, -1), 4095, "out-of-range values are clamped");
});

function pickLook(look) {
  return { style: look.style, filled: look.filled, peak: look.peak };
}
