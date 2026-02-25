import {
  mdxGetTitle,
  mdxHasPdxFileName,
  mdxGetPdxFileName,
  mdxGetRequiredBufferSize,
  mdxUtilCreateMdxPdxBuffer,
} from './mdx_util.js';

const ui = {
  mdxFileInput: document.getElementById('mdxFileInput'),
  pdxFileInput: document.getElementById('pdxFileInput'),
  loadPlayBtn: document.getElementById('loadPlayBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  fadeBtn: document.getElementById('fadeBtn'),
  stopBtn: document.getElementById('stopBtn'),
  dropZone: document.getElementById('dropZone'),
  titleValue: document.getElementById('titleValue'),
  elapsedValue: document.getElementById('elapsedValue'),
  loopsValue: document.getElementById('loopsValue'),
  durationValue: document.getElementById('durationValue'),
  statusText: document.getElementById('statusText'),
  meterCanvas: document.getElementById('meterCanvas'),
};

let audioContext = null;
let workletNode = null;
let workletReady = false;
let readyResolve = null;
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve;
});

const playbackState = {
  running: false,
  paused: false,
};

let selectedMdxFile = null;
let selectedPdxFile = null;
const discoveredFiles = new Map();

const vizState = {
  opmRegs: new Uint8Array(256),
  opmElapsed: new Uint16Array(256),
  keyOnActive: new Uint8Array(16),
  notes: new Uint16Array(16),
  pitchOffsets: new Int16Array(16),
  volumes: new Uint8Array(16),
  keyOnLevels: new Float32Array(16),
  keyOffLevels: new Float32Array(16),
};

function setStatus(text, isError = false) {
  ui.statusText.textContent = text;
  ui.statusText.style.color = isError ? 'var(--danger)' : 'var(--text-soft)';
}

function formatSecondsFromMs(ms) {
  const sec = Math.max(0, (ms >>> 0) / 1000);
  return `${sec.toFixed(1)}s`;
}

function levelFromVolume(rawVolume) {
  const volume = rawVolume & 0xff;
  if (volume & 0x80) {
    return ((0x7f - (volume & 0x7f)) * 2) & 0xff;
  }
  return ((volume & 0x0f) * 0x11) & 0xff;
}

function invertAsciiCaseChar(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code + 0x20);
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x20);
  return ch;
}

function togglePdxNameCase(name, toggleBase, toggleExt) {
  const firstDot = name.indexOf('.');
  const lastDot = name.lastIndexOf('.');
  let out = '';
  for (let i = 0; i < name.length; i += 1) {
    const inBase = firstDot < 0 || i < firstDot;
    const inExt = lastDot >= 0 && i > lastDot;
    if ((toggleBase && inBase) || (toggleExt && inExt)) {
      out += invertAsciiCaseChar(name[i]);
    } else {
      out += name[i];
    }
  }
  return out;
}

