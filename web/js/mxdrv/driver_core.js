import {
  MxdrvContext,
  MxdrvContext_EnterCriticalSection,
  MxdrvContext_LeaveCriticalSection,
  MxdrvContextImpl_ResetMemoryPool,
  MxdrvContextImpl_ReserveMemory,
  MxdrvContextImpl_ReleaseMemory,
  MxdrvContextImpl_GetReservedMemoryPoolSize,
} from './context.js';
import {
  sound_iocs_init,
  _iocs_opmset,
  _iocs_adpcmout,
  _iocs_adpcmmod,
} from './sound_iocs.js';
import {
  X68Sound_Start,
  X68Sound_StartPcm,
  X68Sound_GetPcm,
  X68Sound_Pcm8_Out,
  X68Sound_Pcm8_Abort,
  X68Sound_TotalVolume,
  X68Sound_GetTotalVolume,
  X68Sound_Free,
  X68Sound_OpmInt,
  X68Sound_OpmWait,
} from '../x68sound/index.js';

const SET = 0xff;
const CLR = 0x00;

const MXWORK_CREDIT = 'X68k MXDRV music driver version 2.06+17 Rel.X5-S (c)1988-92 milk.,K.MAEKAWA, Missy.M, Yatsube\nConverted for Win32 [MXDRVg] V2.00a Copyright (C) 2000-2002 GORRY.';

const MXDRV_WORK_FM = 0;
const MXDRV_WORK_PCM = 1;
const MXDRV_WORK_GLOBAL = 2;
const MXDRV_WORK_KEY = 3;
const MXDRV_WORK_OPM = 4;
const MXDRV_WORK_PCM8 = 5;
const MXDRV_WORK_CREDIT = 6;
const MXDRV_CALLBACK_OPMINT = 7;

const MXDRV_ERR_MEMORY = 1;

const X68SNDERR_PCMOUT = -1;
const X68SNDERR_TIMER = -2;
const X68SNDERR_MEMORY = -3;

function ensureContext(context) {
  if (!(context instanceof MxdrvContext)) {
    throw new Error('context must be MxdrvContext');
  }
  if (!context.m_impl || !context.m_impl.m_x68SoundContext) {
    throw new Error('MxdrvContext is not initialized');
  }
}

function ensureReg(reg) {
  if (!reg || typeof reg !== 'object') {
    throw new Error('reg must be an object with d0-d7/a0-a7');
  }
}

function requireUint8Array(buffer, name) {
  if (!(buffer instanceof Uint8Array)) {
    throw new Error(`${name} must be Uint8Array`);
  }
}

function u32(v) {
  return v >>> 0;
}

function low8(v) {
  return v & 0xff;
}

function low16(v) {
  return v & 0xffff;
}

function signed8(v) {
  const n = v & 0xff;
  return (n & 0x80) ? (n - 0x100) : n;
}

function signed16(v) {
  const n = v & 0xffff;
  return (n & 0x8000) ? (n - 0x10000) : n;
}

function signed32(v) {
  return v >> 0;
}

function isSignedWordNegative(v) {
  return (v & 0x8000) !== 0;
}

function pool(context) {
  return context.m_impl.m_memoryPool;
}

function isValidRange(context, ofs, size) {
  const impl = context.m_impl;
  const start = ofs >>> 0;
  const len = size >>> 0;
  const base = impl.m_memoryPoolBaseOffset >>> 0;
  const limit = impl.m_memoryPoolSizeInBytes >>> 0;

  if (len === 0) {
    return start === 0 || (start >= base && start <= limit);
  }
  if (start < base) return false;
  if (start + len > limit) return false;
  return true;
}

function getBWord(context, ofs) {
  if (!isValidRange(context, ofs, 2)) return 0;
  const mem = pool(context);
  const p = ofs >>> 0;
  return ((mem[p] << 8) | mem[p + 1]) >>> 0;
}

function getBLong(context, ofs) {
  if (!isValidRange(context, ofs, 4)) return 0;
  const mem = pool(context);
  const p = ofs >>> 0;
  return ((mem[p] * 0x1000000) + (mem[p + 1] << 16) + (mem[p + 2] << 8) + mem[p + 3]) >>> 0;
}

function getBByte(context, ofs) {
  if (!isValidRange(context, ofs, 1)) return 0;
  return pool(context)[ofs >>> 0] >>> 0;
}

function putBByte(context, ofs, value) {
  if (!isValidRange(context, ofs, 1)) return false;
  pool(context)[ofs >>> 0] = low8(value);
  return true;
}

function putBWord(context, ofs, value) {
  if (!isValidRange(context, ofs, 2)) return false;
  const mem = pool(context);
  const p = ofs >>> 0;
  const v = value >>> 0;
  mem[p] = (v >>> 8) & 0xff;
  mem[p + 1] = v & 0xff;
  return true;
}

function putBLong(context, ofs, value) {
  if (!isValidRange(context, ofs, 4)) return false;
  const mem = pool(context);
  const p = ofs >>> 0;
  const v = value >>> 0;
  mem[p] = (v >>> 24) & 0xff;
  mem[p + 1] = (v >>> 16) & 0xff;
  mem[p + 2] = (v >>> 8) & 0xff;
  mem[p + 3] = v & 0xff;
  return true;
}

function copyPoolBytes(context, dstOfs, srcOfs, size) {
  if (!isValidRange(context, srcOfs, size)) return false;
  if (!isValidRange(context, dstOfs, size)) return false;
  const mem = pool(context);
  mem.set(mem.subarray(srcOfs >>> 0, (srcOfs + size) >>> 0), dstOfs >>> 0);
  return true;
}

function ensureExportBufferOffset(context, fieldName, size) {
  const impl = context.m_impl;
  const existing = impl[fieldName] >>> 0;
  if (existing !== 0 && isValidRange(context, existing, size)) {
    return existing;
  }

  const region = MxdrvContextImpl_ReserveMemory(impl, size >>> 0);
  if (!region) return 0;
  impl[fieldName] = region.offset >>> 0;
  return impl[fieldName] >>> 0;
}

function writeU16LE(mem, ofs, value) {
  const v = value >>> 0;
  mem[ofs >>> 0] = v & 0xff;
  mem[(ofs + 1) >>> 0] = (v >>> 8) & 0xff;
}

function writeU32LE(mem, ofs, value) {
  const v = value >>> 0;
  mem[ofs >>> 0] = v & 0xff;
  mem[(ofs + 1) >>> 0] = (v >>> 8) & 0xff;
  mem[(ofs + 2) >>> 0] = (v >>> 16) & 0xff;
  mem[(ofs + 3) >>> 0] = (v >>> 24) & 0xff;
}

function writeMxWorkChToPool(mem, baseOfs, ch) {
  // Matches MSVC default-aligned MXWORK_CH layout used by the native host API.
  mem[baseOfs + 4] = low8(ch.S0004_b);

  writeU32LE(mem, baseOfs + 0, ch.S0000);
  writeU32LE(mem, baseOfs + 8, ch.S0004);
  writeU32LE(mem, baseOfs + 12, ch.S0008);
  writeU32LE(mem, baseOfs + 16, ch.S000c);

  writeU16LE(mem, baseOfs + 20, ch.S0010);
  writeU16LE(mem, baseOfs + 22, ch.S0012);
  writeU16LE(mem, baseOfs + 24, ch.S0014);

  mem[baseOfs + 26] = low8(ch.S0016);
  mem[baseOfs + 27] = low8(ch.S0017);
  mem[baseOfs + 28] = low8(ch.S0018);
  mem[baseOfs + 29] = low8(ch.S0019);
  mem[baseOfs + 30] = low8(ch.S001a);
  mem[baseOfs + 31] = low8(ch.S001b);
  mem[baseOfs + 32] = low8(ch.S001c);
  mem[baseOfs + 33] = low8(ch.S001d);
  mem[baseOfs + 34] = low8(ch.S001e);
  mem[baseOfs + 35] = low8(ch.S001f);
  mem[baseOfs + 36] = low8(ch.S0020);
  mem[baseOfs + 37] = low8(ch.S0021);
  mem[baseOfs + 38] = low8(ch.S0022);
  mem[baseOfs + 39] = low8(ch.S0023);
  mem[baseOfs + 40] = low8(ch.S0024);
  mem[baseOfs + 41] = low8(ch.S0025);

  writeU32LE(mem, baseOfs + 44, ch.S0026);
  writeU32LE(mem, baseOfs + 48, ch.S002a);
  writeU32LE(mem, baseOfs + 52, ch.S002e);
  writeU32LE(mem, baseOfs + 56, ch.S0032);
  writeU32LE(mem, baseOfs + 60, ch.S0036);

  writeU16LE(mem, baseOfs + 64, ch.S003a);
  writeU16LE(mem, baseOfs + 66, ch.S003c);
  writeU16LE(mem, baseOfs + 68, ch.S003e);

  writeU32LE(mem, baseOfs + 72, ch.S0040);
  writeU16LE(mem, baseOfs + 76, ch.S0044);
  writeU16LE(mem, baseOfs + 78, ch.S0046);
  writeU16LE(mem, baseOfs + 80, ch.S0048);
  writeU16LE(mem, baseOfs + 82, ch.S004a);
  writeU16LE(mem, baseOfs + 84, ch.S004c);
  writeU16LE(mem, baseOfs + 86, ch.S004e);
}

function getChannelByIndex(context, channelIndex) {
  const idx = channelIndex | 0;
  if (idx < 0 || idx > 15) return null;
  if (idx < 9) return context.m_impl.m_MXWORK_CHBUF_FM[idx];
  return context.m_impl.m_MXWORK_CHBUF_PCM[idx - 9];
}

function syncRegistersFromReg(context, reg) {
  const impl = context.m_impl;
  impl.m_D0 = u32(reg.d0 ?? 0);
  impl.m_D1 = u32(reg.d1 ?? 0);
  impl.m_D2 = u32(reg.d2 ?? 0);
  impl.m_D3 = u32(reg.d3 ?? 0);
  impl.m_D4 = u32(reg.d4 ?? 0);
  impl.m_D5 = u32(reg.d5 ?? 0);
  impl.m_D6 = u32(reg.d6 ?? 0);
  impl.m_D7 = u32(reg.d7 ?? 0);
  impl.m_A0 = u32(reg.a0 ?? 0);
  impl.m_A1 = u32(reg.a1 ?? 0);
  impl.m_A2 = u32(reg.a2 ?? 0);
  impl.m_A3 = u32(reg.a3 ?? 0);
  impl.m_A4 = u32(reg.a4 ?? 0);
  impl.m_A5 = u32(reg.a5 ?? 0);
  impl.m_A6 = u32(reg.a6 ?? 0);
  impl.m_A7 = u32(reg.a7 ?? 0);
}

function syncRegistersToReg(context, reg) {
  const impl = context.m_impl;
  reg.d0 = u32(impl.m_D0);
  reg.d1 = u32(impl.m_D1);
  reg.d2 = u32(impl.m_D2);
  reg.d3 = u32(impl.m_D3);
  reg.d4 = u32(impl.m_D4);
  reg.d5 = u32(impl.m_D5);
  reg.d6 = u32(impl.m_D6);
  reg.d7 = u32(impl.m_D7);
  reg.a0 = u32(impl.m_A0);
  reg.a1 = u32(impl.m_A1);
  reg.a2 = u32(impl.m_A2);
  reg.a3 = u32(impl.m_A3);
  reg.a4 = u32(impl.m_A4);
  reg.a5 = u32(impl.m_A5);
  reg.a6 = u32(impl.m_A6);
  reg.a7 = u32(impl.m_A7);
}

function initializeMemory(context, mdxbuf, pdxbuf) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;

  G.L002220 = mdxbuf ? (mdxbuf >>> 0) : 0x10000;
  G.L002224 = pdxbuf ? (pdxbuf >>> 0) : 0x100000;
  G.L001ba8 = 0x600;

  MxdrvContextImpl_ResetMemoryPool(context.m_impl);

  const mdxRegion = MxdrvContextImpl_ReserveMemory(context.m_impl, G.L002220);
  if (!mdxRegion) {
    G.L001e34 = 0;
    G.L001e38 = 0;
    G.L001bac = 0;
    MxdrvContextImpl_ResetMemoryPool(context.m_impl);
    return 1;
  }
  G.L001e34 = mdxRegion.offset >>> 0;
  mdxRegion.view.fill(0);

  const pdxRegion = MxdrvContextImpl_ReserveMemory(context.m_impl, G.L002224);
  if (!pdxRegion) {
    G.L001e34 = 0;
    G.L001e38 = 0;
    G.L001bac = 0;
    MxdrvContextImpl_ResetMemoryPool(context.m_impl);
    return 1;
  }
  G.L001e38 = pdxRegion.offset >>> 0;
  pdxRegion.view.fill(0);

  const voiceRegion = MxdrvContextImpl_ReserveMemory(context.m_impl, G.L001ba8);
  if (!voiceRegion) {
    G.L001e34 = 0;
    G.L001e38 = 0;
    G.L001bac = 0;
    MxdrvContextImpl_ResetMemoryPool(context.m_impl);
    return 1;
  }
  G.L001bac = voiceRegion.offset >>> 0;
  voiceRegion.view.fill(0);

  return 0;
}

function PCM8_SUB(context) {
  const impl = context.m_impl;

  if (impl.m_MeasurePlayTime) return;

  switch (impl.m_D0 & 0xfff0) {
    case 0x0000:
      X68Sound_Pcm8_Out(
        impl.m_x68SoundContext,
        impl.m_D0 & 0xff,
        impl.m_A1 >>> 0,
        impl.m_D1 | 0,
        impl.m_D2 | 0,
      );
      impl.m_logicalSumOfKeyOnFlagsForPcm[impl.m_D0 & 7] = true;
      break;
    case 0x0100:
      if ((impl.m_D0 & 0xffff) === 0x0100) {
        X68Sound_Pcm8_Out(impl.m_x68SoundContext, impl.m_D0 & 0xff, 0, 0, 0);
        impl.m_logicalSumOfKeyOnFlagsForPcm[impl.m_D0 & 7] = true;
      } else if ((impl.m_D0 & 0xffff) === 0x0101) {
        X68Sound_Pcm8_Abort(impl.m_x68SoundContext);
      }
      break;
    case 0x01f0:
      if ((impl.m_D0 & 0xffff) === 0x01fc) {
        impl.m_D0 = 1;
      }
      break;
    default:
      break;
  }
}

function OPM_SUB(context) {
  const impl = context.m_impl;
  if (impl.m_MeasurePlayTime) return;
  _iocs_opmset(context, low8(impl.m_D1), low8(impl.m_D2));
}

function L_WRITEOPM(context) {
  const impl = context.m_impl;
  OPM_SUB(context);
  const reg = low8(impl.m_D1);
  const value = low8(impl.m_D2);
  impl.m_MXWORK_OPMBUF[reg] = value;
  if (reg === 0x1b) {
    impl.m_OpmReg1B = value;
  }
}

