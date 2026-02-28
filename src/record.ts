import { spawn, execSync, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import * as tar from "tar";
import * as zlib from "zlib";
import { chromium } from "playwright";
import { showAnnotation, hideAnnotation, showFinalOverlay, demoClick, demoType, hideCursor } from "./annotations";
import { match } from "assert";

// Load .env file from repo root
const envPath = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?(\w+)=(.*)$/);
    if (match) {
      const [, key, val] = match;
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// ── Config ──────────────────────────────────────────────────────────────

const ADMIN_USER = "johndoe";
const ADMIN_PASS = "demo-password";
const JWT_SECRET = "demo-secret";
const OUTPUT_DIR = path.join(__dirname, "..", "output");

// ── Binary resolution ────────────────────────────────────────────────────
async function getNebiFilename(): Promise<string> {
  const version = await getLatestRelease()
  const platform = process.platform;
  const arch = process.arch;

  let os;
  let ext;
  if (platform === "darwin") {
    os = "macOS"
    ext = ".tar.gz"
  } else if (platform === "win32") {
    os = "windows"
    ext = ".zip"
  } else {
    os = "linux"
    ext = ".tar.gz"
  }

  return `nebi-${version}-${os}-${arch}${ext}`
}

/**
 * @param filename - Filename to extract
 * @param destDir - Directory where the nebi binary should live. Must already exist on filesystem.
 */
async function extract(filename: string, destDir: string) {
  const finalPath = path.join(destDir, "nebi")

  if (filename.endsWith(".tar.gz")) {
    // Extract to the same directory where the archive is, then move to the final destination
    const extractDir = path.dirname(filename)
    await tar.x({f: filename, C: extractDir})
    fs.renameSync(path.join(extractDir, "nebi"), finalPath)
  } else if (filename.endsWith(".zip")) {
    const buf = zlib.unzipSync(fs.readFileSync(filename))
    fs.writeFileSync(finalPath, buf)
  } else {
    throw new Error("Unrecognized artifact filetype; aborting.")
  }

}

async function getLatestRelease(): Promise<string> {
  const result = await fetch("https://api.github.com/repos/nebari-dev/nebi/releases/latest")
  const latestRelease = await result.json()
  return latestRelease['name']
}

async function downloadBinary(dest: string): Promise<void> {
  const filename = await getNebiFilename()
  const url = `https://github.com/nebari-dev/nebi/releases/latest/download/${filename}`;
  console.log(`Downloading nebi binary from ${url}...`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to download binary: ${res.status} ${res.statusText}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const parent = path.dirname(dest)
  const downloadedFilename = path.join(parent, filename)
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(downloadedFilename, buffer);
  await extract(downloadedFilename, dest)
  fs.chmodSync(dest, 0o755);
  console.log(`Binary downloaded to ${dest}`);
}

async function ensureBinary(): Promise<string> {
  // 1. Check PATH
  try {
    execSync("which nebi", { stdio: "ignore" });
    console.log("Using nebi from PATH");
    return "nebi";
  } catch {}

  // 2. Check local ./bin/nebi
  const local = path.join(__dirname, "..", "bin", "nebi");
  if (fs.existsSync(local)) {
    console.log(`Using local binary: ${local}`);
    return local;
  }

  // 3. Download latest release
  await downloadBinary(local);
  return local;
}

// Quay.io credentials for nebari-environments registry (from .env)
const QUAY_USERNAME = process.env.QUAY_USERNAME || "";
const QUAY_PASSWORD = process.env.QUAY_PASSWORD || "";
const QUAY_API_TOKEN = process.env.API_TOKEN || "";

// ── Preflight checks ────────────────────────────────────────────────────

function preflight() {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check Playwright browser
  try {
    const browserPath = execSync("npx playwright install --dry-run chromium 2>&1", { encoding: "utf-8" });
    if (browserPath.includes("not installed")) {
      errors.push("Playwright chromium not installed. Run: npx playwright install chromium");
    }
  } catch {
    // --dry-run may not be supported; try detecting the browser directly
    try {
      execSync("npx playwright install chromium --dry-run", { stdio: "ignore" });
    } catch {
      // Can't reliably detect — skip, Playwright will error at launch
    }
  }

  // Check ffmpeg (needed by convert.sh)
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
  } catch {
    warnings.push("ffmpeg not found — convert.sh will fail. Install via: pixi install / brew install ffmpeg");
  }

  // Check jq (needed by convert.sh)
  try {
    execSync("which jq", { stdio: "ignore" });
  } catch {
    warnings.push("jq not found — convert.sh will fail. Install via: pixi install / brew install jq");
  }

  // Check audio files
  const audioDir = path.join(OUTPUT_DIR, "audio");
  if (!fs.existsSync(audioDir) || !fs.existsSync(path.join(audioDir, "01.wav"))) {
    warnings.push("Audio files not found in output/audio/. Run: pixi run audio");
  }

  // Check Quay.io credentials
  if (!QUAY_USERNAME || !QUAY_PASSWORD) {
    warnings.push("QUAY_USERNAME / QUAY_PASSWORD not set — registry & publish scenes will be limited");
  }
  if (!QUAY_API_TOKEN) {
    warnings.push("API_TOKEN not set — registry browsing will be limited");
  }

  if (errors.length > 0) {
    console.error("\n✗ Preflight failed:");
    for (const e of errors) console.error(`  - ${e}`);
    if (warnings.length > 0) {
      console.warn("\n⚠ Warnings:");
      for (const w of warnings) console.warn(`  - ${w}`);
    }
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn("\n⚠ Preflight warnings:");
    for (const w of warnings) console.warn(`  - ${w}`);
    console.warn("");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("could not get port"));
      }
    });
  });
}

