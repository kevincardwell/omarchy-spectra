// The marketplace validates the manifest at submission time and a maintainer
// reviews it by hand after that, so a mistake here is expensive to find. These
// checks are the cheap half of that, run on every push.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Model } from "./model.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));

test("manifest declares every field the marketplace requires", () => {
  for (const field of ["schemaVersion", "id", "name", "version",
                       "author", "description", "kinds", "entryPoints"]) {
    assert.ok(manifest[field] !== undefined && manifest[field] !== "",
      `manifest is missing ${field}`);
  }
});

test("version is semver, so a plugin update can be ordered against it", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("every declared entry point exists", () => {
  for (const entry of Object.values(manifest.entryPoints)) {
    assert.ok(read(entry).length > 0, `entry point ${entry} is missing or empty`);
  }
});

test("every kind has an entry point", () => {
  const points = Object.keys(manifest.entryPoints);
  for (const kind of manifest.kinds) {
    const expected = kind === "bar-widget" ? "barWidget" : kind;
    assert.ok(points.includes(expected), `kind ${kind} has no entry point`);
  }
});

// Drift between these three is invisible until a user opens the settings form
// and finds a control that does nothing.
test("every schema entry has a matching default", () => {
  const defaults = manifest.barWidget.defaults;
  for (const item of manifest.barWidget.schema) {
    assert.ok(item.key in defaults, `schema key ${item.key} has no default`);
    assert.deepEqual(item.defaultValue, defaults[item.key],
      `schema default disagrees with defaults for ${item.key}`);
  }
});

test("every default is exposed in the settings form", () => {
  const declared = new Set(manifest.barWidget.schema.map((item) => item.key));
  for (const key of Object.keys(manifest.barWidget.defaults)) {
    assert.ok(declared.has(key), `${key} has a default but no settings control`);
  }
});

// Settings are read in one place, Model.resolve, which the widget calls.
test("every setting is actually read", () => {
  const model = read("Model.js");
  for (const key of Object.keys(manifest.barWidget.defaults)) {
    assert.match(model, new RegExp(`"${key}"`), `${key} is declared but never read`);
  }
});

// The form shows the manifest's defaults, but an entry written by hand may
// leave any key out; both must land on the same look.
test("an empty entry resolves exactly like the manifest defaults", () => {
  assert.deepEqual(Model.resolve({}), Model.resolve(manifest.barWidget.defaults));
});

test("enum settings default to one of their own options", () => {
  for (const item of manifest.barWidget.schema) {
    if (item.type !== "enum") continue;
    assert.ok(item.options.includes(item.defaultValue),
      `${item.key} defaults to a value not in its options`);
  }
});

test("numeric settings default inside their own range", () => {
  for (const item of manifest.barWidget.schema) {
    if (item.type !== "integer") continue;
    assert.ok(item.defaultValue >= item.min && item.defaultValue <= item.max,
      `${item.key} defaults outside min..max`);
  }
});

// The rings in Model.js are what the scroll wheel, the IPC handlers and the
// validation walk. A value present in one and missing from the form is a dead
// menu entry.
test("the style, mode, colour, peak and feel lists match the manifest options", () => {
  const optionsOf = (key) =>
    manifest.barWidget.schema.find((item) => item.key === key).options;

  assert.deepEqual(Model.styles, optionsOf("style"));
  assert.deepEqual(Model.modes, optionsOf("mode"));
  assert.deepEqual(Model.palettes, optionsOf("color"));
  assert.deepEqual(Model.peakModes, optionsOf("peak"));
  assert.deepEqual(Model.feelNames, optionsOf("feel"));
});

// Including the ones that are only reachable from shell.json.
const advanced = ["sensitivity", "punch", "smoothing", "attack", "release",
                  "framerate", "idleSuspend", "quietDelay", "sleepDelay"];

test("the README documents every setting", () => {
  const readme = read("README.md");
  for (const key of [...Object.keys(manifest.barWidget.defaults), ...advanced]) {
    assert.match(readme, new RegExp(`\`${key}\``), `${key} is undocumented`);
  }
});

test("every advanced setting is still read", () => {
  const model = read("Model.js");
  for (const key of advanced) {
    assert.match(model, new RegExp(`"${key}"`), `${key} is documented but never read`);
  }
});

test("the changelog mentions the version being shipped", () => {
  assert.match(read("CHANGELOG.md"), new RegExp(`## ${manifest.version.replace(/\./g, "\\.")}`),
    `CHANGELOG.md has no entry for ${manifest.version}`);
});
