// The shader and the widget meet only by name: a ShaderEffect hands each of
// its properties to the uniform of the same name, and a name that matches
// nothing is silently ignored. So a renamed uniform does not fail — it draws
// with zeros. These checks are the cheap guard against that, and against a
// shader edited without being rebuilt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Model } from "./model.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");
const shader = read("spectrum.frag");
const widget = read("Spectrum.qml");

const block = shader.match(/uniform buf \{([\s\S]*?)\};/)[1];
const uniforms = [...block.matchAll(/\b(?:float|vec2|vec4|mat4)\s+(\w+);/g)]
  .map((m) => m[1])
  .filter((name) => !name.startsWith("qt_"))
  .concat([...shader.matchAll(/uniform sampler2D (\w+);/g)].map((m) => m[1]));

const effect = widget.slice(widget.indexOf("ShaderEffect {"));
const properties = [...effect.slice(0, effect.indexOf("\n  }\n")).matchAll(/property \w+ (\w+)/g)]
  .map((m) => m[1]);

test("the compiled shader was rebuilt from the current source", () => {
  const sum = createHash("sha256").update(shader).digest("hex");
  assert.equal(read("spectrum.frag.sha256").trim(), sum,
    "spectrum.frag changed since spectrum.frag.qsb was built — run tools/build-shader.sh");
});

test("every uniform the shader reads is fed by the widget", () => {
  for (const name of uniforms) assert.ok(properties.includes(name), `uniform ${name} has no property`);
});

test("every property on the ShaderEffect reaches a uniform", () => {
  for (const name of properties) assert.ok(uniforms.includes(name), `property ${name} feeds nothing`);
});

test("the shader numbers styles and peaks the way the widget does", () => {
  const numbered = (key) => {
    const line = block.match(new RegExp(`float ${key};\\s*//(.*)`))[1];
    return [...line.matchAll(/(\d+) (\w+)/g)].map((m) => m[2]);
  };
  assert.deepEqual(numbered("style"), Model.styles);
  assert.deepEqual(numbered("peakMode"), Model.peakModes);
});

test("there is room for the most bands a side can have", () => {
  const perSide = uniforms.filter((name) => /^a\d+$/.test(name)).length * 4;
  assert.ok(perSide >= 64, `only ${perSide} bands fit`);
});
