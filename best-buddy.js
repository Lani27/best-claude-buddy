#!/usr/bin/env bun

// best-buddy.js — Find the highest-stat Claude Code companion matching your preferences
// Scans millions of salts to find the optimal PRNG seed, then patches the Claude binary.
//
// Usage:
//   bun best-buddy.js --species dragon --eye ✦ --hat crown --peak CHAOS --name "Sparky" --personality "Judges your variable names"
//   bun best-buddy.js --species cat --hat propeller --name "Whiskers"
//   bun best-buddy.js --list                                  # show all options
//   bun best-buddy.js --current                               # show current companion
//   bun best-buddy.js --restore                               # restore original binary
//   bun best-buddy.js --dry-run --species dragon              # find best without patching

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, statSync, realpathSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { execSync } from "child_process";
import { parseArgs } from "util";
import chalk from "chalk";

if (typeof Bun === "undefined") {
  console.error("best-buddy requires Bun runtime (uses Bun.hash).\nInstall: https://bun.sh");
  process.exit(1);
}

// ── Constants (synced with buddy-reroll / Claude Code) ──────────────────

const ORIGINAL_SALT = "friend-2026-401";
const SALT_LEN = ORIGINAL_SALT.length;

const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];
const RARITY_WEIGHTS = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 };
const RARITY_TOTAL = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
const RARITY_FLOOR = { common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50 };

const SPECIES = [
  "duck", "goose", "blob", "cat", "dragon", "octopus", "owl", "penguin",
  "turtle", "snail", "ghost", "axolotl", "capybara", "cactus", "robot",
  "rabbit", "mushroom", "chonk",
];

const EYES = ["·", "✦", "×", "◉", "@", "°"];
const HATS = ["none", "crown", "tophat", "propeller", "halo", "wizard", "beanie", "tinyduck"];
const STAT_NAMES = ["DEBUGGING", "PATIENCE", "CHAOS", "WISDOM", "SNARK"];

const RARITY_COLORS = {
  common: "white",
  uncommon: "greenBright",
  rare: "blueBright",
  epic: "magentaBright",
  legendary: "yellowBright",
};

const RARITY_STARS = {
  common: "★",
  uncommon: "★★",
  rare: "★★★",
  epic: "★★★★",
  legendary: "★★★★★",
};

// ── PRNG (identical to buddy-reroll / Claude Code) ──────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  return Number(BigInt(Bun.hash(s)) & 0xffffffffn);
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function rollRarity(rng) {
  let roll = rng() * RARITY_TOTAL;
  for (const r of RARITIES) {
    roll -= RARITY_WEIGHTS[r];
    if (roll < 0) return r;
  }
  return "common";
}

function rollFrom(salt, userId) {
  const rng = mulberry32(hashString(userId + salt));
  const rarity = rollRarity(rng);
  const species = pick(rng, SPECIES);
  const eye = pick(rng, EYES);
  const hat = rarity === "common" ? "none" : pick(rng, HATS);
  const shiny = rng() < 0.01;

  const floor = RARITY_FLOOR[rarity];
  const peak = pick(rng, STAT_NAMES);
  let dump = pick(rng, STAT_NAMES);
  while (dump === peak) dump = pick(rng, STAT_NAMES);
  const stats = {};
  for (const name of STAT_NAMES) {
    if (name === peak) stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30));
    else if (name === dump) stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15));
    else stats[name] = floor + Math.floor(rng() * 40);
  }

  return { rarity, species, eye, hat, shiny, stats, peak, dump };
}

// ── Path detection (from buddy-reroll) ──────────────────────────────────

function getClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function findBinaryPath() {
  const isWin = platform() === "win32";
  try {
    const cmd = isWin ? "where.exe claude 2>nul" : "which -a claude 2>/dev/null";
    const allPaths = execSync(cmd, { encoding: "utf-8" }).trim().split("\n");
    for (const entry of allPaths) {
      try {
        const resolved = realpathSync(entry.trim());
        if (resolved && existsSync(resolved) && statSync(resolved).size > 1_000_000) return resolved;
      } catch {}
    }
  } catch {}

  const versionsDirs = [
    join(homedir(), ".local", "share", "claude", "versions"),
    ...(isWin ? [join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Claude", "versions")] : []),
  ];
  for (const versionsDir of versionsDirs) {
    if (!existsSync(versionsDir)) continue;
    try {
      const versions = readdirSync(versionsDir).filter((f) => !f.includes(".backup")).sort();
      if (versions.length > 0) return join(versionsDir, versions[versions.length - 1]);
    } catch {}
  }
  return null;
}

function findConfigPath() {
  const claudeDir = getClaudeConfigDir();
  const legacyPath = join(claudeDir, ".config.json");
  if (existsSync(legacyPath)) return legacyPath;
  const home = process.env.CLAUDE_CONFIG_DIR || homedir();
  const defaultPath = join(home, ".claude.json");
  if (existsSync(defaultPath)) return defaultPath;
  if (platform() === "win32" && process.env.APPDATA) {
    const appDataPath = join(process.env.APPDATA, "Claude", "config.json");
    if (existsSync(appDataPath)) return appDataPath;
  }
  return null;
}

function getUserId(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return config.oauthAccount?.accountUuid ?? config.userID ?? "anon";
}

// ── Salt detection (from buddy-reroll) ──────────────────────────────────

function findCurrentSalt(binaryData) {
  if (binaryData.includes(Buffer.from(ORIGINAL_SALT))) return ORIGINAL_SALT;

  const text = binaryData.toString("latin1");
  const patterns = [
    new RegExp(`x{${SALT_LEN - 8}}\\d{8}`, "g"),
    new RegExp(`friend-\\d{4}-.{${SALT_LEN - 12}}`, "g"),
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      if (m[0].length === SALT_LEN) return m[0];
    }
  }

  const saltRegex = new RegExp(`"([a-zA-Z0-9_-]{${SALT_LEN}})"`, "g");
  const candidates = new Set();
  const markers = ["rollRarity", "CompanionBones", "inspirationSeed", "companionUserId"];
  for (const marker of markers) {
    const markerIdx = text.indexOf(marker);
    if (markerIdx === -1) continue;
    const window = text.slice(Math.max(0, markerIdx - 5000), Math.min(text.length, markerIdx + 5000));
    let match;
    while ((match = saltRegex.exec(window)) !== null) candidates.add(match[1]);
  }
  for (const c of candidates) {
    if (/[\d-]/.test(c)) return c;
  }
  return null;
}

// ── Binary patching (from buddy-reroll) ─────────────────────────────────

function isClaudeRunning() {
  try {
    if (platform() === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV 2>nul', { encoding: "utf-8" });
      return out.toLowerCase().includes("claude.exe");
    }
    const out = execSync("pgrep -af claude 2>/dev/null", { encoding: "utf-8" });
    return out.split("\n").some((line) => !line.includes("best-buddy") && line.trim().length > 0);
  } catch {
    return false;
  }
}

function patchBinary(binaryPath, oldSalt, newSalt) {
  if (oldSalt.length !== newSalt.length) {
    throw new Error(`Salt length mismatch: "${oldSalt}" (${oldSalt.length}) vs "${newSalt}" (${newSalt.length})`);
  }
  const data = readFileSync(binaryPath);
  const oldBuf = Buffer.from(oldSalt);
  const newBuf = Buffer.from(newSalt);
  let count = 0;
  let idx = 0;
  while (true) {
    idx = data.indexOf(oldBuf, idx);
    if (idx === -1) break;
    newBuf.copy(data, idx);
    count++;
    idx += newBuf.length;
  }
  if (count === 0) throw new Error(`Salt "${oldSalt}" not found in binary`);

  const isWin = platform() === "win32";
  const maxRetries = isWin ? 3 : 1;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(binaryPath, data);
      return count;
    } catch (err) {
      if (isWin && (err.code === "EACCES" || err.code === "EPERM" || err.code === "EBUSY") && attempt < maxRetries - 1) {
        execSync("timeout /t 2 /nobreak >nul 2>&1", { shell: true, stdio: "ignore" });
        continue;
      }
      throw new Error(`Failed to write binary: ${err.message}${isWin ? " (ensure Claude Code is fully closed)" : ""}`);
    }
  }
}

