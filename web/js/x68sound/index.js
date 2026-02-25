import { X68SoundContext, MemReadDefault } from './context.js';
import { Pcm8Channel } from './pcm8.js';
import { Op } from './ops.js';
import { fillRateDependentTables } from './tables.js';
import { OPMLPF_COL, OPMLOWPASS_44, OPMLOWPASS_48 } from './opm_lowpass_tables.js';

const X68SNDERR_NOTACTIVE = -4;
const X68SNDERR_ALREADYACTIVE = -5;
const X68SNDERR_BADARG = -6;
const NO_DATA = -2147483648;
const MAX_PCM = 2047;
const ADPCM_RATE_BASE = 15625 * 12;
const OPM_CMNDBUF_SIZE = 65535;

const DLT_L_TABLE = Int32Array.from([
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
  73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
]);

const DCT = Int32Array.from([
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
]);

const ADPCM_RATE_TABLE = [
  [2, 3, 4, 4],
  [0, 1, 2, 2],
];

const ADPCM_RATE_ADD_TABLE = Int32Array.from([
  46875, 62500, 93750, 125000, ADPCM_RATE_BASE, ADPCM_RATE_BASE, ADPCM_RATE_BASE, 0,
]);

const DMA_MAR_STEP_TABLE = Int8Array.from([0, 1, -1, 1]);

const DMA_REG_INIT = Uint8Array.from([
  0x00, 0x00, 0xff, 0xff, 0x80, 0x32, 0x04, 0x08,
  0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0xff, 0x00, 0xe9, 0x20, 0x03,
  0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0xff, 0xff, 0x6a, 0xff, 0x6b,
  0xff, 0x05, 0xff, 0xff, 0xff, 0x01, 0xff, 0xff,
  0xff, 0x05, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0x05, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00,
]);

function ensureContext(context) {
  if (!(context instanceof X68SoundContext)) {
    throw new Error('context must be X68SoundContext');
  }
  if (!context.m_impl) {
    throw new Error('X68SoundContext is not initialized');
  }
  return context.m_impl;
}

function setError(impl, code) {
  impl.m_ErrorCode = code | 0;
  return impl.m_ErrorCode;
}

function isValidPositiveInt(value) {
  return Number.isFinite(value) && (value | 0) > 0;
}

function toInt(value, fallback) {
  if (!Number.isFinite(value)) return fallback | 0;
  return value | 0;
}

function ensurePcm8Channels(impl) {
  if (!Array.isArray(impl.m_pcm8Channels) || impl.m_pcm8Channels.length !== 8) {
    impl.m_pcm8Channels = [];
  }

  if (impl.m_pcm8Channels.length !== 8 || !(impl.m_pcm8Channels[0] instanceof Pcm8Channel)) {
    impl.m_pcm8Channels = Array.from({ length: 8 }, () => new Pcm8Channel(impl));
  }
  return impl.m_pcm8Channels;
}

function resetPcm8Channels(impl) {
  const channels = ensurePcm8Channels(impl);
  for (const channel of channels) {
    channel.init();
  }
}

function getPcm8Channel(impl, ch) {
  const channels = ensurePcm8Channels(impl);
  return channels[(ch | 0) & (channels.length - 1)];
}

function makeArrayRef(array, index) {
  return {
    get value() {
      return array[index] | 0;
    },
    set value(v) {
      array[index] = v | 0;
    },
  };
}

function makeOpInputRef(op) {
  return {
    get value() {
      return op.inp | 0;
    },
    set value(v) {
      op.inp = v | 0;
    },
  };
}

function ensureOpmEngine(impl) {
  if (Array.isArray(impl.m_opmOps) && impl.m_opmOps.length === 8) {
    return;
  }

  impl.m_opmOps = Array.from(
    { length: 8 },
    () => Array.from({ length: 4 }, () => new Op(impl)),
  );
  impl.m_opmOpOut = new Int32Array(8);
  impl.m_opmPanLeft = new Int32Array(8);
  impl.m_opmPanRight = new Int32Array(8);
  impl.m_opmOpOutDummy = { value: 0 };
  impl.m_opmOpOutRefs = Array.from({ length: 8 }, (_, ch) => makeArrayRef(impl.m_opmOpOut, ch));
  impl.m_opmOpInRefs = impl.m_opmOps.map((slots) => slots.map((op) => makeOpInputRef(op)));

  impl.m_opmSlotTable = new Int32Array(8 * 4);
  for (let slot = 0; slot < 8; slot++) {
    impl.m_opmSlotTable[slot] = slot * 4;
    impl.m_opmSlotTable[slot + 8] = slot * 4 + 2;
    impl.m_opmSlotTable[slot + 16] = slot * 4 + 1;
    impl.m_opmSlotTable[slot + 24] = slot * 4 + 3;
  }
}

function setOpmConnection(impl, ch, alg) {
  ensureOpmEngine(impl);

  const c = ch & 7;
  const a = alg & 7;
  const ops = impl.m_opmOps[c];
  const inRefs = impl.m_opmOpInRefs[c];
  const outRef = impl.m_opmOpOutRefs[c];
  const dummyRef = impl.m_opmOpOutDummy;

  switch (a) {
    case 0:
      ops[0].setOutputRefs(inRefs[1], dummyRef, dummyRef);
      ops[1].setOutputRefs(inRefs[2]);
      ops[2].setOutputRefs(inRefs[3]);
      ops[3].setOutputRefs(outRef);
      break;
    case 1:
      ops[0].setOutputRefs(inRefs[2], dummyRef, dummyRef);
      ops[1].setOutputRefs(inRefs[2]);
      ops[2].setOutputRefs(inRefs[3]);
      ops[3].setOutputRefs(outRef);
      break;
    case 2:
      ops[0].setOutputRefs(inRefs[3], dummyRef, dummyRef);
      ops[1].setOutputRefs(inRefs[2]);
      ops[2].setOutputRefs(inRefs[3]);
      ops[3].setOutputRefs(outRef);
      break;
    case 3:
      ops[0].setOutputRefs(inRefs[1], dummyRef, dummyRef);
      ops[1].setOutputRefs(inRefs[3]);
      ops[2].setOutputRefs(inRefs[3]);
      ops[3].setOutputRefs(outRef);
      break;
    case 4:
      ops[0].setOutputRefs(inRefs[1], dummyRef, dummyRef);
      ops[1].setOutputRefs(outRef);
      ops[2].setOutputRefs(inRefs[3]);
      ops[3].setOutputRefs(outRef);
      break;
    case 5:
      ops[0].setOutputRefs(inRefs[1], inRefs[2], inRefs[3]);
      ops[1].setOutputRefs(outRef);
      ops[2].setOutputRefs(outRef);
      ops[3].setOutputRefs(outRef);
      break;
    case 6:
      ops[0].setOutputRefs(inRefs[1], dummyRef, dummyRef);
      ops[1].setOutputRefs(outRef);
      ops[2].setOutputRefs(outRef);
      ops[3].setOutputRefs(outRef);
      break;
    case 7:
      ops[0].setOutputRefs(outRef, dummyRef, dummyRef);
      ops[1].setOutputRefs(outRef);
      ops[2].setOutputRefs(outRef);
      ops[3].setOutputRefs(outRef);
      break;
    default:
      break;
  }
}

function clearOpmRateState(impl) {
  impl.m_opmEnvCounter1 = 0;
  impl.m_opmEnvCounter2 = 3;
  impl.m_opmRateForPcmset = 0;
  impl.m_opmOpOut.fill(0);
  impl.m_opmHpfInpPrev0 = 0;
  impl.m_opmHpfInpPrev1 = 0;
  impl.m_opmHpfOut0 = 0;
  impl.m_opmHpfOut1 = 0;
  impl.m_opmInpInp0 = 0;
  impl.m_opmInpInp1 = 0;
  impl.m_opmInpOpm0 = 0;
  impl.m_opmInpOpm1 = 0;
  impl.m_opmInpInpPrev0 = 0;
  impl.m_opmInpInpPrev1 = 0;
  impl.m_opmInpInpPrev20 = 0;
  impl.m_opmInpInpPrev21 = 0;
  impl.m_opmInpOpmPrev0 = 0;
  impl.m_opmInpOpmPrev1 = 0;
  impl.m_opmInpOpmPrev20 = 0;
  impl.m_opmInpOpmPrev21 = 0;
  impl.m_pcmset22Rate2 = 0;
  impl.m_outInpAdpcm0 = 0;
  impl.m_outInpAdpcm1 = 0;
  impl.m_outInpAdpcmPrev0 = 0;
  impl.m_outInpAdpcmPrev1 = 0;
  impl.m_outInpAdpcmPrev20 = 0;
  impl.m_outInpAdpcmPrev21 = 0;
  impl.m_outOutAdpcmPrev0 = 0;
  impl.m_outOutAdpcmPrev1 = 0;
  impl.m_outOutAdpcmPrev20 = 0;
  impl.m_outOutAdpcmPrev21 = 0;
  impl.m_outInpOutAdpcmPrev0 = 0;
  impl.m_outInpOutAdpcmPrev1 = 0;
  impl.m_outInpOutAdpcmPrev20 = 0;
  impl.m_outInpOutAdpcmPrev21 = 0;
  impl.m_outOutInpAdpcmPrev0 = 0;
  impl.m_outOutInpAdpcmPrev1 = 0;
  impl.m_OpmLPFidx = 0;
  impl.m_OpmLPFRowIndex = 0;
  impl.m_InpOpmIdx = 0;

  ensureOpmFirState(impl);
  impl.m_InpOpmBuf0.fill(0);
  impl.m_InpOpmBuf1.fill(0);
}