// ── Server lifecycle ────────────────────────────────────────────────────

async function startServer(port: number, binary: string): Promise<ChildProcess> {
  const tmpDb = path.join(OUTPUT_DIR, "demo.db");
  // Clean old DB
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NEBI_DATABASE_DRIVER: "sqlite",
    NEBI_QUEUE_TYPE: "memory",
    NEBI_DATABASE_DSN: tmpDb,
    NEBI_AUTH_JWT_SECRET: JWT_SECRET,
    NEBI_SERVER_PORT: String(port),
    ADMIN_USERNAME: ADMIN_USER,
    ADMIN_PASSWORD: ADMIN_PASS,
    NEBI_SERVER_MODE: "test",
  };

  const child = spawn(binary, ["serve"], { env, stdio: "pipe" });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

  // Poll health
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/v1/health`);
      if (res.ok) {
        console.log("Server healthy");
        return child;
      }
    } catch {
      // not ready yet
    }
    await sleep(100);
  }
  child.kill();
  throw new Error("Server failed to start within 10s");
}

function stopServer(child: ChildProcess) {
  child.kill("SIGTERM");
}

// ── API helpers ─────────────────────────────────────────────────────────

async function api(
  base: string,
  method: string,
  endpoint: string,
  body?: unknown,
  token?: string,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${endpoint} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function login(base: string): Promise<string> {
  const data = (await api(base, "POST", "/api/v1/auth/login", {
    username: ADMIN_USER,
    password: ADMIN_PASS,
  })) as { token: string };
  return data.token;
}

async function waitForWorkspaceReady(base: string, token: string, wsId: string, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ws = (await api(base, "GET", `/api/v1/workspaces/${wsId}`, undefined, token)) as {
      status: string;
    };
    if (ws.status === "ready") return;
    if (ws.status === "failed") throw new Error(`Workspace ${wsId} creation failed`);
    await sleep(500);
  }
  throw new Error(`Workspace ${wsId} timed out waiting for ready`);
}

// ── Data seeding ────────────────────────────────────────────────────────

const PIXI_TOML_V1 = `[workspace]
name = "ml-pipeline"
channels = ["conda-forge"]
platforms = ["linux-64", "osx-arm64", "osx-64"]