function buildPdxNameCandidates(pdxFileName) {
  const result = [];
  const seen = new Set();
  for (let i = 0; i < 4; i += 1) {
    const candidate = togglePdxNameCase(pdxFileName, (i & 1) !== 0, (i & 2) !== 0);
    const key = candidate.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

function setSelectedMdx(file) {
  selectedMdxFile = file || null;
  if (selectedMdxFile) {
    setStatus(`Selected MDX: ${selectedMdxFile.name}`);
  }
}

function setSelectedPdx(file) {
  selectedPdxFile = file || null;
  if (selectedPdxFile) {
    setStatus(`Selected PDX: ${selectedPdxFile.name}`);
  }
}

function rememberFiles(fileList) {
  for (const file of fileList) {
    discoveredFiles.set(file.name.toUpperCase(), file);
  }
}

async function readFileAsUint8Array(file) {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

function resetVizState() {
  vizState.opmRegs.fill(0);
  vizState.opmElapsed.fill(0);
  vizState.keyOnActive.fill(0);
  vizState.notes.fill(0);
  vizState.pitchOffsets.fill(0);
  vizState.volumes.fill(0);
  vizState.keyOnLevels.fill(0);
  vizState.keyOffLevels.fill(0);
}

function onWorkletMessage(event) {
  const msg = event.data || {};
  switch (msg.type) {
    case 'ready':
      workletReady = true;
      readyResolve();
      setStatus(`Audio engine ready (${msg.sampleRate}Hz).`);
      return;
    case 'trackLoaded':
      playbackState.running = true;
      playbackState.paused = false;
      ui.durationValue.textContent = formatSecondsFromMs(msg.durationMs >>> 0);
      setStatus('Playback started.');
      return;
    case 'paused':
      playbackState.paused = true;
      setStatus('Paused.');
      return;
    case 'resumed':
      playbackState.paused = false;
      setStatus('Resumed.');
      return;
    case 'stopped':
      playbackState.running = false;
      playbackState.paused = false;
      setStatus('Stopped.');
      return;
    case 'ended':
      playbackState.running = false;
      playbackState.paused = false;
      ui.elapsedValue.textContent = formatSecondsFromMs(msg.playTimeMs >>> 0);
      ui.loopsValue.textContent = String(msg.loops >>> 0);
      setStatus('Track finished.');
      return;
    case 'status':
      ui.elapsedValue.textContent = formatSecondsFromMs(msg.playTimeMs >>> 0);
      ui.loopsValue.textContent = String(msg.loops >>> 0);

      if (msg.opmRegs && msg.opmUpdated) {
        for (let i = 0; i < 256; i += 1) {
          vizState.opmRegs[i] = msg.opmRegs[i] >>> 0;
          if (msg.opmUpdated[i]) vizState.opmElapsed[i] = 0;
        }
      }

      if (msg.keyOnActive && msg.notes && msg.pitchOffsets && msg.volumes) {
        for (let i = 0; i < 16; i += 1) {
          vizState.keyOnActive[i] = msg.keyOnActive[i] ? 1 : 0;
          vizState.notes[i] = msg.notes[i] & 0xffff;
          vizState.pitchOffsets[i] = msg.pitchOffsets[i] | 0;
          vizState.volumes[i] = msg.volumes[i] & 0xff;
        }
      }

      if (msg.fmKeyOnCurrent && msg.fmKeyOnPulse) {
        for (let i = 0; i < 8; i += 1) {
          if (!msg.fmKeyOnCurrent[i]) {
            vizState.keyOffLevels[i] = (vizState.keyOffLevels[i] * 127) / 128;
          }
          if (msg.fmKeyOnPulse[i]) {
            const level = levelFromVolume(vizState.volumes[i]);
            vizState.keyOnLevels[i] = level;
            vizState.keyOffLevels[i] = level;
          }
        }
      }

      if (msg.pcmKeyOnPulse) {
        for (let i = 0; i < 8; i += 1) {
          if (msg.pcmKeyOnPulse[i]) {
            const ch = i + 8;
            const level = levelFromVolume(vizState.volumes[ch]);
            vizState.keyOnLevels[ch] = level;
            vizState.keyOffLevels[ch] = level;
          }
        }
      }
      return;
    case 'error':
      setStatus(`Worklet error: ${msg.message}`, true);
      return;
    default:
      return;
  }
}

async function initAudioIfNeeded() {
  if (audioContext && workletNode) return;

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('Web Audio API is not available in this browser.');
  }

  audioContext = new AudioContextCtor({ sampleRate: 48000, latencyHint: 'interactive' });
  if (!audioContext.audioWorklet || typeof audioContext.audioWorklet.addModule !== 'function') {
    const secureHint = window.isSecureContext
      ? 'Use a browser with AudioWorklet support.'
      : 'Serve this page via https:// or http://localhost (not file://).';
    await audioContext.close();
    audioContext = null;
    throw new Error(`AudioWorklet is not available. ${secureHint}`);
  }

  await audioContext.audioWorklet.addModule('./js/audio/worklet.js');

  workletNode = new AudioWorkletNode(audioContext, 'mxdrv-worklet', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  workletNode.port.onmessage = onWorkletMessage;
  workletNode.connect(audioContext.destination);
  workletNode.port.postMessage({
    type: 'init',
    memoryPoolSize: 8 * 1024 * 1024,
    mdxBufferSize: 1 * 1024 * 1024,
    pdxBufferSize: 2 * 1024 * 1024,
    totalVolume: 256,
  });

  window.addEventListener('beforeunload', () => {
    if (workletNode) {
      workletNode.port.postMessage({ type: 'dispose' });
      workletNode.disconnect();
    }
    if (audioContext) {
      audioContext.close();
    }
  });
}

async function ensureWorkletReady() {
  if (workletReady) return;
  await readyPromise;
}

async function choosePdxBytes(mdxBytes) {
  const hasPdx = mdxHasPdxFileName(mdxBytes);
  if (hasPdx == null) throw new Error('MdxHasPdxFileName failed.');
  if (!hasPdx) return null;

  if (selectedPdxFile) {
    return readFileAsUint8Array(selectedPdxFile);
  }

  const pdxFileName = mdxGetPdxFileName(mdxBytes);
  if (!pdxFileName) {
    throw new Error('MdxGetPdxFileName failed.');
  }

  for (const candidate of buildPdxNameCandidates(pdxFileName)) {
    const hit = discoveredFiles.get(candidate.toUpperCase());
    if (hit) {
      setStatus(`Using discovered PDX: ${hit.name}`);
      return readFileAsUint8Array(hit);
    }
  }

  throw new Error(`PDX is required (${pdxFileName}) but no matching file was provided.`);
}

async function loadAndPlay() {
  if (!selectedMdxFile) {
    throw new Error('Select an MDX file first.');
  }

  await initAudioIfNeeded();
  await ensureWorkletReady();
  await audioContext.resume();

  const mdxFileImage = await readFileAsUint8Array(selectedMdxFile);
  const title = mdxGetTitle(mdxFileImage);
  if (!title) throw new Error('MdxGetTitle failed.');
  ui.titleValue.textContent = title;

  const pdxFileImage = await choosePdxBytes(mdxFileImage);
  const required = mdxGetRequiredBufferSize(
    mdxFileImage,
    pdxFileImage ? pdxFileImage.length : 0
  );
  if (!required) throw new Error('MdxGetRequiredBufferSize failed.');

  const mdxBuffer = new Uint8Array(required.mdxBufferSize);
  const pdxBuffer = required.pdxBufferSize > 0 ? new Uint8Array(required.pdxBufferSize) : null;

  const createArgs = { mdxFileImage, mdxBuffer };
  if (pdxBuffer && pdxFileImage) {
    createArgs.pdxFileImage = pdxFileImage;
    createArgs.pdxBuffer = pdxBuffer;
  }
  mdxUtilCreateMdxPdxBuffer(createArgs);

  resetVizState();
  const payload = {
    type: 'loadTrack',
    mdxBuffer: mdxBuffer.buffer,
    pdxBuffer: pdxBuffer ? pdxBuffer.buffer : null,
  };
  const transferList = [payload.mdxBuffer];
  if (payload.pdxBuffer) transferList.push(payload.pdxBuffer);
  workletNode.port.postMessage(payload, transferList);

  ui.elapsedValue.textContent = '0.0s';
  ui.loopsValue.textContent = '0';
  ui.durationValue.textContent = '-';
  setStatus(`Loading ${selectedMdxFile.name} ...`);
}

async function sendTransportCommand(type) {
  await initAudioIfNeeded();
  await ensureWorkletReady();
  if (type === 'resume') {
    await audioContext.resume();
  }
  workletNode.port.postMessage({ type });
}

function onDropZoneEnter(event) {
  event.preventDefault();
  ui.dropZone.classList.add('is-active');
}

function onDropZoneLeave(event) {
  event.preventDefault();
  ui.dropZone.classList.remove('is-active');
}

function onDropZoneDrop(event) {
  event.preventDefault();
  ui.dropZone.classList.remove('is-active');

  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length === 0) return;
  rememberFiles(files);

  for (const file of files) {
    const upper = file.name.toUpperCase();
    if (!selectedMdxFile && upper.endsWith('.MDX')) {
      setSelectedMdx(file);
      continue;
    }
    if (!selectedPdxFile && upper.endsWith('.PDX')) {
      setSelectedPdx(file);
    }
  }

  setStatus(`Discovered ${files.length} dropped file(s).`);
}

function fillRectSafe(ctx, x, y, w, h, color, boundsW, boundsH) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(boundsW, Math.ceil(x + w));
  const y1 = Math.min(boundsH, Math.ceil(y + h));
  if (x1 <= x0 || y1 <= y0) return;
  ctx.fillStyle = color;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}

function renderVisualizer() {
  const canvas = ui.meterCanvas;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.imageSmoothingEnabled = false;

  const OPM_COLUMN_W = 64;
  const OPM_ROW_H = 8;
  const OPM_BIT_W = 7;
  const KEY_DISPLAY_X = 32;
  const KEY_DISPLAY_Y = 256;
  const KEY_W = 5;
  const KEY_H = 16;
  const LEVEL_METER_X = 0;
  const LEVEL_METER_Y = 256;
  const LEVEL_METER_W = 32;
  const LEVEL_METER_H = 16;

  const draw = () => {
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, 'rgba(14, 29, 40, 0.98)');
    bg.addColorStop(1, 'rgba(5, 11, 20, 0.98)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    for (let reg = 0; reg < 256; reg += 1) {
      const regVal = vizState.opmRegs[reg];
      const attn = Math.min(vizState.opmElapsed[reg], 512);
      for (let bit = 0; bit < 8; bit += 1) {
        const x = ((reg & 7) * OPM_COLUMN_W) + (bit * OPM_BIT_W);
        const y = ((reg / 8) | 0) * OPM_ROW_H;
        const bitOn = (regVal & (1 << bit)) !== 0 ? 1 : 0;
        const r = (bitOn * 0x60 + (0x80 / Math.exp(attn / 64)) + 0x1f) | 0;
        const g = (bitOn * 0x80 + (0x60 / Math.exp(attn / 16)) + 0x1f) | 0;
        const b = (bitOn * 0x60 + (0x80 / Math.exp(attn / 256)) + 0x1f) | 0;
        fillRectSafe(ctx, x, y, OPM_BIT_W - 1, OPM_ROW_H - 1, `rgb(${r}, ${g}, ${b})`, width, height);
      }
      if (vizState.opmElapsed[reg] < 0xffff) {
        vizState.opmElapsed[reg] += 1;
      }
    }

    for (let i = 0; i < 16; i += 1) {
      const note = vizState.notes[i] & 0xffff;
      const pitchOffset = vizState.pitchOffsets[i] | 0;
      const level = levelFromVolume(vizState.volumes[i]);

      if (vizState.keyOnActive[i]) {
        const key = ((note + 27) / 64) | 0;
        const xBase = key * KEY_W + KEY_DISPLAY_X;
        const yBase = i * KEY_H + KEY_DISPLAY_Y;

        if (i < 8) {
          const xPitch = xBase + ((pitchOffset * KEY_W) / 64);
          fillRectSafe(ctx, xPitch, yBase, KEY_W, KEY_H - 1, 'rgb(0, 128, 0)', width, height);
          fillRectSafe(ctx, xBase, yBase, KEY_W, KEY_H - 1, `rgb(${level}, ${level}, 255)`, width, height);
        } else {
          fillRectSafe(ctx, xBase, yBase, KEY_W, KEY_H - 1, `rgb(255, ${level}, ${level})`, width, height);
        }
      }

      if (!vizState.keyOnActive[i]) {
        vizState.keyOffLevels[i] = (vizState.keyOffLevels[i] * 127) / 128;
      }

      const offWidth = (vizState.keyOffLevels[i] * LEVEL_METER_W) / 255;
      const onWidth = (vizState.keyOnLevels[i] * LEVEL_METER_W) / 255;
      const y = i * LEVEL_METER_H + LEVEL_METER_Y;
      fillRectSafe(ctx, LEVEL_METER_X, y, offWidth, LEVEL_METER_H - 1, 'rgb(64, 64, 64)', width, height);
      fillRectSafe(ctx, LEVEL_METER_X, y, onWidth, LEVEL_METER_H - 1, 'rgb(255, 255, 255)', width, height);
      vizState.keyOnLevels[i] = (vizState.keyOnLevels[i] * 31) / 32;
    }

    requestAnimationFrame(draw);
  };

  draw();
}

