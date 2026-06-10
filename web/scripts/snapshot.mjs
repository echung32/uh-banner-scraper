#!/usr/bin/env node
// Downloads the remote D1 snapshot to .tmp/snapshot.sql and imports it locally.
//
// Works around a wrangler 4.98.0 / Node 24 incompatibility: `d1 export --output`
// receives a web ReadableStream from fetch() where it expects a Buffer, so the
// local file write throws. The export still completes on S3 and wrangler always
// prints a pre-signed download URL in the output; we use that to fetch the file
// ourselves with Node's native fetch() instead.
import { spawnSync, execSync } from "child_process";
import { writeFileSync, existsSync, mkdirSync } from "fs";

mkdirSync(".tmp", { recursive: true });
const OUTPUT = ".tmp/snapshot.sql";

// Pipe stdin so wrangler treats itself as non-interactive and auto-confirms
// the "Ok to proceed?" prompt with its built-in fallback value "yes".
const result = spawnSync(
  "yarn",
  ["wrangler", "d1", "export", "uh-course-search-db", "--remote", "--output", OUTPUT],
  { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
);
const combined = result.stdout + result.stderr;
process.stdout.write(combined);

if (result.status === 0 && existsSync(OUTPUT)) {
  // wrangler wrote the file successfully — future version fixed the bug.
  console.log("Export wrote file directly.");
} else {
  // Extract the pre-signed S3 URL from wrangler's output.
  const m = combined.match(/https:\/\/\S+/);
  if (!m) {
    console.error("Export failed and no download URL found in output.");
    process.exit(1);
  }
  process.stdout.write("Downloading snapshot from pre-signed URL...\n");
  const res = await fetch(m[0]);
  if (!res.ok) {
    console.error(`Download failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(OUTPUT, buf);
  process.stdout.write(`Downloaded ${buf.length} bytes to ${OUTPUT}\n`);
}

// Import into local D1.
execSync(`yarn wrangler d1 execute uh-course-search-db --local --file ${OUTPUT}`, {
  stdio: "inherit",
});
