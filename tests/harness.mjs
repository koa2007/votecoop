// Test harness: boots a REAL PocketBase with the repo's real pb_hooks against a
// throwaway data dir, imports the production collection schema, and hands back
// small helpers for talking to it over HTTP.
//
// Why a real instance and not mocks: every defect this suite guards against lives
// in the seam between PocketBase and the JS hooks (how a json field is handed to
// goja, when an update rule is evaluated). A mock would reproduce our assumptions,
// which is exactly what let those defects ship.
//
// Needs the pocketbase binary. Point PB_BIN at it, or drop it in tests/.bin/.
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const SUPERUSER = { email: "harness@test.local", password: "HarnessPassw0rd!" };

function findBinary() {
  if (process.env.PB_BIN && existsSync(process.env.PB_BIN))
    return process.env.PB_BIN;
  for (const name of ["pocketbase.exe", "pocketbase"]) {
    const p = join(HERE, ".bin", name);
    if (existsSync(p)) return p;
  }
  throw new Error(
    "pocketbase binary not found.\n" +
      "Download the version that runs in production and put it in tests/.bin/, " +
      "or set PB_BIN=/path/to/pocketbase.\n" +
      "https://github.com/pocketbase/pocketbase/releases",
  );
}

function run(bin, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { ...opts, stdio: "pipe" });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("close", (code) =>
      code === 0
        ? res(out)
        : rej(new Error(`${args[0]} exited ${code}: ${err || out}`)),
    );
    p.on("error", rej);
  });
}

export async function startPocketBase({ port = 0 } = {}) {
  const bin = findBinary();
  const dataDir = mkdtempSync(join(tmpdir(), "spilka-test-"));
  // PB_HOOKS_DIR lets a run point at a different copy of the hooks — used to
  // confirm a test really fails against the code it was written for.
  const hooksDir = process.env.PB_HOOKS_DIR || join(REPO, "pb_hooks");

  // A fixed port keeps the helpers simple; pick a high one unlikely to clash.
  const httpPort = port || 8090 + Math.floor(Math.random() * 900);
  const base = `http://127.0.0.1:${httpPort}`;

  await run(bin, [
    "superuser",
    "upsert",
    SUPERUSER.email,
    SUPERUSER.password,
    `--dir=${dataDir}`,
  ]);

  const proc = spawn(
    bin,
    [
      "serve",
      `--http=127.0.0.1:${httpPort}`,
      `--dir=${dataDir}`,
      `--hooksDir=${hooksDir}`,
      // Point PB_PUBLIC_DIR at the repo root and this instance also serves the real
      // app, so a change can be looked at in a browser against the real hooks
      // instead of only asserted over HTTP. Unused by the test suite itself.
      ...(process.env.PB_PUBLIC_DIR
        ? [`--publicDir=${process.env.PB_PUBLIC_DIR}`]
        : []),
    ],
    { stdio: "pipe" },
  );

  let log = "";
  proc.stdout.on("data", (d) => {
    log += d;
  });
  proc.stderr.on("data", (d) => {
    log += d;
  });

  await waitFor(
    async () => {
      try {
        const r = await fetch(`${base}/api/health`);
        return r.ok;
      } catch {
        return false;
      }
    },
    20000,
    () => `PocketBase did not come up.\n${log.slice(-2000)}`,
  );

  const admin = await api(
    base,
    "POST",
    "/api/collections/_superusers/auth-with-password",
    {
      identity: SUPERUSER.email,
      password: SUPERUSER.password,
    },
  );

  const collections = JSON.parse(
    readFileSync(join(HERE, "fixtures", "collections.json"), "utf8"),
  );
  await api(
    base,
    "PUT",
    "/api/collections/import",
    { collections, deleteMissing: false },
    admin.token,
  );

  return {
    base,
    adminToken: admin.token,
    log: () => log,
    async stop() {
      proc.kill();
      await new Promise((r) => proc.on("close", r));
    },
  };
}

export async function api(base, method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json body */
  }
  if (!r.ok) {
    const e = new Error(
      `${method} ${path} -> ${r.status}: ${text.slice(0, 400)}`,
    );
    e.status = r.status;
    e.body = json;
    throw e;
  }
  return json;
}

/** Same as api() but returns {status, body} instead of throwing, for negative cases. */
export async function tryApi(base, method, path, body, token) {
  try {
    const body2 = await api(base, method, path, body, token);
    return { status: 200, body: body2 };
  } catch (e) {
    if (e.status) return { status: e.status, body: e.body };
    throw e;
  }
}

export async function makeUser(base, adminToken, email) {
  const password = "TestPassw0rd!";
  const user = await api(
    base,
    "POST",
    "/api/collections/users/records",
    {
      email,
      password,
      passwordConfirm: password,
      verified: true,
    },
    adminToken,
  );
  const auth = await api(
    base,
    "POST",
    "/api/collections/users/auth-with-password",
    {
      identity: email,
      password,
    },
  );
  return { id: user.id, email, token: auth.token };
}

export async function waitFor(fn, timeoutMs, describe) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    typeof describe === "function" ? describe() : describe || "timed out",
  );
}

export { SUPERUSER };