function ADPCMOUT(context) {
  const impl = context.m_impl;
  const addr = impl.m_A1 >>> 0;
  const len = impl.m_D2 >>> 0;

  if (addr !== 0 && isValidRange(context, addr, len)) {
    _iocs_adpcmout(context, addr, impl.m_D1 >>> 0, impl.m_D2 >>> 0);
  }

  impl.m_logicalSumOfKeyOnFlagsForPcm[0] = true;
}

function ADPCMMOD_STOP(context) {
  _iocs_adpcmmod(context, 1);
}

function ADPCMMOD_END(context) {
  _iocs_adpcmmod(context, 0);
}

function L0006c4(context) {
  const impl = context.m_impl;
  if (impl.m_MXWORK_PCM8) {
    impl.m_D0 = 0x01fc;
    impl.m_D1 = 0xffffffff;
    PCM8_SUB(context);
    if (low8(impl.m_D0) === 0x01) {
      impl.m_D0 = 0x0101;
      PCM8_SUB(context);
      return;
    }
    ADPCMMOD_STOP(context);
  }
  ADPCMMOD_END(context);
}

function L00063e(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  G.L001e13 = 0x01;
  L0006c4(context);

  if (impl.m_MXWORK_PCM8) {
    impl.m_D0 = 0x0100;
    PCM8_SUB(context);
  }

  if (G.L001df4 !== 0) {
    impl.m_D0 = 0x01ff;
    PCM8_SUB(context);
    G.L001df4 = CLR;
  }

  impl.m_D2 = 0x0f;
  for (let reg = 0xe0; reg <= 0xff; reg++) {
    impl.m_D1 = reg;
    L_WRITEOPM(context);
  }

  impl.m_D1 = 0x08;
  impl.m_D2 = 0x00;
  for (let i = 0; i < 8; i++) {
    L_WRITEOPM(context);
    G.L00223c[i] = low8(impl.m_D2);
    G.L001bb4[i] = low8(impl.m_D2);
    impl.m_D2 = u32(impl.m_D2 + 1);
  }
}

function L00095a(_context) {
  // Native code has no extra side effects here.
}

function L_ERROR(context) {
  context.m_impl.m_D0 = 0xffffffff;
  L00095a(context);
}

function L000998(context) {
  context.m_impl.m_D0 = 0;
}

function L_OPMINT(context) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  if (G.FATALERROR) return;

  L0000dc(context);
  L000756(context);

  const impl = context.m_impl;
  impl.m_D1 = 0x14;
  impl.m_D2 = 0x1b;
  L_WRITEOPM(context);
}

function OPMINTFUNC(arg) {
  const context = arg;
  if (!(context instanceof MxdrvContext) || !context.m_impl) {
    return;
  }

  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  MxdrvContext_EnterCriticalSection(context);
  try {
    if (typeof impl.m_OPMINT_FUNC === 'function') {
      impl.m_OPMINT_FUNC(context);
    }
    if (!G.STOPMUSICTIMER) {
      G.PLAYTIME += 256 - low8(G.MUSICTIMER);
    }
    if (typeof impl.m_MXCALLBACK_OPMINT === 'function') {
      impl.m_MXCALLBACK_OPMINT(context);
    }
  } finally {
    MxdrvContext_LeaveCriticalSection(context);
  }
}

function SETOPMINT(context, func) {
  context.m_impl.m_OPMINT_FUNC = func;
  X68Sound_OpmInt(context.m_impl.m_x68SoundContext, OPMINTFUNC, context);
}

function L00056a(context) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  G.L001e13 = CLR;
  if (G.L001e08 === 0) {
    SETOPMINT(context, L_OPMINT);
  }
}

function L000756(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  impl.m_D2 = (G.L001e08 !== 0) ? 0x30 : 0x3a;
  impl.m_D1 = 0x14;
  L_WRITEOPM(context);
}

function L000554(context) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  G.L001e30 = 0;
  G.L001e19 = 0;
}

function L000534(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  G.L001e18 = CLR;
  G.L002230 = CLR;
  G.L002231 = CLR;

  const a0 = G.L001e34 >>> 0;
  G.L002218 = getBLong(context, a0);
  G.L00221c = getBLong(context, a0 + 4);
  L00063e(context);
}

function L000552(context) {
  L000534(context);
  L000554(context);
}

function copyImageToWorkingBuffer(context, dstOfs, dstMaxSize, srcOfs, srcSize, readyFlagField) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  const bytesToCopy = srcSize >>> 0;
  const maxBytes = dstMaxSize >>> 0;

  if (bytesToCopy > maxBytes) {
    impl.m_D0 = u32(maxBytes | 0x80000000);
    return;
  }

  L00063e(context);
  if (!copyPoolBytes(context, dstOfs >>> 0, srcOfs >>> 0, bytesToCopy)) {
    L_ERROR(context);
    return;
  }

  G[readyFlagField] = SET;
  impl.m_D0 = 0;
}

function L0005f8(context) {
  const impl = context.m_impl;
  const sizeLimit = impl.m_D0 >>> 0;
  const copySize = impl.m_D1 >>> 0;

  if (copySize > sizeLimit) {
    impl.m_D0 = u32(sizeLimit | 0x80000000);
    return;
  }

  const savedD1 = impl.m_D1 >>> 0;
  const savedA0 = impl.m_A0 >>> 0;
  const savedA1 = impl.m_A1 >>> 0;
  const savedA2 = impl.m_A2 >>> 0;

  L00063e(context);

  impl.m_D1 = savedD1;
  impl.m_A0 = savedA0;
  impl.m_A1 = savedA1;
  impl.m_A2 = savedA2;

  if (!copyPoolBytes(context, impl.m_A0 >>> 0, impl.m_A1 >>> 0, copySize)) {
    L_ERROR(context);
    return;
  }

  putBByte(context, impl.m_A2 >>> 0, SET);
  impl.m_D0 = 0;
}

function L_SETMDX(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  if (G.L001e18 !== 0) {
    const d1 = impl.m_D1;
    const a1 = impl.m_A1;
    L000552(context);
    impl.m_A1 = a1;
    impl.m_D1 = d1;
  }

  impl.m_A0 = u32(G.L001e34);
  G.L002218 = impl.m_A0 >>> 0;
  impl.m_D0 = u32(G.L002220);
  impl.m_A2 = 0;
  L0005f8(context);
  if (impl.m_D0 === 0) {
    G.L002230 = SET;
  }
}

function L_SETPDX(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  if (G.L001e18 !== 0) {
    const d1 = impl.m_D1;
    const a1 = impl.m_A1;
    L000552(context);
    impl.m_A1 = a1;
    impl.m_D1 = d1;
  }

  impl.m_A0 = u32(G.L001e38);
  G.L00221c = impl.m_A0 >>> 0;
  impl.m_D0 = u32(G.L002224);
  impl.m_A2 = 0;
  L0005f8(context);
  if (impl.m_D0 === 0) {
    G.L002231 = SET;
  }
}

function L0007c0(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  G.PLAYTIME = 0;
  G.FATALERROR = 0;
  G.L001e14 = CLR;
  G.L001e15 = CLR;
  G.L001e17 = CLR;
  G.L001e13 = CLR;

  if (G.L001e12 !== 0 && impl.m_MXWORK_PCM8) {
    impl.m_D0 = 0x0100;
    PCM8_SUB(context);
  }

  G.L001e12 = CLR;
  G.STOPMUSICTIMER = CLR;
  G.L001df4 = CLR;
  G.L001e1a = 0x01ff;
  G.L001e06 = 0x01ff;
  G.L002246 = CLR;
  G.L001ba6 = CLR;

  if (G.L002230 === 0) {
    L_ERROR(context);
    return;
  }

  L00063e(context);

  let a2 = G.L002218 >>> 0;
  let d1 = getBWord(context, a2 + 2);
  if (!isSignedWordNegative(d1)) {
    if (G.L002231 === 0) {
      L_ERROR(context);
      return;
    }

    let a0 = G.L00221c >>> 0;
    while ((d1--) !== 0) {
      const delta = getBLong(context, a0);
      if (delta === 0) {
        L_ERROR(context);
        return;
      }
      a0 = u32(a0 + delta);
    }
    a0 = u32(a0 + getBWord(context, a0 + 4));
    G.L00222c = a0;
  }

  a2 = u32(a2 + getBWord(context, a2 + 4));
  let a1 = a2;
  let a0 = a2;
  let d0 = getBWord(context, a1);
  a1 = u32(a1 + 2);
  a2 = u32(a2 + d0);
  G.L002228 = a2;

  const a3 = 0;
  const d6 = 0xffffffff;
  for (let d7 = 0; d7 <= 15; d7++) {
    a2 = a0;
    d0 = getBWord(context, a1);
    a1 = u32(a1 + 2);
    a2 = u32(a2 + d0);

    const ch = getChannelByIndex(context, d7);
    if (!ch) {
      L_ERROR(context);
      return;
    }

    ch.S0000 = a2;
    ch.S0026 = a3;
    ch.S0040 = a3;
    ch.S0014 = low16(d6);
    ch.S0023 = low8(d6);
    ch.S0018 = low8(d7);
    ch.S001d = 0x00;
    ch.S001a = 0x01;
    ch.S0022 = 0x08;
    ch.S001c = 0xc0;
    ch.S001e = 0x08;
    ch.S0036 = u32(ch.S0036 & 0xffff);
    ch.S004a = CLR;
    ch.S0010 = CLR;
    ch.S0024 = CLR;
    ch.S001f = CLR;
    ch.S0019 = CLR;
    ch.S0016 = CLR;
    ch.S0017 = CLR;

    if (d7 < 8) {
      impl.m_D1 = u32(0x38 + d7);
      impl.m_D2 = 0x00;
      L_WRITEOPM(context);
    } else {
      ch.S001c = 0x10;
      ch.S0022 = 0x08;
      ch.S0018 = low8((d7 & 0x07) | 0x80);
      ch.S0004_b = 0x00;
    }
  }

  G.L001df6.fill(0);
  G.L002232 = CLR;

  impl.m_D2 = 0x00;
  impl.m_D1 = 0x01;
  L_WRITEOPM(context);

  impl.m_D1 = 0x0f;
  L_WRITEOPM(context);

  impl.m_D1 = 0x19;
  L_WRITEOPM(context);

  impl.m_D2 = 0x80;
  L_WRITEOPM(context);

  impl.m_D2 = 0xc8;
  impl.m_D1 = 0x12;
  G.L001e0c = low8(impl.m_D2);
  G.MUSICTIMER = low8(impl.m_D2);

  if (G.L001e08 === 0) {
    L_WRITEOPM(context);
  }

  L00056a(context);
  L000756(context);
  impl.m_D0 = 0;
}

function L000788(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  G.L001e28 = impl.m_A0 >>> 0;
  G.L001e22 = getBWord(context, impl.m_A0);
  let a1 = getBLong(context, impl.m_A0 + 2);
  G.L00221c = getBLong(context, a1);
  a1 = u32(a1 + 4);

  const d0 = (~getBWord(context, a1)) & 0xffff;
  const d1 = (~getBWord(context, a1 + 2)) & 0xffff;
  G.L002230 = low8(d0);
  G.L002231 = low8(d1);
  G.L002218 = a1;
  G.L001e1c = CLR;
  L0007c0(context);
}

function L000766(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  impl.m_A0 = u32(G.L001e28);
  impl.m_A1 = u32(G.L001e24);
  impl.m_A0 = u32(impl.m_A0 - 6);
  if (impl.m_A1 > impl.m_A0) {
    impl.m_A0 = u32(G.L001e2c);
  }
  L000788(context);
}

function L00077a(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  impl.m_A0 = u32(G.L001e28 + 6);
  if (getBWord(context, impl.m_A0) === 0) {
    impl.m_A0 = u32(G.L001e24);
  }
  L000788(context);
}

function L_0A(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  G.L001e14 = low8(impl.m_D1);
}

function L_0B(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  G.L001e15 = low8(impl.m_D1);
}

function L_0C(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  G.L001e1e[0] = low16(impl.m_D1);
  G.L001e17 = SET;
}

function L_0D(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  const cmd = low8(impl.m_D1);
  if (cmd === 0xf0) {
    L000552(context);
    return;
  }
  if (cmd === 0xfc) {
    impl.m_D0 = u32(G.L001e19);
    return;
  }
  if ((impl.m_D1 & 0x80000000) !== 0) {
    L000534(context);
    return;
  }
  if (G.L001e18 !== 0) {
    L_ERROR(context);
    return;
  }

  G.L001e30 = impl.m_A2 >>> 0;
  G.L001e24 = impl.m_A1 >>> 0;
  G.L001e28 = impl.m_A1 >>> 0;

  let a1 = impl.m_A1 >>> 0;
  while (getBWord(context, a1) !== 0) {
    a1 = u32(a1 + 6);
  }
  a1 = u32(a1 - 6);
  G.L001e2c = a1;
  G.L001e18 = SET;
  G.L001e19 = SET;
  impl.m_A0 = G.L001e24 >>> 0;
  L000788(context);
}

function L_08(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  if (G.L002230 === 0) {
    L000998(context);
    return;
  }
  let a0 = G.L002218 >>> 0;
  let d1 = impl.m_D1 >>> 0;
  while ((d1--) !== 0) {
    const step = getBWord(context, a0);
    if (step === 0) {
      L000998(context);
      return;
    }
    a0 = u32(a0 + step);
  }
  a0 = u32(a0 + getBWord(context, a0 + 6));
  impl.m_D0 = a0;
}

function L_09(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  if (G.L002231 === 0) {
    L000998(context);
    return;
  }
  let a0 = G.L00221c >>> 0;
  let d1 = impl.m_D1 >>> 0;
  while ((d1--) !== 0) {
    const step = getBLong(context, a0);
    if (step === 0) {
      L000998(context);
      return;
    }
    a0 = u32(a0 + step);
  }
  a0 = u32(a0 + getBWord(context, a0 + 6));
  impl.m_D0 = a0;
}

function L_PLAY(context) {
  context.m_impl.m_MXWORK_GLOBALBUF.L001e1c = CLR;
  L0007c0(context);
}

function L_0E(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  G.L001e1c = low16(impl.m_D1);
}

function L_0F(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  G.L001e1c = low16(impl.m_D1);
  L0007c0(context);
}

function L_10(context) {
  const impl = context.m_impl;
  const ofs = ensureExportBufferOffset(context, 'm_exportOpmBufOffset', 0x100);
  if (ofs === 0) {
    L_ERROR(context);
    return;
  }

  pool(context).set(impl.m_MXWORK_OPMBUF, ofs);
  impl.m_D0 = ofs >>> 0;
}