function ensureOpmFirState(impl) {
  const col = Math.max(1, (impl.m_OPMLPF_COL | 0) || OPMLPF_COL);
  const expectedLen = col * 2;

  if (!(impl.m_InpOpmBuf0 instanceof Int16Array) || impl.m_InpOpmBuf0.length !== expectedLen) {
    impl.m_InpOpmBuf0 = new Int16Array(expectedLen);
  }
  if (!(impl.m_InpOpmBuf1 instanceof Int16Array) || impl.m_InpOpmBuf1.length !== expectedLen) {
    impl.m_InpOpmBuf1 = new Int16Array(expectedLen);
  }

  if (!Number.isFinite(impl.m_InpOpmIdx)) {
    impl.m_InpOpmIdx = 0;
  }
  if (!Number.isFinite(impl.m_OpmLPFidx)) {
    impl.m_OpmLPFidx = 0;
  }
  if (!Number.isFinite(impl.m_OpmLPFRowIndex)) {
    impl.m_OpmLPFRowIndex = 0;
  }
}

function resetOpmEngine(impl) {
  ensureOpmEngine(impl);

  for (let ch = 0; ch < 8; ch++) {
    impl.m_opmPanLeft[ch] = 0;
    impl.m_opmPanRight[ch] = 0;
    for (let slot = 0; slot < 4; slot++) {
      impl.m_opmOps[ch][slot].Init();
    }
    setOpmConnection(impl, ch, 0);
  }

  impl.m_lfo.init();
  clearOpmRateState(impl);
}

function resetOpmEngineForRateChange(impl) {
  ensureOpmEngine(impl);
  for (let ch = 0; ch < 8; ch++) {
    for (let slot = 0; slot < 4; slot++) {
      impl.m_opmOps[ch][slot].InitSamprate();
    }
  }
  impl.m_lfo.initSamprate();
  clearOpmRateState(impl);
}

function slotToOperator(impl, slot) {
  const idx = slot & 31;
  const flat = impl.m_opmSlotTable[idx] | 0;
  return impl.m_opmOps[flat >> 2][flat & 3];
}

function applyQueuedOpmCommand(impl, regNo, data) {
  ensureOpmEngine(impl);

  const reg = regNo & 0xff;
  const value = data & 0xff;

  switch (reg) {
    case 0x01:
      if (value & 0x02) {
        impl.m_lfo.lfoReset();
      } else {
        impl.m_lfo.lfoStart();
      }
      return;
    case 0x08: {
      const ch = value & 7;
      let bit = 8;
      for (let slot = 0; slot < 4; slot++, bit <<= 1) {
        if (value & bit) {
          impl.m_opmOps[ch][slot].KeyON();
        } else {
          impl.m_opmOps[ch][slot].KeyOFF();
        }
      }
      return;
    }
    case 0x0f:
      impl.m_opmOps[7][3].SetNFRQ(value);
      return;
    case 0x18:
      impl.m_lfo.setLFRQ(value);
      return;
    case 0x19:
      impl.m_lfo.setPMDAMD(value);
      return;
    case 0x1b:
      impl.m_lfo.setWaveForm(value);
      return;
    default:
      break;
  }

  if (reg >= 0x20 && reg <= 0x27) {
    const ch = reg - 0x20;
    setOpmConnection(impl, ch, value & 7);
    impl.m_opmPanLeft[ch] = (value & 0x40) ? -1 : 0;
    impl.m_opmPanRight[ch] = (value & 0x80) ? -1 : 0;
    impl.m_opmOps[ch][0].SetFL(value);
    return;
  }

  if (reg >= 0x28 && reg <= 0x2f) {
    const ch = reg - 0x28;
    impl.m_opmOps[ch][0].SetKC(value);
    impl.m_opmOps[ch][1].SetKC(value);
    impl.m_opmOps[ch][2].SetKC(value);
    impl.m_opmOps[ch][3].SetKC(value);
    return;
  }

  if (reg >= 0x30 && reg <= 0x37) {
    const ch = reg - 0x30;
    impl.m_opmOps[ch][0].SetKF(value);
    impl.m_opmOps[ch][1].SetKF(value);
    impl.m_opmOps[ch][2].SetKF(value);
    impl.m_opmOps[ch][3].SetKF(value);
    return;
  }

  if (reg >= 0x38 && reg <= 0x3f) {
    impl.m_lfo.setPMSAMS(reg - 0x38, value);
    return;
  }

  if (reg >= 0x40 && reg <= 0x5f) {
    slotToOperator(impl, reg - 0x40).SetDT1MUL(value);
    return;
  }
  if (reg >= 0x60 && reg <= 0x7f) {
    slotToOperator(impl, reg - 0x60).SetTL(value);
    return;
  }
  if (reg >= 0x80 && reg <= 0x9f) {
    slotToOperator(impl, reg - 0x80).SetKSAR(value);
    return;
  }
  if (reg >= 0xa0 && reg <= 0xbf) {
    slotToOperator(impl, reg - 0xa0).SetAMED1R(value);
    return;
  }
  if (reg >= 0xc0 && reg <= 0xdf) {
    slotToOperator(impl, reg - 0xc0).SetDT2D2R(value);
    return;
  }
  if (reg >= 0xe0 && reg <= 0xff) {
    slotToOperator(impl, reg - 0xe0).SetD1LRR(value);
  }
}

function resetRuntimeHooks(impl) {
  impl.m_opmIntProc = null;
  impl.m_opmIntArg = null;
  impl.m_betwIntProc = null;
  impl.m_betwIntArg = null;
  impl.m_dmaIntProc = null;
  impl.m_dmaIntArg = null;
  impl.m_dmaErrIntProc = null;
  impl.m_dmaErrIntArg = null;
  impl.m_waveFunc = null;
  impl.m_waveArg = null;
  impl.m_MemRead = impl.m_defaultMemRead ?? MemReadDefault;
}

function applyNativeSampleRateProfile(impl, samprate) {
  const requested = Number.isFinite(samprate) ? (samprate | 0) : 0;
  if (requested === 44100) {
    impl.m_Samprate = 62500;
    impl.m_WaveOutSamp = 44100;
    impl.m_OPMLPF_ROW = impl.m_OPMLPF_ROW_44 ?? 441;
    impl.m_OPMLOWPASS = impl.m_OPMLOWPASS_44 ?? OPMLOWPASS_44;
    return;
  }
  if (requested === 48000) {
    impl.m_Samprate = 62500;
    impl.m_WaveOutSamp = 48000;
    impl.m_OPMLPF_ROW = impl.m_OPMLPF_ROW_48 ?? 96;
    impl.m_OPMLOWPASS = impl.m_OPMLOWPASS_48 ?? OPMLOWPASS_48;
    return;
  }
  impl.m_Samprate = 22050;
  impl.m_WaveOutSamp = 22050;
  impl.m_OPMLPF_ROW = impl.m_OPMLPF_ROW_44 ?? 441;
  impl.m_OPMLOWPASS = impl.m_OPMLOWPASS_44 ?? OPMLOWPASS_44;
}

function updateTiming(impl, betw, late, rev) {
  const currentBetw = Math.max(0, toInt(betw, impl.m_configBetw));
  const currentLate = Math.max(0, toInt(late, impl.m_configLate));
  let currentRev = Number.isFinite(rev) ? Number(rev) : Number(impl.m_configRev);
  if (!Number.isFinite(currentRev)) currentRev = 1.0;
  if (currentRev < 0.1) currentRev = 0.1;

  impl.m_configBetw = currentBetw;
  impl.m_configLate = currentLate;
  impl.m_configRev = currentRev;

  impl.m_Betw_Time = currentBetw;
  impl.m_TimerResolution = currentBetw;
  impl.m_Late_Time = currentLate + currentBetw;

  const rate = Math.max(1, impl.m_WaveOutSamp | 0);
  const baseSamples = (rate * currentBetw) / 1000.0;

  impl.m_Betw_Samples_Slower = Math.floor(baseSamples - currentRev) | 0;
  impl.m_Betw_Samples_Faster = Math.ceil(baseSamples + currentRev) | 0;
  impl.m_Betw_Samples_VerySlower = Math.trunc(Math.floor(baseSamples - currentRev) / 8.0) | 0;
  impl.m_Late_Samples = Math.max(0, Math.trunc((rate * impl.m_Late_Time) / 1000.0));
  impl.m_Blk_Samples = impl.m_Late_Samples | 0;

  let fasterLimit;
  if (impl.m_Late_Samples >= Math.trunc((rate * 175) / 1000.0)) {
    fasterLimit = impl.m_Late_Samples - Math.trunc((rate * 125) / 1000.0);
  } else {
    fasterLimit = Math.trunc((rate * 50) / 1000.0);
  }
  if (fasterLimit > impl.m_Late_Samples) fasterLimit = impl.m_Late_Samples;
  impl.m_Faster_Limit = fasterLimit | 0;

  let slowerLimit = impl.m_Faster_Limit | 0;
  if (slowerLimit > impl.m_Late_Samples) slowerLimit = impl.m_Late_Samples;
  impl.m_Slower_Limit = slowerLimit | 0;

  impl.m_nSamples = Math.max(0, impl.m_Betw_Samples_Faster | 0) >>> 0;
}

