import {
  createMxWorkCh,
  resetMxWorkCh,
  createMxWorkGlobal,
  resetMxWorkGlobal,
  createMxWorkKey,
  resetMxWorkKey,
  createMxWorkOpm,
} from './work_structs.js';

const DEFAULT_VOLUME_TABLE = Uint8Array.from([
  0x2a, 0x28, 0x25, 0x22,
  0x20, 0x1d, 0x1a, 0x18,
  0x15, 0x12, 0x10, 0x0d,
  0x0a, 0x08, 0x05, 0x02,
]);

class LightweightLock {
  constructor() {
    this._depth = 0;
  }

  lock() {
    this._depth += 1;
  }

  unlock() {
    if (this._depth === 0) {
      throw new Error('Mxdrv lock underflow');
    }
    this._depth -= 1;
  }
}

class MxdrvContextImpl {
  constructor(memoryPoolSizeInBytes) {
    if (!Number.isInteger(memoryPoolSizeInBytes) || memoryPoolSizeInBytes <= 0) {
      throw new Error('memoryPoolSizeInBytes must be positive integer');
    }

    this.m_memoryPoolSizeInBytes = memoryPoolSizeInBytes;
    this.m_memoryPool = new Uint8Array(memoryPoolSizeInBytes);
    // Keep offset 0 as a null pointer sentinel to match native TO_OFS/TO_PTR usage.
    this.m_memoryPoolBaseOffset = 1;
    this.m_memoryPoolReserved = this.m_memoryPoolBaseOffset;

    this.m_D0 = 0;
    this.m_D1 = 0;
    this.m_D2 = 0;
    this.m_D3 = 0;
    this.m_D4 = 0;
    this.m_D5 = 0;
    this.m_D6 = 0;
    this.m_D7 = 0;
    this.m_A0 = 0;
    this.m_A1 = 0;
    this.m_A2 = 0;
    this.m_A3 = 0;
    this.m_A4 = 0;
    this.m_A5 = 0;
    this.m_A6 = 0;
    this.m_A7 = 0;

    this.m_MXWORK_CHBUF_FM = Array.from({ length: 9 }, () => createMxWorkCh());
    this.m_MXWORK_CHBUF_PCM = Array.from({ length: 7 }, () => createMxWorkCh());
    this.m_MXWORK_GLOBALBUF = createMxWorkGlobal();
    this.m_MXWORK_KEYBUF = createMxWorkKey();
    this.m_MXWORK_OPMBUF = createMxWorkOpm();
    this.m_MXWORK_PCM8 = 0;
    this.m_FAKEA6S0004 = new Uint8Array(256);
    this.m_DisposeStack_L00122e = 0;

    this.m_OPMINT_FUNC = null;
    this.m_MXCALLBACK_OPMINT = null;

    this.m_MeasurePlayTime = false;
    this.m_TerminatePlay = false;
    this.m_LoopCount = 0;
    this.m_LoopLimit = 0;
    this.m_FadeoutStart = false;
    this.m_ReqFadeout = false;
    this.m_L001190 = 0x1234;
    this.m_L0019b2 = Uint8Array.from([0x7f, 0xf1, 0x00]);
    this.m_L000e7eVolume = DEFAULT_VOLUME_TABLE.slice();

    this.m_AdpcmStat = 0;
    this.m_OpmReg1B = 0;
    this.m_DmaErrCode = 0;
    this.m_Adpcmcot_adrs = null;
    this.m_Adpcmcot_len = 0;
    this.m_OpmIntProc = null;
    this.m_OpmIntArg = null;

    this.m_x68SoundContext = null;

    this.m_mdxReservedMemoryPoolSize = 0;
    this.m_pdxReservedMemoryPoolSize = 0;

    this.m_opmRegs = new Uint8Array(0x100);
    this.m_opmRegsUpdated = new Uint8Array(0x100);

    this.m_exportOpmBufOffset = 0;
    this.m_exportL001bb4Offset = 0;
    this.m_exportChPcmOffset = 0;

    this.m_keyOnFlagsForFm = new Array(8).fill(false);
    this.m_logicalSumOfKeyOnFlagsForFm = new Array(8).fill(false);
    this.m_logicalSumOfKeyOnFlagsForPcm = new Array(8).fill(false);

    this.m_mtx = new LightweightLock();
  }