function bindEvents() {
  ui.mdxFileInput.addEventListener('change', () => {
    const file = ui.mdxFileInput.files?.[0] || null;
    if (file) rememberFiles([file]);
    setSelectedMdx(file);
  });

  ui.pdxFileInput.addEventListener('change', () => {
    const file = ui.pdxFileInput.files?.[0] || null;
    if (file) rememberFiles([file]);
    setSelectedPdx(file);
  });

  ui.loadPlayBtn.addEventListener('click', async () => {
    try {
      await loadAndPlay();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, true);
    }
  });

  ui.pauseBtn.addEventListener('click', async () => {
    try {
      await sendTransportCommand('pause');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, true);
    }
  });

  ui.resumeBtn.addEventListener('click', async () => {
    try {
      await sendTransportCommand('resume');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, true);
    }
  });

  ui.stopBtn.addEventListener('click', async () => {
    try {
      await sendTransportCommand('stop');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, true);
    }
  });

  ui.fadeBtn.addEventListener('click', async () => {
    try {
      await sendTransportCommand('fadeout');
      setStatus('Fadeout requested.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, true);
    }
  });

  ui.dropZone.addEventListener('dragenter', onDropZoneEnter);
  ui.dropZone.addEventListener('dragover', onDropZoneEnter);
  ui.dropZone.addEventListener('dragleave', onDropZoneLeave);
  ui.dropZone.addEventListener('drop', onDropZoneDrop);

  window.addEventListener('keydown', async (event) => {
    if (event.target instanceof HTMLInputElement) return;
    try {
      if (event.code === 'Space') {
        event.preventDefault();
        if (playbackState.running) {
          await sendTransportCommand(playbackState.paused ? 'resume' : 'pause');
        } else if (selectedMdxFile) {
          await loadAndPlay();
        }
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        await sendTransportCommand('fadeout');
        setStatus('Fadeout requested.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, true);
    }
  });
}

bindEvents();
renderVisualizer();
