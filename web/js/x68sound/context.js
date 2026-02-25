import { Lfo } from './lfo.js';
import { initializeX68SoundTables } from './tables.js';
import {
  OPMLPF_COL,
  OPMLPF_ROW_44,
  OPMLPF_ROW_48,
  OPMLOWPASS_44,
  OPMLOWPASS_48,
} from './opm_lowpass_tables.js';

const SIZEALPHATBL = 1 << 10;
const SIZESINTBL = 1 << 10;
const ALPHAZERO = SIZEALPHATBL * 3;
const OPM_CMNDBUF_SIZE = 65535;

function MemReadDefault() {
  return -1;
}

class X68SoundContextImpl {
  constructor(dmaBase) {
    this.m_dmaBase = dmaBase;

    this.m_OpmFir = 'OpmFir_Normal';

    this.m_DebugValue = 0;
    this.m_ErrorCode = 0;
    this.m_active = false;
    this.m_dousaMode = 0;
    this.m_useOpm = true;
    this.m_Samprate = 22050;
    this.m_WaveOutSamp = 22050;
    this.m_OpmWait = 240;
    this.m_OpmRate = 62500;
    this.m_OpmClock = 4000000;

    this.m_STEPTBL = new Int32Array(11 * 12 * 64);
    this.m_ALPHATBL = new Uint16Array(ALPHAZERO + SIZEALPHATBL + 1);
    this.m_SINTBL = new Int16Array(SIZESINTBL);
    this.m_D1LTBL = new Int32Array(16);
    this.m_DT1TBL = new Int32Array(128 + 4);
    this.m_NOISEALPHATBL = new Uint16Array(ALPHAZERO + SIZEALPHATBL + 1);

    this.m_MemRead = MemReadDefault;
    this.m_defaultMemRead = (adrs) => {
      const ofs = Number.isFinite(adrs) ? (adrs >>> 0) : 0;
      const dmaBase = this.m_dmaBase;
      if (!dmaBase || !(dmaBase.m_memoryPool instanceof Uint8Array)) {
        return -1;
      }
      const mem = dmaBase.m_memoryPool;
      const minOfs = Number.isFinite(dmaBase.m_memoryPoolBaseOffset)
        ? (dmaBase.m_memoryPoolBaseOffset >>> 0)
        : 1;
      if (ofs < minOfs || ofs >= mem.length) {
        return -1;
      }
      return mem[ofs] & 0xff;
    };
    this.m_MemRead = this.m_defaultMemRead;
    this.m_TotalVolume = 0;
    this.m_Semapho = 0;
    this.m_TimerSemapho = 0;
    this.m_OPMLPF_COL = OPMLPF_COL;
    this.m_OPMLPF_ROW = OPMLPF_ROW_44;
    this.m_OPMLPF_ROW_44 = OPMLPF_ROW_44;
    this.m_OPMLPF_ROW_48 = OPMLPF_ROW_48;
    this.m_OPMLOWPASS_44 = OPMLOWPASS_44;
    this.m_OPMLOWPASS_48 = OPMLOWPASS_48;
    this.m_OPMLOWPASS = OPMLOWPASS_44;
    this.m_OpmLPFidx = 0;
    this.m_OpmLPFRowIndex = 0;
    this.m_InpOpmIdx = 0;
    this.m_InpOpmBuf0 = new Int16Array(OPMLPF_COL * 2);
    this.m_InpOpmBuf1 = new Int16Array(OPMLPF_COL * 2);

    this.m_Betw_Time = 0;
    this.m_Late_Time = 0;
    this.m_Late_Samples = 0;
    this.m_Blk_Samples = 0;
    this.m_Betw_Samples_Slower = 0;
    this.m_Betw_Samples_Faster = 0;
    this.m_Betw_Samples_VerySlower = 0;
    this.m_Slower_Limit = 0;
    this.m_Faster_Limit = 0;
    this.m_TimerResolution = 1;
    this.m_nSamples = 0;

    this.m_N_waveblk = 4;
    this.m_waveblk = 0;
    this.m_playingblk = 0;
    this.m_playingblk_next = 1;
    this.m_setPcmBufPtr = -1;

    this.m_RandSeed = 1;
    this.m_opm = {};
    this.m_lfo = new Lfo(this);
    this.m_lastStart = null;
    this.m_configBetw = 5;
    this.m_configLate = 200;
    this.m_configRev = 1.0;

    this.m_opmStatus = 0;
    this.m_opmRegSelect = 0;
    this.m_opmRegisters = new Uint8Array(0x100);
    this.m_opmTimerAReg10 = 0;
    this.m_opmTimerAReg11 = 0;
    this.m_opmTimerA = 1024;
    this.m_opmTimerACounter = 0;
    this.m_opmTimerB = (256 - 0) << (10 - 6);
    this.m_opmTimerBCounter = 0;
    this.m_opmTimerReg = 0;
    this.m_opmTimerStepRemainder = 0;
    this.m_opmNumCmnd = 0;
    this.m_opmCmndReadIdx = 0;
    this.m_opmCmndWriteIdx = 0;
    this.m_opmCmndRate = 1;
    this.m_opmRateForExecuteCmnd = 0;
    this.m_opmCmndBufReg = new Uint8Array(OPM_CMNDBUF_SIZE + 1);
    this.m_opmCmndBufData = new Uint8Array(OPM_CMNDBUF_SIZE + 1);

    this.m_adpcmReg = 0;
    this.m_ppiReg = 0x0b;
    this.m_dmaRegs = new Uint8Array(0x40);
    this.m_dmaLastValue = 0;

    this.m_adpcmScale = 0;
    this.m_adpcmPcm = 0;
    this.m_adpcmInpPcm = 0;
    this.m_adpcmInpPcmPrev = 0;
    this.m_adpcmOutPcm = 0;
    this.m_adpcmOutInpPcm = 0;
    this.m_adpcmOutInpPcmPrev = 0;
    this.m_adpcmRate = 15625 * 12;
    this.m_adpcmRateCounter = 0;
    this.m_adpcmN1Data = 0;
    this.m_adpcmN1DataFlag = 0;
    this.m_adpcmBaseClock = 0;
    this.m_adpcmFinishCounter = 3;

    this.m_opmIntProc = null;
    this.m_opmIntArg = null;
    this.m_betwIntProc = null;
    this.m_betwIntArg = null;
    this.m_dmaIntProc = null;
    this.m_dmaIntArg = null;
    this.m_dmaErrIntProc = null;
    this.m_dmaErrIntArg = null;
    this.m_waveFunc = null;
    this.m_waveArg = null;
    this.m_pcm8Channels = [];
  }
}

class X68SoundContext {
  constructor() {
    this.m_impl = null;
  }
}

function X68SoundContext_Initialize(context, dmaBase) {
  if (!(context instanceof X68SoundContext)) {
    throw new Error('context must be X68SoundContext');
  }

  context.m_impl = null;
  context.m_impl = new X68SoundContextImpl(dmaBase);
  initializeX68SoundTables(context.m_impl);
  return true;
}

function X68SoundContext_Terminate(context) {
  if (!(context instanceof X68SoundContext)) {
    throw new Error('context must be X68SoundContext');
  }

  if (context.m_impl === null) return false;
  context.m_impl = null;
  return true;
}

export {
  X68SoundContext,
  X68SoundContext_Initialize,
  X68SoundContext_Terminate,
  X68SoundContextImpl,
  MemReadDefault,
};
