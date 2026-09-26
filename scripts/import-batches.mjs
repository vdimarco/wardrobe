import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// Background imports of many photos (a Google Photos pick or a shared album).
// A batch first downloads every photo to disk, because Google's download links
// expire, and then works through the files one at a time:
//   1. skip photos that look almost the same as one already checked (burst shots),
//   2. ask a cheap, low-detail question: does this photo show the owner's clothes?
//   3. run the full clothing detection only on photos that pass.
// State is saved to disk, so a batch continues after a restart.

const DOWNLOAD_CONCURRENCY = 6;
const CHECK_CONCURRENCY = 4;
const DUPLICATE_DISTANCE = 5;
const MAX_FAILURES_IN_A_ROW = 5;
const SAVE_INTERVAL_MS = 2000;
const ACTIVE = new Set(["downloading", "running"]);
const COUNT_FOR_STATUS = { duplicate: "duplicates", noClothes: "noClothes", withItems: "withItems", failed: "failed" };

// 64-bit difference hash: compares each pixel of a 9x8 grayscale thumbnail with its
// neighbor. Photos that look almost the same get hashes a few bits apart.
export async function differenceHash(bytes) {
  const { data } = await sharp(bytes).rotate().grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let hash = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      hash = (hash << 1n) | (data[row * 9 + column] > data[row * 9 + column + 1] ? 1n : 0n);
    }
  }
  return hash.toString(16).padStart(16, "0");
}

