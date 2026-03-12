/**
 * Generate config.schema.json from the TypeBox schema in src/config/schema.ts.
 *
 * Usage:
 *   pnpm run schema:generate
 *
 * The output file is committed to the repository and served at a stable URL
 * so that config.json5 files can reference it via `$schema`.
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { BeigeConfigSchema } from "../src/config/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "../config.schema.json");

// TypeBox schemas are plain JSON Schema Draft-07 objects — serialize directly.
const jsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  ...BeigeConfigSchema,
};

// Remove internal TypeBox symbols/metadata that aren't valid JSON Schema.
// TypeBox adds [Kind] and [Hint] symbol properties; JSON.stringify skips them.
const output = JSON.stringify(jsonSchema, null, 2);

writeFileSync(outPath, output + "\n", "utf-8");
console.log(`Generated: ${outPath}`);
