#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  mdxGetTitle,
  mdxHasPdxFileName,
  mdxGetPdxFileName,
  mdxGetRequiredBufferSize,
  mdxUtilCreateMdxPdxBuffer,
} from '../mdx_util.js';
import {
  MxdrvContext,
  MxdrvContext_Initialize,
  MxdrvContext_Terminate,
} from '../mxdrv/context.js';
import {
  MXDRV_Start,
  MXDRV_End,
  MXDRV_SetData2,
  MXDRV_Play2,
  MXDRV_MeasurePlayTime2,
  MXDRV_PCM8Enable,
  MXDRV_TotalVolume,
  MXDRV_GetPCM,
} from '../mxdrv/driver_core.js';

const SAMPLE_RATE = 48000;
const MDX_BUFFER_SIZE = 1 * 1024 * 1024;
const PDX_BUFFER_SIZE = 2 * 1024 * 1024;
const MEMORY_POOL_SIZE = 8 * 1024 * 1024;

function printUsage() {
  console.log(
    'Simple mdx -> wav converter (JavaScript port)\n' +
    'usage:\n' +
    '  node web/js/tools/simple_mdx2wav.mjs -i <mdxfilepath> -o <wavfilepath>\n'
  );
}

function parseArgs(argv) {
  const args = { input: null, output: null, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if (token === '-i') {
      i += 1;
      if (i >= argv.length) throw new Error("No arg for '-i'.");
      args.input = argv[i];
      continue;
    }
    if (token === '-o') {
      i += 1;
      if (i >= argv.length) throw new Error("No arg for '-o'.");
      args.output = argv[i];
      continue;
    }
    throw new Error(`Invalid arg '${token}'.`);
  }
  return args;
}

function stripSurroundingQuotes(text) {
  if (typeof text !== 'string') return text;
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
    return text.slice(1, -1);
  }
  return text;
}

function readFileAsUint8Array(filePath) {
  return new Uint8Array(fs.readFileSync(filePath));
}

function invertAsciiCaseChar(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) {
    return String.fromCharCode(code + 0x20);
  }
  if (code >= 0x61 && code <= 0x7a) {
    return String.fromCharCode(code - 0x20);
  }
  return ch;
}