function resignBinary(binaryPath) {
  if (platform() !== "darwin") return false;
  try {
    execSync(`codesign -s - --force "${binaryPath}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function writeCompanion(configPath, companionData) {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);
  config.companion = companionData;
  delete config.companionMuted;
  const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
  writeFileSync(configPath, JSON.stringify(config, null, indent) + "\n");
}

function clearCompanion(configPath) {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);
  delete config.companion;
  delete config.companionMuted;
  const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
  writeFileSync(configPath, JSON.stringify(config, null, indent) + "\n");
}

// ── Matching ────────────────────────────────────────────────────────────

function matches(roll, target) {
  if (target.species && roll.species !== target.species) return false;
  if (target.rarity && roll.rarity !== target.rarity) return false;
  if (target.eye && roll.eye !== target.eye) return false;
  if (target.hat && roll.hat !== target.hat) return false;
  if (target.shiny !== undefined && roll.shiny !== target.shiny) return false;
  if (target.peak && roll.peak !== target.peak) return false;
  if (target.dump && roll.dump !== target.dump) return false;
  return true;
}

// ── Display ─────────────────────────────────────────────────────────────

function formatCard(result, salt, name, personality) {
  const colorFn = chalk[RARITY_COLORS[result.rarity]] ?? chalk.white;
  const stars = RARITY_STARS[result.rarity] ?? "";
  const total = Object.values(result.stats).reduce((a, b) => a + b, 0);

  const lines = [];
  if (name) lines.push(colorFn.bold(`  "${name}"`));
  lines.push(colorFn(`  ${result.species} | ${result.rarity}${result.shiny ? " ✦shiny" : ""} | eye:${result.eye} | hat:${result.hat}`));
  lines.push(colorFn(`  ${stars}  total: ${total}`));
  if (personality) lines.push(chalk.italic.dim(`  "${personality}"`));
  if (salt) lines.push(chalk.dim(`  salt: ${salt}`));
  lines.push("");

  for (const s of STAT_NAMES) {
    const v = result.stats[s];
    const filled = Math.min(10, Math.max(0, Math.round(v / 10)));
    const bar = colorFn("█".repeat(filled) + "░".repeat(10 - filled));
    const label = s === result.peak ? `${s} ▲` : s === result.dump ? `${s} ▼` : s;
    lines.push(`  ${label.padEnd(13)} ${bar} ${String(v).padStart(3)}`);
  }

  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    species:     { type: "string" },
    rarity:      { type: "string" },
    eye:         { type: "string" },
    hat:         { type: "string" },
    peak:        { type: "string" },
    dump:        { type: "string" },
    name:        { type: "string" },
    personality: { type: "string" },
    shiny:       { type: "boolean", default: undefined },
    scan:        { type: "string", default: "50000000" },
    threads:     { type: "string" },
    perfect:     { type: "boolean", default: false },
    "dry-run":   { type: "boolean", default: false },
    list:        { type: "boolean", default: false },
    current:     { type: "boolean", default: false },
    restore:     { type: "boolean", default: false },
    help:        { type: "boolean", short: "h", default: false },
  },
  strict: false,
});

console.log(chalk.yellowBright("\n  best-buddy") + chalk.dim(" — find the highest-stat companion\n"));

// ── --help ──

if (args.help) {
  console.log(`  ${chalk.bold("Usage:")}
    bun best-buddy.js --species dragon --eye ✦ --hat crown --peak CHAOS --name "Sparky"
    bun best-buddy.js --species cat --name "Whiskers" --personality "Judges your variable names"
    bun best-buddy.js --list
    bun best-buddy.js --current
    bun best-buddy.js --restore
    bun best-buddy.js --dry-run --species dragon --rarity legendary

  ${chalk.bold("Target flags")} (all optional — omit to leave unconstrained):
    --species <name>       ${SPECIES.join(", ")}
    --rarity <name>        ${RARITIES.join(", ")} ${chalk.dim("(default: legendary)")}
    --eye <char>           ${EYES.join("  ")}
    --hat <name>           ${HATS.join(", ")}
    --peak <stat>          ${STAT_NAMES.join(", ")}
    --dump <stat>          ${STAT_NAMES.join(", ")}
    --shiny / --no-shiny
    --name <name>          Custom name for your companion (any string)
    --personality <text>   Custom personality (controls speech bubble tone, max 200 chars)

  ${chalk.bold("Options:")}
    --scan <number>        Salts to scan (default: 50,000,000)
    --threads <number>     Worker threads for parallel scan (default: CPU cores)
    --perfect              Scan forever until theoretical max stats are found (Ctrl+C to stop)
    --dry-run              Show best result without patching the binary
    --list                 Show all available options
    --current              Show current companion and stats
    --restore              Restore original binary from backup
    -h, --help             Show this help
`);
  process.exit(0);
}

// ── --list ──

if (args.list) {
  console.log(`  ${chalk.bold("Species:")}       ${SPECIES.join(", ")}`);
  console.log(`  ${chalk.bold("Rarity:")}        ${RARITIES.map((r) => `${r} (${RARITY_WEIGHTS[r]}%)`).join(", ")}`);
  console.log(`  ${chalk.bold("Eyes:")}          ${EYES.join("  ")}`);
  console.log(`  ${chalk.bold("Hats:")}          ${HATS.join(", ")}`);
  console.log(`  ${chalk.bold("Stats:")}         ${STAT_NAMES.join(", ")}`);
  console.log(`  ${chalk.bold("Shiny:")}         true / false (1% natural chance)`);
  console.log(`  ${chalk.bold("Name:")}          any string (written to config)`);
  console.log(`  ${chalk.bold("Personality:")}   any string up to 200 chars (controls speech bubbles)\n`);
  process.exit(0);
}

// ── Resolve paths ──

const binaryPath = findBinaryPath();
if (!binaryPath) { console.error("  ✗ Could not find Claude Code binary."); process.exit(1); }
const configPath = findConfigPath();
if (!configPath) { console.error("  ✗ Could not find Claude Code config."); process.exit(1); }
const userId = getUserId(configPath);

console.log(chalk.dim(`  Binary:  ${binaryPath}`));
console.log(chalk.dim(`  Config:  ${configPath}`));
console.log(chalk.dim(`  User:    ${userId.slice(0, 8)}...\n`));

// ── --restore ──

if (args.restore) {
  const backupPath = binaryPath + ".backup";
  if (!existsSync(backupPath)) {
    console.error("  ✗ No backup found at " + backupPath);
    console.error("    The binary has never been patched, or the backup was deleted.\n");
    process.exit(1);
  }

  if (isClaudeRunning()) {
    console.warn(chalk.yellow("  ⚠ Claude Code appears to be running. Quit it before restoring.\n"));
  }

  copyFileSync(backupPath, binaryPath);
  resignBinary(binaryPath);
  clearCompanion(configPath);

  console.log("  ✓ Binary restored from backup.");
  console.log("  ✓ Companion data cleared.");
  console.log(chalk.greenBright("\n  Done! Restart Claude Code and run /buddy to re-hatch.\n"));
  process.exit(0);
}

// ── --current ──

if (args.current) {
  const binaryData = readFileSync(binaryPath);
  const currentSalt = findCurrentSalt(binaryData);
  if (!currentSalt) { console.error("  ✗ Could not find companion salt in binary."); process.exit(1); }
  const result = rollFrom(currentSalt, userId);

  // Read saved data from config
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const savedName = config.companion?.name ?? null;
  const savedPersonality = config.companion?.personality ?? null;

  console.log(chalk.bold("  Current companion:\n"));
  console.log(formatCard(result, currentSalt, savedName, savedPersonality));
  console.log();
  process.exit(0);
}

// ── Build target ──

const target = {};

// Default to legendary unless explicitly set
target.rarity = args.rarity ?? "legendary";

if (args.species) {
  if (!SPECIES.includes(args.species)) { console.error(`  ✗ Unknown species "${args.species}". Use --list.`); process.exit(1); }
  target.species = args.species;
}
if (args.rarity) {
  if (!RARITIES.includes(args.rarity)) { console.error(`  ✗ Unknown rarity "${args.rarity}". Use --list.`); process.exit(1); }
  target.rarity = args.rarity;
}
if (args.eye) {
  if (!EYES.includes(args.eye)) { console.error(`  ✗ Unknown eye "${args.eye}". Use --list.`); process.exit(1); }
  target.eye = args.eye;
}
if (args.hat) {
  if (!HATS.includes(args.hat)) { console.error(`  ✗ Unknown hat "${args.hat}". Use --list.`); process.exit(1); }
  target.hat = args.hat;
}
if (args.peak) {
  const p = args.peak.toUpperCase();
  if (!STAT_NAMES.includes(p)) { console.error(`  ✗ Unknown stat "${args.peak}". Use --list.`); process.exit(1); }
  target.peak = p;
}
if (args.dump) {
  const d = args.dump.toUpperCase();
  if (!STAT_NAMES.includes(d)) { console.error(`  ✗ Unknown stat "${args.dump}". Use --list.`); process.exit(1); }
  target.dump = d;
}
if (args.peak && args.dump && args.peak.toUpperCase() === args.dump.toUpperCase()) {
  console.error("  ✗ Peak and dump cannot be the same stat."); process.exit(1);
}
if (args.shiny !== undefined) target.shiny = args.shiny;

const companionName = args.name ?? null;
const companionPersonality = args.personality ? args.personality.slice(0, 200) : null;
const perfectMode = args.perfect;
const maxThreads = parseInt(args.threads, 10) || (navigator.hardwareConcurrency ?? require("os").cpus().length);
const dryRun = args["dry-run"];

// Calculate theoretical max total for the target rarity
const targetRarity = target.rarity ?? "legendary";
const targetFloor = RARITY_FLOOR[targetRarity];
const maxPeak = Math.min(100, targetFloor + 50 + 29);
const maxDump = Math.max(1, targetFloor - 10 + 14);
const maxOther = targetFloor + 39;
const theoreticalMax = maxPeak + maxDump + maxOther * 3;

// In perfect mode: scan in batches of 50M until max is found
// Otherwise: use --scan value
const scanBatchSize = parseInt(args.scan, 10) || 50_000_000;
const scanLimit = perfectMode ? Infinity : scanBatchSize;

const targetDesc = Object.entries(target).map(([k, v]) => `${k}=${v}`).join("  ");
console.log(chalk.bold("  Target:  ") + targetDesc);
if (companionName) console.log(chalk.bold("  Name:    ") + chalk.yellowBright(companionName));
if (companionPersonality) console.log(chalk.bold("  Persona: ") + chalk.italic(companionPersonality));
if (perfectMode) {
  console.log(chalk.bold("  Mode:    ") + chalk.magentaBright(`PERFECT — hunting for ${theoreticalMax} total (theoretical max)`));
  console.log(chalk.bold("  Scan:    ") + `unlimited, ${chalk.bold(maxThreads)} threads, ${scanBatchSize.toLocaleString()} per batch` + chalk.dim(" (Ctrl+C to stop with best so far)"));
} else {
  console.log(chalk.bold("  Scan:    ") + `${scanBatchSize.toLocaleString()} salts across ${chalk.bold(maxThreads)} threads` + (dryRun ? chalk.yellow(" (dry run)") : ""));
}
console.log(chalk.dim(`  Max possible: ${theoreticalMax} (peak:${maxPeak} + dump:${maxDump} + other:${maxOther}×3)`));
console.log();

// ── Multithreaded scan ─────────────────────────────────────────────────

const workerCode = `
const { parentPort } = require("worker_threads");

const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];
const RARITY_WEIGHTS = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 };
const RARITY_TOTAL = 100;
const RARITY_FLOOR = { common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50 };
const SPECIES = ["duck","goose","blob","cat","dragon","octopus","owl","penguin","turtle","snail","ghost","axolotl","capybara","cactus","robot","rabbit","mushroom","chonk"];
const EYES = ["\\u00b7","\\u2726","\\u00d7","\\u25c9","@","\\u00b0"];
const HATS = ["none","crown","tophat","propeller","halo","wizard","beanie","tinyduck"];
const STAT_NAMES = ["DEBUGGING","PATIENCE","CHAOS","WISDOM","SNARK"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashString(s) { return Number(BigInt(Bun.hash(s)) & 0xffffffffn); }
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function rollRarity(rng) { let roll = rng() * RARITY_TOTAL; for (const r of RARITIES) { roll -= RARITY_WEIGHTS[r]; if (roll < 0) return r; } return "common"; }

function rollFrom(salt, userId) {
  const rng = mulberry32(hashString(userId + salt));
  const rarity = rollRarity(rng);
  const species = pick(rng, SPECIES);
  const eye = pick(rng, EYES);
  const hat = rarity === "common" ? "none" : pick(rng, HATS);
  const shiny = rng() < 0.01;
  const floor = RARITY_FLOOR[rarity];
  const peak = pick(rng, STAT_NAMES);
  let dump = pick(rng, STAT_NAMES);
  while (dump === peak) dump = pick(rng, STAT_NAMES);
  const stats = {};
  for (const name of STAT_NAMES) {
    if (name === peak) stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30));
    else if (name === dump) stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15));
    else stats[name] = floor + Math.floor(rng() * 40);
  }
  return { rarity, species, eye, hat, shiny, stats, peak, dump };
}

