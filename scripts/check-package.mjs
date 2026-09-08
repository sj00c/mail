#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@sj00c/mail";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = join(PACKAGE_ROOT, "package.json");
const TAR_EXECUTABLE = process.platform === "win32" ? "tar.exe" : "tar";

const REQUIRED_FILES = new Set([
  "cli/mail.mjs",
  "server/index.ts",
  "dist/index.html",
  "LICENSE",
  "THIRD_PARTY_NOTICES",
  "README.md",
  "package.json",
]);

function fail(message) {
  throw new Error(`Package check failed: ${message}`);
}

function normalizePackagePath(value) {
  if (typeof value !== "string") fail(`package entry path is not a string: ${String(value)}`);
  let path = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.startsWith("package/")) path = path.slice("package/".length);
  return path.replace(/\/+$/, "");
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkManifest(manifest, source) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`${source} does not contain a package manifest object`);
  }
  if (manifest.name !== PACKAGE_NAME) {
    fail(`${source} has name ${JSON.stringify(manifest.name)}, expected ${PACKAGE_NAME}`);
  }
  if (
    typeof manifest.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    fail(`${source} has an invalid package version`);
  }
  if (manifest.license !== "MIT") {
    fail(`${source} must declare license MIT`);
  }
  if (manifest.private === true) {
    fail(`${source} must be public (private must not be true)`);
  }
  if (manifest.private !== undefined && manifest.private !== false) {
    fail(`${source} has an invalid private setting`);
  }
  if (manifest.publishConfig?.access !== "public") {
    fail(`${source} must set publishConfig.access to public`);
  }

  const bin = manifest.bin;
  if (
    !bin ||
    typeof bin !== "object" ||
    Array.isArray(bin) ||
    Object.keys(bin).length !== 1 ||
    bin["sj-mail"] !== "cli/mail.mjs"
  ) {
    fail(`${source} must map the sole sj-mail bin to cli/mail.mjs`);
  }
}

function isForbiddenPath(path) {
  const segments = path.split("/");
  if (
    segments.some((segment) =>
      /^\.env/i.test(segment) ||
      /^\.data/i.test(segment) ||
      /\.log$/i.test(segment) ||
      /^(?:test|tests|__tests__)$/i.test(segment),
    )
  ) {
    return true;
  }
  return segments.some((segment) => /(?:^|[._-])(test|spec)(?:[._-]|$)/i.test(segment));
}

function isAllowedPath(path) {
  if (path === "cli/mail.mjs") return true;
  if (path === "package.json") return true;
  if (path === "README.md" || path === "LICENSE" || path === "THIRD_PARTY_NOTICES") return true;
  if (path === "dist/index.html") return true;
  if (path.startsWith("dist/assets/") && path.length > "dist/assets/".length) return true;
  if (
    path.startsWith("server/") &&
    path.endsWith(".ts") &&
    !/(?:^|\/)[^/]+\.(?:test|spec)\.ts$/i.test(path)
  ) {
    return true;
  }
  return false;
}

function checkEntries(entries, source) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`${source} contains no package files`);
  }

  const paths = [];
  const seen = new Set();
  for (const entry of entries) {
    const rawPath = typeof entry === "string" ? entry : entry?.path;
    const path = normalizePackagePath(rawPath);
    if (!path) continue;
    if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
      fail(`${source} contains unsafe path ${path}`);
    }
    if (seen.has(path)) fail(`${source} contains duplicate path ${path}`);
    seen.add(path);
    paths.push(path);

    if (isForbiddenPath(path)) {
      fail(`${source} contains forbidden secret/test/log path ${path}`);
    }
    if (!isAllowedPath(path)) {
      fail(`${source} contains path outside the package allowlist: ${path}`);
    }

    if (entry && typeof entry === "object") {
      if (entry.type && entry.type !== "file") {
        fail(`${source} contains non-file entry ${path}`);
      }
      if (entry.link || entry.linkname || entry.symlink) {
        fail(`${source} contains symlink or hardlink entry ${path}`);
      }
      const fileType = Number.isInteger(entry.mode) ? entry.mode & 0o170000 : 0;
      if (fileType !== 0 && fileType !== 0o100000) {
        fail(`${source} contains a non-regular entry ${path}`);
      }
    }
  }

  for (const required of REQUIRED_FILES) {
    if (!seen.has(required)) fail(`${source} is missing required file ${required}`);
  }
  return paths;
}

function parseReceipt(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${source} is not valid npm pack JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const receipts = Array.isArray(parsed) ? parsed : [parsed];
  if (receipts.length !== 1 || !receipts[0] || typeof receipts[0] !== "object") {
    fail(`${source} must contain exactly one npm pack receipt`);
  }
  if (!Array.isArray(receipts[0].files)) {
    fail(`${source} does not contain the npm pack files list`);
  }
  return receipts[0];
}

