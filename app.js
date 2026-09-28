const DEFAULT_DOTS = { width: 96, height: 40 }; // fallback until we know the real device

// The receiver redoes the dot conversion itself at every zoom level, so it needs the
// original detail, not the 96x40 pattern.
const SOURCE_SEND_MAX_SIDE = 2400;

const state = {
  ip: localStorage.getItem("monarchIp") || "",
  dots: DEFAULT_DOTS,
  connected: false,
  rawBitmap: null, // pristine source image (file/camera or GeoGebra capture)
  source: null, // { bitmap, canvas, width, height, lum }: rawBitmap as it gets sent (see buildSource)
  dotPattern: null, // { width, height, dots }, the 0/1 pattern the Monarch will show at zoom 1
  sentSource: null, // the source currently on the Monarch, so thickness changes can go live
  thickness: 0, // line-thickening amount, in dots
};

const el = {
  ip: document.getElementById("ip"),
  connectBtn: document.getElementById("connectBtn"),
  connectionStatus: document.getElementById("connectionStatus"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  cameraInput: document.getElementById("cameraInput"),
  previewCard: document.getElementById("previewCard"),
  originalCanvas: document.getElementById("originalCanvas"),
  ditherCanvas: document.getElementById("ditherCanvas"),
  ditherLabel: document.getElementById("ditherLabel"),
  sendBtn: document.getElementById("sendBtn"),
  sendStatus: document.getElementById("sendStatus"),
  tabButtons: document.querySelectorAll(".tab-btn"),
  imageTab: document.getElementById("imageTab"),
  geogebraTab: document.getElementById("geogebraTab"),
  captureBtn: document.getElementById("captureBtn"),
  captureStatus: document.getElementById("captureStatus"),
  thicknessInput: document.getElementById("thicknessInput"),
  thicknessValue: document.getElementById("thicknessValue"),
  deviceCol: document.getElementById("deviceCol"),
  deviceCanvas: document.getElementById("deviceCanvas"),
  deviceLabel: document.getElementById("deviceLabel"),
  screenBtn: document.getElementById("screenBtn"),
};

el.ip.value = state.ip;

// Auto-reconnect to the last IP that worked, so you don't have to go read it
// off the Monarch's screen and retype it every time you reopen this page.
if (state.ip) {
  setStatus(el.connectionStatus, `Reconectando a ${state.ip}...`);
  connect();
}

function baseUrl() {
  const ip = el.ip.value.trim();
  return ip.includes(":") ? `http://${ip}` : `http://${ip}:8080`;
}

function setStatus(node, text, kind) {
  node.textContent = text;
  node.className = "status" + (kind ? " " + kind : "");
}

// --- Connection ---------------------------------------------------------

el.connectBtn.addEventListener("click", connect);
el.ip.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connect();
});

async function connect() {
  const ip = el.ip.value.trim();
  if (!ip) {
    setStatus(el.connectionStatus, "Escribe la IP que muestra la pantalla de la Monarch.", "err");
    return;
  }
  localStorage.setItem("monarchIp", ip);
  setStatus(el.connectionStatus, "Conectando...");
  try {
    const res = await fetch(`${baseUrl()}/info`, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    state.dots = { width: info.width, height: info.height };
    state.connected = true;
    setStatus(
      el.connectionStatus,
      `Conectado. Pantalla braille: ${info.width}x${info.height} puntos.`,
      "ok"
    );
    el.ditherLabel.textContent = `Braille (${info.width}x${info.height})`;
    if (state.rawBitmap) reprocessImage();
  } catch (err) {
    state.connected = false;
    setStatus(
      el.connectionStatus,
      `No se pudo conectar (${err.message}). Revisa que ambos dispositivos esten en la misma red Wi-Fi.`,
      "err"
    );
  }
}

// --- File selection ------------------------------------------------------

el.fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
el.cameraInput.addEventListener("change", (e) => handleFile(e.target.files[0]));

["dragenter", "dragover"].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropZone.classList.remove("dragover");
  })
);
el.dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  if (!file) return;
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  if (!isSvg && !file.type.startsWith("image/")) return;

  setStatus(el.sendStatus, "");
  try {
    state.rawBitmap = isSvg ? await rasterizeSvg(file) : await createImageBitmap(file);
    await reprocessImage();
  } catch (err) {
    setStatus(el.sendStatus, `No se pudo leer el archivo (${err.message}).`, "err");
  }
}

