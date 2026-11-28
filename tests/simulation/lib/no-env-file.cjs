"use strict";

/**
 * Preloaded (`node --require`) into every process of the delivery-day
 * simulation that runs API code: to it, every `.env` file is absent.
 *
 * Those processes run from the API folder, where the developer keeps the
 * real `.env`. src/env and prisma.config.ts call `dotenv.config()` there,
 * and dotenv-expand then copies the file's value over every variable that
 * is set but EMPTY — the very keys the simulated env (sim-env.ts) leaves
 * blank to switch an integration off (WhatsApp, health pings, the
 * geocoder…). Giving every key a value is not enough; the file has to stay
 * unread. A container built from the image has no `.env` either, so a
 * replica booted like this is the faithful one.
 *
 * Only reads, stats and folder listings go through here, and only of `.env`
 * and `.env.<anything>`; `.env.example` stays readable. Safe to load twice
 * (tsx may).
 */

const { AsyncLocalStorage, AsyncResource } = require("node:async_hooks");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const INSTALLED = Symbol.for("trajetto.simulation.no-env-file");

/** The file name of a path argument; null for a descriptor or anything else. */
function fileName(target) {
  if (typeof target === "string") return path.basename(target);
  if (Buffer.isBuffer(target)) return path.basename(target.toString());
  if (target instanceof URL && target.protocol === "file:") {
    return path.basename(fileURLToPath(target));
  }

  return null;
}

function isEnvFile(target) {
  const name = fileName(target);

  return (
    name !== null &&
    /^\.env(\..+)?$/i.test(name) &&
    name.toLowerCase() !== ".env.example"
  );
}

const reported = new Set();

/** The error a missing file gives, after one line on stderr per file. */
function absent(target, syscall = "open") {
  const file = String(target instanceof URL ? fileURLToPath(target) : target);

  if (!reported.has(file)) {
    reported.add(file);
    process.stderr.write(
      `[sim] ${file}: .env ignorado (nenhum processo da simulação lê arquivos .env).\n`,
    );
  }

  const error = new Error(
    `ENOENT: no such file or directory, ${syscall} '${file}'`,
  );

  error.code = "ENOENT";
  error.errno = -2;
  error.syscall = syscall;
  error.path = file;

  return error;
}

/**
 * statSync that reports every .env file as missing. A loader that stats
 * before reading (Vite's loadEnv, under vitest) would otherwise find the file
 * and then crash on the guarded read instead of skipping it. lstat stays
 * real: it describes the directory entry, and fs.rmSync walks a folder with
 * it (a temporary folder holding a fake .env must still be removable). The
 * listing that walk makes stays real for the same reason (`removal` below).
 */
function guardedStatSync(real, syscall) {
  return function guarded(target, options) {
    if (!isEnvFile(target)) return real.call(this, target, options);
    if (options && options.throwIfNoEntry === false) return undefined;

    throw absent(target, syscall);
  };
}

/** fs.stat with a callback, same rule. */
function guardedStatCallback(real, syscall) {
  return function guarded(target, ...rest) {
    const callback = rest[rest.length - 1];

    if (isEnvFile(target) && typeof callback === "function") {
      process.nextTick(callback, absent(target, syscall));
      return;
    }

    return real.call(this, target, ...rest);
  };
}

/** fs.promises.stat, same rule. */
function guardedStatPromise(real, syscall) {
  return function guarded(target, ...rest) {
    if (isEnvFile(target)) return Promise.reject(absent(target, syscall));

    return real.call(this, target, ...rest);
  };
}

/** A listing entry: a name, a relative path (recursive) or a Dirent. */
function isEnvEntry(entry) {
  return isEnvFile(entry instanceof fs.Dirent ? entry.name : entry);
}

function withoutEnvFiles(entries) {
  return Array.isArray(entries)
    ? entries.filter((entry) => !isEnvEntry(entry))
    : entries;
}

