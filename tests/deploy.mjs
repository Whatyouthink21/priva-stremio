/**
 * Deployment & clean-boot verification suite.
 *
 * Verifies:
 *   - Excluded legacy priva-embed player/embed/remux/ffmpeg artifacts do NOT exist anywhere
 *   - render.yaml matches Render web-service blueprint requirements
 *   - Real child-process boot without a .env file generates ephemeral TOKEN_SECRET + warns loudly,
 *     respects PORT env var, defaults PUBLIC_BASE_URL to http://127.0.0.1:$PORT, and passes /health
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const check = (name, cond, detail = "") => {
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${name}`);
  }
};

const ROOT = process.cwd();

console.log("\n[1] No excluded player / embed / remux / ffmpeg files or dependencies");
const forbiddenPaths = [
  "public/js/player.js",
  "public/js/browse.js",
  "public/embed.js",
  "server/routes/embed.js",
  "server/lib/remux.js",
];
for (const rel of forbiddenPaths) {
  check(`${rel} is absent`, !existsSync(path.join(ROOT, rel)));
}

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
check("package.json has zero ffmpeg dependency", !("@ffmpeg-installer/ffmpeg" in allDeps));
check("package.json has zero dotenv dependency", !("dotenv" in allDeps));
check("npm start uses native Node --env-file flag", pkg.scripts?.start?.includes("--env-file"));

console.log("\n[2] Render blueprint (render.yaml)");
const renderYaml = await fs.readFile(path.join(ROOT, "render.yaml"), "utf8");
check("render.yaml specifies type: web & runtime: node", /type:\s*web/.test(renderYaml) && /runtime:\s*node/.test(renderYaml));
check("render.yaml uses buildCommand: npm ci", /buildCommand:\s*npm ci/.test(renderYaml));
check("render.yaml uses startCommand: npm start", /startCommand:\s*npm start/.test(renderYaml));
check("render.yaml uses healthCheckPath: /health", /healthCheckPath:\s*\/health/.test(renderYaml));
check("render.yaml auto-generates TOKEN_SECRET", /key:\s*TOKEN_SECRET[\s\S]*generateValue:\s*true/.test(renderYaml));

console.log("\n[3] Real subprocess boot without .env (ephemeral TOKEN_SECRET + PORT override)");
const freePort = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
  s.on("error", reject);
});

const env = { ...process.env, PORT: String(freePort), PUBLIC_BASE_URL: "", TOKEN_SECRET: "" };
const child = spawn(process.execPath, ["--env-file-if-exists=.nonexistent.env", "server/index.js"], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));

try {
  const ready = await new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(false), 10_000);
    const poll = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${freePort}/health`);
        if (res.ok) {
          clearTimeout(deadline);
          return resolve(await res.json());
        }
      } catch {}
      setTimeout(poll, 120);
    };
    poll();
  });

  check("subprocess booted and answered /health with HTTP 200", Boolean(ready?.ok), stdout + stderr);
  check("binds to 0.0.0.0:$PORT", stdout.includes(`0.0.0.0:${freePort}`), stdout);
  check(
    "warns loudly on stderr when TOKEN_SECRET is unset",
    stderr.includes("TOKEN_SECRET is empty"),
    stderr,
  );
  check(
    "defaults public base URL to http://127.0.0.1:$PORT",
    stdout.includes(`http://127.0.0.1:${freePort}`),
    stdout,
  );
  check(
    "loads vendored core providers on boot",
    ["castle", "4khdhub", "autoEmbed", "movieBoxWeb"].every((id) =>
      ready.providers.some((p) => p.id === id),
    ),
    JSON.stringify(ready?.providers?.map((p) => p.id)),
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}