function matches(roll, target) {
  if (target.species && roll.species !== target.species) return false;
  if (target.rarity && roll.rarity !== target.rarity) return false;
  if (target.eye && roll.eye !== target.eye) return false;
  if (target.hat && roll.hat !== target.hat) return false;
  if (target.shiny !== undefined && roll.shiny !== target.shiny) return false;
  if (target.peak && roll.peak !== target.peak) return false;
  if (target.dump && roll.dump !== target.dump) return false;
  return true;
}

let stopped = false;
parentPort.on("message", (msg) => {
  if (msg.type === "stop") { stopped = true; return; }

  const { startIdx, endIdx, userId, target, saltLen } = msg;
  const top10 = [];
  let matchCount = 0;
  let checked = 0;
  let lastReport = Date.now();

  for (let i = startIdx; i < endIdx; i++) {
    if (stopped) break;
    const salt = String(i).padStart(saltLen, "x");
    checked++;
    const r = rollFrom(salt, userId);
    if (!matches(r, target)) continue;
    matchCount++;
    const total = Object.values(r.stats).reduce((a, b) => a + b, 0);

    if (top10.length < 10 || total > top10[top10.length - 1].total) {
      top10.push({ salt, total, ...r });
      top10.sort((a, b) => b.total - a.total);
      if (top10.length > 10) top10.pop();

      if (top10[0].salt === salt) {
        parentPort.postMessage({ type: "best", total, result: r, salt, matchCount, checked });
      }
    }

    const now = Date.now();
    if (now - lastReport > 3000) {
      parentPort.postMessage({ type: "progress", checked, matchCount });
      lastReport = now;
    }
  }

  parentPort.postMessage({ type: "done", top10, matchCount, checked });
});
`;

const { Worker } = await import("worker_threads");

const workerBlob = new Blob([workerCode], { type: "application/javascript" });
const workerUrl = URL.createObjectURL(workerBlob);

let top10 = [];
let totalChecked = 0;
let totalMatches = 0;
let globalBest = 0;
let perfectFound = false;
let interrupted = false;
const startTime = Date.now();

// Graceful Ctrl+C — stop scanning and use best result so far
process.on("SIGINT", () => {
  if (interrupted) process.exit(1); // second Ctrl+C = force quit
  interrupted = true;
  console.log(chalk.yellow("\n\n  ⚠ Interrupted — stopping workers and using best result so far...\n"));
});

async function runBatch(batchStart, batchSize) {
  const chunkSize = Math.ceil(batchSize / maxThreads);
  const workers = [];
  const results = [];
  let doneCount = 0;

  return new Promise((resolve) => {
    for (let t = 0; t < maxThreads; t++) {
      const startIdx = batchStart + t * chunkSize;
      const endIdx = Math.min(startIdx + chunkSize, batchStart + batchSize);
      if (startIdx >= batchStart + batchSize) { doneCount++; if (doneCount >= maxThreads) resolve({ results, workers }); continue; }

      const w = new Worker(workerUrl);
      workers.push(w);

      w.on("message", (msg) => {
        if (msg.type === "best") {
          if (msg.total > globalBest) {
            globalBest = msg.total;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const totalSoFar = totalChecked + results.reduce((s, r) => s + r.checked, 0) + msg.checked;
            console.log(chalk.green(`  ▲ NEW BEST`) + chalk.dim(` [${totalSoFar.toLocaleString()} checked, ${elapsed}s]`) + ` total=${chalk.bold(msg.total)}` + (perfectMode ? chalk.dim(` / ${theoreticalMax}`) : ""));
            console.log(chalk.dim(`    ${msg.result.species} | eye:${msg.result.eye} | hat:${msg.result.hat} | peak:${msg.result.peak} | dump:${msg.result.dump}${msg.result.shiny ? " | shiny" : ""}`));
            if (perfectMode && msg.total >= theoreticalMax) {
              perfectFound = true;
              console.log(chalk.magentaBright.bold(`\n  ★ PERFECT ROLL FOUND! ★\n`));
              // Stop all workers
              for (const wk of workers) wk.postMessage({ type: "stop" });
            }
          }
        } else if (msg.type === "done") {
          results.push(msg);
          doneCount++;
          if (doneCount >= workers.length) resolve({ results, workers });
        }
      });

      w.on("error", (err) => {
        console.error(`  ✗ Worker error:`, err.message);
        doneCount++;
        if (doneCount >= workers.length) resolve({ results, workers });
      });

      // Send stop if already interrupted
      if (interrupted) w.postMessage({ type: "stop" });
      w.postMessage({ startIdx, endIdx, userId, target, saltLen: SALT_LEN });
    }
  });
}

// Run scan — single batch or loop until perfect
let batchNum = 0;
while (!perfectFound && !interrupted) {
  const batchStart = batchNum * scanBatchSize;
  const batchSize = perfectMode ? scanBatchSize : Math.min(scanBatchSize, scanLimit - batchStart);

  if (!perfectMode && batchStart >= scanLimit) break;

  if (perfectMode && batchNum > 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (totalChecked / ((Date.now() - startTime) / 1000) / 1_000_000).toFixed(1);
    console.log(chalk.dim(`  ... ${totalChecked.toLocaleString()} checked, ${totalMatches.toLocaleString()} matches, best=${globalBest}/${theoreticalMax}, ${elapsed}s, ${rate}M/s`));
  }

  const { results, workers } = await runBatch(batchStart, batchSize);

  for (const r of results) {
    totalChecked += r.checked;
    totalMatches += r.matchCount;
    top10.push(...r.top10);
  }
  top10.sort((a, b) => b.total - a.total);
  top10 = top10.slice(0, 10);

  // Clean up workers
  for (const w of workers) w.terminate();

  batchNum++;

  // Single batch mode — done after one pass
  if (!perfectMode) break;
}

URL.revokeObjectURL(workerUrl);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
const rate = totalChecked > 0 ? (totalChecked / ((Date.now() - startTime) / 1000) / 1_000_000).toFixed(1) : "0";

if (totalMatches === 0) {
  console.error(`\n  ✗ No matches found in ${totalChecked.toLocaleString()} salts (${elapsed}s, ${rate}M/s).`);
  console.error("    Try relaxing your constraints (remove --peak, --dump, --shiny, etc.).\n");
  process.exit(1);
}

const matchCount = totalMatches;

// ── Results ─────────────────────────────────────────────────────────────

console.log(`\n${chalk.yellowBright("  " + "═".repeat(66))}`);
console.log(chalk.bold(`  SCAN COMPLETE: `) + `${totalChecked.toLocaleString()} salts in ${elapsed}s (${rate}M/s, ${maxThreads} threads) — ${matchCount.toLocaleString()} matches`);
console.log(chalk.yellowBright("  " + "═".repeat(66)));

console.log(chalk.bold(`\n  TOP ${Math.min(10, top10.length)} RESULTS:\n`));

for (let i = 0; i < top10.length; i++) {
  const r = top10[i];
  console.log(chalk.bold(`  #${i + 1}`));
  console.log(formatCard(r, r.salt, i === 0 ? companionName : null, i === 0 ? companionPersonality : null));
  console.log();
}