function L_11(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  if ((impl.m_D1 & 0x80000000) !== 0) {
    impl.m_D0 = u32(G.L001e0e);
    return;
  }
  G.L001e0e = low8(impl.m_D1);
}

function L_12(context) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  context.m_impl.m_D0 = u32((low8(G.L001e12) << 8) | low8(G.L001e13));
}

function L_13(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  impl.m_D0 = u32(low8(G.L001e0a));
  G.L001e0a = low8(impl.m_D1);
}

function L_14(context) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  context.m_impl.m_D0 = u32(~G.L001e06);
}

function L_15(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  impl.m_D0 = u32(low8(G.L001e0b));
  G.L001e0b = low8(impl.m_D1);
}

function L_16(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  impl.m_D0 = u32(low8(G.L001e08));
  G.L001e08 = low8(impl.m_D1);
  L_STOP(context);
}

function L_17(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  impl.m_D0 = u32(low8(G.L001e08));
  if (impl.m_D0 === 0) {
    impl.m_D0 = u32((low8(G.L001e12) << 8) | low8(G.L001e13));
    return;
  }

  L0000dc(context);
}

function L_1F(context) {
  context.m_impl.m_D0 = u32(context.m_impl.m_MXWORK_GLOBALBUF.L001ba6);
}

function L_19(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  const ofs = ensureExportBufferOffset(context, 'm_exportL001bb4Offset', 16);
  if (ofs === 0) {
    L_ERROR(context);
    return;
  }

  pool(context).set(G.L001bb4, ofs);
  impl.m_A0 = ofs >>> 0;
  impl.m_D0 = ofs >>> 0;
}

function L_18(context) {
  const impl = context.m_impl;
  const channels = impl.m_MXWORK_CHBUF_PCM;
  const chSize = 88;
  const sizeInBytes = (channels.length * chSize) >>> 0;

  const ofs = ensureExportBufferOffset(context, 'm_exportChPcmOffset', sizeInBytes);
  if (ofs === 0) {
    L_ERROR(context);
    return;
  }

  const mem = pool(context);
  mem.fill(0, ofs, ofs + sizeInBytes);

  for (let i = 0; i < channels.length; i++) {
    writeMxWorkChToPool(mem, (ofs + i * chSize) >>> 0, channels[i]);
  }

  impl.m_A0 = ofs >>> 0;
  impl.m_D0 = ofs >>> 0;
}

function L000216(context) {
  const impl = context.m_impl;
  const baseA0 = impl.m_A0 >>> 0;

  let d0 = 0;
  let d1 = 0;
  let d3 = 0xffffffff;
  let a1 = baseA0;

  // Invalid images can otherwise spin forever; native code assumes a valid table.
  for (let guard = 0; guard < 0x100000; guard++) {
    if (!isValidRange(context, a1, 8)) {
      impl.m_D0 = 0xffffffff;
      impl.m_D1 = d1 >>> 0;
      return;
    }

    let d4 = getBLong(context, a1);
    a1 = u32(a1 + 4);
    let d2 = getBLong(context, a1);
    a1 = u32(a1 + 4);

    d4 &= 0x00ffffff;
    if (d4 === 0) {
      d0 = u32(d0 + 1);
      continue;
    }
    if (getBLong(context, u32(a1 - 8)) !== (d4 >>> 0)) {
      impl.m_D0 = d0 >>> 0;
      impl.m_D1 = d1 >>> 0;
      return;
    }

    d2 &= 0x00ffffff;
    if (d2 === 0) {
      d0 = u32(d0 + 1);
      continue;
    }
    if (getBLong(context, u32(a1 - 4)) !== (d2 >>> 0)) {
      impl.m_D0 = d0 >>> 0;
      impl.m_D1 = d1 >>> 0;
      return;
    }

    d2 = u32(d2 + d4);
    if ((d1 >>> 0) <= (d2 >>> 0)) d1 = d2;
    if ((d4 >>> 0) <= (d3 >>> 0)) d3 = d4;

    const a2 = u32(baseA0 + d3);
    if (a2 === a1) {
      d0 = u32(d0 + 1);
      impl.m_D0 = d0 >>> 0;
      impl.m_D1 = d1 >>> 0;
      return;
    }
    if ((a2 >>> 0) < (a1 >>> 0)) {
      impl.m_D0 = 0xffffffff;
      impl.m_D1 = d1 >>> 0;
      return;
    }

    d0 = u32(d0 + 1);
  }

  impl.m_D0 = 0xffffffff;
  impl.m_D1 = d1 >>> 0;
}

function L_1A(context) {
  L000216(context);
}

function L_1B(context) {
  const impl = context.m_impl;
  const saved = {
    d1: impl.m_D1 >>> 0,
    d2: impl.m_D2 >>> 0,
    d3: impl.m_D3 >>> 0,
    d4: impl.m_D4 >>> 0,
    d5: impl.m_D5 >>> 0,
    a0: impl.m_A0 >>> 0,
    a1: impl.m_A1 >>> 0,
    a2: impl.m_A2 >>> 0,
  };

  L000216(context);

  let d0 = impl.m_D0 >>> 0;
  let d2 = d0 >>> 0;
  if ((d2 | 0) >= 0) {
    let d5 = d0 >>> 0;
    d0 = u32(d0 << 3);

    let d3 = 0x60;
    while (true) {
      d2 = u32(d2 - d3);
      if ((d2 | 0) < 0) break;
    }
    d2 = u32(d2 + d3);

    if ((d2 >>> 0) !== 0) {
      d3 = u32(d3 - d2);
      let d4 = d3 >>> 0;
      d3 = u32(d3 << 3);

      d2 = u32(saved.d1 + 1);
      d2 &= 0xfffffffe;

      let a2 = u32(saved.a0 + d2);
      let d1Work = u32(saved.d1 + d3);
      let a1 = u32(saved.a0 + d1Work);

      d2 = u32(d2 - d0);
      d2 >>>= 1;

      let loopCounter = d2 >>> 1;
      loopCounter = u32(loopCounter - 1);

      while (true) {
        a1 = u32(a1 - 4);
        a2 = u32(a2 - 4);
        if (!isValidRange(context, a1, 4) || !isValidRange(context, a2, 4)) {
          d0 = 0xffffffff;
          break;
        }
        putBLong(context, a1, getBLong(context, a2));
        const prev = loopCounter;
        loopCounter = u32(loopCounter - 1);
        if (prev === 0) break;
      }

      if ((d0 | 0) >= 0) {
        d2 &= 0xffff0001;
        if ((d2 & 0xffff) !== 0) {
          // Portable C path uses a1 as both src/dst here; preserve behavior.
          a1 = u32(a1 - 2);
          a2 = a1;
        }

        d4 = u32(d4 - 1) & 0xffff;
        while (true) {
          a1 = u32(a1 - 4);
          if (!putBLong(context, a1, 0)) {
            d0 = 0xffffffff;
            break;
          }
          a1 = u32(a1 - 4);
          if (!putBLong(context, a1, 0)) {
            d0 = 0xffffffff;
            break;
          }
          const prev = d4;
          d4 = u32(d4 - 1);
          if (prev === 0) break;
        }
      }

      if ((d0 | 0) >= 0) {
        d5 = u32(d5 - 1);
        let a0 = saved.a0 >>> 0;
        while (true) {
          if (!isValidRange(context, a0, 4)) {
            d0 = 0xffffffff;
            break;
          }
          d0 = getBLong(context, a0);
          a0 = u32(a0 + 4);
          if ((d0 >>> 0) !== 0) {
            if (!putBLong(context, u32(a0 - 4), u32(d0 + d3))) {
              d0 = 0xffffffff;
              break;
            }
          }

          a0 = u32(a0 + 4);
          const prev = d5;
          d5 = u32(d5 - 1);
          if (prev === 0) break;
        }
      }
    }
  }

  impl.m_D0 = d0 >>> 0;
  impl.m_D1 = saved.d1;
  impl.m_D2 = saved.d2;
  impl.m_D3 = saved.d3;
  impl.m_D4 = saved.d4;
  impl.m_D5 = saved.d5;
  impl.m_A0 = saved.a0;
  impl.m_A1 = saved.a1;
  impl.m_A2 = saved.a2;
}