  resetMemoryPool() {
    this.m_memoryPoolReserved = this.m_memoryPoolBaseOffset;
    this.m_exportOpmBufOffset = 0;
    this.m_exportL001bb4Offset = 0;
    this.m_exportChPcmOffset = 0;
  }

  reserveMemory(sizeInBytes) {
    if (sizeInBytes < 0) return null;
    if (this.m_memoryPoolReserved + sizeInBytes > this.m_memoryPoolSizeInBytes) {
      return null;
    }
    const start = this.m_memoryPoolReserved;
    this.m_memoryPoolReserved += sizeInBytes;
    return {
      view: this.m_memoryPool.subarray(start, start + sizeInBytes),
      offset: start,
    };
  }

  releaseMemory(sizeInBytes) {
    if (sizeInBytes < 0) return false;
    if (this.m_memoryPoolReserved - sizeInBytes < this.m_memoryPoolBaseOffset) return false;
    this.m_memoryPoolReserved -= sizeInBytes;
    return true;
  }

  getReservedMemoryPoolSize() {
    return this.m_memoryPoolReserved - this.m_memoryPoolBaseOffset;
  }

  resetState() {
    this.m_D0 = 0;
    this.m_D1 = 0;
    this.m_D2 = 0;
    this.m_D3 = 0;
    this.m_D4 = 0;
    this.m_D5 = 0;
    this.m_D6 = 0;
    this.m_D7 = 0;
    this.m_A0 = 0;
    this.m_A1 = 0;
    this.m_A2 = 0;
    this.m_A3 = 0;
    this.m_A4 = 0;
    this.m_A5 = 0;
    this.m_A6 = 0;
    this.m_A7 = 0;
    this.m_MXWORK_CHBUF_FM.forEach(resetMxWorkCh);
    this.m_MXWORK_CHBUF_PCM.forEach(resetMxWorkCh);
    resetMxWorkGlobal(this.m_MXWORK_GLOBALBUF);
    resetMxWorkKey(this.m_MXWORK_KEYBUF);
    this.m_MXWORK_OPMBUF.fill(0);
    this.m_MXWORK_PCM8 = 0;
    this.m_FAKEA6S0004.fill(0);
    this.m_DisposeStack_L00122e = 0;
    this.m_OPMINT_FUNC = null;
    this.m_MXCALLBACK_OPMINT = null;
    this.m_MeasurePlayTime = false;
    this.m_TerminatePlay = false;
    this.m_LoopCount = 0;
    this.m_LoopLimit = 0;
    this.m_FadeoutStart = false;
    this.m_ReqFadeout = false;
    this.m_L001190 = 0x1234;
    this.m_L0019b2.fill(0);
    this.m_L0019b2.set([0x7f, 0xf1, 0x00]);
    this.m_L000e7eVolume.set(DEFAULT_VOLUME_TABLE);
    this.m_AdpcmStat = 0;
    this.m_OpmReg1B = 0;
    this.m_DmaErrCode = 0;
    this.m_Adpcmcot_adrs = null;
    this.m_Adpcmcot_len = 0;
    this.m_OpmIntProc = null;
    this.m_OpmIntArg = null;
    this.m_mdxReservedMemoryPoolSize = 0;
    this.m_pdxReservedMemoryPoolSize = 0;
    this.m_opmRegs.fill(0);
    this.m_opmRegsUpdated.fill(0);
    this.m_exportOpmBufOffset = 0;
    this.m_exportL001bb4Offset = 0;
    this.m_exportChPcmOffset = 0;
    this.m_keyOnFlagsForFm.fill(false);
    this.m_logicalSumOfKeyOnFlagsForFm.fill(false);
    this.m_logicalSumOfKeyOnFlagsForPcm.fill(false);
  }

  toOffset(ptr) {
    if (ptr == null) return 0;
    if (typeof ptr !== 'number') {
      throw new Error('Pointers must be numeric offsets');
    }
    return ptr >>> 0;
  }

  toPointer(ofs) {
    if (!ofs) return 0;
    return ofs >>> 0;
  }
}

export { MxdrvContextImpl, LightweightLock };