function clamp16(v) {
  if (v > 32767) return 32767;
  if (v < -32767) return -32767;
  return v | 0;
}

function clampSymmetric(v, limit) {
  const max = limit | 0;
  if (v > max) return max;
  if (v < -max) return -max;
  return v | 0;
}

function readDmaBE16(impl, ofs) {
  const o = ofs & 0x3f;
  return ((impl.m_dmaRegs[o] << 8) | impl.m_dmaRegs[(o + 1) & 0x3f]) >>> 0;
}

function writeDmaBE16(impl, ofs, value) {
  const o = ofs & 0x3f;
  const v = value >>> 0;
  impl.m_dmaRegs[o] = (v >>> 8) & 0xff;
  impl.m_dmaRegs[(o + 1) & 0x3f] = v & 0xff;
}

function readDmaBE32(impl, ofs) {
  const o = ofs & 0x3f;
  return (
    ((impl.m_dmaRegs[o] << 24) >>> 0) |
    (impl.m_dmaRegs[(o + 1) & 0x3f] << 16) |
    (impl.m_dmaRegs[(o + 2) & 0x3f] << 8) |
    impl.m_dmaRegs[(o + 3) & 0x3f]
  ) >>> 0;
}

function writeDmaBE32(impl, ofs, value) {
  const o = ofs & 0x3f;
  const v = value >>> 0;
  impl.m_dmaRegs[o] = (v >>> 24) & 0xff;
  impl.m_dmaRegs[(o + 1) & 0x3f] = (v >>> 16) & 0xff;
  impl.m_dmaRegs[(o + 2) & 0x3f] = (v >>> 8) & 0xff;
  impl.m_dmaRegs[(o + 3) & 0x3f] = v & 0xff;
}

function updateAdpcmRateFromRegs(impl) {
  const baseClock = impl.m_adpcmBaseClock & 1;
  const rateSel = (impl.m_ppiReg >>> 2) & 0x03;
  const idx = ADPCM_RATE_TABLE[baseClock][rateSel] & 0x07;
  impl.m_adpcmRate = ADPCM_RATE_ADD_TABLE[idx] | 0;
}

function resetAdpcmDecodeState(impl) {
  impl.m_adpcmScale = 0;
  impl.m_adpcmPcm = 0;
  impl.m_adpcmInpPcm = 0;
  impl.m_adpcmInpPcmPrev = 0;
  impl.m_adpcmOutPcm = 0;
  impl.m_adpcmOutInpPcm = 0;
  impl.m_adpcmOutInpPcmPrev = 0;
  impl.m_adpcmRateCounter = 0;
  impl.m_adpcmN1Data = 0;
  impl.m_adpcmN1DataFlag = 0;
}

function resetDmaRegs(impl) {
  impl.m_dmaRegs.set(DMA_REG_INIT);
  impl.m_dmaLastValue = 0;
}

function resetAdpcmState(impl) {
  impl.m_adpcmReg = 0xc7;
  impl.m_ppiReg = 0x0b;
  impl.m_adpcmBaseClock = 0;
  impl.m_adpcmFinishCounter = 3;
  resetAdpcmDecodeState(impl);
  resetDmaRegs(impl);
  updateAdpcmRateFromRegs(impl);
}

function resetOpmState(impl) {
  resetOpmEngine(impl);
  impl.m_opmStatus = 0;
  impl.m_opmRegSelect = 0;
  impl.m_opmRegisters.fill(0);
  impl.m_opmTimerAReg10 = 0;
  impl.m_opmTimerAReg11 = 0;
  impl.m_opmTimerA = 1024;
  impl.m_opmTimerACounter = 0;
  impl.m_opmTimerB = (256 - 0) << (10 - 6);
  impl.m_opmTimerBCounter = 0;
  impl.m_opmTimerReg = 0;
  impl.m_opmTimerStepRemainder = 0;
  impl.m_opmNumCmnd = 0;
  impl.m_opmCmndReadIdx = 0;
  impl.m_opmCmndWriteIdx = 0;
  impl.m_opmRateForExecuteCmnd = 0;
  recalcOpmCommandRate(impl);
}

function recalcOpmCommandRate(impl) {
  if ((impl.m_OpmWait | 0) !== 0) {
    let rate = Math.trunc((4096 * 160) / (impl.m_OpmWait | 0));
    if (rate === 0) rate = 1;
    impl.m_opmCmndRate = rate | 0;
  } else {
    impl.m_opmCmndRate = 4096 * OPM_CMNDBUF_SIZE;
  }
}

function enqueueOpmCommand(impl, reg, data) {
  if ((impl.m_opmNumCmnd | 0) >= OPM_CMNDBUF_SIZE) return;

  const idx = impl.m_opmCmndWriteIdx & OPM_CMNDBUF_SIZE;
  impl.m_opmCmndBufReg[idx] = reg & 0xff;
  impl.m_opmCmndBufData[idx] = data & 0xff;
  impl.m_opmCmndWriteIdx = (idx + 1) & OPM_CMNDBUF_SIZE;
  impl.m_opmNumCmnd = (impl.m_opmNumCmnd + 1) | 0;
}

function executeQueuedOpmCommandsTick(impl) {
  impl.m_opmRateForExecuteCmnd = (impl.m_opmRateForExecuteCmnd - (impl.m_opmCmndRate | 0)) | 0;
  while ((impl.m_opmRateForExecuteCmnd | 0) < 0) {
    impl.m_opmRateForExecuteCmnd = (impl.m_opmRateForExecuteCmnd + 4096) | 0;

    if ((impl.m_opmNumCmnd | 0) === 0) continue;

    const idx = impl.m_opmCmndReadIdx & OPM_CMNDBUF_SIZE;
    const reg = impl.m_opmCmndBufReg[idx] & 0xff;
    const data = impl.m_opmCmndBufData[idx] & 0xff;
    impl.m_opmCmndReadIdx = (idx + 1) & OPM_CMNDBUF_SIZE;
    impl.m_opmNumCmnd = (impl.m_opmNumCmnd - 1) | 0;
    applyQueuedOpmCommand(impl, reg, data);
  }
}

function stepOpmTimer(impl) {
  const timerReg = impl.m_opmTimerReg & 0x0f;
  const prevStatus = impl.m_opmStatus & 0x03;
  let flagSet = 0;

  if (timerReg & 0x01) {
    impl.m_opmTimerACounter = (impl.m_opmTimerACounter + 1) | 0;
    if (impl.m_opmTimerACounter >= (impl.m_opmTimerA | 0)) {
      flagSet |= (timerReg >>> 2) & 0x01;
      impl.m_opmTimerACounter = 0;
    }
  }

  if (timerReg & 0x02) {
    impl.m_opmTimerBCounter = (impl.m_opmTimerBCounter + 1) | 0;
    if (impl.m_opmTimerBCounter >= (impl.m_opmTimerB | 0)) {
      flagSet |= (timerReg >>> 2) & 0x02;
      impl.m_opmTimerBCounter = 0;
    }
  }

  if (flagSet !== 0) {
    impl.m_opmStatus = (impl.m_opmStatus | flagSet) & 0xff;
    if (prevStatus === 0 && impl.m_opmIntProc) {
      impl.m_opmIntProc(impl.m_opmIntArg);
    }
  }
}

function advanceOpmSynthesis(impl, rateBase) {
  ensureOpmEngine(impl);
  if (!(impl.m_opmLfoPitch instanceof Int32Array) || impl.m_opmLfoPitch.length !== 8) {
    impl.m_opmLfoPitch = new Int32Array(8);
    impl.m_opmLfoLevel = new Int32Array(8);
  }

  impl.m_opmRateForPcmset = (impl.m_opmRateForPcmset - (impl.m_OpmRate | 0)) | 0;
  while ((impl.m_opmRateForPcmset | 0) < 0) {
    impl.m_opmRateForPcmset = (impl.m_opmRateForPcmset + rateBase) | 0;
    stepOpmTimer(impl);
    executeQueuedOpmCommandsTick(impl);

    impl.m_opmEnvCounter2 = (impl.m_opmEnvCounter2 - 1) | 0;
    if ((impl.m_opmEnvCounter2 | 0) === 0) {
      impl.m_opmEnvCounter2 = 3;
      impl.m_opmEnvCounter1 = (impl.m_opmEnvCounter1 + 1) | 0;
      for (let slot = 0; slot < 32; slot++) {
        impl.m_opmOps[slot & 7][slot >> 3].Envelope(impl.m_opmEnvCounter1);
      }
    }
  }
}