function L_1C(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  const saved = {
    d1: impl.m_D1 >>> 0,
    d2: impl.m_D2 >>> 0,
    d3: impl.m_D3 >>> 0,
    d4: impl.m_D4 >>> 0,
    d5: impl.m_D5 >>> 0,
    d6: impl.m_D6 >>> 0,
    d7: impl.m_D7 >>> 0,
    a0: impl.m_A0 >>> 0,
    a1: impl.m_A1 >>> 0,
    a2: impl.m_A2 >>> 0,
    a3: impl.m_A3 >>> 0,
    a4: impl.m_A4 >>> 0,
  };

  const regs = {
    d0: impl.m_D0 >>> 0,
    d1: impl.m_D1 >>> 0,
    d2: impl.m_D2 >>> 0,
    d3: impl.m_D3 >>> 0,
    d4: impl.m_D4 >>> 0,
    d5: impl.m_D5 >>> 0,
    d6: impl.m_D6 >>> 0,
    d7: impl.m_D7 >>> 0,
    a0: impl.m_A0 >>> 0,
    a1: impl.m_A1 >>> 0,
    a2: impl.m_A2 >>> 0,
    a3: impl.m_A3 >>> 0,
    a4: impl.m_A4 >>> 0,
    a5: impl.m_A5 >>> 0,
    a6: impl.m_A6 >>> 0,
    a7: impl.m_A7 >>> 0,
  };

  function syncToImpl() {
    impl.m_D0 = regs.d0 >>> 0;
    impl.m_D1 = regs.d1 >>> 0;
    impl.m_D2 = regs.d2 >>> 0;
    impl.m_D3 = regs.d3 >>> 0;
    impl.m_D4 = regs.d4 >>> 0;
    impl.m_D5 = regs.d5 >>> 0;
    impl.m_D6 = regs.d6 >>> 0;
    impl.m_D7 = regs.d7 >>> 0;
    impl.m_A0 = regs.a0 >>> 0;
    impl.m_A1 = regs.a1 >>> 0;
    impl.m_A2 = regs.a2 >>> 0;
    impl.m_A3 = regs.a3 >>> 0;
    impl.m_A4 = regs.a4 >>> 0;
    impl.m_A5 = regs.a5 >>> 0;
    impl.m_A6 = regs.a6 >>> 0;
    impl.m_A7 = regs.a7 >>> 0;
  }

  function syncFromImpl() {
    regs.d0 = impl.m_D0 >>> 0;
    regs.d1 = impl.m_D1 >>> 0;
    regs.d2 = impl.m_D2 >>> 0;
    regs.d3 = impl.m_D3 >>> 0;
    regs.d4 = impl.m_D4 >>> 0;
    regs.d5 = impl.m_D5 >>> 0;
    regs.d6 = impl.m_D6 >>> 0;
    regs.d7 = impl.m_D7 >>> 0;
    regs.a0 = impl.m_A0 >>> 0;
    regs.a1 = impl.m_A1 >>> 0;
    regs.a2 = impl.m_A2 >>> 0;
    regs.a3 = impl.m_A3 >>> 0;
    regs.a4 = impl.m_A4 >>> 0;
    regs.a5 = impl.m_A5 >>> 0;
    regs.a6 = impl.m_A6 >>> 0;
    regs.a7 = impl.m_A7 >>> 0;
  }

  function callL000216() {
    syncToImpl();
    L000216(context);
    syncFromImpl();
  }

  function callL1B() {
    syncToImpl();
    L_1B(context);
    syncFromImpl();
  }

  function restoreAndReturn(resultD0) {
    impl.m_D0 = resultD0 >>> 0;
    impl.m_D1 = saved.d1;
    impl.m_D2 = saved.d2;
    impl.m_D3 = saved.d3;
    impl.m_D4 = saved.d4;
    impl.m_D5 = saved.d5;
    impl.m_D6 = saved.d6;
    impl.m_D7 = saved.d7;
    impl.m_A0 = saved.a0;
    impl.m_A1 = saved.a1;
    impl.m_A2 = saved.a2;
    impl.m_A3 = saved.a3;
    impl.m_A4 = saved.a4;
  }

  callL000216();
  if ((regs.d0 | 0) < 0) {
    restoreAndReturn(0xfffffffd);
    return;
  }

  regs.d1 = u32(regs.d1 + regs.a0);
  regs.d1 = u32(regs.d1 + 1);
  regs.d1 &= 0xfffffffe;
  regs.d3 = regs.d1;
  regs.d7 = regs.d3;
  regs.d2 = regs.d0;

  let t0 = regs.a0;
  regs.a0 = regs.a1;
  regs.a1 = t0;

  callL000216();
  if ((regs.d0 | 0) < 0) {
    restoreAndReturn(0xfffffffd);
    return;
  }

  regs.d3 = u32(regs.d3 + regs.d1);
  regs.d1 = u32(regs.d1 + regs.a0);
  regs.d6 = regs.d1;
  regs.d1 = regs.d0;
  regs.d1 = u32(regs.d1 << 3);
  regs.d1 = u32(regs.d1 + regs.a0);
  regs.d4 = regs.d1;
  regs.a2 = u32(regs.a2 - regs.d3);

  if ((regs.d3 | 0) < 0) {
    restoreAndReturn(0xffffffff);
    return;
  }

  regs.d1 = 0x60;
  regs.d3 = regs.d2;
  while (true) {
    regs.d3 = u32(regs.d3 - regs.d1);
    if ((regs.d3 | 0) < 0) break;
  }
  regs.d3 = u32(regs.d3 + regs.d1);
  if (regs.d3 !== 0) {
    regs.d3 = u32(regs.d3 - regs.d1);
    regs.d3 = u32(-((regs.d3 | 0)));
    regs.d1 = regs.d3;
    regs.d3 = u32(regs.d3 << 3);
    if ((regs.a2 >>> 0) < (regs.d3 >>> 0)) {
      restoreAndReturn(0xffffffff);
      return;
    }
  }

  regs.d3 = u32(regs.d3 + regs.d0);
  regs.d3 = u32(regs.d3 << 3);
  regs.d3 = u32(regs.d3 + regs.d7);

  regs.a4 = regs.a0;
  if ((regs.a0 >>> 0) <= (regs.d3 >>> 0)) {
    regs.d1 = regs.d0;
    regs.d1 = u32(regs.d1 << 3);
    if ((G.L001ba8 >>> 0) < (regs.d1 >>> 0)) {
      restoreAndReturn(0xfffffffe);
      return;
    }

    regs.a4 = G.L001bac >>> 0;
    regs.a3 = regs.a0;
    regs.d1 = regs.d0;
    regs.d1 = u32(regs.d1 - 1);

    let guard = 0;
    while (true) {
      if (!isValidRange(context, regs.a3, 8) || !isValidRange(context, regs.a4, 8)) {
        restoreAndReturn(0xffffffff);
        return;
      }
      putBLong(context, regs.a4, getBLong(context, regs.a3));
      putBLong(context, u32(regs.a4 + 4), getBLong(context, u32(regs.a3 + 4)));
      regs.a4 = u32(regs.a4 + 8);
      regs.a3 = u32(regs.a3 + 8);

      const prev = regs.d1;
      regs.d1 = u32(regs.d1 - 1);
      if (prev === 0) break;
      guard += 1;
      if (guard > 0x200000) {
        restoreAndReturn(0xffffffff);
        return;
      }
    }

    regs.a4 = G.L001bac >>> 0;
  }

  regs.d0 = u32(regs.d0 << 3);
  regs.d5 = regs.d0;

  t0 = regs.a0;
  regs.a0 = regs.a1;
  regs.a1 = t0;

  callL1B();
  if ((regs.d0 | 0) < 0) {
    restoreAndReturn(0xfffffffc);
    return;
  }

  callL000216();
  regs.d2 = regs.d0;
  if ((regs.d2 | 0) < 0) {
    restoreAndReturn(0xfffffffd);
    return;
  }

  regs.d1 = u32(regs.d1 + regs.a0);
  regs.d1 = u32(regs.d1 + 1);
  regs.d1 &= 0xfffffffe;
  regs.a2 = regs.d1;
  regs.d1 = u32(regs.d1 + regs.d5);
  regs.d0 = u32(regs.d0 << 3);
  regs.d0 = u32(regs.d0 + regs.a0);
  regs.d0 = u32(regs.d0 + regs.d5);
  regs.a3 = regs.d1;
  regs.a1 = regs.a3;
  regs.d1 = u32(regs.d1 - regs.d0);
  regs.d7 = regs.d1;
  regs.d1 >>>= 1;
  const c0 = regs.d1 & 1;
  regs.d1 >>>= 1;
  regs.d1 = u32(regs.d1 - 1);

  {
    let guard = 0;
    while (true) {
      regs.a3 = u32(regs.a3 - 4);
      regs.a2 = u32(regs.a2 - 4);
      if (!isValidRange(context, regs.a2, 4) || !isValidRange(context, regs.a3, 4)) {
        restoreAndReturn(0xffffffff);
        return;
      }
      putBLong(context, regs.a3, getBLong(context, regs.a2));

      const prev = regs.d1;
      regs.d1 = u32(regs.d1 - 1);
      if (prev === 0) break;
      guard += 1;
      if (guard > 0x200000) {
        restoreAndReturn(0xffffffff);
        return;
      }
    }
  }

  if (c0 !== 0) {
    regs.a3 = u32(regs.a3 - 2);
    regs.a2 = u32(regs.a2 - 2);
    if (!putBWord(context, regs.a3, getBWord(context, regs.a2))) {
      restoreAndReturn(0xffffffff);
      return;
    }
  }

  regs.a2 = regs.d0;
  regs.a2 = u32(regs.a2 - regs.d5);
  if (regs.a2 !== regs.a4) {
    regs.d1 = regs.d5;
    regs.d1 >>>= 3;
    regs.d1 = u32(regs.d1 - 1);

    let guard = 0;
    while (true) {
      if (!isValidRange(context, regs.a2, 8) || !isValidRange(context, regs.a4, 8)) {
        restoreAndReturn(0xffffffff);
        return;
      }
      putBLong(context, regs.a2, getBLong(context, regs.a4));
      putBLong(context, u32(regs.a2 + 4), getBLong(context, u32(regs.a4 + 4)));
      regs.a2 = u32(regs.a2 + 8);
      regs.a4 = u32(regs.a4 + 8);

      const prev = regs.d1;
      regs.d1 = u32(regs.d1 - 1);
      if ((prev >>> 0) === 0) break;
      guard += 1;
      if (guard > 0x200000) {
        restoreAndReturn(0xffffffff);
        return;
      }
    }
  }

  regs.a2 = regs.d4;
  regs.d6 = u32(regs.d6 - regs.d4);
  regs.d1 = regs.d6;
  regs.d2 >>>= 2;
  regs.d1 = u32(regs.d1 - 1);

  {
    let guard = 0;
    while (true) {
      if (!isValidRange(context, regs.a2, 4) || !isValidRange(context, regs.a1, 4)) {
        restoreAndReturn(0xffffffff);
        return;
      }
      putBLong(context, regs.a1, getBLong(context, regs.a2));
      regs.a1 = u32(regs.a1 + 4);
      regs.a2 = u32(regs.a2 + 4);

      const prev = regs.d1;
      regs.d1 = u32(regs.d1 - 1);
      if ((prev >>> 0) === 0) break;
      guard += 1;
      if (guard > 0x200000) {
        restoreAndReturn(0xffffffff);
        return;
      }
    }
  }

  regs.d1 = regs.d6;
  regs.d1 &= 0x00000002;
  if (regs.d1 !== 0) {
    if (!putBWord(context, regs.a1, getBWord(context, regs.a2))) {
      restoreAndReturn(0xffffffff);
      return;
    }
    regs.a1 = u32(regs.a1 + 2);
    regs.a2 = u32(regs.a2 + 2);
  }

  regs.d6 &= 0x00000001;
  if (regs.d1 !== 0) {
    if (!putBByte(context, regs.a1, getBByte(context, regs.a2))) {
      restoreAndReturn(0xffffffff);
      return;
    }
    regs.a1 = u32(regs.a1 + 1);
    regs.a2 = u32(regs.a2 + 1);
  }

  regs.a1 = u32(regs.a1 - regs.a0);
  regs.d1 = regs.d5;
  regs.d0 = regs.d2;
  regs.d0 = u32(regs.d0 << 3);
  regs.d7 = u32(regs.d7 + regs.d0);
  regs.d2 = u32(regs.d2 - 1);

  {
    let guard = 0;
    while (true) {
      regs.d0 = getBLong(context, regs.a0);
      if ((regs.d0 >>> 0) !== 0) {
        if (!putBLong(context, regs.a0, u32(regs.d0 + regs.d1))) {
          restoreAndReturn(0xffffffff);
          return;
        }
      }
      regs.a0 = u32(regs.a0 + 8);

      const prev = regs.d2;
      regs.d2 = u32(regs.d2 - 1);
      if ((prev >>> 0) === 0) break;
      guard += 1;
      if (guard > 0x200000) {
        restoreAndReturn(0xffffffff);
        return;
      }
    }
  }

  regs.d5 >>>= 3;
  regs.d5 = u32(regs.d5 - 1);

  regs.d0 = getBLong(context, regs.a0);
  if ((regs.d0 >>> 0) !== 0) {
    if (!putBLong(context, regs.a0, u32(regs.d0 + regs.d7))) {
      restoreAndReturn(0xffffffff);
      return;
    }
  }
  regs.a0 = u32(regs.a0 + 8);

  {
    let guard = 0;
    while (true) {
      const prev = regs.d2;
      regs.d2 = u32(regs.d2 - 1);
      if ((prev >>> 0) === 0) break;

      regs.d0 = getBLong(context, regs.a0);
      if ((regs.d0 >>> 0) !== 0) {
        if (!putBLong(context, regs.a0, u32(regs.d0 + regs.d1))) {
          restoreAndReturn(0xffffffff);
          return;
        }
      }
      regs.a0 = u32(regs.a0 + 8);

      guard += 1;
      if (guard > 0x200000) {
        restoreAndReturn(0xffffffff);
        return;
      }
    }
  }

  regs.d5 >>>= 3;
  regs.d5 = u32(regs.d5 - 1);
  regs.d0 = regs.a1;

  restoreAndReturn(regs.d0);
}

function L0000dc(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  const saved = {
    d1: impl.m_D1 >>> 0,
    d2: impl.m_D2 >>> 0,
    d3: impl.m_D3 >>> 0,
    d4: impl.m_D4 >>> 0,
    d5: impl.m_D5 >>> 0,
    d6: impl.m_D6 >>> 0,
    d7: impl.m_D7 >>> 0,
    a0: impl.m_A0 >>> 0,
    a1: impl.m_A1 >>> 0,
    a2: impl.m_A2 >>> 0,
    a3: impl.m_A3 >>> 0,
    a4: impl.m_A4 >>> 0,
    a5: impl.m_A5 >>> 0,
    a6: impl.m_A6 >>> 0,
  };

  G.L002245 = SET;

  const fadeSpeed = G.L001e1e;
  if (G.L001e17 !== 0) {
    if (signed8(G.L001e17) < 0) {
      G.L001e17 = 0x7f;
      fadeSpeed[1] = fadeSpeed[0];
    }

    if (signed16(fadeSpeed[1]) >= 0) {
      fadeSpeed[1] = low16(fadeSpeed[1] - 2);
    } else {
      if (signed8(G.L001e14) >= 0x0a) {
        G.L001e15 = SET;
      }

      if (signed8(G.L001e14) < 0x3e) {
        G.L001e14 = low8(G.L001e14 + 1);
        fadeSpeed[1] = fadeSpeed[0];
      } else if (G.L001e18 !== 0) {
        L00077a(context);
      } else {
        G.L001e14 = 0x7f;
        G.L001e17 = CLR;
        G.L001e13 = 0x01;
        L_PAUSE_(context);

        if (impl.m_MXWORK_PCM8) {
          impl.m_D0 = 0x0100;
          PCM8_SUB(context);
        }
        if (G.L001df4 !== 0) {
          impl.m_D0 = 0x01ff;
          PCM8_SUB(context);
          G.L001df4 = CLR;
        }
      }
    }
  }

  impl.m_D2 = u32(low8(G.L001e0c));
  impl.m_D1 = 0x12;

  if (G.L001e13 === 0) {
    G.L001ba6 = low16(G.L001ba6 + 1);

    for (let d7 = 0; d7 < 9; d7++) {
      const ch = getChannelByIndex(context, d7);
      impl.m_D7 = d7 >>> 0;
      L001050(context, ch, d7);
      L0011b4(context, ch, d7);
      if ((G.L001e1c & (1 << d7)) === 0) {
        L000c66(context, ch, d7);
      }
    }

    if (G.L001df4 !== 0) {
      for (let d7 = 9; d7 < 16; d7++) {
        const ch = getChannelByIndex(context, d7);
        impl.m_D7 = d7 >>> 0;
        L001050(context, ch, d7);
        L0011b4(context, ch, d7);
        if ((G.L001e1c & (1 << d7)) === 0) {
          L000c66(context, ch, d7);
        }
      }
    }
  }

  G.L002245 = CLR;

  impl.m_D1 = saved.d1;
  impl.m_D2 = saved.d2;
  impl.m_D3 = saved.d3;
  impl.m_D4 = saved.d4;
  impl.m_D5 = saved.d5;
  impl.m_D6 = saved.d6;
  impl.m_D7 = saved.d7;
  impl.m_A0 = saved.a0;
  impl.m_A1 = saved.a1;
  impl.m_A2 = saved.a2;
  impl.m_A3 = saved.a3;
  impl.m_A4 = saved.a4;
  impl.m_A5 = saved.a5;
  impl.m_A6 = saved.a6;
  impl.m_D0 = u32((low8(G.L001e12) << 8) | low8(G.L001e13));
}

const KEYCODE_TABLE = Uint8Array.from([
  0x00, 0x01, 0x02, 0x04, 0x05, 0x06, 0x08, 0x09,
  0x0a, 0x0c, 0x0d, 0x0e, 0x10, 0x11, 0x12, 0x14,
  0x15, 0x16, 0x18, 0x19, 0x1a, 0x1c, 0x1d, 0x1e,
  0x20, 0x21, 0x22, 0x24, 0x25, 0x26, 0x28, 0x29,
  0x2a, 0x2c, 0x2d, 0x2e, 0x30, 0x31, 0x32, 0x34,
  0x35, 0x36, 0x38, 0x39, 0x3a, 0x3c, 0x3d, 0x3e,
  0x40, 0x41, 0x42, 0x44, 0x45, 0x46, 0x48, 0x49,
  0x4a, 0x4c, 0x4d, 0x4e, 0x50, 0x51, 0x52, 0x54,
  0x55, 0x56, 0x58, 0x59, 0x5a, 0x5c, 0x5d, 0x5e,
  0x60, 0x61, 0x62, 0x64, 0x65, 0x66, 0x68, 0x69,
  0x6a, 0x6c, 0x6d, 0x6e, 0x70, 0x71, 0x72, 0x74,
  0x75, 0x76, 0x78, 0x79, 0x7a, 0x7c, 0x7d, 0x7e,
]);

const CARRIER_SLOT_TABLE = Uint8Array.from([0x08, 0x08, 0x08, 0x08, 0x0c, 0x0e, 0x0e, 0x0f]);

const PCM_VOLUME_TABLE = Uint8Array.from([
  0x0f, 0x0f, 0x0f, 0x0e, 0x0e, 0x0e, 0x0d, 0x0d,
  0x0d, 0x0c, 0x0c, 0x0b, 0x0b, 0x0b, 0x0a, 0x0a,
  0x0a, 0x09, 0x09, 0x08, 0x08, 0x08, 0x07, 0x07,
  0x07, 0x06, 0x06, 0x05, 0x05, 0x05, 0x04, 0x04,
  0x04, 0x03, 0x03, 0x02, 0x02, 0x02, 0x01, 0x01,
  0x01, 0x00, 0x00, 0xff,
]);

function MX_ABORT(_context) {}

function readInstrumentByte(context, instrumentOfs, index) {
  const impl = context.m_impl;
  const idx = index | 0;
  const source = instrumentOfs >>> 0;

  if (source === 0) {
    return impl.m_FAKEA6S0004[idx] ?? 0;
  }
  return getBByte(context, source + idx);
}

const SPECIAL_SEQ_L0019B2_BASE = 0xffff0000;

function isSpecialSeqPointer(ofs) {
  return ((ofs >>> 16) & 0xffff) === 0xffff;
}

function seqReadByte(context, ofs) {
  const impl = context.m_impl;
  const ptr = ofs >>> 0;
  if (isSpecialSeqPointer(ptr)) {
    const idx = ptr & 0xffff;
    return impl.m_L0019b2[idx] ?? 0;
  }
  return getBByte(context, ptr);
}

function seqWriteByte(context, ofs, value) {
  const impl = context.m_impl;
  const ptr = ofs >>> 0;
  const v = low8(value);

  if (isSpecialSeqPointer(ptr)) {
    const idx = ptr & 0xffff;
    if (idx < impl.m_L0019b2.length) {
      impl.m_L0019b2[idx] = v;
      return true;
    }
    return false;
  }
  return putBByte(context, ptr, v);
}

function seqReadWord(context, ofs) {
  const p = ofs >>> 0;
  return ((seqReadByte(context, p) << 8) | seqReadByte(context, p + 1)) >>> 0;
}