// --- SVG loading -----------------------------------------------------------
//
// createImageBitmap() can't reliably decode SVG directly across browsers,
// especially when the file has no explicit width/height (common when it's
// just a viewBox). We rasterize it ourselves via a plain <img>, at a fixed
// resolution well above what we actually need, so the vector art (often
// razor-thin paths) has enough pixels to survive the min-pooling downscale
// in buildProcessedBitmap.

const SVG_RENDER_MAX_SIDE = 1600;

async function rasterizeSvg(file) {
  const text = await file.text();
  const { width, height } = svgIntrinsicSize(text);

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("no se pudo decodificar el SVG"));
      img.src = url;
    });

    const aspect = width && height ? width / height : (img.naturalWidth || 1) / (img.naturalHeight || 1);
    const targetW = aspect >= 1 ? SVG_RENDER_MAX_SIDE : Math.max(1, Math.round(SVG_RENDER_MAX_SIDE * aspect));
    const targetH = aspect >= 1 ? Math.max(1, Math.round(SVG_RENDER_MAX_SIDE / aspect)) : SVG_RENDER_MAX_SIDE;

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    canvas.getContext("2d").drawImage(img, 0, 0, targetW, targetH);

    return createImageBitmap(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Reads width/height (or falls back to viewBox) off the root <svg> element,
// ignoring percentage values since those are meaningless without a
// container. Returns {} if nothing usable is declared.
function svgIntrinsicSize(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.nodeName !== "svg") return {};

    const dim = (attr) => {
      const raw = root.getAttribute(attr);
      if (!raw || raw.trim().endsWith("%")) return null;
      const v = parseFloat(raw);
      return v > 0 ? v : null;
    };
    const w = dim("width");
    const h = dim("height");
    if (w && h) return { width: w, height: h };

    const viewBox = root.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        return { width: parts[2], height: parts[3] };
      }
    }
  } catch {
    // Fall through to the <img> natural size.
  }
  return {};
}

// --- Dot pattern (max contrast, no grays) ---------------------------------
//
// Rather than send a grayscale/JPEG-ish image and trust the Monarch's own
// fit+grayscale+dither to reproduce it, we compute the exact black/white
// dot pattern ourselves and send that (blown up into solid blocks). This
// guarantees maximum contrast with no in-between grays, and fixes thin
// lines vanishing, in one pass:
//
// 1. "Min-pooling" straight from the native-resolution source down to the
//    real dot grid: each destination dot takes the DARKEST source pixel in
//    its cell instead of the average, so any line that exists anywhere in
//    that cell survives, however thin -- a plain resize would blend a 1-2px
//    dark line into the surrounding white and erase it.
// 2. Optional adjustment via the "Grosor de líneas" slider, in dot-space so
//    one step = one dot of radius: positive values thicken (a grayscale
//    "min filter" / dilation of the ink), negative values thin them back
//    down (a "max filter" / erosion) -- min-pooling above is deliberately
//    generous about what counts as ink, which is what keeps thin lines
//    from vanishing, but on a high-resolution source it can also make them
//    read as bolder than they really are; negative values correct for that.
// 3. A hard threshold (no Floyd-Steinberg error diffusion): every dot ends
//    up fully raised or fully lowered, never an in-between gray.
//
// MonarchImageReceiver runs this exact same algorithm on the device (on the
// original image we send it, plus the thickness), so at zoom 1 what you see
// in the preview is dot-for-dot what you get on the device; zooming in there
// re-derives the dots from the full-resolution source.

const THRESHOLD = 128;

let thicknessRaf = null;
let thicknessSendTimer = null;

el.thicknessInput.addEventListener("input", () => {
  state.thickness = Number(el.thicknessInput.value);
  el.thicknessValue.textContent = String(state.thickness);
  if (thicknessRaf) cancelAnimationFrame(thicknessRaf);
  thicknessRaf = requestAnimationFrame(() => {
    thicknessRaf = null;
    reprocessImage();
  });
  // If this image is already on the Monarch, apply the new thickness there too
  // (only the number travels; the device re-renders the image it already has).
  if (state.sentSource && state.sentSource === state.source) {
    clearTimeout(thicknessSendTimer);
    thicknessSendTimer = setTimeout(sendThickness, 250);
  }
});

