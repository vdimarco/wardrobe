import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, GooglePhotosLogo, Pause, Play, Plus, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import "./import-flow.css";

const API = "/api/import/jobs";
const CONFIG_API = "/api/import/config";
const GOOGLE_API = "/api/import/google-photos";
const BATCH_API = "/api/import/batches";
const ACTIVE_BATCH = new Set(["downloading", "running"]);
const visibleJob = (job) => job.status !== "complete" && job.stages?.crop?.status !== "rejected" && job.stages?.garment?.status !== "rejected" && job.stages?.modeled?.status !== "rejected";
const PARTS = [
  ["upperbody", "Tops"],
  ["wholebody_up", "Jackets"],
  ["lowerbody", "Bottoms"],
  ["accessories_up", "Accessories"],
  ["shoes", "Shoes"],
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("Could not read that image."));
  reader.readAsDataURL(file);
});

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "The import job could not be updated.");
  return value;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves when the OAuth callback page in the popup reports back.
function waitForGoogleConnection(popup) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.removeEventListener("message", onMessage); clearInterval(closedTimer); };
    const onMessage = (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== "wardrobe:google-photos") return;
      cleanup();
      if (event.data.ok) resolve(); else reject(new Error(event.data.message || "Google Photos was not connected."));
    };
    const closedTimer = setInterval(() => { if (popup.closed) { cleanup(); reject(new Error("Google sign-in was closed before it finished.")); } }, 500);
    window.addEventListener("message", onMessage);
  });
}

function deriveStatus(job) {
  const crop = job.stages?.crop;
  const garment = job.stages?.garment;
  const modeled = job.stages?.modeled;
  if (job.error || crop?.status === "failed" || garment?.status === "failed" || modeled?.status === "failed") return { tone: "error", text: "Import needs attention", detail: crop?.error || garment?.error || modeled?.error || job.error };
  if (modeled?.status === "review") return { tone: "ready", text: "Modeled image ready for review" };
  if (modeled?.status === "processing") return { tone: "processing", text: "Styling modeled image" };
  if (garment?.status === "review") return { tone: "ready", text: "Ready for review" };
  if (garment?.status === "approved") return { tone: "processing", text: "Creating modeled image" };
  if (crop?.status === "review") return { tone: "ready", text: "Crop ready for review" };
  if (crop?.status === "approved") return { tone: "processing", text: "Creating garment image" };
  if (crop?.status === "rejected" || garment?.status === "rejected" || modeled?.status === "rejected") return { tone: "complete", text: "Import declined" };
  return { tone: "processing", text: "Extracting clothing from image" };
}

function reviewStageFor(job) {
  if (job.stages?.modeled?.status === "review") return "modeled";
  if (job.stages?.garment?.status === "review") return "garment";
  if (job.stages?.crop?.status === "review") return "crop";
  return null;
}

function hasCleanupFailure(job) {
  return job.stages?.garment?.status === "failed" && Boolean(job.stages?.garment?.failedAssetUrl);
}

function defaultDraft(job) {
  const metadata = job.metadata || {};
  return {
    name: metadata.name || "New piece",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || "",
    tags: Array.isArray(metadata.tags) ? metadata.tags.join(", ") : (metadata.tags || ""),
  };
}

// Photos that are finished: checked, or failed to download (those are never checked).
const batchProgress = (batch) => batch.state === "downloading" ? batch.counts.downloaded + batch.counts.downloadFailed : batch.counts.checked + batch.counts.downloadFailed;

function batchSummary(batch) {
  const { counts } = batch;
  if (batch.state === "downloading") return `Downloading ${batchProgress(batch).toLocaleString()} of ${batch.total.toLocaleString()} photos`;
  return [
    `${batchProgress(batch).toLocaleString()} of ${batch.total.toLocaleString()} photos checked`,
    `${counts.items.toLocaleString()} new ${counts.items === 1 ? "item" : "items"}`,
    counts.alreadyOwned && `${counts.alreadyOwned.toLocaleString()} already owned`,
    counts.duplicates && `${counts.duplicates.toLocaleString()} near-duplicates`,
    counts.noClothes && `${counts.noClothes.toLocaleString()} without your clothes`,
    counts.failed && `${counts.failed.toLocaleString()} failed`,
  ].filter(Boolean).join(" · ");
}

const BATCH_STATE_LABELS = { downloading: "Downloading", running: "Importing", paused: "Paused", done: "Done", cancelled: "Cancelled", failed: "Failed" };