function runOpmOperators(impl) {
  impl.m_lfo.update();

  const lfopitch = impl.m_opmLfoPitch;
  const lfolevel = impl.m_opmLfoLevel;
  for (let ch = 0; ch < 8; ch++) {
    impl.m_opmOps[ch][1].inp = 0;
    impl.m_opmOps[ch][2].inp = 0;
    impl.m_opmOps[ch][3].inp = 0;
    impl.m_opmOpOut[ch] = 0;
    lfopitch[ch] = impl.m_lfo.getPmValue(ch);
    lfolevel[ch] = impl.m_lfo.getAmValue(ch);
  }

  for (let ch = 0; ch < 8; ch++) {
    impl.m_opmOps[ch][0].Output0_22(lfopitch[ch], lfolevel[ch]);
  }
  for (let ch = 0; ch < 8; ch++) {
    impl.m_opmOps[ch][1].Output_22(lfopitch[ch], lfolevel[ch]);
  }
  for (let ch = 0; ch < 8; ch++) {
    impl.m_opmOps[ch][2].Output_22(lfopitch[ch], lfolevel[ch]);
  }
  for (let ch = 0; ch < 7; ch++) {
    impl.m_opmOps[ch][3].Output_22(lfopitch[ch], lfolevel[ch]);
  }
  impl.m_opmOps[7][3].Output32_22(lfopitch[7], lfolevel[7]);

  let inpInpL = 0;
  let inpInpR = 0;
  for (let ch = 0; ch < 8; ch++) {
    const o = impl.m_opmOpOut[ch] | 0;
    inpInpL += o & (impl.m_opmPanLeft[ch] | 0);
    inpInpR += o & (impl.m_opmPanRight[ch] | 0);
  }

  return [inpInpL | 0, inpInpR | 0];
}

function synthesizeOpmInputSample22(impl) {
  advanceOpmSynthesis(impl, 22050);
  let [inpInpL, inpInpR] = runOpmOperators(impl);

  inpInpL = (inpInpL & 0xfffffc00) >> 5;
  inpInpR = (inpInpR & 0xfffffc00) >> 5;

  inpInpL = (inpInpL + (inpInpL << 4) + inpInpL) | 0;
  inpInpR = (inpInpR + (inpInpR << 4) + inpInpR) | 0;

  const inpOpmL = (
    inpInpL
    + (impl.m_opmInpInpPrev0 | 0) + (impl.m_opmInpInpPrev0 | 0)
    + (impl.m_opmInpInpPrev20 | 0)
    + (impl.m_opmInpOpmPrev0 | 0) + (impl.m_opmInpOpmPrev0 | 0) + (impl.m_opmInpOpmPrev0 | 0)
    - ((impl.m_opmInpOpmPrev20 | 0) * 11)
  ) >> 6;
  const inpOpmR = (
    inpInpR
    + (impl.m_opmInpInpPrev1 | 0) + (impl.m_opmInpInpPrev1 | 0)
    + (impl.m_opmInpInpPrev21 | 0)
    + (impl.m_opmInpOpmPrev1 | 0) + (impl.m_opmInpOpmPrev1 | 0) + (impl.m_opmInpOpmPrev1 | 0)
    - ((impl.m_opmInpOpmPrev21 | 0) * 11)
  ) >> 6;

  impl.m_opmInpInpPrev20 = impl.m_opmInpInpPrev0 | 0;
  impl.m_opmInpInpPrev21 = impl.m_opmInpInpPrev1 | 0;
  impl.m_opmInpInpPrev0 = inpInpL | 0;
  impl.m_opmInpInpPrev1 = inpInpR | 0;
  impl.m_opmInpOpmPrev20 = impl.m_opmInpOpmPrev0 | 0;
  impl.m_opmInpOpmPrev21 = impl.m_opmInpOpmPrev1 | 0;
  impl.m_opmInpOpmPrev0 = inpOpmL | 0;
  impl.m_opmInpOpmPrev1 = inpOpmR | 0;
  impl.m_opmInpOpm0 = inpOpmL | 0;
  impl.m_opmInpOpm1 = inpOpmR | 0;

  return [inpOpmL | 0, inpOpmR | 0];
}

function synthesizeOpmInputSample62(impl) {
  advanceOpmSynthesis(impl, 62500);
  const [sumL, sumR] = runOpmOperators(impl);

  const hpfInpL = ((sumL & 0xfffffc00) << 4) | 0;
  const hpfInpR = ((sumR & 0xfffffc00) << 4) | 0;

  const hpfOutL = (
    hpfInpL
    - (impl.m_opmHpfInpPrev0 | 0)
    + (impl.m_opmHpfOut0 | 0)
    - ((impl.m_opmHpfOut0 | 0) >> 10)
    - ((impl.m_opmHpfOut0 | 0) >> 12)
  ) | 0;
  const hpfOutR = (
    hpfInpR
    - (impl.m_opmHpfInpPrev1 | 0)
    + (impl.m_opmHpfOut1 | 0)
    - ((impl.m_opmHpfOut1 | 0) >> 10)
    - ((impl.m_opmHpfOut1 | 0) >> 12)
  ) | 0;

  impl.m_opmHpfInpPrev0 = hpfInpL | 0;
  impl.m_opmHpfInpPrev1 = hpfInpR | 0;
  impl.m_opmHpfOut0 = hpfOutL | 0;
  impl.m_opmHpfOut1 = hpfOutR | 0;

  const inpInpL = ((hpfOutL >> (4 + 5)) * 29) | 0;
  const inpInpR = ((hpfOutR >> (4 + 5)) * 29) | 0;

  const inpOpmL = (
    inpInpL
    + (impl.m_opmInpInpPrev0 | 0)
    + ((impl.m_opmInpOpm0 | 0) * 70)
  ) >> 7;
  const inpOpmR = (
    inpInpR
    + (impl.m_opmInpInpPrev1 | 0)
    + ((impl.m_opmInpOpm1 | 0) * 70)
  ) >> 7;

  impl.m_opmInpInpPrev0 = inpInpL | 0;
  impl.m_opmInpInpPrev1 = inpInpR | 0;
  impl.m_opmInpOpm0 = inpOpmL | 0;
  impl.m_opmInpOpm1 = inpOpmR | 0;

  return [(inpOpmL >> 5) | 0, (inpOpmR >> 5) | 0];
}

function pushOpmFirInput(impl, left, right) {
  ensureOpmFirState(impl);
  const col = Math.max(1, (impl.m_OPMLPF_COL | 0) || OPMLPF_COL);
  const sampleL = clamp16(left | 0);
  const sampleR = clamp16(right | 0);

  let idx = (impl.m_InpOpmIdx | 0) - 1;
  if (idx < 0) idx = col - 1;
  impl.m_InpOpmIdx = idx;

  impl.m_InpOpmBuf0[idx] = sampleL;
  impl.m_InpOpmBuf0[idx + col] = sampleL;
  impl.m_InpOpmBuf1[idx] = sampleR;
  impl.m_InpOpmBuf1[idx + col] = sampleR;
}

function applyOpmFir(impl) {
  ensureOpmFirState(impl);

  const col = Math.max(1, (impl.m_OPMLPF_COL | 0) || OPMLPF_COL);
  const taps = (impl.m_OPMLOWPASS instanceof Int16Array)
    ? impl.m_OPMLOWPASS
    : (impl.m_OPMLOWPASS_44 ?? OPMLOWPASS_44);

  let rowCount = (impl.m_OPMLPF_ROW | 0);
  const maxRows = Math.trunc(taps.length / col);
  if (rowCount <= 0 || rowCount > maxRows) rowCount = maxRows;

  let rowIndex = impl.m_OpmLPFRowIndex | 0;
  if (rowIndex < 0 || rowIndex >= rowCount) rowIndex = 0;

  const base = rowIndex * col;
  const idx = impl.m_InpOpmIdx | 0;
  const buf0 = impl.m_InpOpmBuf0;
  const buf1 = impl.m_InpOpmBuf1;

  let outL = 0;
  let outR = 0;
  for (let i = 0; i < col; i++) {
    const coeff = taps[base + i] | 0;
    outL += (buf0[idx + i] | 0) * coeff;
    outR += (buf1[idx + i] | 0) * coeff;
  }

  impl.m_OpmLPFRowIndex = (rowIndex + 1) % rowCount;
  return [(outL >> 15) | 0, (outR >> 15) | 0];
}