async function sendThickness() {
  const thickness = state.thickness;
  try {
    const res = await fetch(`${baseUrl()}/thickness?value=${thickness}`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showDeviceResult(await res.json(), `Grosor ${thickness} aplicado en la Monarch.`);
  } catch (err) {
    setStatus(el.sendStatus, `No se pudo cambiar el grosor en la Monarch (${err.message}).`, "err");
  }
}

async function reprocessImage() {
  if (!state.rawBitmap) return;
  if (state.source?.bitmap !== state.rawBitmap) {
    state.source = buildSource(state.rawBitmap);
    el.deviceCol.hidden = true;
  }
  state.dotPattern = buildDotPattern(state.source, state.thickness);
  el.previewCard.hidden = false;
  el.sendBtn.disabled = false;
  renderPreview();
}

// The exact pixels that get sent (and that the Monarch processes): flattened
// onto white -- a transparent pixel has no defined RGB and could read as ink --
// and capped at SOURCE_SEND_MAX_SIDE. The preview is computed from these same
// pixels so it can't drift from what the device shows.
function buildSource(bitmap) {
  const scale = Math.min(1, SOURCE_SEND_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { bitmap, canvas, width: w, height: h, lum: toLuminance(ctx.getImageData(0, 0, w, h)) };
}

function buildDotPattern(source, thicknessDots) {
  const { width: srcW, height: srcH, lum: nativeLum } = source;

  // Fit (letterbox) into the real dot grid; the receiver does the same at zoom 1.
  const dotsW = (state.dots && state.dots.width) || DEFAULT_DOTS.width;
  const dotsH = (state.dots && state.dots.height) || DEFAULT_DOTS.height;
  const fitScale = Math.min(dotsW / srcW, dotsH / srcH);
  const scaledW = Math.max(1, Math.round(srcW * fitScale));
  const scaledH = Math.max(1, Math.round(srcH * fitScale));
  const offsetX = Math.floor((dotsW - scaledW) / 2);
  const offsetY = Math.floor((dotsH - scaledH) / 2);

  const scaledLum = minPoolLuminance(nativeLum, srcW, srcH, scaledW, scaledH);

  let dotLum = new Float32Array(dotsW * dotsH).fill(255);
  for (let y = 0; y < scaledH; y++) {
    for (let x = 0; x < scaledW; x++) {
      dotLum[(y + offsetY) * dotsW + (x + offsetX)] = scaledLum[y * scaledW + x];
    }
  }

  if (thicknessDots > 0) {
    dotLum = minFilterSeparable(dotLum, dotsW, dotsH, thicknessDots);
  } else if (thicknessDots < 0) {
    dotLum = maxFilterSeparable(dotLum, dotsW, dotsH, -thicknessDots);
  }

  const dots = new Uint8Array(dotsW * dotsH);
  for (let i = 0; i < dotLum.length; i++) dots[i] = dotLum[i] < THRESHOLD ? 1 : 0;

  return { width: dotsW, height: dotsH, dots };
}

function toLuminance(imageData) {
  const { width, height, data } = imageData;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return lum;
}

// Downscales a luminance grid by taking the darkest source pixel in each
// destination cell (single pass, each source pixel visited once), instead
// of averaging. Guarantees thin dark lines survive a large resize.
function minPoolLuminance(srcLum, srcW, srcH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH).fill(255);
  for (let y = 0; y < srcH; y++) {
    const ty = Math.min(dstH - 1, Math.floor((y * dstH) / srcH));
    const rowOff = y * srcW;
    const outRowOff = ty * dstW;
    for (let x = 0; x < srcW; x++) {
      const tx = Math.min(dstW - 1, Math.floor((x * dstW) / srcW));
      const v = srcLum[rowOff + x];
      const idx = outRowOff + tx;
      if (v < out[idx]) out[idx] = v;
    }
  }
  return out;
}

// Square min filter over the luminance grid, done as two 1D passes (darkest
// pixel in a [-radius, radius] window). Darkens ink outward, i.e. thickens
// dark strokes on a light background.
function minFilterSeparable(lum, width, height, radius) {
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      let m = Infinity;
      for (let xi = x0; xi <= x1; xi++) {
        const v = lum[rowOff + xi];
        if (v < m) m = v;
      }
      tmp[rowOff + x] = m;
    }
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      let m = Infinity;
      for (let yi = y0; yi <= y1; yi++) {
        const v = tmp[yi * width + x];
        if (v < m) m = v;
      }
      out[y * width + x] = m;
    }
  }

  return out;
}

