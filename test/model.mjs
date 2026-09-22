// Model.js is deliberately free of QML so it can be tested without a running
// shell. It is not a module — the shell loads it as a QML JS resource — so it
// is read and evaluated here with the handful of Qt globals it touches stubbed
// out.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "Model.js"), "utf8");

// The colour helpers are the only part that reaches for Qt. Stubbing it keeps
// them in the test surface instead of forcing them out of the file.
const Qt = {
  rgba: (r, g, b, a) => ({ r, g, b, a }),
  hsva: (h, s, v, a) => ({ h, s, v, a }),
};

// Every top-level function and var, so a new helper needs no export list.
const names = [...source.matchAll(/^(?:function|var)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);

export const Model = new Function("Qt", `${source}\nreturn { ${names.join(", ")} }`)(Qt);
