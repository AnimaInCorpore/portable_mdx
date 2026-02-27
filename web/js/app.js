import {
  mdxGetTitle,
  mdxHasPdxFileName,
  mdxGetPdxFileName,
  mdxGetRequiredBufferSize,
  mdxUtilCreateMdxPdxBuffer,
} from './mdx_util.js';

const ui = {
  filePicker: document.getElementById('filePicker'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  playIcon: document.getElementById('playIcon'),
  pauseIcon: document.getElementById('pauseIcon'),
  playPauseText: document.getElementById('playPauseText'),
  fadeBtn: document.getElementById('fadeBtn'),
  stopBtn: document.getElementById('stopBtn'),
  dropZone: document.getElementById('dropZone'),
  titleValue: document.getElementById('titleValue'),
  elapsedValue: document.getElementById('elapsedValue'),
  loopsValue: document.getElementById('loopsValue'),
  durationValue: document.getElementById('durationValue'),
  statusText: document.getElementById('statusText'),
  meterCanvas: document.getElementById('meterCanvas'),
  songList: document.getElementById('songList'),
  songCountValue: document.getElementById('songCountValue'),
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

const trackLibrary = {
  tracks: [],
  selectedTrackId: null,
  collections: new Map(),
  globalByPath: new Map(),
  globalByBase: new Map(),
};

const utf8Decoder = new TextDecoder('utf-8');
let zipImportSequence = 0;
const FILE_PICKER_ACCEPT = '.mdx,.MDX,.pdx,.PDX,.zip,.ZIP';

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

function normalizePath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function getPathBaseName(path) {
  const normalized = normalizePath(path);
  const pos = normalized.lastIndexOf('/');
  return pos >= 0 ? normalized.slice(pos + 1) : normalized;
}

function getPathDirName(path) {
  const normalized = normalizePath(path);
  const pos = normalized.lastIndexOf('/');
  return pos >= 0 ? normalized.slice(0, pos) : '';
}

function isMdxPath(path) {
  return normalizePath(path).toUpperCase().endsWith('.MDX');
}

function isPdxPath(path) {
  return normalizePath(path).toUpperCase().endsWith('.PDX');
}

function isZipPath(path) {
  return normalizePath(path).toUpperCase().endsWith('.ZIP');
}

function isIOSLikeDevice() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
}

function configureFilePickerAccept() {
  // iOS Safari can hide unknown custom extensions when accept only lists them.
  // Allow all picks on iOS; unsupported files are still ignored in handleIncomingFiles().
  ui.filePicker.accept = isIOSLikeDevice() ? '' : FILE_PICKER_ACCEPT;
}

function formatTrackLabel(track) {
  return track.sourceName
    ? `${track.relativePath} [${track.sourceName}]`
    : track.relativePath;
}

function getOrCreateCollection(collectionId) {
  let collection = trackLibrary.collections.get(collectionId);
  if (!collection) {
    collection = {
      byPath: new Map(),
      byBase: new Map(),
    };
    trackLibrary.collections.set(collectionId, collection);
  }
  return collection;
}

function addResourceIndexEntry(resource, byPath, byBase) {
  if (!byPath.has(resource.pathKey)) {
    byPath.set(resource.pathKey, resource);
  }
  let list = byBase.get(resource.baseKey);
  if (!list) {
    list = [];
    byBase.set(resource.baseKey, list);
  }
  if (!list.some((entry) => entry.id === resource.id)) {
    list.push(resource);
  }
}

function registerResource(resource) {
  const collection = getOrCreateCollection(resource.collectionId);
  addResourceIndexEntry(resource, collection.byPath, collection.byBase);
  addResourceIndexEntry(resource, trackLibrary.globalByPath, trackLibrary.globalByBase);

  if (!isMdxPath(resource.relativePath)) {
    return null;
  }
  if (trackLibrary.tracks.some((track) => track.id === resource.id)) {
    return null;
  }
  trackLibrary.tracks.push(resource);
  return resource;
}

function getSelectedTrack() {
  if (!trackLibrary.selectedTrackId) return null;
  return trackLibrary.tracks.find((track) => track.id === trackLibrary.selectedTrackId) || null;
}

function renderSongList() {
  if (!ui.songList) return;
  const selectedTrackId = trackLibrary.selectedTrackId;
  ui.songList.textContent = '';
  for (const track of trackLibrary.tracks) {
    const option = document.createElement('option');
    option.value = track.id;
    option.textContent = formatTrackLabel(track);
    option.selected = track.id === selectedTrackId;
    ui.songList.appendChild(option);
  }
  ui.songList.disabled = trackLibrary.tracks.length === 0;
  if (ui.songCountValue) {
    ui.songCountValue.textContent = String(trackLibrary.tracks.length);
  }
}

function setSelectedMdx(track, { silentStatus = false } = {}) {
  trackLibrary.selectedTrackId = track ? track.id : null;
  renderSongList();
  if (track && !silentStatus) {
    setStatus(`Selected MDX: ${formatTrackLabel(track)}`);
  }
}

function makeResourceId(collectionId, relativePath, sizeHint = 0, stamp = 0) {
  return `${collectionId}::${normalizePath(relativePath).toUpperCase()}::${sizeHint}::${stamp}`;
}

function createResourceFromFile(file, collectionId = 'loose') {
  const relativePath = normalizePath(file.name);
  return {
    id: makeResourceId(collectionId, relativePath, file.size >>> 0, file.lastModified >>> 0),
    collectionId,
    sourceName: '',
    relativePath,
    pathKey: relativePath.toUpperCase(),
    baseName: getPathBaseName(relativePath),
    baseKey: getPathBaseName(relativePath).toUpperCase(),
    readBytes: async () => readFileAsUint8Array(file),
  };
}

function readUint16LE(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new Error('Invalid ZIP: truncated uint16 field.');
  }
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error('Invalid ZIP: truncated uint32 field.');
  }
  return (
    (bytes[offset]) |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function decodeZipPath(bytes, start, length) {
  if (start < 0 || length < 0 || start + length > bytes.length) {
    throw new Error('Invalid ZIP: filename field out of bounds.');
  }
  return normalizePath(utf8Decoder.decode(bytes.subarray(start, start + length)));
}

function findEndOfCentralDirectoryOffset(zipBytes) {
  const minimum = Math.max(0, zipBytes.length - (0xffff + 22));
  for (let offset = zipBytes.length - 22; offset >= minimum; offset -= 1) {
    if (
      zipBytes[offset] === 0x50 &&
      zipBytes[offset + 1] === 0x4b &&
      zipBytes[offset + 2] === 0x05 &&
      zipBytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}

async function inflateRawDeflate(compressedBytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('ZIP deflate extraction requires browser support for DecompressionStream.');
  }
  const decompressed = new Blob([compressedBytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(decompressed).arrayBuffer();
  return new Uint8Array(buffer);
}

function createResourceFromZipEntry({
  collectionId,
  sourceName,
  relativePath,
  compressionMethod,
  compressedBytes,
  uncompressedSize,
}) {
  let cachedBytesPromise = null;
  const normalizedPath = normalizePath(relativePath);
  const ensureBytes = async () => {
    if (!cachedBytesPromise) {
      cachedBytesPromise = (async () => {
        if (compressionMethod === 0) {
          if (uncompressedSize !== 0xffffffff && compressedBytes.length !== (uncompressedSize >>> 0)) {
            throw new Error(`ZIP entry size mismatch for ${normalizedPath}.`);
          }
          return compressedBytes;
        }
        if (compressionMethod === 8) {
          const inflated = await inflateRawDeflate(compressedBytes);
          if (uncompressedSize !== 0xffffffff && inflated.length !== (uncompressedSize >>> 0)) {
            throw new Error(`ZIP entry size mismatch for ${normalizedPath}.`);
          }
          return inflated;
        }
        throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${normalizedPath}.`);
      })();
    }
    return cachedBytesPromise;
  };

  return {
    id: makeResourceId(collectionId, normalizedPath, uncompressedSize >>> 0, compressionMethod >>> 0),
    collectionId,
    sourceName,
    relativePath: normalizedPath,
    pathKey: normalizedPath.toUpperCase(),
    baseName: getPathBaseName(normalizedPath),
    baseKey: getPathBaseName(normalizedPath).toUpperCase(),
    readBytes: ensureBytes,
  };
}

async function extractMdxPdxResourcesFromZip(file) {
  const zipBytes = await readFileAsUint8Array(file);
  const eocdOffset = findEndOfCentralDirectoryOffset(zipBytes);
  if (eocdOffset < 0) {
    throw new Error(`Invalid ZIP archive: ${file.name}`);
  }

  const totalEntries = readUint16LE(zipBytes, eocdOffset + 10);
  const centralDirectoryOffset = readUint32LE(zipBytes, eocdOffset + 16);
  const collectionId = `zip:${file.name}:${file.lastModified >>> 0}:${file.size >>> 0}:${zipImportSequence++}`;
  const resources = [];
  let cursor = centralDirectoryOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > zipBytes.length) {
      throw new Error(`Invalid ZIP archive: central directory entry ${i} is truncated.`);
    }
    const centralSig = readUint32LE(zipBytes, cursor);
    if (centralSig !== 0x02014b50) {
      throw new Error(`Invalid ZIP archive: bad central directory signature at entry ${i}.`);
    }

    const flags = readUint16LE(zipBytes, cursor + 8);
    const compressionMethod = readUint16LE(zipBytes, cursor + 10);
    const compressedSize = readUint32LE(zipBytes, cursor + 20);
    const uncompressedSize = readUint32LE(zipBytes, cursor + 24);
    const fileNameLength = readUint16LE(zipBytes, cursor + 28);
    const extraLength = readUint16LE(zipBytes, cursor + 30);
    const commentLength = readUint16LE(zipBytes, cursor + 32);
    const localHeaderOffset = readUint32LE(zipBytes, cursor + 42);

    const fileNameStart = cursor + 46;
    const relativePath = decodeZipPath(zipBytes, fileNameStart, fileNameLength);

    const nextCursor = fileNameStart + fileNameLength + extraLength + commentLength;
    if (nextCursor > zipBytes.length) {
      throw new Error(`Invalid ZIP archive: entry ${relativePath || i} exceeds central directory bounds.`);
    }
    cursor = nextCursor;

    if (!relativePath || relativePath.endsWith('/')) {
      continue;
    }
    if (!isMdxPath(relativePath) && !isPdxPath(relativePath)) {
      continue;
    }
    if ((flags & 0x1) !== 0) {
      throw new Error(`Encrypted ZIP entries are not supported (${relativePath}).`);
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${relativePath}.`);
    }

    if (localHeaderOffset + 30 > zipBytes.length) {
      throw new Error(`Invalid ZIP archive: local header out of range for ${relativePath}.`);
    }
    const localSig = readUint32LE(zipBytes, localHeaderOffset);
    if (localSig !== 0x04034b50) {
      throw new Error(`Invalid ZIP archive: local header signature mismatch for ${relativePath}.`);
    }
    const localNameLength = readUint16LE(zipBytes, localHeaderOffset + 26);
    const localExtraLength = readUint16LE(zipBytes, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBytes.length) {
      throw new Error(`Invalid ZIP archive: compressed payload out of range for ${relativePath}.`);
    }

    resources.push(createResourceFromZipEntry({
      collectionId,
      sourceName: file.name,
      relativePath,
      compressionMethod,
      compressedBytes: zipBytes.slice(dataStart, dataEnd),
      uncompressedSize,
    }));
  }

  return resources;
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

function updatePlayPauseButton() {
  if (!playbackState.running) {
    ui.playIcon.style.display = 'block';
    ui.pauseIcon.style.display = 'none';
    ui.playPauseText.textContent = 'Play';
  } else if (playbackState.paused) {
    ui.playIcon.style.display = 'block';
    ui.pauseIcon.style.display = 'none';
    ui.playPauseText.textContent = 'Resume';
  } else {
    ui.playIcon.style.display = 'none';
    ui.pauseIcon.style.display = 'block';
    ui.playPauseText.textContent = 'Pause';
  }
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
      updatePlayPauseButton();
      ui.durationValue.textContent = formatSecondsFromMs(msg.durationMs >>> 0);
      setStatus('Playback started.');
      return;
    case 'paused':
      playbackState.paused = true;
      updatePlayPauseButton();
      setStatus('Paused.');
      return;
    case 'resumed':
      playbackState.paused = false;
      updatePlayPauseButton();
      setStatus('Resumed.');
      return;
    case 'stopped':
      playbackState.running = false;
      playbackState.paused = false;
      updatePlayPauseButton();
      setStatus('Stopped.');
      return;
    case 'ended':
      playbackState.running = false;
      playbackState.paused = false;
      updatePlayPauseButton();
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

function firstIndexedByBase(byBase, key) {
  const list = byBase.get(key);
  return list && list.length > 0 ? list[0] : null;
}

function findPdxResourceForTrack(track, pdxCandidateName) {
  const trackDir = getPathDirName(track.relativePath);
  const normalizedCandidate = normalizePath(pdxCandidateName);
  const candidateInTrackDir = trackDir && normalizedCandidate.indexOf('/') < 0
    ? normalizePath(`${trackDir}/${normalizedCandidate}`)
    : normalizedCandidate;
  const candidatePathKey = normalizedCandidate.toUpperCase();
  const candidateTrackPathKey = candidateInTrackDir.toUpperCase();
  const candidateBaseKey = getPathBaseName(normalizedCandidate).toUpperCase();

  const collection = trackLibrary.collections.get(track.collectionId);
  if (collection) {
    const scopedHit =
      collection.byPath.get(candidateTrackPathKey) ||
      collection.byPath.get(candidatePathKey) ||
      firstIndexedByBase(collection.byBase, candidateBaseKey);
    if (scopedHit) return scopedHit;
  }

  return (
    trackLibrary.globalByPath.get(candidateTrackPathKey) ||
    trackLibrary.globalByPath.get(candidatePathKey) ||
    firstIndexedByBase(trackLibrary.globalByBase, candidateBaseKey) ||
    null
  );
}

async function choosePdxBytes(mdxBytes, track) {
  const hasPdx = mdxHasPdxFileName(mdxBytes);
  if (hasPdx == null) throw new Error('MdxHasPdxFileName failed.');
  if (!hasPdx) return null;

  const pdxFileName = mdxGetPdxFileName(mdxBytes);
  if (!pdxFileName) {
    throw new Error('MdxGetPdxFileName failed.');
  }

  for (const candidate of buildPdxNameCandidates(pdxFileName)) {
    const hit = findPdxResourceForTrack(track, candidate);
    if (hit) {
      setStatus(`Using discovered PDX: ${formatTrackLabel(hit)}`);
      return hit.readBytes();
    }
  }

  throw new Error(`PDX is required (${pdxFileName}) but no matching file was provided.`);
}

async function loadAndPlay() {
  const selectedTrack = getSelectedTrack();
  if (!selectedTrack) {
    throw new Error('Select an MDX file first.');
  }

  await initAudioIfNeeded();
  await ensureWorkletReady();
  await audioContext.resume();

  const mdxFileImage = await selectedTrack.readBytes();
  const title = mdxGetTitle(mdxFileImage);
  if (!title) throw new Error('MdxGetTitle failed.');
  ui.titleValue.textContent = title;

  const pdxFileImage = await choosePdxBytes(mdxFileImage, selectedTrack);
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
  setStatus(`Loading ${formatTrackLabel(selectedTrack)} ...`);
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

async function handleIncomingFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const resources = [];
  const importStats = {
    droppedItems: files.length,
    directMdx: 0,
    directPdx: 0,
    zipFiles: 0,
    zipEntries: 0,
    ignored: 0,
  };

  for (const file of files) {
    if (isZipPath(file.name)) {
      importStats.zipFiles += 1;
      const zipResources = await extractMdxPdxResourcesFromZip(file);
      importStats.zipEntries += zipResources.length;
      resources.push(...zipResources);
      continue;
    }
    if (isMdxPath(file.name) || isPdxPath(file.name)) {
      const resource = createResourceFromFile(file);
      resources.push(resource);
      if (isMdxPath(file.name)) {
        importStats.directMdx += 1;
      } else {
        importStats.directPdx += 1;
      }
      continue;
    }
    importStats.ignored += 1;
  }

  if (resources.length === 0) {
    setStatus(`Scanned ${importStats.droppedItems} item(s), but no MDX/PDX files were found.`, true);
    return;
  }

  const newTracks = [];
  for (const resource of resources) {
    const addedTrack = registerResource(resource);
    if (addedTrack) {
      newTracks.push(addedTrack);
    }
  }

  if (newTracks.length > 0) {
    setSelectedMdx(newTracks[0], { silentStatus: true });
  } else if (!getSelectedTrack() && trackLibrary.tracks.length > 0) {
    setSelectedMdx(trackLibrary.tracks[0], { silentStatus: true });
  } else {
    renderSongList();
  }

  const selectedTrack = getSelectedTrack();
  if (!selectedTrack) {
    setStatus('Imported files, but no MDX song is available to play.', true);
    return;
  }

  const importedCount = resources.length;
  const songCount = trackLibrary.tracks.length;
  const sourceSummary = importStats.zipFiles > 0
    ? `${importStats.directMdx + importStats.directPdx} direct + ${importStats.zipEntries} from ZIP`
    : `${importedCount} direct`;
  setStatus(
    `Imported ${importedCount} MDX/PDX (${sourceSummary}). ${songCount} song(s) available. Selected: ${formatTrackLabel(selectedTrack)}.`
  );
}

async function onDropZoneDrop(event) {
  event.preventDefault();
  ui.dropZone.classList.remove('is-active');
  await handleIncomingFiles(event.dataTransfer?.files || []);
}

function openFilePicker() {
  ui.filePicker.value = '';
  ui.filePicker.click();
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

  // Base dimensions from original 1024x512 layout
  const BASE_W = 1024;
  const BASE_H = 512;
  
  // Calculate scale factors
  const scaleX = width / BASE_W;
  const scaleY = height / BASE_H;

  const OPM_COLUMN_W = 64 * scaleX;
  const OPM_ROW_H = 8 * scaleY;
  const OPM_BIT_W = 7 * scaleX;
  const KEY_DISPLAY_X = 32 * scaleX;
  const KEY_DISPLAY_Y = 256 * scaleY;
  const KEY_W = 5 * scaleX;
  const KEY_H = 16 * scaleY;
  const LEVEL_METER_X = 0;
  const LEVEL_METER_Y = 256 * scaleY;
  const LEVEL_METER_W = 32 * scaleX;
  const LEVEL_METER_H = 16 * scaleY;

  const draw = () => {
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, 'rgba(5, 10, 15, 0.98)');
    bg.addColorStop(1, 'rgba(15, 25, 35, 0.98)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Draw grid lines for OPM registers
    ctx.strokeStyle = 'rgba(79, 208, 203, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 32; i++) {
      ctx.moveTo(0, i * OPM_ROW_H);
      ctx.lineTo(width, i * OPM_ROW_H);
    }
    for (let i = 0; i <= 16; i++) {
      ctx.moveTo(i * OPM_COLUMN_W, 0);
      ctx.lineTo(i * OPM_COLUMN_W, 256 * scaleY);
    }
    ctx.stroke();

    for (let reg = 0; reg < 256; reg += 1) {
      const regVal = vizState.opmRegs[reg];
      const attn = Math.min(vizState.opmElapsed[reg], 512);
      for (let bit = 0; bit < 8; bit += 1) {
        const x = ((reg & 7) * OPM_COLUMN_W) + (bit * OPM_BIT_W);
        const y = ((reg / 8) | 0) * OPM_ROW_H;
        const bitOn = (regVal & (1 << bit)) !== 0 ? 1 : 0;
        
        // Modern color palette for OPM bits
        const r = (bitOn * 79 + (100 / Math.exp(attn / 64)) + 10) | 0;
        const g = (bitOn * 208 + (150 / Math.exp(attn / 16)) + 20) | 0;
        const b = (bitOn * 203 + (150 / Math.exp(attn / 256)) + 30) | 0;
        
        if (bitOn || attn < 512) {
          fillRectSafe(ctx, x + 1, y + 1, OPM_BIT_W - (2 * scaleX), OPM_ROW_H - (2 * scaleY), `rgb(${r}, ${g}, ${b})`, width, height);
        } else {
          fillRectSafe(ctx, x + 1, y + 1, OPM_BIT_W - (2 * scaleX), OPM_ROW_H - (2 * scaleY), 'rgba(255, 255, 255, 0.03)', width, height);
        }
      }
      if (vizState.opmElapsed[reg] < 0xffff) {
        vizState.opmElapsed[reg] += 1;
      }
    }

    // Draw separator line
    ctx.strokeStyle = 'rgba(79, 208, 203, 0.2)';
    ctx.beginPath();
    ctx.moveTo(0, KEY_DISPLAY_Y);
    ctx.lineTo(width, KEY_DISPLAY_Y);
    ctx.stroke();

    for (let i = 0; i < 16; i += 1) {
      const note = vizState.notes[i] & 0xffff;
      const pitchOffset = vizState.pitchOffsets[i] | 0;
      const level = levelFromVolume(vizState.volumes[i]);

      if (vizState.keyOnActive[i]) {
        const key = ((note + 27) / 64) | 0;
        const xBase = key * KEY_W + KEY_DISPLAY_X;
        const yBase = i * KEY_H + KEY_DISPLAY_Y;

        if (i < 8) {
          // FM Channels (Cyan/Blue)
          const xPitch = xBase + ((pitchOffset * KEY_W) / 64);
          fillRectSafe(ctx, xPitch, yBase + 2, KEY_W, KEY_H - (4 * scaleY), 'rgba(79, 208, 203, 0.5)', width, height);
          fillRectSafe(ctx, xBase, yBase + 2, KEY_W, KEY_H - (4 * scaleY), `rgb(${level/2}, ${level}, 255)`, width, height);
        } else {
          // ADPCM Channels (Orange/Red)
          fillRectSafe(ctx, xBase, yBase + 2, KEY_W, KEY_H - (4 * scaleY), `rgb(255, ${level/1.5}, ${level/3})`, width, height);
        }
      }

      if (!vizState.keyOnActive[i]) {
        vizState.keyOffLevels[i] = (vizState.keyOffLevels[i] * 127) / 128;
      }

      const offWidth = (vizState.keyOffLevels[i] * LEVEL_METER_W) / 255;
      const onWidth = (vizState.keyOnLevels[i] * LEVEL_METER_W) / 255;
      const y = i * LEVEL_METER_H + LEVEL_METER_Y;
      
      // Channel labels
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = `${10 * scaleY}px monospace`;
      ctx.fillText(i < 8 ? `FM${i+1}` : `PCM${i-7}`, 2 * scaleX, y + (12 * scaleY));

      // Level meters
      const meterX = LEVEL_METER_X + (30 * scaleX);
      fillRectSafe(ctx, meterX, y + 2, offWidth, LEVEL_METER_H - (4 * scaleY), 'rgba(255, 255, 255, 0.1)', width, height);
      
      const meterColor = i < 8 ? 'rgb(79, 208, 203)' : 'rgb(241, 178, 74)';
      fillRectSafe(ctx, meterX, y + 2, onWidth, LEVEL_METER_H - (4 * scaleY), meterColor, width, height);
      
      vizState.keyOnLevels[i] = (vizState.keyOnLevels[i] * 31) / 32;
    }

    requestAnimationFrame(draw);
  };

  draw();
}

function bindEvents() {
  ui.filePicker.addEventListener('change', async () => {
    try {
      await handleIncomingFiles(ui.filePicker.files || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, true);
    }
  });

  ui.playPauseBtn.addEventListener('click', async () => {
    try {
      if (!playbackState.running) {
        await loadAndPlay();
      } else if (playbackState.paused) {
        await sendTransportCommand('resume');
      } else {
        await sendTransportCommand('pause');
      }
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
  ui.dropZone.addEventListener('click', () => {
    openFilePicker();
  });
  ui.dropZone.addEventListener('keydown', (event) => {
    if (event.code === 'Enter' || event.code === 'Space') {
      event.preventDefault();
      openFilePicker();
    }
  });

  if (ui.songList) {
    ui.songList.addEventListener('change', () => {
      const nextTrack = trackLibrary.tracks.find((track) => track.id === ui.songList.value) || null;
      if (nextTrack) {
        setSelectedMdx(nextTrack);
      }
    });
  }

  window.addEventListener('keydown', async (event) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLButtonElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable)
    ) {
      return;
    }
    try {
      if (event.code === 'Space') {
        event.preventDefault();
        if (!playbackState.running) {
          if (getSelectedTrack()) {
            await loadAndPlay();
          }
        } else if (playbackState.paused) {
          await sendTransportCommand('resume');
        } else {
          await sendTransportCommand('pause');
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

configureFilePickerAccept();
bindEvents();
renderSongList();
renderVisualizer();