// Square max filter -- same as minFilterSeparable but keeps the LIGHTEST
// pixel in the window instead of the darkest. Erodes ink inward, i.e. thins
// dark strokes back down (used for negative "Grosor de líneas" values).
function maxFilterSeparable(lum, width, height, radius) {
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      let m = -Infinity;
      for (let xi = x0; xi <= x1; xi++) {
        const v = lum[rowOff + xi];
        if (v > m) m = v;
      }
      tmp[rowOff + x] = m;
    }
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      let m = -Infinity;
      for (let yi = y0; yi <= y1; yi++) {
        const v = tmp[yi * width + x];
        if (v > m) m = v;
      }
      out[y * width + x] = m;
    }
  }

  return out;
}

// --- Preview rendering -----------------------------------------------------

const PREVIEW_ORIGINAL_MAX_SIDE = 640;
const PREVIEW_PIN_PX = 8;

function renderPreview() {
  const source = state.source;
  const pattern = state.dotPattern;
  if (!source || !pattern) return;

  // Original: the real image (as it's sent, i.e. flattened onto white), smooth.
  const scaleOriginal = Math.min(1, PREVIEW_ORIGINAL_MAX_SIDE / Math.max(source.width, source.height));
  const ow = Math.max(1, Math.round(source.width * scaleOriginal));
  const oh = Math.max(1, Math.round(source.height * scaleOriginal));
  el.originalCanvas.width = ow;
  el.originalCanvas.height = oh;
  const octx = el.originalCanvas.getContext("2d");
  octx.imageSmoothingQuality = "high";
  octx.drawImage(source.canvas, 0, 0, ow, oh);

  drawPins(el.ditherCanvas, pattern);
}

// One circle per pin, like the Monarch's own on-screen view -- raised pins
// bright, lowered pins as faint marks so the 96x40 grid stays readable.
function drawPins(canvas, pattern) {
  const { width, height, dots } = pattern;
  canvas.width = width * PREVIEW_PIN_PX;
  canvas.height = height * PREVIEW_PIN_PX;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const half = PREVIEW_PIN_PX / 2;
  for (const raised of [0, 1]) {
    ctx.fillStyle = raised ? "#fff" : "#3a3a3a";
    const r = raised ? PREVIEW_PIN_PX * 0.42 : PREVIEW_PIN_PX * 0.15;
    ctx.beginPath();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (dots[y * width + x] !== raised) continue;
        const cx = x * PREVIEW_PIN_PX + half;
        const cy = y * PREVIEW_PIN_PX + half;
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
}

function parseDevicePattern(json) {
  const dots = new Uint8Array(json.width * json.height);
  for (let i = 0; i < dots.length; i++) dots[i] = json.dots.charCodeAt(i) === 49 ? 1 : 0; // "1"
  return { width: json.width, height: json.height, dots };
}

function countDifferences(a, b) {
  if (a.width !== b.width || a.height !== b.height) return -1;
  let diff = 0;
  for (let i = 0; i < a.dots.length; i++) if (a.dots[i] !== b.dots[i]) diff++;
  return diff;
}

// Shows the zoom-1 pattern the Monarch computed next to our preview and says
// whether they agree, so a mismatch can be pinned on processing vs. display.
function showDeviceResult(json, prefix) {
  const device = parseDevicePattern(json);
  drawPins(el.deviceCanvas, device);
  el.deviceLabel.textContent = `Monarch (lo que recibió, grosor ${json.thickness})`;
  el.deviceCol.hidden = false;

  const info = `Recibió ${json.receivedWidth}x${json.receivedHeight} px, pantalla ${json.width}x${json.height}.`;
  const diff = state.dotPattern && json.thickness === state.thickness
    ? countDifferences(state.dotPattern, device)
    : null;
  if (diff === 0) {
    setStatus(el.sendStatus, `${prefix} ${info} Coincide punto por punto con la vista previa.`, "ok");
  } else if (diff === null) {
    setStatus(el.sendStatus, `${prefix} ${info}`, "ok");
  } else {
    setStatus(
      el.sendStatus,
      `${prefix} ${info} OJO: no coincide con la vista previa (${diff < 0 ? "tamaño distinto" : diff + " puntos distintos"}).`,
      "err"
    );
  }
}

el.screenBtn.addEventListener("click", async () => {
  try {
    const res = await fetch(`${baseUrl()}/screen`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.dots) throw new Error("la Monarch todavía no ha mostrado nada");
    drawPins(el.deviceCanvas, parseDevicePattern(json));
    const mode = json.mode === "image" ? `imagen, zoom ${json.zoom}x` : "pantalla de la IP";
    el.deviceLabel.textContent = `Monarch (pantalla actual: ${mode})`;
    el.deviceCol.hidden = false;
    el.previewCard.hidden = false;
    if (json.displayError) {
      setStatus(el.sendStatus, `KeySoft rechazó los puntos: ${json.displayError}`, "err");
    } else {
      setStatus(el.sendStatus, "Esto es lo que la app le está mandando ahora a la pantalla braille.", "ok");
    }
  } catch (err) {
    setStatus(el.sendStatus, `No se pudo leer la pantalla de la Monarch (${err.message}).`, "err");
  }
});

// --- GeoGebra tab ------------------------------------------------------------

const GGB_FILE = "assets/app-final.ggb";
let ggbApi = null;
let ggbLoaded = false;

el.tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  el.tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  el.imageTab.hidden = tab !== "image";
  el.geogebraTab.hidden = tab !== "geogebra";
  if (tab === "geogebra" && !ggbLoaded) loadGeoGebra();
}