function togglePdxNameCase(pdxFileName, toggleBaseName, toggleExtension) {
  const firstDot = pdxFileName.indexOf('.');
  const lastDot = pdxFileName.lastIndexOf('.');
  let out = '';
  for (let i = 0; i < pdxFileName.length; i += 1) {
    const ch = pdxFileName[i];
    const inBaseName = firstDot < 0 || i < firstDot;
    const inExtension = lastDot >= 0 && i > lastDot;
    if ((toggleBaseName && inBaseName) || (toggleExtension && inExtension)) {
      out += invertAsciiCaseChar(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

function buildPdxNameCandidates(pdxFileName) {
  const result = [];
  const seen = new Set();
  for (let retry = 0; retry < 4; retry += 1) {
    const candidate = togglePdxNameCase(pdxFileName, (retry & 1) !== 0, (retry & 2) !== 0);
    const key = candidate.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

function tryReadOptionalPdx(mdxFilePath, pdxFileName) {
  const mdxDir = path.dirname(mdxFilePath);
  const candidates = buildPdxNameCandidates(pdxFileName);
  for (const nameCandidate of candidates) {
    const pdxFilePath = path.join(mdxDir, nameCandidate);
    process.stdout.write(`read ${pdxFilePath} ... `);
    try {
      const image = readFileAsUint8Array(pdxFilePath);
      console.log('succeeded.');
      return image;
    } catch {
      console.log('failed.');
    }
  }
  return new Uint8Array(0);
}

function writePcm16StereoAsWav(filePath, pcmSamples, sampleRate) {
  const numChannels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample >> 3;
  const dataSize = pcmSamples.byteLength >>> 0;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE((36 + dataSize) >>> 0, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate >>> 0, 24);
  header.writeUInt32LE((sampleRate * numChannels * bytesPerSample) >>> 0, 28);
  header.writeUInt16LE(numChannels * bytesPerSample, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const pcmBuffer = Buffer.from(
    pcmSamples.buffer,
    pcmSamples.byteOffset,
    pcmSamples.byteLength
  );

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  if (!args.input) {
    throw new Error('Please specify an input mdx filepath with -i.');
  }
  if (!args.output) {
    throw new Error('Please specify an output wav filepath with -o.');
  }

  const mdxFilePath = stripSurroundingQuotes(args.input);
  const wavFilePath = stripSurroundingQuotes(args.output);
  const mdxFileImage = readFileAsUint8Array(mdxFilePath);

  const title = mdxGetTitle(mdxFileImage);
  if (title == null) {
    throw new Error('MdxGetTitle failed.');
  }
  console.log(`mdx title = ${title}`);

  const hasPdx = mdxHasPdxFileName(mdxFileImage);
  if (hasPdx == null) {
    throw new Error('MdxHasPdxFileName failed.');
  }

  let pdxFileImage = new Uint8Array(0);
  if (hasPdx) {
    const pdxFileName = mdxGetPdxFileName(mdxFileImage);
    if (!pdxFileName) {
      throw new Error('MdxGetPdxFileName failed.');
    }
    console.log(`pdx filename = ${pdxFileName}`);
    pdxFileImage = tryReadOptionalPdx(mdxFilePath, pdxFileName);
  }

  const requiredSizes = mdxGetRequiredBufferSize(mdxFileImage, pdxFileImage.length);
  if (requiredSizes == null) {
    throw new Error('MdxGetRequiredBufferSize failed.');
  }
  console.log(`mdxBufferSizeInBytes = ${requiredSizes.mdxBufferSize}`);
  console.log(`pdxBufferSizeInBytes = ${requiredSizes.pdxBufferSize}`);

  const mdxBuffer = new Uint8Array(requiredSizes.mdxBufferSize);
  const pdxBuffer = requiredSizes.pdxBufferSize > 0
    ? new Uint8Array(requiredSizes.pdxBufferSize)
    : null;

  const createOptions = { mdxFileImage, mdxBuffer };
  if (pdxBuffer) {
    createOptions.pdxFileImage = pdxFileImage;
    createOptions.pdxBuffer = pdxBuffer;
  }
  mdxUtilCreateMdxPdxBuffer(createOptions);

  const context = new MxdrvContext();
  if (!MxdrvContext_Initialize(context, MEMORY_POOL_SIZE)) {
    throw new Error('MxdrvContext_Initialize failed.');
  }

  let started = false;
  try {
    const startRet = MXDRV_Start(
      context,
      SAMPLE_RATE,
      0,
      0,
      0,
      MDX_BUFFER_SIZE,
      PDX_BUFFER_SIZE,
      0
    );
    if (startRet !== 0) {
      throw new Error(`MXDRV_Start failed. return code = ${startRet}`);
    }
    started = true;

    MXDRV_PCM8Enable(context, 1);
    MXDRV_TotalVolume(context, 256);

    const setDataRet = MXDRV_SetData2(
      context,
      mdxBuffer,
      mdxBuffer.length,
      pdxBuffer,
      pdxBuffer ? pdxBuffer.length : 0
    );
    if (setDataRet !== 0) {
      throw new Error(`MXDRV_SetData2 failed. return code = ${setDataRet}`);
    }

    const durationMs = MXDRV_MeasurePlayTime2(context, 1, 0) >>> 0;
    if (durationMs === 0) {
      throw new Error('MXDRV_MeasurePlayTime2 returned 0.');
    }
    console.log(`song duration ${(durationMs / 1000).toFixed(1)}(sec)`);

    MXDRV_Play2(context);

    const numFrames = Math.floor((durationMs * SAMPLE_RATE) / 1000);
    const wavBuffer = new Int16Array(numFrames * 2);
    const getPcmRet = MXDRV_GetPCM(context, wavBuffer, numFrames);
    if (getPcmRet !== 0) {
      throw new Error(`MXDRV_GetPCM failed. return code = ${getPcmRet}`);
    }

    writePcm16StereoAsWav(wavFilePath, wavBuffer, SAMPLE_RATE);
    console.log(`wrote ${wavFilePath}`);
  } finally {
    if (started) {
      MXDRV_End(context);
    }
    MxdrvContext_Terminate(context);
  }

  return 0;
}

try {
  const exitCode = run();
  process.exit(exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  printUsage();
  process.exit(1);
}