function seqReadLong(context, ofs) {
  const p = ofs >>> 0;
  return (
    (seqReadByte(context, p) * 0x1000000)
    + (seqReadByte(context, p + 1) << 16)
    + (seqReadByte(context, p + 2) << 8)
    + seqReadByte(context, p + 3)
  ) >>> 0;
}

function writeOpmFromSeqState(context, state) {
  const impl = context.m_impl;
  impl.m_D1 = u32(state.d1);
  impl.m_D2 = u32(state.d2);
  L_WRITEOPM(context);
}

function L0015d0(_context, channel, _channelIndex) {
  if (!channel) return;
  channel.S004e = low16(channel.S004c);
  channel.S0048 = low16(channel.S0044);
  channel.S004a = low16(channel.S0046);
}

function L001216(_context, state) {
  const channel = state.channel;
  state.d1 = u32(state.d1 + 1);
  channel.S001b = low8(state.d1);

  state.d0 = u32(state.d0 + 1);
  channel.S001a = low8(state.d0);
  channel.S0000 = state.pc >>> 0;
}

function L001292(context, state) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;

  state.d1 = 0x12;
  state.d2 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  G.L001e0c = low8(state.d2);
  G.MUSICTIMER = low8(state.d2);

  if (G.L001e08 === 0) {
    writeOpmFromSeqState(context, state);
  }
}

function L0012a6(context, state) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;

  state.d1 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  state.d2 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);

  if (state.d1 === 0x12 && G.L001e08 === 0) {
    G.L001e0c = low8(state.d2);
    G.MUSICTIMER = low8(state.d2);
  }

  writeOpmFromSeqState(context, state);
}

function L0012be(context, state) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  const channel = state.channel;

  if (signed8(channel.S0018) < 0) {
    channel.S0004_b = low8(seqReadByte(context, state.pc));
    state.pc = u32(state.pc + 1);
    return;
  }

  state.d0 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);

  let a0 = G.L002228 >>> 0;
  const limit = u32((G.L001e34 >>> 0) + (G.L002220 >>> 0));
  while (true) {
    if (a0 >= limit) return;

    const id = seqReadByte(context, a0);
    a0 = u32(a0 + 1);
    if (id !== low8(state.d0)) {
      a0 = u32(a0 + 0x1a);
      continue;
    }

    channel.S0004 = a0 >>> 0;
    channel.S0017 = low8(channel.S0017 | 0x02);
    return;
  }
}

function L0012e6(context, state) {
  const channel = state.channel;

  if (signed8(channel.S0018) >= 0) {
    state.d0 = channel.S001c & 0x3f;
    state.d0 |= (seqReadByte(context, state.pc) << 6);
    state.pc = u32(state.pc + 1);
    channel.S001c = low8(state.d0);
    channel.S0017 = low8(channel.S0017 | 0x04);
    return;
  }

  state.d0 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  if (state.d0 === 0x00 || state.d0 === 0x03) {
    state.d0 ^= 0x03;
  }
  channel.S001c = low8((channel.S001c & 0xfc) | state.d0);
}

function L00131c(context, state) {
  const channel = state.channel;
  channel.S0022 = low8(seqReadByte(context, state.pc));
  state.pc = u32(state.pc + 1);
  channel.S0017 = low8(channel.S0017 | 0x01);
}

function L001328(context, state) {
  const channel = state.channel;
  state.d2 = channel.S0022 & 0xff;

  if (signed8(state.d2) >= 0) {
    if (state.d2 === 0x00) return;
    channel.S0022 = low8(channel.S0022 - 1);
    channel.S0017 = low8(channel.S0017 | 0x01);
    return;
  }

  if ((state.d2 & 0xff) === 0xff) return;
  channel.S0022 = low8(channel.S0022 + 1);
  channel.S0017 = low8(channel.S0017 | 0x01);
}

function L001330(context, state) {
  const channel = state.channel;
  channel.S0022 = low8(channel.S0022 - 1);
  channel.S0017 = low8(channel.S0017 | 0x01);
}

function L001344(context, state) {
  const channel = state.channel;
  state.d2 = channel.S0022 & 0xff;

  if (signed8(state.d2) >= 0) {
    if (state.d2 === 0x0f) return;
    channel.S0022 = low8(channel.S0022 + 1);
    channel.S0017 = low8(channel.S0017 | 0x01);
    return;
  }

  if (low8(state.d2) !== 0x80) {
    L001330(context, state);
  }
}

function L001364(context, state) {
  const channel = state.channel;
  channel.S001e = low8(seqReadByte(context, state.pc));
  state.pc = u32(state.pc + 1);
}

function L00136a(context, state) {
  const channel = state.channel;
  channel.S0016 = low8(channel.S0016 | 0x04);
}

function L001372(context, state) {
  const t0 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  seqWriteByte(context, state.pc, t0);
  state.pc = u32(state.pc + 1);
}

function L001376(context, state) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;

  state.d0 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);
  state.d0 = u32(((state.d0 ^ 0xffff) + 1) & 0xffff);

  const counterPtr = u32(state.pc - state.d0 - 1);
  const counter = low8(seqReadByte(context, counterPtr) - 1);
  seqWriteByte(context, counterPtr, counter);

  if (counter === 0) return;

  if (G.L001e0b) {
    if (seqReadByte(context, state.pc) === 0xf1 && seqReadByte(context, state.pc + 1) === 0x00) {
      L0013e6(context, state);
      return;
    }
  }

  if (u32(state.pc - state.d0) < (G.L001e34 >>> 0)) {
    G.FATALERROR = 0x001396;
    G.FATALERRORADR = state.pc >>> 0;
    return;
  }
  state.pc = u32(state.pc - state.d0);
}

function L00139a(context, state) {
  state.d0 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);

  let a0 = u32(state.pc + state.d0);
  state.d0 = seqReadWord(context, a0);
  a0 = u32(a0 + 2);
  state.d0 = u32(((state.d0 ^ 0xffff) + 1) & 0xffff);

  if (seqReadByte(context, u32(a0 - state.d0 - 1)) === 0x01) {
    state.pc = a0;
  }
}

function L0013ba(context, state) {
  const channel = state.channel;
  state.d0 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);
  channel.S0010 = low16(state.d0);
}

function L0013c6(context, state) {
  const channel = state.channel;
  state.d0 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);
  state.d0 = u32((signed16(state.d0) << 8) | 0);
  channel.S0008 = u32(state.d0);
  channel.S0016 = low8(channel.S0016 | 0x80);
}

function L0013dc(context, state) {
  const op = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  if (op === 0x00) {
    L001440(context, state);
    return;
  }

  state.pc = u32(state.pc - 1);
  state.d0 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);
  state.d0 = u32(((state.d0 ^ 0xffff) + 1) & 0xffff);
  L0013e6(context, state);
}

function L0013e6(context, state) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  const idx = state.channelIndex | 0;

  if (u32(state.pc - state.d0) < (G.L001e34 >>> 0)) {
    G.FATALERROR = 0x0013e6;
    G.FATALERRORADR = state.pc >>> 0;
    return;
  }

  state.pc = u32(state.pc - state.d0);

  let d0 = (G.L001e1a & 0xffff) & (~(1 << idx));
  G.L001e1a = low16(d0);

  d0 &= (G.L001e06 & 0xffff);
  if (d0 !== 0) return;

  if (!G.L001e18) {
    G.L001e1a = 0x01ff;
    if (G.L001df4) {
      G.L001e1a = low16((G.L001e1a & 0xffff) | 0xfe00);
    }
    G.L002246 = low16((G.L002246 & 0xffff) + 1);
    return;
  }

  if (G.L001e17) return;

  G.L001e1a = 0x01ff;
  if (G.L001df4) {
    G.L001e1a = low16((G.L001e1a & 0xffff) | 0xfe00);
  }
  G.L001e22 = low16((G.L001e22 & 0xffff) - 1);
  if ((G.L001e22 & 0xffff) === 0) {
    G.L001e1e[0] = 0x0011;
    G.L001e17 = SET;
  }
}

function L001440(context, state) {
  L001442(context, state);
}

function L001442(context, state) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  const idx = state.channelIndex | 0;

  state.pc = SPECIAL_SEQ_L0019B2_BASE;

  let d0 = (G.L001e1a & 0xffff) & (~(1 << idx));
  G.L001e1a = low16(d0);

  d0 = (G.L001e06 & 0xffff) & (~(1 << idx));
  G.L001e06 = low16(d0);

  if (d0 !== 0) return;

  G.L001e13 = 0x01;
  if (G.L001df4) {
    impl.m_D0 = 0x01ff;
    PCM8_SUB(context);
    G.L001df4 = CLR;
  }

  if (!G.L001e18) {
    G.L002246 = 0xffff;
    return;
  }

  G.L001e1e[0] = 0xffff;
  G.L001e17 = SET;
  G.L001e14 = 0x00;
  G.L001e15 = 0x37;
}

function L001492(context, state) {
  const channel = state.channel;
  channel.S001f = low8(seqReadByte(context, state.pc));
  state.pc = u32(state.pc + 1);
}

function L001498(context, state) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  state.d0 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);

  const target = state.d0 & 0xff;
  if (target < G.L001df6.length) {
    G.L001df6[target] = SET;
  }
  if (target < 0x09 && state.channelIndex < G.L002233.length) {
    G.L002233[state.channelIndex] = SET;
  }
}

function L0014b0(context, state) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  const channel = state.channel;
  const idx = state.channelIndex | 0;

  if (idx < G.L001df6.length && G.L001df6[idx]) {
    G.L001df6[idx] = CLR;
    if (idx < 0x09 && idx < G.L002233.length) {
      G.L002233[idx] = CLR;
    }
    channel.S0017 = low8(channel.S0017 & 0xf7);
    return;
  }

  channel.S0017 = low8(channel.S0017 | 0x08);
  channel.S0000 = state.pc >>> 0;
  state.dispose = true;
}

function L0014dc(context, state) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  const channel = state.channel;

  state.d2 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);

  if (signed8(channel.S0018) >= 0) {
    G.L002232 = low8(state.d2);
    state.d1 = 0x0f;
    writeOpmFromSeqState(context, state);
    return;
  }

  state.d2 = u32((state.d2 << 2) & 0xff);
  channel.S001c = low8((channel.S001c & 0x03) | state.d2);
}

function L0014fc(context, state) {
  const channel = state.channel;

  channel.S0016 = low8(channel.S0016 | 0x20);
  state.d1 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);

  if (signed8(state.d1) < 0) {
    state.d1 &= 0x01;
    if (state.d1) {
      channel.S003e = low16(channel.S003a);
      channel.S0032 = u32(channel.S002e);
      channel.S0036 = u32(channel.S002a);
      return;
    }
    channel.S0016 = low8(channel.S0016 & 0xdf);
    channel.S0036 = CLR;
    return;
  }

  const d1Raw = state.d1 & 0xff;
  state.d1 = u32((state.d1 & 0x03) + ((state.d1 & 0x03)));
  channel.S0026 = u32((state.d1 >>> 1) + 1);

  state.d2 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);
  channel.S003c = low16(state.d2);

  if (state.d1 !== 0x02) {
    state.d2 = u32(state.d2 >>> 1);
    if (state.d1 === 0x06) {
      state.d2 = 0x01;
    }
  }
  channel.S003a = low16(state.d2);

  state.d0 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);
  state.d0 = u32((signed16(state.d0) << 8) | 0);
  state.d1 = d1Raw;
  if (state.d1 >= 0x04) {
    state.d0 = u32((signed32(state.d0) << 8) | 0);
    state.d1 &= 0x03;
  }

  channel.S002e = u32(state.d0);
  if (state.d1 !== 0x02) {
    state.d0 = 0;
  }
  channel.S002a = u32(state.d0);
  channel.S003e = low16(channel.S003a);
  channel.S0032 = u32(channel.S002e);
  channel.S0036 = u32(channel.S002a);
}

function L001590(context, state) {
  const channel = state.channel;

  channel.S0016 = low8(channel.S0016 | 0x40);
  state.d2 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  if (signed8(state.d2) < 0) {
    L0015e4(context, state);
    return;
  }

  state.d2 = u32((state.d2 + state.d2) & 0xff);
  channel.S0040 = u32((state.d2 >>> 1) + 1);

  state.d1 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);
  channel.S004c = low16(state.d1);

  state.d0 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);
  channel.S0044 = low16(state.d0);

  if ((state.d2 & (1 << 1)) === 0) {
    state.d0 = u32((signed16(state.d0) * signed16(state.d1)) | 0);
  }

  let d0 = -signed16(state.d0);
  if (d0 < 0) d0 = 0;
  channel.S0046 = low16(d0);

  L0015d0(context, channel, state.channelIndex);
}

function L0015e4(context, state) {
  const channel = state.channel;

  state.d2 &= 0x01;
  if (state.d2) {
    L0015d0(context, channel, state.channelIndex);
    return;
  }

  channel.S0016 = low8(channel.S0016 & 0xbf);
  channel.S004a = CLR;
}

function L0015fe(context, state) {
  const impl = context.m_impl;
  const channel = state.channel;

  state.d2 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  if (signed8(state.d2) < 0) {
    state.d2 &= 0x01;
    if (state.d2) {
      state.d2 = channel.S0021 & 0xff;
    }
    state.d1 = u32(0x38 + low8(channel.S0018));
    writeOpmFromSeqState(context, state);
    return;
  }

  channel.S0016 = low8(channel.S0016 & 0xfd);
  const c0 = state.d2 & (1 << 6);
  state.d2 &= ~(1 << 6);
  if (c0) {
    channel.S0016 = low8(channel.S0016 | 0x02);
  }

  state.d2 |= impl.m_OpmReg1B & 0xc0;
  state.d1 = 0x1b;
  writeOpmFromSeqState(context, state);

  state.d1 = 0x18;
  state.d2 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  writeOpmFromSeqState(context, state);

  state.d1 = 0x19;
  state.d2 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  writeOpmFromSeqState(context, state);

  state.d2 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  writeOpmFromSeqState(context, state);

  state.d2 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  channel.S0021 = low8(state.d2);

  state.d1 = u32(0x38 + low8(channel.S0018));
  writeOpmFromSeqState(context, state);
}

function L001656(context, state) {
  const channel = state.channel;
  channel.S0024 = low8(seqReadByte(context, state.pc));
  state.pc = u32(state.pc + 1);
}

function L00165c(context, _state) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  if (!impl.m_MXWORK_PCM8) return;

  G.L001df4 = SET;
  impl.m_D0 = 0x01fe;
  PCM8_SUB(context);
  G.L001e1a = low16((G.L001e1a & 0xffff) | 0xfe00);
  G.L001e06 = low16((G.L001e06 & 0xffff) | 0xfe00);
}

function L0016b8(context, state) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  state.d0 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  G.L001e1e[0] = low16(state.d0);
  G.L001e17 = SET;
}