function mixAdpcmPcm8For62(impl, channels) {
  let outInpAdpcmL = 0;
  let outInpAdpcmR = 0;

  const adpcm = adpcmGetPcm62Sample(impl);
  if (adpcm !== NO_DATA) {
    outInpAdpcmL += ((((impl.m_ppiReg | 0) >> 1) & 1) - 1) & adpcm;
    outInpAdpcmR += (((impl.m_ppiReg | 0) & 1) - 1) & adpcm;
  }

  for (const channel of channels) {
    const sample = channel.getPcm62();
    if (sample === NO_DATA) continue;
    const pan = channel.getMode() | 0;
    outInpAdpcmL += (-(pan & 1)) & sample;
    outInpAdpcmR += (-((pan >> 1) & 1)) & sample;
  }

  outInpAdpcmL = clampSymmetric(outInpAdpcmL, (1 << (15 + 4)) - 1);
  outInpAdpcmR = clampSymmetric(outInpAdpcmR, (1 << (15 + 4)) - 1);

  outInpAdpcmL = (outInpAdpcmL * 26) | 0;
  outInpAdpcmR = (outInpAdpcmR * 26) | 0;

  const outInpOutAdpcmL = (
    outInpAdpcmL
    + (impl.m_outInpAdpcmPrev0 | 0) + (impl.m_outInpAdpcmPrev0 | 0)
    + (impl.m_outInpAdpcmPrev20 | 0)
    + ((impl.m_outInpOutAdpcmPrev0 | 0) * 1537)
    - ((impl.m_outInpOutAdpcmPrev20 | 0) * 617)
  ) >> 10;
  const outInpOutAdpcmR = (
    outInpAdpcmR
    + (impl.m_outInpAdpcmPrev1 | 0) + (impl.m_outInpAdpcmPrev1 | 0)
    + (impl.m_outInpAdpcmPrev21 | 0)
    + ((impl.m_outInpOutAdpcmPrev1 | 0) * 1537)
    - ((impl.m_outInpOutAdpcmPrev21 | 0) * 617)
  ) >> 10;

  impl.m_outInpAdpcmPrev20 = impl.m_outInpAdpcmPrev0 | 0;
  impl.m_outInpAdpcmPrev21 = impl.m_outInpAdpcmPrev1 | 0;
  impl.m_outInpAdpcmPrev0 = outInpAdpcmL | 0;
  impl.m_outInpAdpcmPrev1 = outInpAdpcmR | 0;
  impl.m_outInpOutAdpcmPrev20 = impl.m_outInpOutAdpcmPrev0 | 0;
  impl.m_outInpOutAdpcmPrev21 = impl.m_outInpOutAdpcmPrev1 | 0;
  impl.m_outInpOutAdpcmPrev0 = outInpOutAdpcmL | 0;
  impl.m_outInpOutAdpcmPrev1 = outInpOutAdpcmR | 0;

  const outOutInpAdpcmL = (outInpOutAdpcmL * 356) | 0;
  const outOutInpAdpcmR = (outInpOutAdpcmR * 356) | 0;

  const outOutAdpcmL = (
    outOutInpAdpcmL
    + (impl.m_outOutInpAdpcmPrev0 | 0)
    + ((impl.m_outOutAdpcmPrev0 | 0) * 312)
  ) >> 10;
  const outOutAdpcmR = (
    outOutInpAdpcmR
    + (impl.m_outOutInpAdpcmPrev1 | 0)
    + ((impl.m_outOutAdpcmPrev1 | 0) * 312)
  ) >> 10;

  impl.m_outOutInpAdpcmPrev0 = outOutInpAdpcmL | 0;
  impl.m_outOutInpAdpcmPrev1 = outOutInpAdpcmR | 0;
  impl.m_outOutAdpcmPrev0 = outOutAdpcmL | 0;
  impl.m_outOutAdpcmPrev1 = outOutAdpcmR | 0;

  return [
    (outOutAdpcmL * 506) >> (4 + 9),
    (outOutAdpcmR * 506) >> (4 + 9),
  ];
}

function renderSample62(impl, channels) {
  let outL = 0;
  let outR = 0;

  impl.m_OpmLPFidx = (impl.m_OpmLPFidx + (impl.m_Samprate | 0)) | 0;
  while ((impl.m_OpmLPFidx | 0) >= (impl.m_WaveOutSamp | 0)) {
    impl.m_OpmLPFidx = (impl.m_OpmLPFidx - (impl.m_WaveOutSamp | 0)) | 0;

    let inL = 0;
    let inR = 0;
    if (impl.m_useOpm) {
      [inL, inR] = synthesizeOpmInputSample62(impl);
    }
    if (impl.m_useAdpcm) {
      const [adpcmL, adpcmR] = mixAdpcmPcm8For62(impl, channels);
      inL = (inL + adpcmL) | 0;
      inR = (inR + adpcmR) | 0;
    }

    inL = clampSymmetric(inL, (1 << 15) - 1);
    inR = clampSymmetric(inR, (1 << 15) - 1);
    pushOpmFirInput(impl, inL, inR);
  }

  let [firL, firR] = applyOpmFir(impl);
  firL = ((firL * (impl.m_TotalVolume | 0)) >> 8) | 0;
  firR = ((firR * (impl.m_TotalVolume | 0)) >> 8) | 0;
  outL -= firL;
  outR -= firR;

  if (impl.m_waveFunc) {
    const waveOut = impl.m_waveFunc(impl.m_waveArg);
    if (Number.isFinite(waveOut)) {
      const ret = waveOut | 0;
      outL += (ret << 16) >> 16;
      outR += ret >> 16;
    }
  }

  return [clamp16(outL), clamp16(outR)];
}

function mixAdpcmPcm8For22(impl, channels) {
  impl.m_pcmset22Rate2 = (impl.m_pcmset22Rate2 - 15625) | 0;
  if ((impl.m_pcmset22Rate2 | 0) < 0) {
    impl.m_pcmset22Rate2 = (impl.m_pcmset22Rate2 + 22050) | 0;

    let outInpAdpcmL = 0;
    let outInpAdpcmR = 0;
    const adpcm = adpcmGetPcm22Sample(impl);
    if (adpcm !== NO_DATA) {
      outInpAdpcmL += ((((impl.m_ppiReg | 0) >> 1) & 1) - 1) & adpcm;
      outInpAdpcmR += (((impl.m_ppiReg | 0) & 1) - 1) & adpcm;
    }

    for (const channel of channels) {
      const sample = channel.getPcm();
      if (sample === NO_DATA) continue;
      const pan = channel.getMode() | 0;
      outInpAdpcmL += (-(pan & 1)) & sample;
      outInpAdpcmR += (-((pan >> 1) & 1)) & sample;
    }

    outInpAdpcmL = clampSymmetric(outInpAdpcmL, (1 << 19) - 1);
    outInpAdpcmR = clampSymmetric(outInpAdpcmR, (1 << 19) - 1);
    impl.m_outInpAdpcm0 = (outInpAdpcmL * 40) | 0;
    impl.m_outInpAdpcm1 = (outInpAdpcmR * 40) | 0;
  }

  const outOutAdpcmL = (
    (impl.m_outInpAdpcm0 | 0)
    + (impl.m_outInpAdpcmPrev0 | 0) + (impl.m_outInpAdpcmPrev0 | 0)
    + (impl.m_outInpAdpcmPrev20 | 0)
    + ((impl.m_outOutAdpcmPrev0 | 0) * 157)
    - ((impl.m_outOutAdpcmPrev20 | 0) * 61)
  ) >> 8;
  const outOutAdpcmR = (
    (impl.m_outInpAdpcm1 | 0)
    + (impl.m_outInpAdpcmPrev1 | 0) + (impl.m_outInpAdpcmPrev1 | 0)
    + (impl.m_outInpAdpcmPrev21 | 0)
    + ((impl.m_outOutAdpcmPrev1 | 0) * 157)
    - ((impl.m_outOutAdpcmPrev21 | 0) * 61)
  ) >> 8;

  impl.m_outInpAdpcmPrev20 = impl.m_outInpAdpcmPrev0 | 0;
  impl.m_outInpAdpcmPrev21 = impl.m_outInpAdpcmPrev1 | 0;
  impl.m_outInpAdpcmPrev0 = impl.m_outInpAdpcm0 | 0;
  impl.m_outInpAdpcmPrev1 = impl.m_outInpAdpcm1 | 0;
  impl.m_outOutAdpcmPrev20 = impl.m_outOutAdpcmPrev0 | 0;
  impl.m_outOutAdpcmPrev21 = impl.m_outOutAdpcmPrev1 | 0;
  impl.m_outOutAdpcmPrev0 = outOutAdpcmL | 0;
  impl.m_outOutAdpcmPrev1 = outOutAdpcmR | 0;

  return [outOutAdpcmL >> 4, outOutAdpcmR >> 4];
}

function renderSample22(impl, channels) {
  let outL = 0;
  let outR = 0;

  if (impl.m_useOpm) {
    const [inpOpmL, inpOpmR] = synthesizeOpmInputSample22(impl);
    const outOpmL = ((inpOpmL * (impl.m_TotalVolume | 0)) >> 8) | 0;
    const outOpmR = ((inpOpmR * (impl.m_TotalVolume | 0)) >> 8) | 0;
    outL -= outOpmL >> 5;
    outR -= outOpmR >> 5;
  }

  if (impl.m_useAdpcm) {
    const [adpcmL, adpcmR] = mixAdpcmPcm8For22(impl, channels);
    outL -= adpcmL;
    outR -= adpcmR;
  }

  if (impl.m_waveFunc) {
    const waveOut = impl.m_waveFunc(impl.m_waveArg);
    if (Number.isFinite(waveOut)) {
      const ret = waveOut | 0;
      outL += (ret << 16) >> 16;
      outR += ret >> 16;
    }
  }

  return [clamp16(outL), clamp16(outR)];
}

function dmaError(impl, errCode) {
  impl.m_dmaRegs[0x00] &= 0xf7;
  impl.m_dmaRegs[0x00] |= 0x90;
  impl.m_dmaRegs[0x01] = errCode & 0xff;
  if ((impl.m_dmaRegs[0x07] & 0x08) && impl.m_dmaErrIntProc) {
    impl.m_dmaErrIntProc(impl.m_dmaErrIntArg);
  }
}

function dmaFinish(impl) {
  impl.m_dmaRegs[0x00] &= 0xf7;
  impl.m_dmaRegs[0x00] |= 0x80;
  if ((impl.m_dmaRegs[0x07] & 0x08) && impl.m_dmaIntProc) {
    impl.m_dmaIntProc(impl.m_dmaIntArg);
  }
}