function runNpmDryRun() {
  const npmInvocation = resolveNpmInvocation();
  const result = spawnSync(
    npmInvocation.command,
    [...npmInvocation.args, "pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    const details = [result.error?.message, result.stderr?.trim()].filter(Boolean).join("\n");
    fail(`npm pack --dry-run failed${details ? `: ${details}` : ""}`);
  }
  return parseReceipt(result.stdout, "npm pack --dry-run output");
}

function resolveNpmInvocation() {
  const npmCliCandidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  if (process.platform === "win32") {
    const npmCli = npmCliCandidates.find((candidate) => existsSync(candidate));
    if (!npmCli) {
      fail(
        "could not locate npm-cli.js on Windows; run with npm_execpath set or install npm with Node",
      );
    }
    return { command: process.execPath, args: [npmCli] };
  }
  return { command: "npm", args: [] };
}

function runTar(args, archive) {
  const result = spawnSync(TAR_EXECUTABLE, [...args, archive], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const details = [result.error?.message, result.stderr?.trim()].filter(Boolean).join("\n");
    fail(`could not inspect ${archive} with tar${details ? `: ${details}` : ""}`);
  }
  return result.stdout;
}

function archiveManifest(archive) {
  const result = spawnSync(TAR_EXECUTABLE, ["-xOf", archive, "package/package.json"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail(`packed archive is missing package/package.json`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`packed package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkArchive(archive, receiptPaths = undefined) {
  const listing = runTar(["-tf"], archive)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => path !== "package/")
    .map(normalizePackagePath);
  const details = runTar(["-tvf"], archive);
  for (const line of details.split(/\r?\n/)) {
    const type = line.trimStart()[0];
    if (type && type !== "-") fail(`packed archive contains a non-regular entry: ${line}`);
  }
  const archivePaths = checkEntries(listing.map((path) => ({ path })), "packed archive");
  if (receiptPaths) {
    const expected = new Set(receiptPaths);
    const actual = new Set(archivePaths);
    if (expected.size !== actual.size || [...expected].some((path) => !actual.has(path))) {
      fail("npm pack receipt file list does not match the packed archive");
    }
  }
  checkManifest(archiveManifest(archive), "packed package.json");
}

function resolveReceiptTarball(receiptPath, receipt) {
  if (typeof receipt.filename !== "string" || receipt.filename.length === 0) {
    fail("npm pack receipt has no tarball filename");
  }
  const candidates = [
    resolve(PACKAGE_ROOT, receipt.filename),
    resolve(dirname(resolve(receiptPath)), receipt.filename),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) fail(`npm pack tarball does not exist: ${receipt.filename}`);
  return path;
}

function checkReceipt(receiptPath) {
  const receipt = parseReceipt(readFileSync(receiptPath, "utf8"), receiptPath);
  checkManifest(readJson(PACKAGE_JSON, "package.json"), "package.json");
  const paths = checkEntries(receipt.files, "npm pack receipt");
  const archive = resolveReceiptTarball(receiptPath, receipt);
  checkArchive(archive, paths);
  const manifest = archiveManifest(archive);
  const expected = readJson(PACKAGE_JSON, "package.json");
  if (receipt.name !== expected.name || receipt.version !== expected.version || manifest.version !== expected.version) {
    fail("receipt and packed manifest must match the checked-out package version");
  }
  return { mode: "receipt and archive", count: paths.length, version: receipt.version };
}

function checkDefault() {
  const receipt = runNpmDryRun();
  checkManifest(readJson(PACKAGE_JSON, "package.json"), "package.json");
  const paths = checkEntries(receipt.files, "npm pack --dry-run receipt");
  return { mode: "npm pack --dry-run", count: paths.length, version: receipt.version };
}

function checkTarball(archive) {
  if (!existsSync(archive)) fail(`tarball does not exist: ${archive}`);
  try {
    if (!statSync(archive).isFile()) fail(`tarball is not a regular file: ${archive}`);
  } catch (error) {
    fail(`could not stat tarball ${archive}: ${error instanceof Error ? error.message : String(error)}`);
  }
  checkArchive(archive);
  const manifest = archiveManifest(archive);
  return { mode: "archive", count: undefined, version: manifest.version };
}

function parseArguments(args) {
  if (args.length === 0) return { kind: "default" };
  if (args.length === 2 && args[0] === "--receipt") return { kind: "receipt", path: resolve(args[1]) };
  if (args.length === 1 && args[0].startsWith("--receipt=")) {
    return { kind: "receipt", path: resolve(args[0].slice("--receipt=".length)) };
  }
  if (args.length === 1 && !args[0].startsWith("-")) return { kind: "tarball", path: resolve(args[0]) };
  fail("usage: node scripts/check-package.mjs [--receipt <npm-pack-json>] [<tarball>]");
}

try {
  const request = parseArguments(process.argv.slice(2));
  const result =
    request.kind === "default"
      ? checkDefault()
      : request.kind === "receipt"
        ? checkReceipt(request.path)
        : checkTarball(request.path);
  const count = result.count === undefined ? "" : `, ${result.count} files`;
  console.log(`Package check passed (${result.mode}${count}): ${PACKAGE_NAME}@${result.version}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