function L0016c6(context, state) {
  const impl = context.m_impl;

  if (!impl.m_MXWORK_PCM8) {
    state.pc = u32(state.pc + 6);
    return;
  }

  state.d0 = seqReadWord(context, state.pc);
  state.pc = u32(state.pc + 2);
  state.d1 = seqReadLong(context, state.pc);
  state.pc = u32(state.pc + 4);
  impl.m_D0 = u32(state.d0);
  impl.m_D1 = u32(state.d1);
  PCM8_SUB(context);
}

function L0016fa(context, state) {
  const channel = state.channel;
  if (seqReadByte(context, state.pc) !== 0) {
    state.pc = u32(state.pc + 1);
    channel.S0016 = low8(channel.S0016 | 0x10);
    return;
  }
  state.pc = u32(state.pc + 1);
  channel.S0016 = low8(channel.S0016 & 0xef);
}

function L00178a(context, state) {
  const channel = state.channel;

  state.d0 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);
  state.d1 = state.d0;
  L001216(context, state);
  channel.S0016 = low8(channel.S0016 & 0xfe);
  L000e7e(context, channel, state.channelIndex);
  state.dispose = true;
}

function L0017a0(context, state) {
  const channel = state.channel;

  if (seqReadByte(context, state.pc) !== 0) {
    state.pc = u32(state.pc + 1);
    channel.S0017 = low8(channel.S0017 | 0x80);
  } else {
    state.pc = u32(state.pc + 1);
  }
  channel.S0017 = low8(channel.S0017 & 0x7f);
}

function L00170e(context, state) {
  const targetIndex = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);

  const target = getChannelByIndex(context, targetIndex);
  if (!target) return;

  const savedPtr = target.S0000 >>> 0;
  const targetState = {
    context,
    channel: target,
    channelIndex: targetIndex | 0,
    pc: state.pc >>> 0,
    d0: 0,
    d1: 0,
    d2: 0,
    dispose: false,
  };

  target.S0016 = low8(target.S0016 & 0x7b);

  targetState.d0 = seqReadByte(context, targetState.pc);
  targetState.pc = u32(targetState.pc + 1);
  targetState.d1 = targetState.d0;

  if (signed8(targetState.d0) < 0) {
    if ((targetState.d0 & 0xff) >= 0xe0) {
      targetState.d0 = u32((targetState.d0 ^ 0xff) & 0xff);
      const handler = L001252_TABLE[targetState.d0];
      if (typeof handler === 'function') {
        handler(context, targetState);
      }

      state.pc = targetState.pc >>> 0;
      if (!targetState.dispose) {
        target.S0000 = savedPtr;
      }
      return;
    }

    targetState.d0 = u32(((targetState.d0 & 0x7f) << 6) + 0x05);
    targetState.d0 = u32(targetState.d0 + (target.S0010 & 0xffff));
    target.S0012 = low16(targetState.d0);
    target.S0016 = low8(target.S0016 | 0x01);
    target.S0020 = low8(target.S001f);
    targetState.d0 = seqReadByte(context, targetState.pc);
    targetState.pc = u32(targetState.pc + 1);
    targetState.d1 = target.S001e & 0xff;

    if (signed8(targetState.d1) < 0) {
      const d1sum = (targetState.d1 & 0xff) + (targetState.d0 & 0xff);
      if (d1sum >= 0x100) {
        targetState.d1 = u32((targetState.d1 & 0xffffff00) | (d1sum & 0xff));
      } else {
        targetState.d1 = 0;
      }
    } else {
      targetState.d1 = u32(((targetState.d1 & 0xffff) * (targetState.d0 & 0xffff)) >>> 3);
    }
  }

  targetState.d1 = u32(targetState.d1 + 1);
  target.S001b = low8(targetState.d1);
  targetState.d0 = u32(targetState.d0 + 1);
  target.S001a = low8(targetState.d0);
  state.pc = targetState.pc >>> 0;
  target.S0000 = savedPtr;
}

const L0016AA_TABLE = [
  L001442,
  L0016b8,
  L0016c6,
  L0016fa,
  L00170e,
  L00178a,
  L0017a0,
];

function L001694(context, state) {
  state.d0 = seqReadByte(context, state.pc);
  state.pc = u32(state.pc + 1);

  if (state.d0 > 7) {
    L001442(context, state);
    return;
  }
  L0016AA_TABLE[state.d0](context, state);
}

const L001252_TABLE = [
  L001292,
  L0012a6,
  L0012be,
  L0012e6,
  L00131c,
  L001328,
  L001344,
  L001364,
  L00136a,
  L001372,
  L001376,
  L00139a,
  L0013ba,
  L0013c6,
  L0013dc,
  L001492,
  L001498,
  L0014b0,
  L0014dc,
  L0014fc,
  L001590,
  L0015fe,
  L001656,
  L00165c,
  L001694,
  L001442,
  L001442,
  L001442,
  L001442,
  L001442,
  L001442,
  L001442,
];

function L0011d4(context, channel, channelIndex) {
  if (!channel) return;

  const state = {
    context,
    channel,
    channelIndex: channelIndex | 0,
    pc: channel.S0000 >>> 0,
    d0: 0,
    d1: 0,
    d2: 0,
    dispose: false,
  };

  channel.S0016 = low8(channel.S0016 & 0x7b);

  while (true) {
    state.d0 = seqReadByte(context, state.pc);
    state.pc = u32(state.pc + 1);
    state.d1 = state.d0;

    if (signed8(state.d1) >= 0) {
      L001216(context, state);
      return;
    }

    if ((state.d0 & 0xff) >= 0xe0) {
      state.d0 = u32((state.d0 ^ 0xff) & 0xff);
      state.dispose = false;
      const handler = L001252_TABLE[state.d0];
      if (typeof handler === 'function') {
        handler(context, state);
      }
      if (state.dispose) return;
      continue;
    }

    state.d0 = u32(((state.d0 & 0x7f) << 6) + 0x05);
    state.d0 = u32(state.d0 + (channel.S0010 & 0xffff));
    channel.S0012 = low16(state.d0);
    channel.S0016 = low8(channel.S0016 | 0x01);
    channel.S0020 = low8(channel.S001f);

    state.d0 = seqReadByte(context, state.pc);
    state.pc = u32(state.pc + 1);
    state.d1 = channel.S001e & 0xff;

    if (signed8(state.d1) < 0) {
      state.d1 = u32((state.d1 & 0xff) + (state.d0 & 0xff));
      if (state.d1 >= 0x100) {
        L001216(context, state);
        return;
      }
      state.d1 = 0x00;
      L001216(context, state);
      return;
    }

    state.d1 = u32(((state.d1 & 0xffff) * (state.d0 & 0xffff)) >>> 3);
    L001216(context, state);
    return;
  }
}

function L00117a(context) {
  const impl = context.m_impl;
  let d0 = impl.m_L001190 & 0xffff;
  d0 = (d0 * 0xc549 + 0x000c) & 0xffff;
  impl.m_L001190 = d0;
  impl.m_D0 = u32(d0 >>> 8);
}

function L0010be(context, channel, _channelIndex) {
  const impl = context.m_impl;
  channel.S0036 = u32(channel.S0036 + impl.m_D1);
  channel.S003e = low16(channel.S003e - 1);
  if (channel.S003e !== 0) return;
  channel.S003e = low16(channel.S003c);
  channel.S0036 = u32(-signed32(channel.S0036));
}

function L0010d4(context, channel, _channelIndex) {
  const impl = context.m_impl;
  channel.S0036 = u32(impl.m_D1);
  channel.S003e = low16(channel.S003e - 1);
  if (channel.S003e !== 0) return;
  channel.S003e = low16(channel.S003c);
  channel.S0032 = u32(-signed32(channel.S0032));
}

function L0010ea(context, channel, _channelIndex) {
  const impl = context.m_impl;
  channel.S0036 = u32(channel.S0036 + impl.m_D1);
  channel.S003e = low16(channel.S003e - 1);
  if (channel.S003e !== 0) return;
  channel.S003e = low16(channel.S003c);
  channel.S0032 = u32(-signed32(channel.S0032));
}

function L001100(context, channel, _channelIndex) {
  const impl = context.m_impl;
  channel.S003e = low16(channel.S003e - 1);
  if (channel.S003e !== 0) return;
  L00117a(context);
  impl.m_D0 = u32((signed16(impl.m_D0) * signed16(impl.m_D1)) | 0);
  channel.S0036 = u32(impl.m_D0);
  channel.S003e = low16(channel.S003c);
}

function L0010b4(context, channel, channelIndex) {
  const impl = context.m_impl;
  const table = [L00095a, L0010be, L0010d4, L0010ea, L001100];

  impl.m_D1 = u32(channel.S0032);
  const mode = channel.S0026 >>> 0;
  if (mode < table.length) {
    table[mode](context, channel, channelIndex);
  }
  MX_ABORT(context);
}

function L001120(context, channel, _channelIndex) {
  const impl = context.m_impl;
  channel.S004a = low16(channel.S004a + low16(impl.m_D1));
  channel.S004e = low16(channel.S004e - 1);
  if (channel.S004e !== 0) return;
  channel.S004e = low16(channel.S004c);
  channel.S004a = low16(channel.S0046);
}

function L001138(context, channel, _channelIndex) {
  const impl = context.m_impl;
  channel.S004e = low16(channel.S004e - 1);
  if (channel.S004e !== 0) return;
  channel.S004e = low16(channel.S004c);
  channel.S004a = low16(channel.S004a + low16(impl.m_D1));
  channel.S0048 = low16(-signed16(channel.S0048));
}

function L00114e(context, channel, _channelIndex) {
  const impl = context.m_impl;
  channel.S004a = low16(channel.S004a + low16(impl.m_D1));
  channel.S004e = low16(channel.S004e - 1);
  if (channel.S004e !== 0) return;
  channel.S004e = low16(channel.S004c);
  channel.S0048 = low16(-signed16(channel.S0048));
}

function L001164(context, channel, _channelIndex) {
  const impl = context.m_impl;
  channel.S004e = low16(channel.S004e - 1);
  if (channel.S004e !== 0) return;
  L00117a(context);
  impl.m_D1 = u32((signed16(impl.m_D1) * signed16(impl.m_D0)) | 0);
  channel.S004e = low16(channel.S004c);
  channel.S004a = low16(impl.m_D1);
}

function L001116(context, channel, channelIndex) {
  const impl = context.m_impl;
  const table = [L00095a, L001120, L001138, L00114e, L001164];

  impl.m_D1 = u32(channel.S0048);
  const mode = channel.S0040 >>> 0;
  if (mode < table.length) {
    table[mode](context, channel, channelIndex);
  }
  MX_ABORT(context);
}

function L001094(context, channel, channelIndex) {
  channel.S0025 = low8(channel.S0025 - 1);
  if (channel.S0025 !== 0) return;

  if (channel.S0016 & (1 << 5)) {
    channel.S003e = low16(channel.S003a);
    channel.S0032 = u32(channel.S002e);
    channel.S0036 = u32(channel.S002a);
  }

  if (channel.S0016 & (1 << 6)) {
    L0015d0(context, channel, channelIndex);
  }
}

function L001050(context, channel, channelIndex) {
  if (!channel) return;

  if (signed8(channel.S0018) >= 0) {
    if (signed8(channel.S0016) < 0 && channel.S0020 === 0) {
      channel.S000c = u32(channel.S000c + channel.S0008);
    }
  }

  if (channel.S0024 !== 0) {
    if (channel.S0020 !== 0) return;
    if (channel.S0025 !== 0) {
      L001094(context, channel, channelIndex);
      return;
    }
  }

  if (channel.S0016 & (1 << 5)) {
    L0010b4(context, channel, channelIndex);
  }
  if (channel.S0016 & (1 << 6)) {
    L001116(context, channel, channelIndex);
  }
}

function L001192(context, channel, channelIndex) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  if (!G.L001df6[channelIndex]) return;

  G.L001df6[channelIndex] = CLR;
  if (channelIndex < 9) {
    G.L002233[channelIndex] = CLR;
  }
  channel.S0017 = low8(channel.S0017 & 0xf7);
  L0011d4(context, channel, channelIndex);
}

function L0011ce(context, channel, channelIndex) {
  channel.S001a = low8(channel.S001a - 1);
  if (channel.S001a !== 0) return;
  L0011d4(context, channel, channelIndex);
}

function L000fe6(context, channel, channelIndex) {
  const c0 = channel.S0016 & (1 << 3);
  channel.S0016 = low8(channel.S0016 & ~(1 << 3));
  if (c0 === 0) return;
  if (channel.S0016 & (1 << 4)) return;
  L000ff6(context, channel, channelIndex);
}

function L0011b4(context, channel, channelIndex) {
  if (!channel) return;

  if (channel.S0017 & (1 << 3)) {
    L001192(context, channel, channelIndex);
    return;
  }
  if (channel.S0016 & (1 << 2)) {
    L0011ce(context, channel, channelIndex);
    return;
  }

  channel.S001b = low8(channel.S001b - 1);
  if (channel.S001b !== 0) {
    L0011ce(context, channel, channelIndex);
    return;
  }

  L000fe6(context, channel, channelIndex);
  L0011ce(context, channel, channelIndex);
}

function L000ff6(context, channel, channelIndex) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  impl.m_D2 = u32(channel.S0018);
  if (signed8(channel.S0018) >= 0) {
    impl.m_D1 = 0x08;
    G.L00223c[channelIndex] = low8(channel.S0018);
    G.L001bb4[channelIndex] = low8(channel.S0018);
    L_WRITEOPM(context);
    return;
  }

  if (G.L002231 === 0 || G.L001e09) return;

  if (G.L001df4 !== 0) {
    impl.m_D0 = u32(channel.S0018 & 0x0007);
    impl.m_D1 = u32(((channel.S0022 & 0xffff) << 16) | (impl.m_D2 & 0xffff));
    impl.m_D2 = 0;
    PCM8_SUB(context);
    return;
  }

  if (channel.S0017 === 0) {
    ADPCMMOD_STOP(context);
  }
  ADPCMMOD_END(context);
}

function L000cdc(context, channel, _channelIndex) {
  const impl = context.m_impl;

  impl.m_D2 = u32((channel.S0012 + (channel.S000c >>> 16) + (channel.S0036 >>> 16)) & 0xffff);
  if ((impl.m_D2 & 0xffff) === (channel.S0014 & 0xffff)) return;

  channel.S0014 = low16(impl.m_D2);
  impl.m_D1 = 0x17ff;
  if (impl.m_D1 < impl.m_D2) {
    if (signed16(impl.m_D2) < 0) {
      impl.m_D2 = 0;
    } else {
      impl.m_D2 = impl.m_D1;
    }
  }

  impl.m_D2 = u32((impl.m_D2 & 0xffff) * 4);
  impl.m_D1 = u32(0x30 + low8(channel.S0018));
  L_WRITEOPM(context);

  impl.m_D1 = u32(impl.m_D1 - 8);
  impl.m_D2 = u32((impl.m_D2 >>> 8) & 0xff);
  impl.m_D2 = KEYCODE_TABLE[impl.m_D2] ?? 0;
  L_WRITEOPM(context);
}

