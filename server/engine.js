// Učitava zajednički motor (web/core.js) s GeoJSON slojevima s diska.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createEngine } from "../web/core.js";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const WEB = path.join(ROOT, "web");

export const engine = createEngine({
  isBrowser: false,
  loadJSON: async (name) => JSON.parse(await readFile(path.join(WEB, "data", name), "utf8")),
});