function dmaContinueSetNextMtcMar(impl) {
  impl.m_dmaRegs[0x07] &= 0xff - 0x40;
  writeDmaBE16(impl, 0x0a, readDmaBE16(impl, 0x1a));
  writeDmaBE32(impl, 0x0c, readDmaBE32(impl, 0x1c));
  impl.m_dmaRegs[0x29] = impl.m_dmaRegs[0x39];

  if (readDmaBE16(impl, 0x0a) === 0) {
    dmaError(impl, 0x0d);
    return true;
  }
  impl.m_dmaRegs[0x00] |= 0x40;
  if ((impl.m_dmaRegs[0x07] & 0x08) && impl.m_dmaIntProc) {
    impl.m_dmaIntProc(impl.m_dmaIntArg);
  }
  return false;
}

function dmaArrayChainSetNextMtcMar(impl) {
  let btc = readDmaBE16(impl, 0x1a);
  if (btc === 0) {
    dmaFinish(impl);
    impl.m_adpcmFinishCounter = 0;
    return true;
  }
  btc = (btc - 1) & 0xffff;
  writeDmaBE16(impl, 0x1a, btc);

  let bar = readDmaBE32(impl, 0x1c);
  const mem = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    const value = impl.m_MemRead((bar + i) >>> 0);
    if (!Number.isFinite(value) || (value | 0) === -1) {
      dmaError(impl, 0x0b);
      return true;
    }
    mem[i] = value & 0xff;
  }

  bar = (bar + 6) >>> 0;
  writeDmaBE32(impl, 0x1c, bar);
  impl.m_dmaRegs[0x0c] = mem[0];
  impl.m_dmaRegs[0x0d] = mem[1];
  impl.m_dmaRegs[0x0e] = mem[2];
  impl.m_dmaRegs[0x0f] = mem[3];
  impl.m_dmaRegs[0x0a] = mem[4];
  impl.m_dmaRegs[0x0b] = mem[5];

  if (readDmaBE16(impl, 0x0a) === 0) {
    dmaError(impl, 0x0d);
    return true;
  }
  return false;
}

function dmaLinkArrayChainSetNextMtcMar(impl) {
  const bar = readDmaBE32(impl, 0x1c);
  if (bar === 0) {
    dmaFinish(impl);
    impl.m_adpcmFinishCounter = 0;
    return true;
  }

  const mem = new Uint8Array(10);
  for (let i = 0; i < 10; i++) {
    const value = impl.m_MemRead((bar + i) >>> 0);
    if (!Number.isFinite(value) || (value | 0) === -1) {
      dmaError(impl, 0x0b);
      return true;
    }
    mem[i] = value & 0xff;
  }

  impl.m_dmaRegs[0x0c] = mem[0];
  impl.m_dmaRegs[0x0d] = mem[1];
  impl.m_dmaRegs[0x0e] = mem[2];
  impl.m_dmaRegs[0x0f] = mem[3];
  impl.m_dmaRegs[0x0a] = mem[4];
  impl.m_dmaRegs[0x0b] = mem[5];
  impl.m_dmaRegs[0x1c] = mem[6];
  impl.m_dmaRegs[0x1d] = mem[7];
  impl.m_dmaRegs[0x1e] = mem[8];
  impl.m_dmaRegs[0x1f] = mem[9];

  if (readDmaBE16(impl, 0x0a) === 0) {
    dmaError(impl, 0x0d);
    return true;
  }
  return false;
}

function dmaGetByte(impl) {
  if ((impl.m_dmaRegs[0x00] & 0x08) === 0 || (impl.m_dmaRegs[0x07] & 0x20) !== 0) {
    return NO_DATA;
  }

  let mtc = readDmaBE16(impl, 0x0a);
  if (mtc === 0) {
    return NO_DATA;
  }

  const mar = readDmaBE32(impl, 0x0c);
  const mem = impl.m_MemRead(mar);
  if (!Number.isFinite(mem) || (mem | 0) === -1) {
    dmaError(impl, 0x09);
    return NO_DATA;
  }

  impl.m_dmaLastValue = mem & 0xff;
  const marStep = DMA_MAR_STEP_TABLE[(impl.m_dmaRegs[0x06] >>> 2) & 0x03] | 0;
  writeDmaBE32(impl, 0x0c, (mar + marStep) >>> 0);

  mtc = (mtc - 1) & 0xffff;
  writeDmaBE16(impl, 0x0a, mtc);

  if (mtc === 0) {
    if ((impl.m_dmaRegs[0x07] & 0x40) !== 0) {
      dmaContinueSetNextMtcMar(impl);
    } else if ((impl.m_dmaRegs[0x05] & 0x08) !== 0) {
      if ((impl.m_dmaRegs[0x05] & 0x04) === 0) {
        dmaArrayChainSetNextMtcMar(impl);
      } else {
        dmaLinkArrayChainSetNextMtcMar(impl);
      }
    } else {
      dmaFinish(impl);
      impl.m_adpcmFinishCounter = 0;
    }
  }

  return impl.m_dmaLastValue & 0xff;
}

function adpcmNibbleToPcm(impl, adpcmNibble) {
  const nibble = adpcmNibble & 0x0f;
  let delta = DLT_L_TABLE[impl.m_adpcmScale];
  delta = (delta & ((nibble & 0x04) ? -1 : 0))
    + ((delta >> 1) & ((nibble & 0x02) ? -1 : 0))
    + ((delta >> 2) & ((nibble & 0x01) ? -1 : 0))
    + (delta >> 3);
  const sign = (nibble & 0x08) ? -1 : 0;
  delta = (delta ^ sign) + (sign & 1);

  impl.m_adpcmPcm += delta;
  if ((impl.m_adpcmPcm + MAX_PCM) > (MAX_PCM * 2)) {
    impl.m_adpcmPcm = MAX_PCM;
  } else if ((impl.m_adpcmPcm + MAX_PCM) < 0) {
    impl.m_adpcmPcm = -MAX_PCM;
  }

  impl.m_adpcmInpPcm = (impl.m_adpcmPcm & 0xfffffffc) << 8;

  impl.m_adpcmScale += DCT[nibble];
  if (impl.m_adpcmScale > 48) {
    impl.m_adpcmScale = 48;
  } else if (impl.m_adpcmScale < 0) {
    impl.m_adpcmScale = 0;
  }
}

function adpcmGetPcm22Sample(impl) {
  if (impl.m_adpcmReg & 0x80) {
    return NO_DATA;
  }

  impl.m_adpcmRateCounter -= impl.m_adpcmRate;
  while (impl.m_adpcmRateCounter < 0) {
    if (impl.m_adpcmN1DataFlag === 0) {
      const packed = dmaGetByte(impl);
      if (packed === NO_DATA) {
        impl.m_adpcmRateCounter = 0;
        return NO_DATA;
      }
      adpcmNibbleToPcm(impl, packed & 0x0f);
      impl.m_adpcmN1Data = (packed >>> 4) & 0x0f;
      impl.m_adpcmN1DataFlag = 1;
    } else {
      adpcmNibbleToPcm(impl, impl.m_adpcmN1Data & 0x0f);
      impl.m_adpcmN1DataFlag = 0;
    }
    impl.m_adpcmRateCounter += ADPCM_RATE_BASE;
  }

  impl.m_adpcmOutPcm =
    ((impl.m_adpcmInpPcm << 9) - (impl.m_adpcmInpPcmPrev << 9) + 459 * impl.m_adpcmOutPcm) >> 9;
  impl.m_adpcmInpPcmPrev = impl.m_adpcmInpPcm;
  return (impl.m_adpcmOutPcm * (impl.m_TotalVolume | 0)) >> 8;
}

function adpcmGetPcm62Sample(impl) {
  if (impl.m_adpcmReg & 0x80) {
    return NO_DATA;
  }

  impl.m_adpcmRateCounter -= impl.m_adpcmRate;
  while (impl.m_adpcmRateCounter < 0) {
    if (impl.m_adpcmN1DataFlag === 0) {
      const packed = dmaGetByte(impl);
      if (packed === NO_DATA) {
        impl.m_adpcmRateCounter = 0;
        return NO_DATA;
      }
      adpcmNibbleToPcm(impl, packed & 0x0f);
      impl.m_adpcmN1Data = (packed >>> 4) & 0x0f;
      impl.m_adpcmN1DataFlag = 1;
    } else {
      adpcmNibbleToPcm(impl, impl.m_adpcmN1Data & 0x0f);
      impl.m_adpcmN1DataFlag = 0;
    }
    impl.m_adpcmRateCounter += ADPCM_RATE_BASE * 4;
  }

  impl.m_adpcmOutInpPcm = (
    (impl.m_adpcmInpPcm << 9)
    - (impl.m_adpcmInpPcmPrev << 9)
    + impl.m_adpcmOutInpPcm
    - (impl.m_adpcmOutInpPcm >> 5)
    - (impl.m_adpcmOutInpPcm >> 10)
  ) | 0;
  impl.m_adpcmInpPcmPrev = impl.m_adpcmInpPcm | 0;
  impl.m_adpcmOutPcm = (
    impl.m_adpcmOutInpPcm
    - impl.m_adpcmOutInpPcmPrev
    + impl.m_adpcmOutPcm
    - (impl.m_adpcmOutPcm >> 8)
    - (impl.m_adpcmOutPcm >> 9)
    - (impl.m_adpcmOutPcm >> 12)
  ) | 0;
  impl.m_adpcmOutInpPcmPrev = impl.m_adpcmOutInpPcm | 0;
  return (impl.m_adpcmOutPcm >> 9) | 0;
}