function L000d84(context, channel, _channelIndex) {
  const impl = context.m_impl;

  let c0 = channel.S0017 & (1 << 1);
  channel.S0017 = low8(channel.S0017 & ~(1 << 1));
  if (!c0) return;

  const instrumentOfs = channel.S0004 >>> 0;
  channel.S001c = low8(channel.S001c & 0xc0);

  let d0 = readInstrumentByte(context, instrumentOfs, 0);
  channel.S001c = low8(channel.S001c | d0);
  d0 &= 0x07;

  let d3 = CARRIER_SLOT_TABLE[d0] ?? 0;
  channel.S0019 = low8(d3);

  d0 = readInstrumentByte(context, instrumentOfs, 1);
  d0 = low8((d0 << 3) | low8(channel.S0018));
  channel.S001d = low8(d0);

  impl.m_D1 = u32(0x40 + low8(channel.S0018));
  let pos = 2;

  for (let i = 0; i < 4; i++) {
    impl.m_D2 = readInstrumentByte(context, instrumentOfs, pos++);
    L_WRITEOPM(context);
    impl.m_D1 = u32(impl.m_D1 + 8);
  }

  for (let i = 0; i < 4; i++) {
    impl.m_D2 = readInstrumentByte(context, instrumentOfs, pos++);
    c0 = d3 & 1;
    d3 >>= 1;
    if (c0) {
      impl.m_D2 = 0x7f;
    }
    L_WRITEOPM(context);
    impl.m_D1 = u32(impl.m_D1 + 8);
  }

  for (let i = 0; i < 16; i++) {
    impl.m_D2 = readInstrumentByte(context, instrumentOfs, pos++);
    L_WRITEOPM(context);
    impl.m_D1 = u32(impl.m_D1 + 8);
  }

  channel.S0023 = SET;
  channel.S0017 = low8(channel.S0017 | 0x64);
}

function L000dfe(context, channel, channelIndex) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  let d0 = channel.S0022 & 0xff;
  const hasRawVolume = (d0 & (1 << 7)) !== 0;
  d0 &= ~(1 << 7);
  if (!hasRawVolume) {
    d0 = impl.m_L000e7eVolume[d0 & 0x0f];
  }

  d0 += G.L001e14;
  if (d0 > 0xff || signed8(d0) < 0) d0 = 0x7f;

  d0 += channel.S004a >>> 8;
  if (d0 > 0xff || signed8(d0) < 0) d0 = 0x7f;

  if ((channel.S0023 & 0xff) === (d0 & 0xff)) return;
  impl.m_D0 = u32(d0);
  L000e28(context, channel, channelIndex);
}

function L000e28(context, channel, _channelIndex) {
  const impl = context.m_impl;
  channel.S0023 = low8(impl.m_D0);

  const instrumentOfs = channel.S0004 >>> 0;
  let d3 = channel.S0019 & 0xff;
  impl.m_D1 = u32(0x60 + low8(channel.S0018));

  for (let i = 0; i < 4; i++) {
    let d2 = readInstrumentByte(context, instrumentOfs, 6 + i);
    const c0 = d3 & 1;
    d3 >>= 1;
    if (c0) {
      d2 = low8(d2 + impl.m_D0);
      if (signed8(d2) < 0) d2 = 0x7f;
      impl.m_D2 = u32(d2);
      L_WRITEOPM(context);
    }
    impl.m_D1 = u32(impl.m_D1 + 8);
  }
}

function L000e66(context, channel, _channelIndex) {
  const impl = context.m_impl;
  const c0 = channel.S0017 & (1 << 2);
  channel.S0017 = low8(channel.S0017 & ~(1 << 2));
  if (!c0) return;

  impl.m_D2 = u32(channel.S001c);
  impl.m_D1 = u32(0x20 + low8(channel.S0018));
  L_WRITEOPM(context);
}

function L000e7e(context, channel, channelIndex) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  let c0 = channel.S0016 & (1 << 3);
  channel.S0016 = low8(channel.S0016 | (1 << 3));
  if (c0) return;

  if (channel.S0016 & (1 << 4)) {
    L000ff6(context, channel, channelIndex);
  }

  if (signed8(channel.S0018) >= 0) {
    impl.m_D2 = u32(channel.S001d);
    G.L00223c[channelIndex] = low8(impl.m_D2);
    G.L001bb4[channelIndex] = low8(impl.m_D2);
    impl.m_D1 = 0x08;
    L_WRITEOPM(context);
    return;
  }

  if (G.L002231 === 0 || G.L001e09 !== 0) {
    return;
  }

  let d0 = (channel.S0012 >>> 6) & 0xffff;
  let d2 = channel.S001c & 0xffff;
  let d1 = d2 & 0x0003;
  if (d1 === 0x0000 || d1 === 0x0003) {
    d1 ^= 0x0003;
  }

  d2 = ((d2 & 0x001c) << 6) | d1;
  if (!G.L001df4) {
    if (G.L001e15 !== 0) d2 &= 0xfc;
    d0 = u32(d0 << 3);

    let a1 = G.L00222c >>> 0;
    let a0 = u32(a1 + d0);
    let d3 = 0;

    if (a0 !== 0) {
      a1 = u32(a1 + getBLong(context, a0));
      a0 = u32(a0 + 6);
      d3 = getBWord(context, a0);
      a0 = u32(a0 + 2);
    } else {
      a0 = u32(a0 + 8);
    }

    if (d3 === 0) return;
    ADPCMMOD_END(context);

    impl.m_D1 = u32(d2);
    impl.m_D2 = u32(d3);
    if (impl.m_D2 > 0xff00) {
      impl.m_D2 = 0xff00;
    }
    impl.m_A1 = u32(a1);
    ADPCMOUT(context);

    G.L00223c[channelIndex] = CLR;
    G.L001bb4[channelIndex] = CLR;
    return;
  }

  let d1p = (channel.S0004_b & 0xff) << 5;
  d0 = u32(d0 + d1p);
  d1p = u32(d1p + d1p);
  d0 = u32(d0 + d1p);
  d0 = u32(d0 << 3);

  let a1 = G.L00222c >>> 0;
  const a0 = u32(a1 + d0);
  const d3 = getBLong(context, a0 + 4);
  if (d3 === 0) return;
  a1 = u32(a1 + getBLong(context, a0));
  impl.m_A1 = u32(a1);

  d0 = channel.S0018 & 0x0007;
  let d1v = channel.S0022 & 0xff;
  const hasRawVolume = (d1v & (1 << 7)) !== 0;
  d1v &= ~(1 << 7);
  if (!hasRawVolume) {
    d1v = impl.m_L000e7eVolume[d1v & 0x0f];
  }

  d1v += G.L001e14;
  if (signed8(d1v) < 0 || d1v >= 0x2b) {
    d1v = 0x00;
    d2 &= 0xffffff00;
  } else {
    d1v = PCM_VOLUME_TABLE[d1v] ?? 0;
  }

  impl.m_D0 = u32(d0);
  impl.m_D1 = u32((d1v << 16) | (d2 & 0xffff));
  impl.m_D2 = 0x00;
  PCM8_SUB(context);

  impl.m_D0 = u32(channel.S0018 & 0x07);
  impl.m_D2 = u32(d3 & 0x00ffffff);
  PCM8_SUB(context);

  G.L00223c[0x0008] = CLR;
  G.L001bb4[channelIndex] = CLR;
}

function L000c66(context, channel, channelIndex) {
  const impl = context.m_impl;

  if (channel.S0016 & (1 << 0)) {
    if (channel.S0020) {
      channel.S0020 = low8(channel.S0020 - 1);
    } else {
      if (signed8(channel.S0018) < 0) {
        L000e7e(context, channel, channelIndex);
        channel.S0016 = low8(channel.S0016 & 0xfe);
        return;
      }

      L000d84(context, channel, channelIndex);
      L000e66(context, channel, channelIndex);

      if ((channel.S0016 & (1 << 3)) === 0) {
        channel.S0025 = low8(channel.S0024);
        if (channel.S0025 !== 0) {
          channel.S0036 = CLR;
          channel.S004a = CLR;
          L001094(context, channel, channelIndex);
        }
      }

      if (channel.S0016 & (1 << 1)) {
        impl.m_D1 = 0x01;
        impl.m_D2 = 0x02;
        L_WRITEOPM(context);
        impl.m_D2 = 0;
        L_WRITEOPM(context);
      }

      channel.S000c = CLR;
      L000cdc(context, channel, channelIndex);
      L000dfe(context, channel, channelIndex);
      L000e7e(context, channel, channelIndex);
      channel.S0016 = low8(channel.S0016 & 0xfe);
      return;
    }
  }

  if (signed8(channel.S0018) >= 0) {
    L000cdc(context, channel, channelIndex);
    L000dfe(context, channel, channelIndex);
  }
}

function L000496(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  let d2 = impl.m_D2 >>> 0;
  const d3 = impl.m_D3 >>> 0;
  const d4 = impl.m_D4 >>> 0;

  if (G.L001e13 === 0 && (d2--) !== 0) {
    let loopD2 = d2 >>> 0;
    while (true) {
      impl.m_D2 = loopD2 >>> 0;
      L0000dc(context);
      const prev = loopD2 >>> 0;
      loopD2 = u32(loopD2 - 1);
      if (prev === 0) break;
    }
  }

  G.L001e1c = low16(d3);
  G.L001e08 = low8(d4);
  if (d4 !== 0) {
    L_1F(context);
    return;
  }
  if (G.L001e13 !== 0) {
    L_1F(context);
    return;
  }

  L00056a(context);
  impl.m_D1 = 0x12;
  impl.m_D2 = u32(low8(G.L001e0c));
  L_WRITEOPM(context);
  impl.m_D1 = 0x14;
  impl.m_D2 = 0x3a;
  L_WRITEOPM(context);
  L_1F(context);
}

function L_1D(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  const d4 = low8(G.L001e08);
  const d3 = impl.m_D1 >>> 0;

  G.L001e08 = SET;
  impl.m_D1 = 0xffff;

  const savedD2 = impl.m_D2 >>> 0;
  const savedD3 = d3 >>> 0;
  const savedD4 = d4 >>> 0;

  L_0F(context);

  impl.m_D2 = savedD2;
  impl.m_D3 = savedD3;
  impl.m_D4 = savedD4;
  L000496(context);
}

function L_1E(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  impl.m_D4 = u32(low8(G.L001e08));
  impl.m_D3 = impl.m_D1 >>> 0;
  G.L001e1c = 0xffff;
  G.L001e08 = SET;
  L000496(context);
}

function L_STOP(context) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  if (G.L001e18) {
    L000552(context);
    return;
  }
  L00063e(context);
}

function L_FREE(context) {
  L00063e(context);
  if (context.m_impl.m_MXWORK_GLOBALBUF.L001e19 !== 0) {
    L000554(context);
  }
}

function L_PAUSE(context) {
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  G.L001e12 = SET;
  G.STOPMUSICTIMER = SET;
  L0006c4(context);
}

function L_PAUSE_(context) {
  context.m_impl.m_MXWORK_GLOBALBUF.L001e12 = SET;
  L0006c4(context);
}

function L_CONT(context) {
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  G.L001e12 = CLR;
  G.STOPMUSICTIMER = CLR;
  G.MUSICTIMER = low8(G.L001e0c);
  L000756(context);
}

function L_UNIMPLEMENTED(_context) {
  // Reserved fallback for out-of-table reuse.
}

const JUMP_TABLE = [
  L_FREE,         // 0x00
  L_ERROR,        // 0x01
  L_SETMDX,       // 0x02
  L_SETPDX,       // 0x03
  L_PLAY,         // 0x04
  L_STOP,         // 0x05
  L_PAUSE,        // 0x06
  L_CONT,         // 0x07
  L_08,           // 0x08
  L_09,           // 0x09
  L_0A,           // 0x0a
  L_0B,           // 0x0b
  L_0C,           // 0x0c
  L_0D,           // 0x0d
  L_0E,           // 0x0e
  L_0F,           // 0x0f
  L_10,           // 0x10
  L_11,           // 0x11
  L_12,           // 0x12
  L_13,           // 0x13
  L_14,           // 0x14
  L_15,           // 0x15
  L_16,           // 0x16
  L_17,           // 0x17
  L_18,           // 0x18
  L_19,           // 0x19
  L_1A,           // 0x1a
  L_1B,           // 0x1b
  L_1C,           // 0x1c
  L_1D,           // 0x1d
  L_1E,           // 0x1e
  L_1F,           // 0x1f
];

function MXDRV(context, reg) {
  ensureContext(context);
  ensureReg(reg);

  syncRegistersFromReg(context, reg);
  const command = context.m_impl.m_D0 >>> 0;
  if (command >= 0x20) return;

  JUMP_TABLE[command](context);
  syncRegistersToReg(context, reg);
}

function MXDRV_Start(context, samprate, betw, pcmbuf, late, mdxbuf, pdxbuf, opmmode) {
  ensureContext(context);

  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  const KEY = context.m_impl.m_MXWORK_KEYBUF;

  context.m_impl.resetState();
  context.m_impl.resetMemoryPool();

  Object.keys(G).forEach((key) => {
    if (typeof G[key] === 'number') G[key] = 0;
  });
  KEY.OPT1 = 0;
  KEY.OPT2 = 0;
  KEY.SHIFT = 0;
  KEY.CTRL = 0;
  KEY.XF3 = 0;
  KEY.XF4 = 0;
  KEY.XF5 = 0;

  G.MEASURETIMELIMIT = ((1000 * (60 * 20 - 2)) * 4000) / 1024;

  let mode = opmmode | 0;
  if (mode > 1 || mode < 0) mode = 0;

  let ret;
  if (betw) {
    ret = X68Sound_Start(
      context.m_impl.m_x68SoundContext,
      samprate,
      mode + 1,
      1,
      betw,
      pcmbuf,
      late,
      1.0,
    );
  } else {
    ret = X68Sound_StartPcm(context.m_impl.m_x68SoundContext, samprate, 1, 1, pcmbuf);
  }

  if (ret !== 0) {
    if (ret === X68SNDERR_PCMOUT || ret === X68SNDERR_TIMER || ret === X68SNDERR_MEMORY) {
      return 10100 + ret;
    }
  }

  sound_iocs_init(context);
  ret = initializeMemory(context, mdxbuf, pdxbuf);
  if (ret !== 0) return MXDRV_ERR_MEMORY;

  return 0;
}