function BatchCard({ batch, busy, onControl }) {
  const percent = batch.total ? Math.min(100, Math.round((batchProgress(batch) / batch.total) * 100)) : 0;
  const active = ACTIVE_BATCH.has(batch.state);
  return (
    <article className={`import-batch is-${batch.state}`}>
      <div className="import-batch__head">
        <div>
          <h3 className="import-card__title">{batch.title}</h3>
          <p className="import-card__detail">{BATCH_STATE_LABELS[batch.state] || batch.state} · {batchSummary(batch)}</p>
          {batch.found > batch.total && <p className="import-card__detail">Only the first {batch.total.toLocaleString()} of {batch.found.toLocaleString()} photos are included.</p>}
          {batch.error && <p className="import-card__detail import-batch__error">{batch.error}</p>}
        </div>
        <div className="import-card__actions">
          {active && <button className="import-icon-button" disabled={busy} onClick={() => onControl("pause")} aria-label={`Pause ${batch.title}`}><Pause size={16} /></button>}
          {batch.state === "paused" && <button className="import-icon-button" disabled={busy} onClick={() => onControl("resume")} aria-label={`Resume ${batch.title}`}><Play size={16} /></button>}
          {(active || batch.state === "paused") && <button className="import-icon-button" disabled={busy} onClick={() => onControl("cancel")} aria-label={`Cancel ${batch.title}`}><X size={16} /></button>}
          {!active && <button className="import-icon-button" disabled={busy} onClick={() => onControl("dismiss")} aria-label={`Remove ${batch.title} from the list`}><Trash size={16} /></button>}
        </div>
      </div>
      {batch.state !== "done" && batch.state !== "cancelled" && <div className="import-batch__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="import-batch__bar" style={{ width: `${percent}%` }} /></div>}
    </article>
  );
}

// Review shortcuts. Each one clicks the button that has the same data-shortcut value, so a
// key does exactly what a click does and is ignored while that button is disabled.
const SHORTCUTS = { Enter: "approve", a: "approve", x: "reject", r: "regenerate", z: "undo" };
const isTyping = (target) => Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));

const MIN_CROP_SIZE = 20;
const sameBox = (a, b) => ["x", "y", "width", "height"].every((key) => a?.[key] === b?.[key]);