function writeSampleToBuffer(buf, frameIndex, frameCount, left, right) {
  if (!ArrayBuffer.isView(buf)) return;

  const l = clamp16(left);
  const r = clamp16(right);
  const interleaved = (buf.length ?? 0) >= (frameCount * 2);

  if (interleaved) {
    const i = frameIndex * 2;
    if (buf instanceof Float32Array) {
      buf[i] = l / 32768.0;
      buf[i + 1] = r / 32768.0;
    } else {
      buf[i] = l;
      buf[i + 1] = r;
    }
    return;
  }

  const mono = ((l + r) / 2) | 0;
  if (frameIndex < (buf.length ?? 0)) {
    if (buf instanceof Float32Array) {
      buf[frameIndex] = mono / 32768.0;
    } else {
      buf[frameIndex] = mono;
    }
  }
}

function X68Sound_OpmPeek(context) {
  const impl = ensureContext(context);
  return impl.m_opmStatus & 0xff;
}

function X68Sound_Start(context, samprate, opmflag, adpcmflag, betw, pcmbuf, late, rev) {
  const impl = ensureContext(context);
  if (impl.m_active) {
    return setError(impl, X68SNDERR_ALREADYACTIVE);
  }
  applyNativeSampleRateProfile(impl, samprate);
  impl.m_useOpm = !!opmflag;
  impl.m_useAdpcm = !!adpcmflag;
  impl.m_dousaMode = 1;
  fillRateDependentTables(impl);
  impl.m_TotalVolume = 256;
  impl.m_active = true;
  impl.m_ErrorCode = 0;
  resetRuntimeHooks(impl);
  resetOpmState(impl);
  resetAdpcmState(impl);
  resetPcm8Channels(impl);

  updateTiming(impl, betw, late, rev);
  impl.m_lastStart = {
    mode: 'start',
    opmflag: opmflag | 0,
    adpcmflag: adpcmflag | 0,
    betw: Number.isFinite(betw) ? (betw | 0) : 5,
    late: Number.isFinite(late) ? (late | 0) : 200,
    pcmbuf: pcmbuf | 0,
    rev: Number.isFinite(rev) ? Number(rev) : 1.0,
  };
  return 0;
}

function X68Sound_Samprate(context, samprate) {
  const impl = ensureContext(context);
  if (!impl.m_active) {
    return setError(impl, X68SNDERR_NOTACTIVE);
  }

  applyNativeSampleRateProfile(impl, samprate);
  fillRateDependentTables(impl);
  resetOpmEngineForRateChange(impl);
  impl.m_adpcmRateCounter = 0;
  updateTiming(impl, impl.m_configBetw, impl.m_configLate, impl.m_configRev);
  impl.m_ErrorCode = 0;
  return 0;
}

function X68Sound_OpmClock(context, clock) {
  const impl = ensureContext(context);
  const rate = (clock | 0) >> 6;
  if (rate <= 0) {
    return setError(impl, X68SNDERR_BADARG);
  }

  impl.m_OpmClock = clock | 0;
  impl.m_OpmRate = rate | 0;
  if (impl.m_active) {
    fillRateDependentTables(impl);
    resetOpmEngineForRateChange(impl);
    impl.m_adpcmRateCounter = 0;
    updateTiming(impl, impl.m_configBetw, impl.m_configLate, impl.m_configRev);
  }
  impl.m_ErrorCode = 0;
  return 0;
}

function X68Sound_Reset(context) {
  const impl = ensureContext(context);

  resetRuntimeHooks(impl);
  resetOpmState(impl);
  resetAdpcmState(impl);

  impl.m_waveblk = 0;
  impl.m_playingblk = 0;
  impl.m_playingblk_next = 1;
  impl.m_setPcmBufPtr = -1;
  impl.m_nSamples = 0;
  impl.m_TotalVolume = 256;

  resetPcm8Channels(impl);
  impl.m_ErrorCode = 0;
}

function X68Sound_Free(context) {
  const impl = ensureContext(context);
  impl.m_active = false;
  impl.m_dousaMode = 0;
  impl.m_useOpm = false;
  impl.m_useAdpcm = false;
  resetPcm8Channels(impl);
}

function X68Sound_BetwInt(context, proc, arg) {
  const impl = ensureContext(context);
  impl.m_betwIntProc = typeof proc === 'function' ? proc : null;
  impl.m_betwIntArg = impl.m_betwIntProc ? arg : null;
}

function X68Sound_StartPcm(context, samprate, opmflag, adpcmflag, pcmbuf) {
  const impl = ensureContext(context);
  if (impl.m_active) {
    return setError(impl, X68SNDERR_ALREADYACTIVE);
  }
  applyNativeSampleRateProfile(impl, samprate);
  impl.m_useOpm = !!opmflag;
  impl.m_useAdpcm = !!adpcmflag;
  impl.m_dousaMode = 2;
  fillRateDependentTables(impl);
  impl.m_TotalVolume = 256;
  impl.m_active = true;
  impl.m_ErrorCode = 0;
  resetRuntimeHooks(impl);
  resetOpmState(impl);
  resetAdpcmState(impl);
  resetPcm8Channels(impl);

  updateTiming(impl, 5, 200, 1.0);
  impl.m_lastStart = {
    mode: 'pcm',
    opmflag: opmflag | 0,
    adpcmflag: adpcmflag | 0,
    betw: 5,
    late: 200,
    pcmbuf: pcmbuf | 0,
    rev: 1.0,
  };
  return 0;
}

function X68Sound_GetPcm(context, buf, len) {
  const impl = ensureContext(context);
  if (!impl.m_active || (impl.m_dousaMode | 0) !== 2) {
    return setError(impl, X68SNDERR_NOTACTIVE);
  }

  const pcmLen = Math.max(0, len | 0);
  if (pcmLen > 0) {
    const channels = ensurePcm8Channels(impl);
    const usePcm62 = (impl.m_WaveOutSamp | 0) !== 22050;

    for (let i = 0; i < pcmLen; i++) {
      const [left, right] = usePcm62
        ? renderSample62(impl, channels)
        : renderSample22(impl, channels);
      writeSampleToBuffer(buf, i, pcmLen, left, right);
    }
  }

  if (impl.m_betwIntProc) {
    impl.m_betwIntProc(impl.m_betwIntArg);
  }

  impl.m_nSamples = pcmLen >>> 0;
  impl.m_ErrorCode = 0;
  return 0;
}

function X68Sound_OpmReg(context, no) {
  const impl = ensureContext(context);
  impl.m_opmRegSelect = no & 0xff;
}

function X68Sound_OpmPoke(context, data) {
  const impl = ensureContext(context);
  const reg = impl.m_opmRegSelect & 0xff;
  const value = data & 0xff;
  enqueueOpmCommand(impl, reg, value);
  impl.m_opmRegisters[reg] = value;

  switch (reg) {
    case 0x10:
      impl.m_opmTimerAReg10 = value & 0xff;
      impl.m_opmTimerA = 1024 - ((impl.m_opmTimerAReg10 << 2) + (impl.m_opmTimerAReg11 & 0x03));
      break;
    case 0x11:
      impl.m_opmTimerAReg11 = value & 0x03;
      impl.m_opmTimerA = 1024 - ((impl.m_opmTimerAReg10 << 2) + (impl.m_opmTimerAReg11 & 0x03));
      break;
    case 0x12:
      impl.m_opmTimerB = (256 - value) << (10 - 6);
      break;
    case 0x14:
      impl.m_opmTimerReg = value & 0x0f;
      impl.m_opmStatus &= (~((value >>> 4) & 0x03)) & 0xff;
      break;
    case 0x1b:
      impl.m_adpcmBaseClock = (value >>> 7) & 0x01;
      updateAdpcmRateFromRegs(impl);
      break;
    default:
      break;
  }
}

function X68Sound_OpmInt(context, proc, arg) {
  const impl = ensureContext(context);
  impl.m_opmIntProc = typeof proc === 'function' ? proc : null;
  impl.m_opmIntArg = impl.m_opmIntProc ? arg : null;
}

function X68Sound_OpmWait(context, wait) {
  const impl = ensureContext(context);
  if (!Number.isFinite(wait) || (wait | 0) === -1) {
    return impl.m_OpmWait | 0;
  }
  impl.m_OpmWait = wait | 0;
  recalcOpmCommandRate(impl);
  return impl.m_OpmWait | 0;
}

function X68Sound_DmaPeek(context, adrs) {
  const impl = ensureContext(context);
  const idx = adrs & 0x3f;
  if (idx === 0x00) {
    if ((impl.m_adpcmReg & 0x80) === 0) {
      impl.m_dmaRegs[0x00] |= 0x02;
      return (impl.m_dmaRegs[0x00] | 0x01) & 0xff;
    }
  }
  return impl.m_dmaRegs[idx] & 0xff;
}