function MXDRV_End(context) {
  ensureContext(context);

  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;
  const KEY = impl.m_MXWORK_KEYBUF;

  X68Sound_OpmInt(impl.m_x68SoundContext, null, null);
  impl.m_MXCALLBACK_OPMINT = null;
  impl.m_OPMINT_FUNC = null;

  if (impl.m_pdxReservedMemoryPoolSize !== 0) {
    MxdrvContextImpl_ReleaseMemory(impl, impl.m_pdxReservedMemoryPoolSize);
    impl.m_pdxReservedMemoryPoolSize = 0;
  }
  if (impl.m_mdxReservedMemoryPoolSize !== 0) {
    MxdrvContextImpl_ReleaseMemory(impl, impl.m_mdxReservedMemoryPoolSize);
    impl.m_mdxReservedMemoryPoolSize = 0;
  }
  if (G.L001bac) {
    MxdrvContextImpl_ReleaseMemory(impl, G.L001ba8 >>> 0);
    G.L001bac = 0;
  }
  if (G.L001e38) {
    MxdrvContextImpl_ReleaseMemory(impl, G.L002224 >>> 0);
    G.L001e38 = 0;
  }
  if (G.L001e34) {
    MxdrvContextImpl_ReleaseMemory(impl, G.L002220 >>> 0);
    G.L001e34 = 0;
  }

  if (MxdrvContextImpl_GetReservedMemoryPoolSize(impl) !== 0) {
    impl.resetMemoryPool();
  }

  impl.resetState();
  impl.resetMemoryPool();
  Object.keys(KEY).forEach((key) => {
    KEY[key] = 0;
  });

  X68Sound_Free(impl.m_x68SoundContext);
}

function MXDRV_GetPCM(context, buf, len) {
  ensureContext(context);
  return X68Sound_GetPcm(context.m_impl.m_x68SoundContext, buf, len);
}

function MXDRV_TotalVolume(context, vol) {
  ensureContext(context);
  return X68Sound_TotalVolume(context.m_impl.m_x68SoundContext, vol);
}

function MXDRV_GetTotalVolume(context) {
  ensureContext(context);
  return X68Sound_GetTotalVolume(context.m_impl.m_x68SoundContext);
}

function MXDRV_ChannelMask(context, mask) {
  ensureContext(context);
  context.m_impl.m_MXWORK_GLOBALBUF.L001e1c = mask & 0xffff;
}

function MXDRV_GetChannelMask(context) {
  ensureContext(context);
  return context.m_impl.m_MXWORK_GLOBALBUF.L001e1c & 0xffff;
}

function MXDRV_PCM8Enable(context, sw) {
  ensureContext(context);
  context.m_impl.m_MXWORK_PCM8 = sw ? 1 : 0;
}

function MXDRV_GetPCM8Enable(context) {
  ensureContext(context);
  return context.m_impl.m_MXWORK_PCM8 ? 1 : 0;
}

function MXDRV_SetData2(context, mdx, mdxsize, pdx, pdxsize) {
  ensureContext(context);
  requireUint8Array(mdx, 'mdx');
  if (pdx != null) requireUint8Array(pdx, 'pdx');

  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  if (impl.m_pdxReservedMemoryPoolSize !== 0) {
    MxdrvContextImpl_ReleaseMemory(impl, impl.m_pdxReservedMemoryPoolSize);
    impl.m_pdxReservedMemoryPoolSize = 0;
  }
  if (impl.m_mdxReservedMemoryPoolSize !== 0) {
    MxdrvContextImpl_ReleaseMemory(impl, impl.m_mdxReservedMemoryPoolSize);
    impl.m_mdxReservedMemoryPoolSize = 0;
  }

  const mdxRegion = MxdrvContextImpl_ReserveMemory(impl, mdxsize >>> 0);
  if (!mdxRegion) return MXDRV_ERR_MEMORY;
  impl.m_mdxReservedMemoryPoolSize = mdxsize >>> 0;
  if ((mdxsize >>> 0) > 0) {
    mdxRegion.view.set(mdx.subarray(0, mdxsize >>> 0));
  }

  const pdxRegion = MxdrvContextImpl_ReserveMemory(impl, pdxsize >>> 0);
  if (!pdxRegion) return MXDRV_ERR_MEMORY;
  impl.m_pdxReservedMemoryPoolSize = pdxsize >>> 0;
  if (pdx && (pdxsize >>> 0) > 0) {
    pdxRegion.view.set(pdx.subarray(0, pdxsize >>> 0));
  }

  const reg = {
    d0: 0x02,
    d1: mdxsize >>> 0,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 0,
    a0: 0,
    a1: mdxRegion.offset >>> 0,
    a2: 0,
    a3: 0,
    a4: 0,
    a5: 0,
    a6: 0,
    a7: 0,
  };
  MXDRV(context, reg);

  if (pdx) {
    reg.d0 = 0x03;
    reg.d1 = pdxsize >>> 0;
    reg.a1 = pdxRegion.offset >>> 0;
    MXDRV(context, reg);
  } else {
    G.L002231 = CLR;
  }

  return 0;
}

function MXDRV_Play(context, mdx, mdxsize, pdx, pdxsize) {
  const ret = MXDRV_SetData2(context, mdx, mdxsize, pdx, pdxsize);
  if (ret !== 0) return;
  MXDRV_Play2(context);
}

function MXDRV_Play2(context) {
  ensureContext(context);
  const reg = {
    d0: 0x0f,
    d1: 0x00,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 0,
    a0: 0,
    a1: 0,
    a2: 0,
    a3: 0,
    a4: 0,
    a5: 0,
    a6: 0,
    a7: 0,
  };
  MXDRV(context, reg);
}

function _mdx_setpdx(context, mdx, mdxsize, pdx, pdxsize) {
  return MXDRV_SetData2(context, mdx, mdxsize, pdx, pdxsize);
}

function _play(context) {
  ensureContext(context);
  const reg = {
    d0: 0x04,
    d1: 0x00,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 0,
    a0: 0,
    a1: 0,
    a2: 0,
    a3: 0,
    a4: 0,
    a5: 0,
    a6: 0,
    a7: 0,
  };
  MXDRV(context, reg);
}

function _stop(context) {
  ensureContext(context);
  const reg = {
    d0: 0x05,
    d1: 0x00,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 0,
    a0: 0,
    a1: 0,
    a2: 0,
    a3: 0,
    a4: 0,
    a5: 0,
    a6: 0,
    a7: 0,
  };
  MXDRV(context, reg);
}

function MXDRV_Replay(context) {
  MXDRV_Play2(context);
}

function MXDRV_Stop(context) {
  _stop(context);
}

function MXDRV_Pause(context) {
  ensureContext(context);
  const reg = {
    d0: 0x06,
    d1: 0x00,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 0,
    a0: 0,
    a1: 0,
    a2: 0,
    a3: 0,
    a4: 0,
    a5: 0,
    a6: 0,
    a7: 0,
  };
  MXDRV(context, reg);
}

function MXDRV_Cont(context) {
  ensureContext(context);
  const reg = {
    d0: 0x07,
    d1: 0x00,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 0,
    a0: 0,
    a1: 0,
    a2: 0,
    a3: 0,
    a4: 0,
    a5: 0,
    a6: 0,
    a7: 0,
  };
  MXDRV(context, reg);
}

function MXDRV_Fadeout2(context, speed) {
  ensureContext(context);
  const reg = {
    d0: 0x0c,
    d1: speed | 0,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 0,
    a0: 0,
    a1: 0,
    a2: 0,
    a3: 0,
    a4: 0,
    a5: 0,
    a6: 0,
    a7: 0,
  };
  MXDRV(context, reg);
}

function MXDRV_Fadeout(context) {
  MXDRV_Fadeout2(context, 19);
}

function MXDRV_MeasurePlayTime_OPMINT(context) {
  ensureContext(context);
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  if (G.PLAYTIME >= G.MEASURETIMELIMIT) {
    impl.m_TerminatePlay = true;
  }
  if (G.L001e13 !== 0) {
    impl.m_TerminatePlay = true;
  }
  if (G.L002246 === 0xffff) {
    impl.m_TerminatePlay = true;
  } else {
    impl.m_LoopCount = G.L002246 & 0xffff;
    if (!impl.m_FadeoutStart && impl.m_LoopCount >= impl.m_LoopLimit) {
      if (impl.m_ReqFadeout) {
        impl.m_FadeoutStart = true;
        MXDRV_Fadeout(context);
      } else {
        impl.m_TerminatePlay = true;
      }
    }
  }
}

function MXDRV_MeasurePlayTime2(context, loop, fadeout) {
  ensureContext(context);
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  X68Sound_OpmInt(impl.m_x68SoundContext, null, null);

  impl.m_MeasurePlayTime = true;
  impl.m_TerminatePlay = false;
  impl.m_LoopCount = 0;
  impl.m_LoopLimit = loop | 0;
  impl.m_FadeoutStart = false;
  impl.m_ReqFadeout = !!fadeout;

  const opmintBack = impl.m_MXCALLBACK_OPMINT;
  impl.m_MXCALLBACK_OPMINT = MXDRV_MeasurePlayTime_OPMINT;

  const reg = {
    d0: 0x0f,
    d1: 0xffffffff,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 0,
    a0: 0,
    a1: 0,
    a2: 0,
    a3: 0,
    a4: 0,
    a5: 0,
    a6: 0,
    a7: 0,
  };
  MXDRV(context, reg);

  while (!impl.m_TerminatePlay) {
    OPMINTFUNC(context);
  }

  MXDRV_Stop(context);

  impl.m_MXCALLBACK_OPMINT = opmintBack;
  impl.m_MeasurePlayTime = false;
  X68Sound_OpmInt(impl.m_x68SoundContext, OPMINTFUNC, context);

  const ret = Math.trunc((G.PLAYTIME * 1024) / 4000 + (1 - Number.EPSILON)) + 2000;
  G.PLAYTIME = 0;
  return ret >>> 0;
}

function MXDRV_MeasurePlayTime(context, mdx, mdxsize, pdx, pdxsize, loop, fadeout) {
  ensureContext(context);
  const ret = MXDRV_SetData2(context, mdx, mdxsize, pdx, pdxsize);
  if (ret !== 0) return 0;
  return MXDRV_MeasurePlayTime2(context, loop, fadeout);
}

function MXDRV_PlayAt(context, playat, loop, fadeout) {
  ensureContext(context);
  const impl = context.m_impl;
  const G = impl.m_MXWORK_GLOBALBUF;

  X68Sound_OpmInt(impl.m_x68SoundContext, null, null);

  impl.m_TerminatePlay = false;
  impl.m_LoopCount = 0;
  impl.m_LoopLimit = loop | 0;
  impl.m_FadeoutStart = false;
  impl.m_ReqFadeout = !!fadeout;

  L_PLAY(context);

  let targetPlayTime = Number.isFinite(playat) ? Math.max(0, playat | 0) : 0;
  targetPlayTime = Math.trunc((targetPlayTime * 4000) / 1024) >>> 0;

  const opmintBack = impl.m_MXCALLBACK_OPMINT;
  impl.m_MXCALLBACK_OPMINT = MXDRV_MeasurePlayTime_OPMINT;
  const channelMaskBack = G.L001e1c & 0xffff;

  const reg = {
    d0: 0x0f,
    d1: 0xffffffff,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 0,
    a0: 0,
    a1: 0,
    a2: 0,
    a3: 0,
    a4: 0,
    a5: 0,
    a6: 0,
    a7: 0,
  };
  MXDRV(context, reg);

  const opmWaitBack = X68Sound_OpmWait(impl.m_x68SoundContext, -1);
  X68Sound_OpmWait(impl.m_x68SoundContext, 1);
  while (G.PLAYTIME < targetPlayTime) {
    if (impl.m_TerminatePlay) break;
    OPMINTFUNC(context);
  }
  X68Sound_OpmWait(impl.m_x68SoundContext, opmWaitBack);

  G.L001e1c = channelMaskBack;
  impl.m_MXCALLBACK_OPMINT = opmintBack;
  X68Sound_OpmInt(impl.m_x68SoundContext, OPMINTFUNC, context);
}

function MXDRV_GetPlayAt(context) {
  ensureContext(context);
  const G = context.m_impl.m_MXWORK_GLOBALBUF;
  return Math.trunc((G.PLAYTIME * 1024) / 4000) >>> 0;
}

function MXDRV_GetTerminated(context) {
  ensureContext(context);
  const G = context.m_impl.m_MXWORK_GLOBALBUF;

  if (G.PLAYTIME >= G.MEASURETIMELIMIT) return 1;
  if (G.L001e13 !== 0) return 1;
  if (G.L002246 === 0xffff) return 1;
  return 0;
}

function MXDRV_GetWork(context, i) {
  ensureContext(context);
  const impl = context.m_impl;

  switch (i | 0) {
    case MXDRV_WORK_FM:
      return impl.m_MXWORK_CHBUF_FM;
    case MXDRV_WORK_PCM:
      return impl.m_MXWORK_CHBUF_PCM;
    case MXDRV_WORK_GLOBAL:
      return impl.m_MXWORK_GLOBALBUF;
    case MXDRV_WORK_KEY:
      return impl.m_MXWORK_KEYBUF;
    case MXDRV_WORK_OPM:
      return impl.m_MXWORK_OPMBUF;
    case MXDRV_WORK_PCM8:
      return impl.m_MXWORK_PCM8;
    case MXDRV_WORK_CREDIT:
      return MXWORK_CREDIT;
    case MXDRV_CALLBACK_OPMINT:
      return impl.m_MXCALLBACK_OPMINT;
    default:
      return null;
  }
}

export {
  MXWORK_CREDIT,
  MXDRV_WORK_FM,
  MXDRV_WORK_PCM,
  MXDRV_WORK_GLOBAL,
  MXDRV_WORK_KEY,
  MXDRV_WORK_OPM,
  MXDRV_WORK_PCM8,
  MXDRV_WORK_CREDIT,
  MXDRV_CALLBACK_OPMINT,
  MXDRV_ERR_MEMORY,
  MXDRV,
  MXDRV_Start,
  MXDRV_End,
  MXDRV_GetPCM,
  MXDRV_TotalVolume,
  MXDRV_GetTotalVolume,
  MXDRV_ChannelMask,
  MXDRV_GetChannelMask,
  MXDRV_PCM8Enable,
  MXDRV_GetPCM8Enable,
  MXDRV_SetData2,
  MXDRV_Play,
  MXDRV_Play2,
  MXDRV_MeasurePlayTime,
  MXDRV_MeasurePlayTime2,
  MXDRV_PlayAt,
  MXDRV_GetPlayAt,
  MXDRV_GetTerminated,
  MXDRV_Replay,
  MXDRV_Stop,
  MXDRV_Pause,
  MXDRV_Cont,
  MXDRV_Fadeout,
  MXDRV_Fadeout2,
  _mdx_setpdx,
  _play,
  _stop,
  MXDRV_GetWork,
};