// ── Patch ───────────────────────────────────────────────────────────────

const winner = top10[0];

if (dryRun) {
  console.log(chalk.yellowBright("  " + "═".repeat(66)));
  console.log(chalk.bold("  DRY RUN — no changes made."));
  console.log(chalk.dim("  To apply, run again without --dry-run.\n"));
  process.exit(0);
}

console.log(chalk.yellowBright("  " + "═".repeat(66)));
console.log(chalk.bold("  APPLYING #1...\n"));

if (isClaudeRunning()) {
  console.warn(chalk.yellow("  ⚠ Claude Code appears to be running. Quit it before patching to avoid issues.\n"));
}

const binaryData = readFileSync(binaryPath);
const currentSalt = findCurrentSalt(binaryData);
if (!currentSalt) {
  console.error("  ✗ Could not find current salt in binary.");
  process.exit(1);
}

if (currentSalt === winner.salt) {
  console.log("  ✓ Already using the optimal salt!");
} else {
  // Backup
  const backupPath = binaryPath + ".backup";
  if (!existsSync(backupPath)) {
    copyFileSync(binaryPath, backupPath);
    console.log(chalk.dim(`  Backup:  ${backupPath}`));
  }

  const patchCount = patchBinary(binaryPath, currentSalt, winner.salt);
  console.log(`  Patched: ${patchCount} occurrence(s)`);

  if (resignBinary(binaryPath)) console.log("  Signed:  ad-hoc codesign ✓");
}

// Write companion to config with custom name and personality
const companionData = {
  name: companionName ?? winner.species,
  species: winner.species,
  rarity: winner.rarity,
  eye: winner.eye,
  hat: winner.hat,
  shiny: winner.shiny,
  stats: winner.stats,
};

if (companionPersonality) {
  companionData.personality = companionPersonality;
}

writeCompanion(configPath, companionData);

const savedFields = [];
if (companionName) savedFields.push(`name="${companionName}"`);
if (companionPersonality) savedFields.push(`personality set`);
console.log(`  Config:  companion saved` + (savedFields.length ? ` (${savedFields.join(", ")})` : ""));

console.log(chalk.greenBright("\n  ✓ Done! Restart Claude Code and run /buddy.\n"));
