const DEFAULT_DOTS = { width: 96, height: 40 }; // fallback until we know the real device

const state = {
  ip: localStorage.getItem("monarchIp") || "",
  dots: DEFAULT_DOTS,
  connected: false,
  imageBitmap: null, // decoded source image, kept for re-sending at full res
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
    if (state.imageBitmap) renderPreview();
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
  if (!file || !file.type.startsWith("image/")) return;
  const bitmap = await createImageBitmap(file);
  state.imageBitmap = bitmap;
  el.previewCard.hidden = false;
  el.sendBtn.disabled = false;
  setStatus(el.sendStatus, "");
  renderPreview();
}

// --- Preview rendering -----------------------------------------------------

function renderPreview() {
  const bitmap = state.imageBitmap;
  if (!bitmap) return;

  // Original, capped for display purposes.
  const maxOriginal = 320;
  const scaleOriginal = Math.min(maxOriginal / bitmap.width, maxOriginal / bitmap.height, 1);
  const ow = Math.round(bitmap.width * scaleOriginal);
  const oh = Math.round(bitmap.height * scaleOriginal);
  el.originalCanvas.width = ow;
  el.originalCanvas.height = oh;
  el.originalCanvas.getContext("2d").drawImage(bitmap, 0, 0, ow, oh);

  // Dithered preview matching the receiver's own fit-and-threshold logic.
  const { width, height } = state.dots;
  const dots = ditherToFit(bitmap, width, height);

  el.ditherCanvas.width = width;
  el.ditherCanvas.height = height;
  const ctx = el.ditherCanvas.getContext("2d");
  const imgData = ctx.createImageData(width, height);
  for (let i = 0; i < dots.length; i++) {
    const v = dots[i] ? 0 : 255; // raised (1) -> black dot, lowered (0) -> white
    imgData.data[i * 4] = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Mirrors ReceiverActivity.bitmapToDotsMatrix: fit-with-letterbox, grayscale,
 * Floyd-Steinberg dithering. Returns a flat Uint8Array (0/1) of length width*height.
 * This is only a preview -- the actual conversion always happens on the Monarch.
 */
function ditherToFit(bitmap, width, height) {
  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const scaledW = Math.max(1, Math.round(bitmap.width * scale));
  const scaledH = Math.max(1, Math.round(bitmap.height * scale));
  const offsetX = Math.floor((width - scaledW) / 2);
  const offsetY = Math.floor((height - scaledH) / 2);

  const tmp = document.createElement("canvas");
  tmp.width = scaledW;
  tmp.height = scaledH;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(bitmap, 0, 0, scaledW, scaledH);
  const pixels = tctx.getImageData(0, 0, scaledW, scaledH).data;

  const gray = new Float32Array(width * height).fill(255);
  for (let y = 0; y < scaledH; y++) {
    for (let x = 0; x < scaledW; x++) {
      const p = (y * scaledW + x) * 4;
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[(y + offsetY) * width + (x + offsetX)] = lum;
    }
  }

  const dots = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldValue = gray[idx];
      const raised = oldValue < 128;
      const newValue = raised ? 0 : 255;
      const error = oldValue - newValue;
      dots[idx] = raised ? 1 : 0;

      if (x + 1 < width) gray[idx + 1] += (error * 7) / 16;
      if (y + 1 < height) {
        if (x - 1 >= 0) gray[idx + width - 1] += (error * 3) / 16;
        gray[idx + width] += (error * 5) / 16;
        if (x + 1 < width) gray[idx + width + 1] += (error * 1) / 16;
      }
    }
  }
  return dots;
}

// --- Send ------------------------------------------------------------------

el.sendBtn.addEventListener("click", sendImage);

async function sendImage() {
  if (!state.imageBitmap) return;
  if (!el.ip.value.trim()) {
    setStatus(el.sendStatus, "Escribe la IP de la Monarch primero.", "err");
    return;
  }

  el.sendBtn.disabled = true;
  setStatus(el.sendStatus, "Enviando...");

  try {
    const blob = await bitmapToJpegBlob(state.imageBitmap, 900);
    const res = await fetch(`${baseUrl()}/image`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(el.sendStatus, "Imagen enviada. Deberia verse en la pantalla braille.", "ok");
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

function bitmapToJpegBlob(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}