function loadGeoGebra() {
  ggbLoaded = true;
  setStatus(el.captureStatus, "Cargando applet de GeoGebra...");
  const ggbApp = new GGBApplet(
    {
      appName: "classic",
      width: 560,
      height: 420,
      showToolBar: true,
      showMenuBar: false,
      showAlgebraInput: false,
      showResetIcon: true,
      enableRightClick: true,
      filename: GGB_FILE,
      appletOnLoad: (api) => {
        ggbApi = api;
        setStatus(
          el.captureStatus,
          'Listo. Ajusta el gráfico (deslizadores, zoom, puntos) y presiona "Capturar gráfico".'
        );
      },
    },
    true
  );
  ggbApp.inject("ggbApplet");
}

el.captureBtn.addEventListener("click", captureGeoGebra);

async function captureGeoGebra() {
  if (!ggbApi) {
    setStatus(el.captureStatus, "El applet todavía no está listo.", "err");
    return;
  }
  setStatus(el.captureStatus, "Capturando...");
  try {
    const base64 = ggbApi.getPNGBase64(1, false, 150);
    const res = await fetch(`data:image/png;base64,${base64}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);

    state.rawBitmap = bitmap;
    setStatus(el.sendStatus, "");
    await reprocessImage();
    setStatus(el.captureStatus, "Gráfico capturado. Puedes enviarlo abajo.", "ok");
    el.previewCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus(el.captureStatus, `Error capturando el gráfico (${err.message}).`, "err");
  }
}

// --- Send ------------------------------------------------------------------

el.sendBtn.addEventListener("click", sendImage);

async function sendImage() {
  if (!state.source) return;
  if (!el.ip.value.trim()) {
    setStatus(el.sendStatus, "Escribe la IP de la Monarch primero.", "err");
    return;
  }

  el.sendBtn.disabled = true;
  setStatus(el.sendStatus, "Enviando...");

  try {
    // PNG, not JPEG: lossless, so the device gets exactly the pixels the preview used.
    const blob = await new Promise((resolve) => state.source.canvas.toBlob(resolve, "image/png"));
    const res = await fetch(`${baseUrl()}/image?thickness=${state.thickness}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: blob,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.sentSource = state.source;
    if ((res.headers.get("Content-Type") || "").includes("json")) {
      showDeviceResult(await res.json(), "Imagen enviada.");
    } else {
      setStatus(
        el.sendStatus,
        "Imagen enviada, pero la Monarch tiene una versión vieja de MonarchImageReceiver: instala el APK nuevo.",
        "err"
      );
    }
  } catch (err) {
    setStatus(
      el.sendStatus,
      `Error enviando la imagen (${err.message}). Revisa la IP y la red Wi-Fi.`,
      "err"
    );
  } finally {
    el.sendBtn.disabled = false;
  }
}