// Shows the original photo with the crop box on it. Drag on the photo to draw a new box.
function CropBoxEditor({ src, box, onChange, disabled }) {
  const frameRef = useRef(null);
  const drag = useRef(null);
  const toPoint = (event) => {
    const rect = frameRef.current.getBoundingClientRect();
    const clamp = (value) => Math.round(Math.max(0, Math.min(1000, value)));
    return { x: clamp(((event.clientX - rect.left) / rect.width) * 1000), y: clamp(((event.clientY - rect.top) / rect.height) * 1000) };
  };
  const onPointerDown = (event) => {
    if (disabled || event.button > 0) return;
    event.preventDefault();
    frameRef.current.setPointerCapture(event.pointerId);
    drag.current = { start: toPoint(event), previous: box };
  };
  const onPointerMove = (event) => {
    if (!drag.current) return;
    const { start } = drag.current;
    const point = toPoint(event);
    onChange({ x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.max(1, Math.abs(point.x - start.x)), height: Math.max(1, Math.abs(point.y - start.y)) });
  };
  const onPointerUp = (event) => {
    if (!drag.current) return;
    const { start, previous } = drag.current;
    drag.current = null;
    const point = toPoint(event);
    // A click or a very small drag is not a new box.
    if (Math.abs(point.x - start.x) < MIN_CROP_SIZE || Math.abs(point.y - start.y) < MIN_CROP_SIZE) onChange(previous);
  };
  return (
    <div className="import-crop-frame" ref={frameRef} data-disabled={disabled} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <img src={src} alt="Original photo with the crop box" draggable={false} />
      {box && <div className="import-crop-box" style={{ left: `${box.x / 10}%`, top: `${box.y / 10}%`, width: `${box.width / 10}%`, height: `${box.height / 10}%` }} />}
    </div>
  );
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, busy, onAction, onCrop }) {
  const asset = job.stages[stage]?.assetUrl;
  const isCrop = stage === "crop";
  const isGarment = stage === "garment";
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  const savedBox = job.metadata?.boundingBox;
  const [cropBox, setCropBox] = useState(savedBox);
  useEffect(() => { setCropBox(savedBox); }, [savedBox?.x, savedBox?.y, savedBox?.width, savedBox?.height]);
  const cropChanged = isCrop && Boolean(cropBox) && !sameBox(cropBox, savedBox);
  return (
    <div className={`import-editor${isCrop ? " import-editor--crop" : ""}`}>
      {isCrop && job.originalAssetUrl ? <CropBoxEditor src={job.originalAssetUrl} box={cropBox} onChange={setCropBox} disabled={busy} /> : <img className="import-editor__preview" src={asset} alt={isGarment ? "Extracted garment" : "Generated modeled look"} />}
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "Detected item" : isGarment ? "Garment image" : "Modeled image"}</p>
        {isCrop ? (
          <>
            <p className="import-card__detail">Check that the box holds the complete item. If it does not, drag on the photo to draw a new box, then update the crop. Approving the crop starts the clean garment image.</p>
            <figure className="import-crop-result"><img src={asset} alt="Detected item crop" /><figcaption>Current crop</figcaption></figure>
          </>
        ) : isGarment ? (
          <>
            <div className="import-field"><label htmlFor={`name-${job.id}`}>Name</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>Category</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>Primary color</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="Primary color hex" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div>{!primaryValid && <small className="import-field-error">Use a six-digit hex color, such as #d8d0c2.</small>}</div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>Secondary color <span>optional</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#hex or leave blank" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} />{!secondaryValid && <small className="import-field-error">Use a six-digit hex color or leave this empty.</small>}</div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>Details</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="casual, cotton, striped" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
          </>
        ) : <p className="import-card__detail">Approve this editorial image to attach it to the new wardrobe piece, or regenerate it with a more specific direction.</p>}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>Regeneration direction <span>optional</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="3" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder={isGarment ? "Example: preserve the original zipper and remove the retail tag" : "Example: use a quiet evening street and show the full garment"} />
        </div>}
        <div className="import-actions">
          <button className="import-button" data-shortcut="reject" disabled={busy} onClick={() => onAction("reject")}><Trash size={14} /> Reject <kbd>X</kbd></button>
          {!isCrop && <button className="import-button" data-shortcut="regenerate" disabled={busy} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> Regenerate <kbd>R</kbd></button>}
          {cropChanged && <button className="import-button" data-shortcut="undo" disabled={busy} onClick={() => setCropBox(savedBox)}><ArrowCounterClockwise size={14} /> Undo box <kbd>Z</kbd></button>}
          {cropChanged ? <button className="import-button import-button--primary" data-shortcut="approve" disabled={busy} onClick={() => onCrop(cropBox)}><Check size={14} weight="bold" /> Update crop <kbd>↵</kbd></button> : <button className="import-button import-button--primary" data-shortcut="approve" disabled={busy || (isGarment && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction("approve")}><Check size={14} weight="bold" /> {isCrop ? "Use crop" : "Approve"} <kbd>↵</kbd></button>}
        </div>
      </div>
    </div>
  );
}

function CleanupEditor({ job, tolerance, setTolerance, busy, onPreview, onAccept }) {
  const stage = job.stages.garment;
  const contaminated = stage.cleanupDiagnostics?.contaminatedPixels;
  const previewTimer = useRef(null);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const updateTolerance = (next) => {
    setTolerance(next);
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => onPreview(next), 300);
  };
  return (
    <div className="import-cleanup-editor">
      <p className="import-editor__stage">Background cleanup</p>
      <p className="import-card__detail">The generated garment is preserved below. Adjust the cleanup locally—this does not call the image model again.</p>
      <div className="import-cleanup-comparison">
        <figure><img src={stage.failedAssetUrl} alt="Generated garment on its chroma background" /><figcaption>Generated source</figcaption></figure>
        <figure><img src={stage.cleanupPreviewUrl || stage.failedAssetUrl} alt="Transparent garment cleanup preview" /><figcaption>{stage.cleanupPreviewUrl ? "Cleanup preview" : "Preview appears here"}</figcaption></figure>
      </div>
      <div className="import-field import-cleanup-strength">
        <label htmlFor={`cleanup-${job.id}`}>Cleanup strength <strong>{tolerance}</strong></label>
        <input id={`cleanup-${job.id}`} type="range" min="18" max="110" step="2" value={tolerance} onChange={(event) => updateTolerance(Number(event.target.value))} />
        <div className="import-cleanup-scale"><span>Preserve more edge detail</span><span>Remove more background</span></div>
      </div>
      {Number.isFinite(contaminated) && <p className="import-card__detail">The automated check sees {contaminated.toLocaleString()} tinted edge {contaminated === 1 ? "pixel" : "pixels"}. If the preview looks clean, you can still use it.</p>}
      <div className="import-actions">
        <button className="import-button" disabled={busy} onClick={() => onPreview(tolerance)}><ArrowCounterClockwise size={14} /> Preview cleanup</button>
        <button className="import-button import-button--primary" data-shortcut="approve" disabled={busy} onClick={onAccept}><Check size={14} weight="bold" /> Use this cleanup <kbd>↵</kbd></button>
      </div>
    </div>
  );
}