[dependencies]
python = ">=3.11"
numpy = ">=1.26"
pandas = ">=2.1"
`;

const PIXI_TOML_V2 = `[workspace]
name = "ml-pipeline"
channels = ["conda-forge"]
platforms = ["linux-64", "osx-arm64", "osx-64"]

[dependencies]
python = ">=3.11"
numpy = ">=1.26"
pandas = ">=2.1"
scikit-learn = ">=1.3"
matplotlib = ">=3.8"
`;

const PIXI_TOML_V3 = `[workspace]
name = "ml-pipeline"
channels = ["conda-forge"]
platforms = ["linux-64", "osx-arm64", "osx-64"]

[dependencies]
python = ">=3.11"
numpy = ">=1.26"
pandas = ">=2.1"
scikit-learn = ">=1.3"
matplotlib = ">=3.8"
jupyterlab = ">=4.0"
seaborn = ">=0.13"
`;

async function seedData(base: string) {
  logPhase("Seeding data (7 steps)");
  const token = await login(base);

  // 1. Create workspace "ml-pipeline"
  console.log("  [1/7] Creating workspace ml-pipeline...");
  const ws1 = (await api(base, "POST", "/api/v1/workspaces", {
    name: "ml-pipeline",
    package_manager: "pixi",
    source: "managed",
    pixi_toml: PIXI_TOML_V1,
  }, token)) as { id: string };

  // Wait for workspace to become ready (create job runs in background)
  console.log("        Waiting for ml-pipeline to be ready...");
  await waitForWorkspaceReady(base, token, ws1.id);

  // 2. Push 3 versions with evolving pixi.toml
  console.log("  [2/7] Pushing versions v1.0, v2.0, v3.0...");
  await api(base, "POST", `/api/v1/workspaces/${ws1.id}/push`, {
    tag: "v1.0",
    pixi_toml: PIXI_TOML_V1,
  }, token);

  await api(base, "POST", `/api/v1/workspaces/${ws1.id}/push`, {
    tag: "v2.0",
    pixi_toml: PIXI_TOML_V2,
  }, token);

  await api(base, "POST", `/api/v1/workspaces/${ws1.id}/push`, {
    tag: "v3.0",
    pixi_toml: PIXI_TOML_V3,
  }, token);

  // 3. Create second workspace
  console.log("  [3/7] Creating workspace web-dashboard...");
  const ws2 = (await api(base, "POST", "/api/v1/workspaces", {
    name: "web-dashboard",
    package_manager: "pixi",
    source: "managed",
  }, token)) as { id: string };

  console.log("        Waiting for web-dashboard to be ready...");
  await waitForWorkspaceReady(base, token, ws2.id);

  // 4. Create user "alice"
  console.log("  [4/7] Creating user alice...");
  await api(base, "POST", "/api/v1/admin/users", {
    username: "alice",
    email: "alice@example.com",
    password: "alice-password",
  }, token);

  // 5. Update the default nebari-environments registry with API token for browsing
  //    (this is a public read-only registry that ships with every Nebi installation)
  console.log("  [5/7] Configuring nebari-environments registry...");
  const registries = (await api(base, "GET", "/api/v1/registries", undefined, token)) as Array<{ id: string; name: string }>;
  const nebiRegistry = registries.find((r) => r.name === "nebari-environments");
  if (nebiRegistry && QUAY_API_TOKEN) {
    await api(base, "PUT", `/api/v1/admin/registries/${nebiRegistry.id}`, {
      api_token: QUAY_API_TOKEN,
      is_default: false,
    }, token);
    console.log("  Updated nebari-environments with API token");
  }

  // 6. Create a writable registry for publishing (team has write access)
  console.log("  [6/7] Creating team-environments registry...");
  if (QUAY_USERNAME && QUAY_PASSWORD) {
    await api(base, "POST", "/api/v1/admin/registries", {
      name: "team-environments",
      url: "quay.io",
      namespace: "nebari_environments",
      username: QUAY_USERNAME,
      password: QUAY_PASSWORD,
      api_token: QUAY_API_TOKEN || undefined,
      is_default: true,
    }, token);
    console.log("  Created team-environments (default, writable)");
  }

  // 7. Set avatar for admin user (no API for this, update DB directly)
  console.log("  [7/7] Setting avatar for admin user...");
  const tmpDb = path.join(OUTPUT_DIR, "demo.db");
  // Use a data URI so no external requests or backend changes needed
  const avatarSvg = fs.readFileSync(path.join(__dirname, "..", "assets", "demo-avatar.svg"));
  const avatarUrl = `data:image/svg+xml;base64,${avatarSvg.toString("base64")}`;
  execSync(`sqlite3 "${tmpDb}" "UPDATE users SET avatar_url='${avatarUrl}' WHERE username='${ADMIN_USER}'"`);

  logPhase("Seeding complete");
}

// ── Recording ───────────────────────────────────────────────────────────

const TOTAL_SCENES = 16;
const SCENE_NAMES = [
  "Login",
  "Workspace list",
  "Workspace detail",
  "Packages",
  "pixi.toml",
  "Version History",
  "Publish",
  "Share/Collaborators",
  "Jobs",
  "Registries",
  "Browse & Import",
  "Admin dashboard",
  "User management",
  "Registries (admin)",
  "Audit logs",
  "Final overlay",
];

const SEPARATOR = "═".repeat(60);

function logPhase(title: string) {
  console.log(`\n${SEPARATOR}`);
  console.log(`  ${title}`);
  console.log(SEPARATOR);
}

function logScene(n: number, elapsed: number) {
  const name = SCENE_NAMES[n - 1] || `Scene ${n}`;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const ts = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
  console.log(`\n  [${n}/${TOTAL_SCENES}] ${name} (${ts} elapsed)`);
}

async function recordDemo(base: string) {
  const mode = process.argv.includes("--headless") || process.env.HEADLESS === "1" ? "headless" : "headed";
  logPhase(`Recording ${TOTAL_SCENES} scenes (${mode})`);

  // Load audio durations (generated by generate_audio.py) for timing guards.
  // This ensures NO overlapping clips and NO empty spaces — each scene waits
  // exactly until the current audio clip finishes before starting the next.
  const durationsPath = path.join(OUTPUT_DIR, "audio", "durations.json");
  const audioDurations: Record<string, number> = fs.existsSync(durationsPath)
    ? JSON.parse(fs.readFileSync(durationsPath, "utf-8"))
    : {};

  const headless = process.argv.includes("--headless") || process.env.HEADLESS === "1";
  // In headless mode, Chromium needs --force-device-scale-factor to honor DPI
  // for video capture (without it, content renders at 1x in top-left corner).
  const browser = await chromium.launch({
    headless,
    args: headless ? ["--force-device-scale-factor=2"] : [],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 3840, height: 2160 },
    },
  });
  const page = await context.newPage();

  // Timestamp tracking for audio sync
  const recordingStart = Date.now();
  const timestamps: Array<{ audio: string; start_ms: number }> = [];

  // Timing guard: ensures the previous audio clip has finished before
  // we record the next timestamp. This prevents both overlaps and gaps.
  let lastClipStart = 0;
  let lastClipDuration = 0;

  function markAudioStart(clip: string) {
    const now = Date.now() - recordingStart;
    // Wait if previous clip hasn't finished yet
    const prevEnd = lastClipStart + lastClipDuration;
    const waitNeeded = prevEnd - now;
    timestamps.push({ audio: clip, start_ms: now });
    lastClipStart = now;
    lastClipDuration = audioDurations[clip] || 0;
    console.log(`    Audio ${clip}: start=${now}ms, duration=${lastClipDuration}ms`);
    return waitNeeded;
  }

  // Wait until the current audio clip finishes playing.
  // Call this before transitioning to the next scene.
  async function waitForClipEnd() {
    const now = Date.now() - recordingStart;
    const prevEnd = lastClipStart + lastClipDuration;
    const waitNeeded = prevEnd - now;
    if (waitNeeded > 0) {
      console.log(`    Waiting ${waitNeeded}ms for clip to finish`);
      await sleep(waitNeeded);
    }
  }

  // Scene 1: Login — narration plays over login actions
  logScene(1, Date.now() - recordingStart);
  await page.goto(`${base}/login`);
  await page.getByPlaceholder("Username").waitFor();
  markAudioStart("01.wav");
  await sleep(500);
  await demoClick(page, page.getByPlaceholder("Username"));
  await demoType(page, page.getByPlaceholder("Username"), ADMIN_USER);
  await sleep(200);
  await demoClick(page, page.getByPlaceholder("Password"));
  await demoType(page, page.getByPlaceholder("Password"), ADMIN_PASS);
  await sleep(200);
  await demoClick(page, page.getByRole("button", { name: "Sign in", exact: true }));
  await page.waitForURL("**/workspaces");
  await waitForClipEnd();

  // Scene 2: Workspace list
  logScene(2, Date.now() - recordingStart);
  await page.getByRole("heading", { name: "Workspaces" }).waitFor();
  markAudioStart("02.wav");
  await showAnnotation(page, "Manage workspaces for your team");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scenes follow the UI tab order:
  // Overview → Packages → pixi.toml → Version History → Publications → Collaborators

  // Scene 3: Workspace detail (Overview)
  logScene(3, Date.now() - recordingStart);
  await demoClick(page, page.getByText("ml-pipeline").first());
  await page.getByText("Workspace details and packages").waitFor();
  markAudioStart("03.wav");
  await showAnnotation(page, "Full workspace overview");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 4: Packages — install scipy
  logScene(4, Date.now() - recordingStart);
  await demoClick(page, page.getByText("Packages", { exact: true }));
  await sleep(300);
  markAudioStart("04.wav");
  const installBtn = page.getByText("Install Package");
  if (await installBtn.isVisible()) {
    await demoClick(page, installBtn);
    await sleep(200);
  }
  const pkgInput = page.getByPlaceholder("Package name");
  if (await pkgInput.isVisible()) {
    await demoClick(page, pkgInput);
    await demoType(page, pkgInput, "scipy");
    await sleep(200);
    const installConfirmBtn = page.getByRole("button", { name: "Install", exact: true });
    await demoClick(page, installConfirmBtn);
    await showAnnotation(page, "Installing scipy...");
    await page.getByText("scipy").first().waitFor({ timeout: 120000 });
    await hideAnnotation(page);
  }
  await showAnnotation(page, "Install packages with one click");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 5: pixi.toml tab
  logScene(5, Date.now() - recordingStart);
  markAudioStart("05.wav");
  await demoClick(page, page.getByText("pixi.toml", { exact: true }));
  await sleep(300);
  const editBtn = page.getByRole("button", { name: "Edit" }).first();
  if (await editBtn.isVisible()) {
    await demoClick(page, editBtn);
  }
  await showAnnotation(page, "Edit pixi.toml directly");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 6: Version History — expand an older version to show rollback
  logScene(6, Date.now() - recordingStart);
  markAudioStart("06.wav");
  await demoClick(page, page.getByText("Version History", { exact: true }));
  await sleep(500);
  // Click the expand button on the second version card (first non-latest)
  // Version cards each have a ghost button with ChevronRight icon
  const versionCards = page.locator("[class*='border'][class*='rounded']").filter({ has: page.locator("h3") });
  const secondVersion = versionCards.nth(1);
  await secondVersion.waitFor();
  const expandBtn = secondVersion.locator("button").filter({ has: page.locator("svg") }).first();
  await demoClick(page, expandBtn);
  await sleep(500);
  await showAnnotation(page, "Version history with rollback");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 7: Publish workspace to OCI registry
  // Navigate to Publications tab first, publish, then show the artifact in the tab
  logScene(7, Date.now() - recordingStart);
  await demoClick(page, page.locator("button").filter({ hasText: /^Publications/ }));
  await sleep(500);
  markAudioStart("07.wav");
  await demoClick(page, page.getByRole("button", { name: "Publish" }));
  await page.getByText("Publish Workspace to OCI Registry").waitFor();
  await sleep(800);
  await showAnnotation(page, "Publish to OCI registries");
  await sleep(500);
  // Form auto-populates with defaults; click publish without changing anything
  await demoClick(page, page.locator("button[type='submit']").filter({ hasText: "Publish" }));
  await page.getByText("Published successfully!").waitFor({ timeout: 30000 });
  await waitForClipEnd();
  await hideAnnotation(page);
  // Dialog auto-closes after 2s and triggers page reload
  await sleep(3000);
  await page.getByText("Workspace details and packages").waitFor({ timeout: 10000 }).catch(() => {});
  await sleep(500);
  // Navigate back to Publications tab to show the published artifact
  await demoClick(page, page.locator("button").filter({ hasText: /^Publications/ }));
  await sleep(1000);

  // Scene 8: Share workspace with team member (Collaborators)
  // Navigate to Collaborators tab first, share, then show collaborator in the tab
  logScene(8, Date.now() - recordingStart);
  await demoClick(page, page.locator("button").filter({ hasText: /^Collaborators/ }));
  await sleep(500);
  markAudioStart("08.wav");
  await demoClick(page, page.getByRole("button", { name: "Share" }));
  await page.getByText("Share Workspace").waitFor();
  await sleep(500);
  // Select alice from the user dropdown (Radix select)
  await demoClick(page, page.getByText("Select user..."));
  await sleep(300);
  await demoClick(page, page.locator("[role='option']").filter({ hasText: "alice" }));
  await sleep(300);
  // Change role to editor (Radix select)
  await demoClick(page, page.locator("button").filter({ hasText: "Viewer" }));
  await sleep(300);
  await demoClick(page, page.locator("[role='option']").filter({ hasText: "Editor" }));
  await sleep(300);
  await demoClick(page, page.getByRole("button", { name: "Add Collaborator" }));
  await showAnnotation(page, "Share with your team");
  await waitForClipEnd();
  await hideAnnotation(page);
  // Close the share dialog by clicking the backdrop overlay (top-left corner)
  await page.mouse.click(10, 10);
  await page.getByText("Share Workspace").waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
  await sleep(500);

  // Scene 9: Jobs page
  logScene(9, Date.now() - recordingStart);
  await demoClick(page, page.locator("header nav").getByText("Jobs"));
  await page.getByText("View all job executions").waitFor();
  markAudioStart("09.wav");
  const jobCard = page.locator("[class*='card']").first();
  if (await jobCard.isVisible()) {
    await demoClick(page, jobCard);
    await sleep(500);
  }
  await showAnnotation(page, "Real-time job logs");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 10: Registries page
  logScene(10, Date.now() - recordingStart);
  await demoClick(page, page.locator("header nav").getByText("Registries"));
  await page.getByText("Browse OCI registries").waitFor();
  markAudioStart("10.wav");
  await showAnnotation(page, "Connected OCI registries");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 11: Browse registry and import (narration during browse + import)
  logScene(11, Date.now() - recordingStart);
  await demoClick(page, page.getByRole("button", { name: "Browse" }).first());
  await page.getByText("Browse repositories in this registry").waitFor();
  await page.getByRole("table").getByRole("button", { name: "View Tags" }).first().waitFor({ timeout: 30000 });
  markAudioStart("11.wav");
  await showAnnotation(page, "Browse environments in the registry");
  await sleep(3000);
  await hideAnnotation(page);

  // View Tags → Import flow (continues during narration)
  await demoClick(page, page.getByRole("table").getByRole("button", { name: "View Tags" }).first());
  await page.getByText("Select a tag to import").waitFor();
  await page.getByRole("table").getByRole("button", { name: "Import", exact: true }).first().waitFor({ timeout: 15000 });
  await demoClick(page, page.getByRole("table").getByRole("button", { name: "Import", exact: true }).first());
  await showAnnotation(page, "Import environments with one click");
  const wsNameInput = page.getByPlaceholder("Enter workspace name");
  await wsNameInput.waitFor();
  await demoClick(page, wsNameInput);
  await demoType(page, wsNameInput, "imported-env");
  const importCard = page.locator("[class*='card']", { has: page.getByText("Import Environment") });
  await demoClick(page, importCard.getByRole("button", { name: "Import", exact: true }));
  await page.waitForURL("**/workspaces", { timeout: 60000 });
  await hideAnnotation(page);
  await waitForClipEnd();

  // Scene 12: Admin dashboard
  logScene(12, Date.now() - recordingStart);
  await demoClick(page, page.locator("header a[href='/admin']"));
  await page.getByText("System overview and management").waitFor();
  markAudioStart("12.wav");
  await showAnnotation(page, "Admin dashboard");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 13: User management
  logScene(13, Date.now() - recordingStart);
  markAudioStart("13.wav");
  await demoClick(page, page.getByText("Users", { exact: true }));
  await showAnnotation(page, "Multi-user access control");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 14: Registries (admin)
  logScene(14, Date.now() - recordingStart);
  markAudioStart("14.wav");
  await demoClick(page, page.locator("aside").getByText("Registries"));
  await showAnnotation(page, "Manage OCI registries");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 15: Audit logs
  logScene(15, Date.now() - recordingStart);
  markAudioStart("15.wav");
  await demoClick(page, page.locator("aside").getByText("Logs"));
  await showAnnotation(page, "Complete audit trail");
  await waitForClipEnd();
  await hideAnnotation(page);

  // Scene 16: Final overlay
  logScene(16, Date.now() - recordingStart);
  await hideCursor(page);
  markAudioStart("16.wav");
  const logoPng = fs.readFileSync(path.join(__dirname, "..", "assets", "nebi-icon.png"));
  const logoDataUri = `data:image/png;base64,${logoPng.toString("base64")}`;
  await showFinalOverlay(page, logoDataUri);
  await waitForClipEnd();

  // Write audio timestamps for convert.sh
  const tsPath = path.join(OUTPUT_DIR, "timestamps.json");
  fs.writeFileSync(tsPath, JSON.stringify(timestamps, null, 2));
  console.log(`Timestamps saved: ${tsPath}`);

  // Stop recording — saveAs must be called before context.close()
  const videoPath = path.join(OUTPUT_DIR, "demo.webm");
  await page.close();
  const video = page.video();
  if (video) {
    await video.saveAs(videoPath);
    console.log(`Recording saved: ${videoPath}`);
  }
  await context.close();
  await browser.close();

  const totalSecs = Math.round((Date.now() - recordingStart) / 1000);
  logPhase(`Recording complete: ${TOTAL_SCENES} scenes in ${Math.floor(totalSecs / 60)}m${totalSecs % 60}s`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  preflight();

  // Clean old output (preserve audio/ subdirectory from generate_audio.py)
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const f of fs.readdirSync(OUTPUT_DIR)) {
      const full = path.join(OUTPUT_DIR, f);
      if (fs.statSync(full).isFile()) fs.unlinkSync(full);
    }
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  logPhase("Resolving nebi binary");
  const binary = await ensureBinary();

  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;
  logPhase(`Starting server on port ${port}`);

  let server: ChildProcess | undefined;
  try {
    server = await startServer(port, binary);
    await seedData(base);
    await recordDemo(base);
  } finally {
    if (server) stopServer(server);
  }

  logPhase("Done! Run 'bash convert.sh' to generate MP4 and GIF.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
