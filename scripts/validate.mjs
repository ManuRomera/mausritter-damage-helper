import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../module.json", import.meta.url), "utf8"));
const es = JSON.parse(await readFile(new URL("../lang/es.json", import.meta.url), "utf8"));
const en = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8"));

assert.equal(manifest.id, "mausritter-combat-carousel");
assert.equal(manifest.version, "1.0.0");
assert.equal(manifest.compatibility.minimum, "13");
assert.equal(manifest.compatibility.verified, "13");
assert.ok(manifest.manifest.endsWith("/releases/latest/download/module.json"));
assert.ok(manifest.download.includes(`/v${manifest.version}/`));
assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort(), "Spanish and English translation keys differ");

console.log("Manifest and translations validated.");