export function WardrobeImportFlow({ onGarmentApproved, onModeledApproved }) {
  const inputRef = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [regenerationPrompts, setRegenerationPrompts] = useState({});
  const [cleanupTolerances, setCleanupTolerances] = useState({});
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [setup, setSetup] = useState(null);
  const [googlePhotos, setGooglePhotos] = useState(null);
  const [googleStep, setGoogleStep] = useState("");
  const [albumLink, setAlbumLink] = useState("");
  const [skipped, setSkipped] = useState([]);
  const [batches, setBatches] = useState([]);
  const [batchBusyId, setBatchBusyId] = useState(null);

  useEffect(() => {
    api(CONFIG_API).then(setSetup).catch((requestError) => setSetup({ ready: false, error: requestError.message }));
    api(`${GOOGLE_API}/status`).then(setGooglePhotos).catch(() => setGooglePhotos(null));
    api(BATCH_API).then(setBatches).catch(() => {});
    api(API)
      .then((storedJobs) => {
        const visibleJobs = storedJobs.filter(visibleJob);
        setJobs(visibleJobs);
        setDrafts(Object.fromEntries(visibleJobs.map((job) => [job.id, defaultDraft(job)])));
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(async (id) => {
    try {
      const next = await api(`${API}/${id}`);
      setJobs((current) => current.map((job) => job.id === id ? next : job));
      setDrafts((current) => current[id] ? current : { ...current, [id]: defaultDraft(next) });
    } catch (requestError) { setError(requestError.message); }
  }, []);

  useEffect(() => {
    if (!jobs.some((job) => (job.stages?.crop?.status === "approved" && ["processing", "pending", "queued"].includes(job.stages?.garment?.status)) || ["processing", "queued"].includes(job.stages?.modeled?.status) || (job.stages?.garment?.status === "approved" && job.stages?.modeled?.status === "pending"))) return undefined;
    const timer = setInterval(() => jobs.forEach((job) => refresh(job.id)), 900);
    return () => clearInterval(timer);
  }, [jobs, refresh]);

  // While a big import runs on the server, follow its progress and pick up the items it queues.
  const batchActive = batches.some((batch) => ACTIVE_BATCH.has(batch.state));
  useEffect(() => {
    if (!batchActive) return undefined;
    const timer = setInterval(async () => {
      try {
        setBatches(await api(BATCH_API));
        const storedJobs = (await api(API)).filter(visibleJob);
        setJobs((current) => {
          const known = new Set(current.map((job) => job.id));
          const added = storedJobs.filter((job) => !known.has(job.id));
          return added.length ? [...current, ...added] : current;
        });
        setDrafts((current) => ({ ...Object.fromEntries(storedJobs.filter((job) => !current[job.id]).map((job) => [job.id, defaultDraft(job)])), ...current }));
      } catch { /* try again on the next tick */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [batchActive]);

  const addBatch = useCallback((batch) => setBatches((current) => [batch, ...current.filter((item) => item.id !== batch.id)]), []);

  const controlBatch = async (batch, action) => {
    setBatchBusyId(batch.id); setError("");
    try {
      const result = action === "dismiss" ? await api(`${BATCH_API}/${batch.id}`, { method: "DELETE" }) : await api(`${BATCH_API}/${batch.id}/${action}`, { method: "POST" });
      setBatches((current) => action === "dismiss" ? current.filter((item) => item.id !== batch.id) : current.map((item) => item.id === batch.id ? result : item));
    } catch (requestError) { setError(requestError.message); }
    finally { setBatchBusyId(null); }
  };

  const submitFiles = useCallback(async (files) => {
    if (!setup?.ready) { setOpen(true); return; }
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setDragging(false); setError(""); setNotice(null); setSkipped([]);
    for (const file of images) {
      try {
        const imageDataUrl = await fileToDataUrl(file);
        const result = await api(API, { method: "POST", body: JSON.stringify({ imageDataUrl, metadata: { name: file.name.replace(/\.[^.]+$/, "") } }) });
        const createdJobs = result.jobs || [result];
        if (result.skipped?.length) { setSkipped((current) => [...current, ...result.skipped]); setOpen(true); }
        if (!createdJobs.length && result.noClothingDetected) {
          setNotice({ tone: "complete", text: "No clothing detected", detail: `We couldn’t find a distinct wearable item in ${file.name}. Try a clearer or more tightly framed image.` });
          setOpen(true);
          continue;
        }
        setJobs((current) => [...current, ...createdJobs]);
        setDrafts((current) => ({ ...current, ...Object.fromEntries(createdJobs.map((job) => [job.id, defaultDraft(job)])) }));
      } catch (requestError) { setError(requestError.message); }
    }
  }, [setup]);

  const importAlbum = useCallback(async () => {
    if (!setup?.ready) { setOpen(true); return; }
    const link = albumLink.trim();
    if (!link) return;
    setError(""); setNotice(null); setSkipped([]); setOpen(true);
    setGoogleStep("Reading the album");
    try {
      addBatch(await api(BATCH_API, { method: "POST", body: JSON.stringify({ url: link }) }));
      setAlbumLink("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setGoogleStep("");
    }
  }, [setup, albumLink, addBatch]);

  const importFromGooglePhotos = useCallback(async () => {
    if (!setup?.ready) { setOpen(true); return; }
    // Open the window now, while the click still counts as a user gesture, so pop-up blockers allow it.
    const popup = window.open("", "wardrobe-google-photos", "popup,width=1040,height=780");
    setError(""); setNotice(null); setSkipped([]); setOpen(true);
    let sessionId = null;
    try {
      if (!popup) throw new Error("Allow pop-ups for this site to import from Google Photos.");
      const status = await api(`${GOOGLE_API}/status`);
      if (!status.connected) {
        setGoogleStep("Sign in to Google Photos");
        popup.location.href = `${GOOGLE_API}/connect`;
        await waitForGoogleConnection(popup);
        setGooglePhotos({ ...status, connected: true });
      }
      setGoogleStep("Pick photos in Google Photos");
      const session = await api(`${GOOGLE_API}/sessions`, { method: "POST" });
      sessionId = session.id;
      popup.location.href = `${session.pickerUri}/autoclose`;
      const deadline = Date.now() + session.timeoutIn * 1000;
      let current = session;
      while (!current.mediaItemsSet) {
        if (Date.now() > deadline) throw new Error("The Google Photos picker timed out. Try again.");
        const closed = popup.closed;
        await wait(closed ? 0 : session.pollInterval * 1000);
        current = await api(`${GOOGLE_API}/sessions/${sessionId}`);
        if (closed && !current.mediaItemsSet) {
          await api(`${GOOGLE_API}/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
          sessionId = null;
          return;
        }
      }
      if (!popup.closed) popup.close();
      setGoogleStep("Starting the import");
      const batch = await api(`${GOOGLE_API}/sessions/${sessionId}/import`, { method: "POST" });
      sessionId = null;
      addBatch(batch);
    } catch (requestError) {
      setError(requestError.message);
      if (popup && !popup.closed) popup.close();
      if (sessionId) api(`${GOOGLE_API}/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
      if (/connect/i.test(requestError.message)) api(`${GOOGLE_API}/status`).then(setGooglePhotos).catch(() => {});
    } finally {
      setGoogleStep("");
    }
  }, [setup, addBatch]);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event) => { if (![...event.dataTransfer.types].includes("Files")) return; event.preventDefault(); depth += 1; setDragging(true); };
    const onDragOver = (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); };
    const onDragLeave = (event) => { event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onDrop = (event) => { event.preventDefault(); depth = 0; setDragging(false); submitFiles(event.dataTransfer.files); };
    const onPaste = (event) => { const files = [...event.clipboardData.files]; if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); submitFiles(files); } };
    window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver); window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [submitFiles]);

  const perform = async (job, stage, action, prompt = "") => {
    setBusyId(job.id); setError("");
    try {
      if (stage === "garment" && action === "approve") {
        const draft = drafts[job.id];
        const metadata = { ...draft, secondaryColor: draft.secondaryColor || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
        await api(`${API}/${job.id}/metadata`, { method: "PATCH", body: JSON.stringify({ metadata }) });
        const updated = await api(`${API}/${job.id}/stages/garment/approve`, { method: "POST" });
        const garmentPath = `/api/import/library/import-${job.id}-garment.png`;
        onGarmentApproved?.({ id: `import-${job.id}`, ...metadata, image: garmentPath, thumbnail: garmentPath, modeledImage: null, palette: [metadata.color, metadata.secondaryColor].filter(Boolean), importJobId: job.id });
        setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      } else {
        const updated = await api(`${API}/${job.id}/stages/${stage}/${action}`, { method: "POST", body: action === "regenerate" ? JSON.stringify({ prompt }) : undefined });
        const removeFromQueue = action === "reject" || (stage === "modeled" && action === "approve");
        const remainingJobs = removeFromQueue ? jobs.filter((item) => item.id !== job.id) : null;
        setJobs((current) => removeFromQueue ? current.filter((item) => item.id !== job.id) : current.map((item) => item.id === job.id ? updated : item));
        if (removeFromQueue) {
          setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
          setSelectedReviewId(null);
          if (!remainingJobs.length) setOpen(false);
        }
        if (action === "regenerate") setRegenerationPrompts((current) => ({ ...current, [`${job.id}:${stage}`]: "" }));
        if (stage === "modeled" && action === "approve") onModeledApproved?.(job.id, `/api/import/library/import-${job.id}-modeled.png`);
      }
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const updateCrop = async (job, boundingBox) => {
    setBusyId(job.id); setError("");
    try {
      const updated = await api(`${API}/${job.id}/crop`, { method: "POST", body: JSON.stringify({ boundingBox }) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const performCleanup = async (job, action, requestedTolerance) => {
    setBusyId(job.id); setError("");
    try {
      const tolerance = requestedTolerance ?? cleanupTolerances[job.id] ?? job.stages?.garment?.cleanupTolerance ?? 46;
      const updated = await api(`${API}/${job.id}/stages/garment/cleanup-${action}`, { method: "POST", body: JSON.stringify({ tolerance }) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      setCleanupTolerances((current) => ({ ...current, [job.id]: updated.stages?.garment?.cleanupTolerance ?? tolerance }));
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const deleteJob = async (job) => {
    setBusyId(job.id); setError("");
    try {
      await api(`${API}/${job.id}`, { method: "DELETE" });
      const remaining = jobs.filter((item) => item.id !== job.id);
      setJobs(remaining);
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
      if (selectedReviewId === job.id) setSelectedReviewId(null);
      if (!remaining.length) setOpen(false);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const popoverRef = useRef(null);
  const reviewableIds = jobs.filter((job) => reviewStageFor(job) || hasCleanupFailure(job)).map((job) => job.id);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!open) {
        // "i" opens the import panel, unless an item viewer is open or the user is typing.
        if (event.key.toLowerCase() === "i" && !isTyping(event.target) && !document.body.classList.contains("viewer-open")) { event.preventDefault(); setOpen(true); }
        return;
      }
      if (isTyping(event.target)) {
        if (event.key === "Escape") { event.preventDefault(); event.target.blur(); }
        return;
      }
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === "Escape") {
        event.preventDefault();
        const undo = popoverRef.current?.querySelector('[data-shortcut="undo"]:not(:disabled)');
        if (undo) undo.click(); else setOpen(false);
        return;
      }
      if (["j", "k", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(key)) {
        if (!reviewableIds.length) return;
        event.preventDefault();
        const step = ["j", "ArrowRight", "ArrowDown"].includes(key) ? 1 : -1;
        const current = reviewableIds.indexOf(reviewJob?.id);
        setSelectedReviewId(reviewableIds[(current + step + reviewableIds.length) % reviewableIds.length]);
        return;
      }
      const action = SHORTCUTS[key];
      if (!action || (key === "Enter" && event.target?.closest?.("button, a"))) return;
      const button = popoverRef.current?.querySelector(`.import-editor [data-shortcut="${action}"], .import-cleanup-editor [data-shortcut="${action}"]`);
      if (!button || button.disabled) return;
      event.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const active = jobs[jobs.length - 1];
  const setupRequired = setup?.ready === false;
  const runningBatch = batches.find((batch) => ACTIVE_BATCH.has(batch.state));
  const activeStatus = setupRequired ? { tone: "error", text: "Setup required" } : googleStep ? { tone: "processing", text: googleStep } : active ? deriveStatus(active) : runningBatch ? { tone: "processing", text: `${runningBatch.title}: ${batchProgress(runningBatch).toLocaleString()} of ${runningBatch.total.toLocaleString()}` } : notice;
  const readyCount = jobs.filter((job) => deriveStatus(job).tone === "ready").length;
  const selectedReviewJob = jobs.find((job) => job.id === selectedReviewId && (reviewStageFor(job) || hasCleanupFailure(job)));
  const reviewJob = selectedReviewJob || jobs.find((job) => reviewStageFor(job)) || jobs.find((job) => hasCleanupFailure(job)) || active;
  const reviewStage = reviewJob ? reviewStageFor(reviewJob) : null;
  const progress = 0;
  const hasImportActivity = Boolean(jobs.length || notice || setupRequired || googleStep || batches.length);
  const albumForm = (
    <form className="import-album-form" onSubmit={(event) => { event.preventDefault(); importAlbum(); }}>
      <input type="url" inputMode="url" aria-label="Google Photos album link" placeholder="Paste a Google Photos album link" value={albumLink} disabled={!setup?.ready || Boolean(googleStep)} onChange={(event) => setAlbumLink(event.target.value)} />
      <button className="import-button" type="submit" disabled={!setup?.ready || Boolean(googleStep) || !albumLink.trim()}><GooglePhotosLogo size={14} /> Import album</button>
    </form>
  );
  const googleButton = googlePhotos?.configured && (
    <button className="import-button" disabled={!setup?.ready || Boolean(googleStep)} onClick={importFromGooglePhotos}>
      {googleStep ? <SpinnerGap size={14} className="import-spinner" /> : <GooglePhotosLogo size={14} />} {googleStep || "Google Photos"}
    </button>
  );

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden disabled={!setup?.ready} onChange={(event) => { submitFiles(event.target.files); event.target.value = ""; }} />
      <div className="import-drop-overlay" data-active={dragging && !setupRequired} aria-hidden={!dragging || setupRequired}><div className="import-drop-target is-over"><UploadSimple size={34} weight="light" /><h2>Drop clothing images</h2><p>A single garment or a photo of a full outfit works. Your wardrobe stays exactly where you left it.</p></div></div>
      <aside className={`import-tray${hasImportActivity ? " is-expanded" : ""}`} aria-label="Wardrobe imports">
        <button className="import-tray__button" type="button" onClick={() => setupRequired || hasImportActivity ? setOpen(true) : inputRef.current?.click()} aria-label={setupRequired ? "Open setup instructions" : hasImportActivity ? "Open import progress" : "Add clothes"}>{activeStatus?.tone === "processing" ? <SpinnerGap size={19} className="import-spinner" /> : activeStatus?.tone === "error" ? <WarningCircle size={19} /> : readyCount ? <span>{readyCount}</span> : notice ? <X size={18} /> : <Plus size={19} />}</button>
        <div className="import-tray__actions">{active && <img className="import-tray__preview" src={active.stages?.garment?.assetUrl || active.stages?.garment?.failedAssetUrl || active.stages?.crop?.assetUrl || active.originalAssetUrl} alt="" />}<span className="import-tray__label">{activeStatus?.text || "Add clothes"}</span>{!setupRequired && <button className="import-icon-button" type="button" onClick={() => inputRef.current?.click()} aria-label="Choose images"><UploadSimple size={17} /></button>}{!setupRequired && <button className="import-icon-button" type="button" onClick={() => setOpen(true)} aria-label="Import from Google Photos"><GooglePhotosLogo size={17} /></button>}</div>
      </aside>
      <div className="import-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section ref={popoverRef} className="import-popover" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <header className="import-popover__header"><div><p className="import-popover__eyebrow">Wardrobe import</p><h2 className="import-popover__title" id="import-title">{readyCount ? `${readyCount} ready for review` : activeStatus?.tone === "error" ? "Import needs attention" : jobs.length ? "Preparing new pieces" : notice?.text || "Add to your wardrobe"}</h2></div><button className="import-icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close import progress"><X size={20} /></button></header>
          {batches.length > 0 && <div className="import-batch-list">{batches.map((batch) => <BatchCard key={batch.id} batch={batch} busy={batchBusyId === batch.id} onControl={(action) => controlBatch(batch, action)} />)}</div>}
          {!jobs.length ? setupRequired ? <div className="import-drop-target import-setup-warning"><WarningCircle size={30} /><h2>Setup required</h2><p>Add your OpenAI API key to <code>.env</code> and a PNG reference photo of yourself at <code>{setup.modelReference || "data/model-reference.png"}</code>, then restart the app.</p></div> : <div className="import-drop-target"><UploadSimple size={28} /><h2>{notice ? "Try another image" : "Choose or paste an image"}</h2><p>{notice?.detail || "We’ll isolate each clothing item, suggest its details, and hold everything for your approval."}</p><div className="import-actions"><button className="import-button import-button--primary" disabled={!setup?.ready} onClick={() => { setNotice(null); inputRef.current?.click(); }}>Choose images</button>{googleButton}</div>{albumForm}</div> : (
            <>
              <div className={`import-progress${activeStatus?.tone !== "processing" ? " is-reviewing" : progress < 100 ? " is-indeterminate" : ""}`}><div className="import-progress__meta"><span>{activeStatus?.text}</span><span>{jobs.length} {jobs.length === 1 ? "item" : "items"}</span></div>{activeStatus?.tone === "processing" && <div className="import-progress__track"><div className="import-progress__bar" style={{ "--import-progress": `${progress}%` }} /></div>}</div>
              {reviewJob && reviewStage ? <ReviewEditor key={`${reviewJob.id}:${reviewStage}`} onCrop={(boundingBox) => updateCrop(reviewJob, boundingBox)} job={reviewJob} stage={reviewStage} draft={drafts[reviewJob.id] || defaultDraft(reviewJob)} setDraft={(draft) => setDrafts((current) => ({ ...current, [reviewJob.id]: draft }))} regenPrompt={regenerationPrompts[`${reviewJob.id}:${reviewStage}`] || ""} setRegenPrompt={(prompt) => setRegenerationPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: prompt }))} busy={busyId === reviewJob.id} onAction={(action, prompt) => perform(reviewJob, reviewStage, action, prompt)} /> : reviewJob && hasCleanupFailure(reviewJob) ? <CleanupEditor job={reviewJob} tolerance={cleanupTolerances[reviewJob.id] ?? reviewJob.stages.garment.cleanupTolerance ?? 46} setTolerance={(tolerance) => setCleanupTolerances((current) => ({ ...current, [reviewJob.id]: tolerance }))} busy={busyId === reviewJob.id} onPreview={(tolerance) => performCleanup(reviewJob, "preview", tolerance)} onAccept={() => performCleanup(reviewJob, "accept")} /> : null}
              <div className="import-card-list">{jobs.map((job) => { const status = deriveStatus(job); const itemName = drafts[job.id]?.name || job.metadata?.name || "New piece"; const failedStage = job.stages?.garment?.status === "failed" ? "garment" : job.stages?.modeled?.status === "failed" ? "modeled" : null; return <article className={`import-card is-${status.tone}${reviewJob?.id === job.id ? " is-selected" : ""}`} key={job.id}><img className="import-card__image" src={job.stages?.garment?.assetUrl || job.stages?.garment?.failedAssetUrl || job.stages?.crop?.assetUrl || job.originalAssetUrl} alt="" /><div className="import-card__body"><h3 className="import-card__title">{itemName}</h3><p className="import-card__detail import-card__detail--status" data-tone={status.tone}>{status.tone === "error" ? status.detail : status.text}</p></div><div className="import-card__actions">{status.tone === "ready" && <button className="import-icon-button" onClick={() => { setSelectedReviewId(job.id); setOpen(true); }} aria-label={`Review ${itemName}`}><Check size={17} /></button>}{failedStage && <button className="import-button import-card__retry" disabled={busyId === job.id} onClick={() => perform(job, failedStage, "regenerate", "")}><ArrowCounterClockwise size={14} /> Retry</button>}<button className="import-icon-button import-card__delete" disabled={busyId === job.id} onClick={() => deleteJob(job)} aria-label={`Delete ${itemName} from import queue`}><Trash size={16} /></button></div></article>; })}</div>
              <p className="import-shortcuts" aria-label="Keyboard shortcuts"><span><kbd>↵</kbd> approve</span><span><kbd>X</kbd> reject</span><span><kbd>R</kbd> regenerate</span><span><kbd>J</kbd><kbd>K</kbd> next and previous item</span><span><kbd>Esc</kbd> undo box or close</span></p>
              {albumForm}<div className="import-actions">{googleButton}<button className="import-button" onClick={() => inputRef.current?.click()}><Plus size={14} /> Add another</button></div>
            </>
          )}
          {skipped.length > 0 && <p className="import-status is-complete" role="status">Skipped {skipped.length} {skipped.length === 1 ? "item" : "items"} you already have: {skipped.map((item) => `${item.name} (same as ${item.matches})`).join(", ")}.</p>}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
    </>
  );
}