export function hashDistance(a, b) {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

function emptyCounts() {
  return { downloaded: 0, downloadFailed: 0, checked: 0, duplicates: 0, noClothes: 0, withItems: 0, items: 0, alreadyOwned: 0, failed: 0 };
}

export function publicBatch(batch) {
  const { photos, hashes, ...rest } = batch;
  return rest;
}

// `afterDownload(source)` runs once the photos are on disk (or the import is cancelled),
// for example to close the Google Photos picker session the download links belong to.
export function createBatchManager({ dir, download, checkPhoto, importPhoto, afterDownload = async () => {}, log = console }) {
  const batches = new Map();
  const saveTimers = new Map();
  let workerRunning = false;

  const rootDir = () => (typeof dir === "function" ? dir() : dir);
  const batchDir = (id) => path.join(rootDir(), id);
  const batchFile = (id) => path.join(batchDir(id), "batch.json");
  const photoFile = (id, photo) => path.join(batchDir(id), "photos", photo.file);

  async function writeBatch(batch) {
    batch.updatedAt = new Date().toISOString();
    const file = batchFile(batch.id);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(batch));
    await rename(tmp, file);
  }

  // Progress changes after every photo; write it at most every few seconds.
  function save(batch, now = false) {
    clearTimeout(saveTimers.get(batch.id));
    if (now) { saveTimers.delete(batch.id); return writeBatch(batch); }
    saveTimers.set(batch.id, setTimeout(() => { saveTimers.delete(batch.id); writeBatch(batch).catch((error) => log.warn(`[wardrobe] Could not save batch ${batch.id}: ${error.message}`)); }, SAVE_INTERVAL_MS));
    return Promise.resolve();
  }

  async function load() {
    await mkdir(rootDir(), { recursive: true });
    for (const id of await readdir(rootDir()).catch(() => [])) {
      try {
        const batch = JSON.parse(await readFile(batchFile(id), "utf8"));
        batches.set(batch.id, batch);
      } catch (error) {
        if (error.code !== "ENOENT") log.warn(`[wardrobe] Could not read batch ${id}: ${error.message}`);
      }
    }
    kick();
  }

  async function create({ title, source, photos, found = photos.length }) {
    const id = randomUUID();
    await mkdir(path.join(batchDir(id), "photos"), { recursive: true });
    const now = new Date().toISOString();
    const batch = {
      id, title: title || "Google Photos", source, state: "downloading", error: null,
      total: photos.length, found, cursor: 0, counts: emptyCounts(), createdAt: now, updatedAt: now,
      photos: photos.map((photo, index) => ({ ...photo, file: `${String(index).padStart(5, "0")}.jpg`, status: "pending" })),
      hashes: [],
    };
    batches.set(id, batch);
    await save(batch, true);
    kick();
    return publicBatch(batch);
  }

  function list() {
    return [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicBatch);
  }

  async function control(id, action) {
    const batch = batches.get(id);
    if (!batch) throw Object.assign(new Error("Import not found"), { status: 404 });
    if (action === "pause" && ACTIVE.has(batch.state)) { batch.resumeState = batch.state; batch.state = "paused"; }
    else if (action === "resume" && batch.state === "paused") { batch.state = batch.resumeState || "running"; batch.error = null; }
    else if (action === "cancel" && !["done", "cancelled"].includes(batch.state)) {
      if (batch.state === "downloading" || batch.resumeState === "downloading") await afterDownload(batch.source).catch(() => {});
      batch.state = "cancelled";
      await rm(path.join(batchDir(id), "photos"), { recursive: true, force: true });
    } else if (action === "dismiss" && !ACTIVE.has(batch.state)) {
      batches.delete(id);
      clearTimeout(saveTimers.get(id));
      await rm(batchDir(id), { recursive: true, force: true });
      return { id, dismissed: true };
    } else {
      throw Object.assign(new Error(`This import cannot ${action} now`), { status: 409 });
    }
    await save(batch, true);
    kick();
    return publicBatch(batch);
  }

  function kick() {
    if (workerRunning) return;
    workerRunning = true;
    work().catch((error) => log.error(`[wardrobe] Batch worker stopped: ${error.stack || error.message}`)).finally(() => {
      workerRunning = false;
      if ([...batches.values()].some((batch) => ACTIVE.has(batch.state))) setTimeout(kick, 1000);
    });
  }

  // One batch at a time, oldest first, to keep spending and load predictable.
  async function work() {
    for (;;) {
      const batch = [...batches.values()].filter((item) => ACTIVE.has(item.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!batch) return;
      if (batch.state === "downloading") await downloadAll(batch);
      if (batch.state === "running") await processAll(batch);
    }
  }

  async function downloadAll(batch) {
    let next = 0;
    const worker = async () => {
      while (batch.state === "downloading" && next < batch.photos.length) {
        const photo = batch.photos[next++];
        if (photo.status !== "pending") continue;
        try {
          await writeFile(photoFile(batch.id, photo), await download(batch.source, photo));
          photo.status = "downloaded";
          batch.counts.downloaded += 1;
        } catch (error) {
          photo.status = "failed";
          photo.error = error.message;
          batch.counts.failed += 1;
          batch.counts.downloadFailed += 1;
        }
        save(batch);
      }
    };
    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
    if (batch.state !== "downloading") return;
    await afterDownload(batch.source).catch((error) => log.warn(`[wardrobe] Cleanup after download failed: ${error.message}`));
    batch.state = batch.counts.downloaded ? "running" : "failed";
    if (!batch.counts.downloaded) batch.error = "None of the photos could be downloaded.";
    await save(batch, true);
  }

  async function processAll(batch) {
    let failuresInARow = 0;
    while (batch.state === "running" && batch.cursor < batch.photos.length) {
      // Take the next few downloaded photos, drop near-duplicates, and check the rest in parallel.
      const chunk = [];
      while (chunk.length < CHECK_CONCURRENCY && batch.cursor < batch.photos.length) {
        const photo = batch.photos[batch.cursor++];
        if (photo.status === "downloaded") chunk.push(photo);
      }
      const candidates = [];
      for (const photo of chunk) {
        try {
          const bytes = await readFile(photoFile(batch.id, photo));
          photo.hash = await differenceHash(bytes);
          const earlier = [...batch.hashes, ...candidates.map((candidate) => candidate.photo.hash)];
          if (earlier.some((other) => hashDistance(photo.hash, other) <= DUPLICATE_DISTANCE)) {
            finish(batch, photo, "duplicate");
            continue;
          }
          candidates.push({ photo, bytes });
        } catch (error) {
          finish(batch, photo, "failed", error.message);
        }
      }
      const checks = await Promise.all(candidates.map(({ bytes }) => checkPhoto(bytes).then((worth) => ({ worth }), (error) => ({ error }))));
      for (const [index, { photo, bytes }] of candidates.entries()) {
        if (batch.state !== "running") { batch.cursor = Math.min(batch.cursor, batch.photos.indexOf(photo)); break; }
        const check = checks[index];
        try {
          if (check.error) throw check.error;
          if (!check.worth) { finish(batch, photo, "noClothes"); failuresInARow = 0; continue; }
          const result = await importPhoto(bytes, `${batch.title} photo ${batch.photos.indexOf(photo) + 1}`);
          photo.items = result.jobs.length;
          batch.counts.items += result.jobs.length;
          batch.counts.alreadyOwned += result.skipped.length;
          finish(batch, photo, result.jobs.length ? "withItems" : "noClothes");
          failuresInARow = 0;
        } catch (error) {
          finish(batch, photo, "failed", error.message);
          failuresInARow += 1;
          if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
            // Usually a bad API key or no quota left: stop instead of failing every photo.
            batch.state = "paused";
            batch.resumeState = "running";
            batch.error = `Paused after ${failuresInARow} failed photos in a row. Last error: ${error.message}`;
            batch.cursor = Math.min(batch.cursor, batch.photos.indexOf(photo) + 1);
          }
        }
      }
      save(batch);
    }
    if (batch.state === "running") {
      batch.state = "done";
      await rm(path.join(batchDir(batch.id), "photos"), { recursive: true, force: true });
    }
    await save(batch, true);
  }

  function finish(batch, photo, status, error = null) {
    photo.status = status;
    if (error) photo.error = error;
    // Only photos that are done count as "seen", so a paused photo does not match itself later.
    if (photo.hash && status !== "duplicate") batch.hashes.push(photo.hash);
    batch.counts.checked += 1;
    batch.counts[COUNT_FOR_STATUS[status]] += 1;
    rm(photoFile(batch.id, photo), { force: true }).catch(() => {});
  }

  return { load, create, list, control };
}