function X68Sound_DmaPoke(context, adrs, data) {
  const impl = ensureContext(context);
  const idx = adrs & 0x3f;
  const value = data & 0xff;

  if (idx === 0x00) {
    const clearMask = value & 0xf6;
    impl.m_dmaRegs[idx] &= (~clearMask) & 0xff;
    if (clearMask & 0x10) {
      impl.m_dmaRegs[0x01] = 0;
    }
    return;
  }
  if (idx === 0x01) {
    return;
  }

  if (idx === 0x07) {
    impl.m_dmaRegs[0x07] = value & 0x78;

    if (value & 0x80) {
      if (impl.m_dmaRegs[0x00] & 0xf8) {
        dmaError(impl, 0x02);
        impl.m_dmaRegs[0x07] = value & 0x28;
        return;
      }
      impl.m_dmaRegs[0x00] |= 0x08;

      if (
        (impl.m_dmaRegs[0x04] & 0x08) ||
        (impl.m_dmaRegs[0x06] & 0x03) ||
        (readDmaBE32(impl, 0x14) !== 0x00e92003)
      ) {
        dmaError(impl, 0x0a);
        impl.m_dmaRegs[0x07] = value & 0x28;
        return;
      }

      const ocr = impl.m_dmaRegs[0x05] & 0xb0;
      if (ocr !== 0x00 && ocr !== 0x30) {
        dmaError(impl, 0x01);
        impl.m_dmaRegs[0x07] = value & 0x28;
        return;
      }
    }

    if (value & 0x40) {
      if ((impl.m_dmaRegs[0x00] & 0x48) !== 0x08) {
        dmaError(impl, 0x02);
        impl.m_dmaRegs[0x07] = value & 0x28;
        return;
      }
      if (impl.m_dmaRegs[0x05] & 0x08) {
        dmaError(impl, 0x01);
        impl.m_dmaRegs[0x07] = value & 0x28;
        return;
      }
    }

    if (value & 0x10) {
      if (impl.m_dmaRegs[0x00] & 0x08) {
        dmaError(impl, 0x11);
        impl.m_dmaRegs[0x07] = value & 0x28;
        return;
      }
    }

    if (value & 0x80) {
      const startValue = value & 0x7f;

      if (impl.m_dmaRegs[0x05] & 0x08) {
        if ((impl.m_dmaRegs[0x05] & 0x04) === 0) {
          if (dmaArrayChainSetNextMtcMar(impl)) {
            impl.m_dmaRegs[0x07] = startValue & 0x28;
            return;
          }
        } else if (dmaLinkArrayChainSetNextMtcMar(impl)) {
          impl.m_dmaRegs[0x07] = startValue & 0x28;
          return;
        }
      }

      if (readDmaBE16(impl, 0x0a) === 0) {
        dmaError(impl, 0x0d);
        impl.m_dmaRegs[0x07] = startValue & 0x28;
      }
    }
    return;
  }

  if (
    (idx === 0x04 || idx === 0x05 || idx === 0x06 || idx === 0x0a || idx === 0x0b
      || idx === 0x0c || idx === 0x0d || idx === 0x0e || idx === 0x0f
      || idx === 0x14 || idx === 0x15 || idx === 0x16 || idx === 0x17
      || idx === 0x29 || idx === 0x31) &&
    (impl.m_dmaRegs[0x00] & 0x08)
  ) {
    dmaError(impl, 0x02);
    return;
  }

  impl.m_dmaRegs[idx] = value;
}

function X68Sound_DmaInt(context, proc, arg) {
  const impl = ensureContext(context);
  impl.m_dmaIntProc = typeof proc === 'function' ? proc : null;
  impl.m_dmaIntArg = impl.m_dmaIntProc ? arg : null;
}

function X68Sound_DmaErrInt(context, proc, arg) {
  const impl = ensureContext(context);
  impl.m_dmaErrIntProc = typeof proc === 'function' ? proc : null;
  impl.m_dmaErrIntArg = impl.m_dmaErrIntProc ? arg : null;
}

function X68Sound_AdpcmPeek(context) {
  const impl = ensureContext(context);
  return impl.m_adpcmReg & 0xff;
}

function X68Sound_AdpcmPoke(context, data) {
  const impl = ensureContext(context);
  const value = data & 0xff;
  if (value & 0x02) {
    impl.m_adpcmReg &= 0x7f;
  } else if (value & 0x01) {
    impl.m_adpcmReg |= 0x80;
    resetAdpcmDecodeState(impl);
  }
}

function X68Sound_PpiPeek(context) {
  const impl = ensureContext(context);
  return impl.m_ppiReg & 0xff;
}

function X68Sound_PpiPoke(context, data) {
  const impl = ensureContext(context);
  impl.m_ppiReg = data & 0xff;
  updateAdpcmRateFromRegs(impl);
}

function X68Sound_PpiCtrl(context, data) {
  const impl = ensureContext(context);
  const value = data & 0xff;
  if ((value & 0x80) === 0) {
    const bit = 1 << ((value >>> 1) & 7);
    if (value & 0x01) {
      impl.m_ppiReg |= bit;
    } else {
      impl.m_ppiReg &= (~bit) & 0xff;
    }
    updateAdpcmRateFromRegs(impl);
  }
}

function X68Sound_MemReadFunc(context, func) {
  const impl = ensureContext(context);
  if (typeof func === 'function') {
    impl.m_MemRead = func;
  } else {
    impl.m_MemRead = impl.m_defaultMemRead ?? MemReadDefault;
  }
}

function X68Sound_WaveFunc(context, func, arg) {
  const impl = ensureContext(context);
  impl.m_waveFunc = (typeof func === 'function') ? func : null;
  impl.m_waveArg = impl.m_waveFunc ? arg : null;
}

function X68Sound_Pcm8_Out(context, ch, adrs, mode, len) {
  const impl = ensureContext(context);
  const channel = getPcm8Channel(impl, ch);
  const result = channel.out(adrs, mode, len);
  impl.m_ErrorCode = 0;
  return result | 0;
}

function X68Sound_Pcm8_Aot(context, ch, tbl, mode, cnt) {
  const impl = ensureContext(context);
  const channel = getPcm8Channel(impl, ch);
  const result = channel.aot(tbl, mode, cnt);
  impl.m_ErrorCode = 0;
  return result | 0;
}

function X68Sound_Pcm8_Lot(context, ch, tbl, mode) {
  const impl = ensureContext(context);
  const channel = getPcm8Channel(impl, ch);
  const result = channel.lot(tbl, mode);
  impl.m_ErrorCode = 0;
  return result | 0;
}

function X68Sound_Pcm8_SetMode(context, ch, mode) {
  const impl = ensureContext(context);
  const channel = getPcm8Channel(impl, ch);
  const result = channel.setMode(mode);
  impl.m_ErrorCode = 0;
  return result | 0;
}

function X68Sound_Pcm8_GetRest(context, ch) {
  const impl = ensureContext(context);
  const channel = getPcm8Channel(impl, ch);
  return channel.getRest() | 0;
}

function X68Sound_Pcm8_GetMode(context, ch) {
  const impl = ensureContext(context);
  const channel = getPcm8Channel(impl, ch);
  return channel.getMode() | 0;
}

function X68Sound_Pcm8_Abort(context) {
  const impl = ensureContext(context);
  const channels = ensurePcm8Channels(impl);
  for (const channel of channels) {
    channel.init();
  }
  impl.m_ErrorCode = 0;
  return 0;
}

function X68Sound_TotalVolume(context, v) {
  const impl = ensureContext(context);
  const value = v | 0;
  if ((value >>> 0) <= 0xffff) {
    impl.m_TotalVolume = value;
  }
  return impl.m_TotalVolume | 0;
}

function X68Sound_GetTotalVolume(context) {
  const impl = ensureContext(context);
  return impl.m_TotalVolume | 0;
}

function X68Sound_ErrorCode(context) {
  const impl = ensureContext(context);
  return impl.m_ErrorCode | 0;
}

function X68Sound_DebugValue(context) {
  const impl = ensureContext(context);
  return impl.m_DebugValue | 0;
}

function X68Sound_InternalTriggerDmaInt(context) {
  const impl = ensureContext(context);
  if (!impl.m_dmaIntProc) return false;

  impl.m_dmaRegs[0x00] |= 0x40;
  impl.m_dmaIntProc(impl.m_dmaIntArg);
  return true;
}

function X68Sound_InternalTriggerDmaErrInt(context) {
  const impl = ensureContext(context);
  if (!impl.m_dmaErrIntProc) return false;
  impl.m_dmaErrIntProc(impl.m_dmaErrIntArg);
  return true;
}

export {
  X68Sound_Start,
  X68Sound_Samprate,
  X68Sound_OpmClock,
  X68Sound_Reset,
  X68Sound_Free,
  X68Sound_BetwInt,
  X68Sound_StartPcm,
  X68Sound_GetPcm,
  X68Sound_OpmPeek,
  X68Sound_OpmReg,
  X68Sound_OpmPoke,
  X68Sound_OpmInt,
  X68Sound_OpmWait,
  X68Sound_DmaPeek,
  X68Sound_DmaPoke,
  X68Sound_DmaInt,
  X68Sound_DmaErrInt,
  X68Sound_AdpcmPeek,
  X68Sound_AdpcmPoke,
  X68Sound_PpiPeek,
  X68Sound_PpiPoke,
  X68Sound_PpiCtrl,
  X68Sound_MemReadFunc,
  X68Sound_WaveFunc,
  X68Sound_Pcm8_Out,
  X68Sound_Pcm8_Aot,
  X68Sound_Pcm8_Lot,
  X68Sound_Pcm8_SetMode,
  X68Sound_Pcm8_GetRest,
  X68Sound_Pcm8_GetMode,
  X68Sound_Pcm8_Abort,
  X68Sound_TotalVolume,
  X68Sound_GetTotalVolume,
  X68Sound_ErrorCode,
  X68Sound_DebugValue,
  X68Sound_InternalTriggerDmaInt,
  X68Sound_InternalTriggerDmaErrInt,
};