/**
 * Set while Node's own recursive removal runs (fs.rm, fs.rmSync,
 * fs.promises.rm and the recursive rmdir). That walk lists each folder and
 * then removes every entry it listed, so a listing without the .env would
 * leave the file behind and the folder unremovable (ENOTEMPTY) — the reason
 * lstat stays real. Inside a removal the listing is the real one; anywhere
 * else a .env is left out, as stat and existsSync already report it absent.
 */
const removal = new AsyncLocalStorage();

const listsForRemoval = () => removal.getStore() === true;

/** A removal (sync, or returning a promise) that sees the real listings. */
function realListingsSync(real) {
  return function guarded(...args) {
    return removal.run(true, () => real.apply(this, args));
  };
}

/**
 * A removal with a callback, same rule. The callback is bound to the
 * caller's context first: what it lists is outside the removal again.
 */
function realListingsCallback(real) {
  return function guarded(...args) {
    const last = args.length - 1;

    if (typeof args[last] === "function") {
      args[last] = AsyncResource.bind(args[last]);
    }

    return removal.run(true, () => real.apply(this, args));
  };
}

/**
 * Listings leave the .env files out, in every form (names, Buffers, Dirents,
 * recursive paths). Nothing is written to stderr: a scan lists folders all
 * the time, and leaving an entry out reads nothing.
 */
function guardListings() {
  const readdirSync = fs.readdirSync;
  const readdir = fs.readdir;
  const readdirPromise = fs.promises.readdir;

  fs.readdirSync = function guardedReaddirSync(target, ...rest) {
    const entries = readdirSync.call(this, target, ...rest);

    return listsForRemoval() ? entries : withoutEnvFiles(entries);
  };

  fs.readdir = function guardedReaddir(target, ...rest) {
    const last = rest.length - 1;
    const callback = rest[last];

    if (typeof callback === "function" && !listsForRemoval()) {
      rest[last] = function listed(error, entries) {
        return callback.call(
          this,
          error,
          error ? entries : withoutEnvFiles(entries),
        );
      };
    }

    return readdir.call(this, target, ...rest);
  };

  fs.promises.readdir = function guardedReaddirPromise(target, ...rest) {
    const listing = readdirPromise.call(this, target, ...rest);

    return listsForRemoval() ? listing : listing.then(withoutEnvFiles);
  };

  fs.rmSync = realListingsSync(fs.rmSync);
  fs.rmdirSync = realListingsSync(fs.rmdirSync);
  fs.promises.rm = realListingsSync(fs.promises.rm);
  fs.promises.rmdir = realListingsSync(fs.promises.rmdir);
  fs.rm = realListingsCallback(fs.rm);
  fs.rmdir = realListingsCallback(fs.rmdir);
}

function install() {
  if (globalThis[INSTALLED]) return;

  globalThis[INSTALLED] = true;

  const readFileSync = fs.readFileSync;
  const readFile = fs.readFile;
  const existsSync = fs.existsSync;
  const readFilePromise = fs.promises.readFile;

  fs.readFileSync = function guardedReadFileSync(target, ...rest) {
    if (isEnvFile(target)) throw absent(target);

    return readFileSync.call(this, target, ...rest);
  };

  fs.readFile = function guardedReadFile(target, ...rest) {
    const callback = rest[rest.length - 1];

    if (isEnvFile(target) && typeof callback === "function") {
      process.nextTick(callback, absent(target));
      return;
    }

    return readFile.call(this, target, ...rest);
  };

  fs.existsSync = function guardedExistsSync(target) {
    if (isEnvFile(target)) return false;

    return existsSync.call(this, target);
  };

  fs.promises.readFile = function guardedReadFilePromise(target, ...rest) {
    if (isEnvFile(target)) return Promise.reject(absent(target));

    return readFilePromise.call(this, target, ...rest);
  };

  fs.statSync = guardedStatSync(fs.statSync, "stat");
  fs.stat = guardedStatCallback(fs.stat, "stat");
  fs.promises.stat = guardedStatPromise(fs.promises.stat, "stat");

  guardListings();

  // `import { readFileSync } from "node:fs"` sees the guarded functions too.
  syncBuiltinESMExports();
}

install();
