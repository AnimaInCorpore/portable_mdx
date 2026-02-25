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
  MXDRV_GetPCM,
  MXDRV_Stop,
  MXDRV_Pause,
  MXDRV_Cont,
  MXDRV_Fadeout,
  MXDRV_PCM8Enable,
  MXDRV_TotalVolume,
  MXDRV_MeasurePlayTime2,
  MXDRV_GetWork,
  MXDRV_WORK_FM,
  MXDRV_WORK_PCM,
  MXDRV_WORK_GLOBAL,
} from '../mxdrv/driver_core.js';

const DEFAULT_MEMORY_POOL_SIZE = 8 * 1024 * 1024;
const DEFAULT_MDX_BUFFER_SIZE = 1 * 1024 * 1024;
const DEFAULT_PDX_BUFFER_SIZE = 2 * 1024 * 1024;
const STATUS_RATE_HZ = 20;

class MxdrvWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this._context = null;
    this._running = false;
    this._paused = false;
    this._statusSamples = 0;
    this._statusSamplesStep = Math.max(1, (sampleRate / STATUS_RATE_HZ) | 0);
    this._durationMs = 0;
    this._finishedNotified = false;
    this._pcmI16 = new Int16Array(0);

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      try {
        this._handleMessage(msg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.port.postMessage({ type: 'error', message });
      }
    };
  }

  _ensurePcmBuffer(frames) {
    const needed = (frames * 2) | 0;
    if (this._pcmI16.length !== needed) {
      this._pcmI16 = new Int16Array(needed);
    }
    return this._pcmI16;
  }

  _cleanup() {
    if (!this._context) return;
    MXDRV_End(this._context);
    MxdrvContext_Terminate(this._context);
    this._context = null;
    this._running = false;
    this._paused = false;
    this._durationMs = 0;
    this._finishedNotified = false;
  }

  _initEngine(opts) {
    this._cleanup();

    const memoryPoolSize = (opts.memoryPoolSize >>> 0) || DEFAULT_MEMORY_POOL_SIZE;
    const mdxBufferSize = (opts.mdxBufferSize >>> 0) || DEFAULT_MDX_BUFFER_SIZE;
    const pdxBufferSize = (opts.pdxBufferSize >>> 0) || DEFAULT_PDX_BUFFER_SIZE;
    const totalVolume = Number.isInteger(opts.totalVolume) ? (opts.totalVolume | 0) : 256;

    const context = new MxdrvContext();
    if (!MxdrvContext_Initialize(context, memoryPoolSize)) {
      throw new Error('MxdrvContext_Initialize failed.');
    }

    const ret = MXDRV_Start(
      context,
      sampleRate | 0,
      0,
      0,
      0,
      mdxBufferSize,
      pdxBufferSize,
      0
    );
    if (ret !== 0) {
      MxdrvContext_Terminate(context);
      throw new Error(`MXDRV_Start failed (${ret}).`);
    }

    MXDRV_PCM8Enable(context, 1);
    MXDRV_TotalVolume(context, totalVolume);

    this._context = context;
    this._running = false;
    this._paused = false;
    this._durationMs = 0;
    this._finishedNotified = false;
    this._statusSamples = 0;

    this.port.postMessage({ type: 'ready', sampleRate: sampleRate | 0 });
  }

  _loadTrack(msg) {
    if (!this._context) {
      throw new Error('Engine not initialized.');
    }
    if (!(msg.mdxBuffer instanceof ArrayBuffer)) {
      throw new Error('loadTrack requires mdxBuffer ArrayBuffer.');
    }

    const mdxBuffer = new Uint8Array(msg.mdxBuffer);
    const pdxBuffer = (msg.pdxBuffer instanceof ArrayBuffer)
      ? new Uint8Array(msg.pdxBuffer)
      : null;

    const setDataRet = MXDRV_SetData2(
      this._context,
      mdxBuffer,
      mdxBuffer.length,
      pdxBuffer,
      pdxBuffer ? pdxBuffer.length : 0
    );
    if (setDataRet !== 0) {
      throw new Error(`MXDRV_SetData2 failed (${setDataRet}).`);
    }

    this._durationMs = MXDRV_MeasurePlayTime2(this._context, 1, 0) >>> 0;
    MXDRV_Play2(this._context);

    this._running = true;
    this._paused = false;
    this._finishedNotified = false;
    this._statusSamples = 0;

    this.port.postMessage({
      type: 'trackLoaded',
      durationMs: this._durationMs,
    });
  }

  _readStatus() {
    if (!this._context) return null;

    const impl = this._context.m_impl;
    const global = MXDRV_GetWork(this._context, MXDRV_WORK_GLOBAL);
    const fm = MXDRV_GetWork(this._context, MXDRV_WORK_FM);
    const pcm = MXDRV_GetWork(this._context, MXDRV_WORK_PCM);

    const opmRegs = impl.m_opmRegs.slice();
    const opmUpdated = impl.m_opmRegsUpdated.slice();
    impl.m_opmRegsUpdated.fill(0);

    const fmKeyOnCurrent = new Uint8Array(8);
    const fmKeyOnPulse = new Uint8Array(8);
    for (let i = 0; i < 8; i += 1) {
      fmKeyOnCurrent[i] = impl.m_keyOnFlagsForFm[i] ? 1 : 0;
      fmKeyOnPulse[i] = impl.m_logicalSumOfKeyOnFlagsForFm[i] ? 1 : 0;
      impl.m_logicalSumOfKeyOnFlagsForFm[i] = false;
    }

    const pcmKeyOnPulse = new Uint8Array(8);
    for (let i = 0; i < 8; i += 1) {
      pcmKeyOnPulse[i] = impl.m_logicalSumOfKeyOnFlagsForPcm[i] ? 1 : 0;
      impl.m_logicalSumOfKeyOnFlagsForPcm[i] = false;
    }

    const keyOnActive = new Uint8Array(16);
    const notes = new Uint16Array(16);
    const pitchOffsets = new Int16Array(16);
    const volumes = new Uint8Array(16);

    for (let i = 0; i < 8; i += 1) {
      const ch = fm[i];
      keyOnActive[i] = (ch.S0016 & (1 << 3)) !== 0 ? 1 : 0;
      notes[i] = ch.S0012 & 0xffff;
      pitchOffsets[i] = ((ch.S0014 & 0xffff) - (ch.S0012 & 0xffff)) | 0;
      volumes[i] = ch.S0022 & 0xff;
    }

    for (let i = 8; i < 16; i += 1) {
      const ch = (i === 8) ? fm[8] : pcm[i - 9];
      keyOnActive[i] = (ch.S0016 & (1 << 3)) !== 0 ? 1 : 0;
      notes[i] = ch.S0012 & 0xffff;
      pitchOffsets[i] = 0;
      volumes[i] = ch.S0022 & 0xff;
    }

    return {
      playTimeMs: Math.trunc(((global.PLAYTIME >>> 0) * 1024) / 4000) >>> 0,
      loops: global.L002246 & 0xffff,
      finished: global.L001e13 ? 1 : 0,
      opmRegs,
      opmUpdated,
      fmKeyOnCurrent,
      fmKeyOnPulse,
      pcmKeyOnPulse,
      keyOnActive,
      notes,
      pitchOffsets,
      volumes,
    };
  }

  _emitStatusIfNeeded(force = false) {
    this._statusSamples += 128;
    if (!force && this._statusSamples < this._statusSamplesStep) return;
    this._statusSamples = 0;
    const status = this._readStatus();
    if (!status) return;
    this.port.postMessage({ type: 'status', ...status });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        this._initEngine(msg);
        return;
      case 'loadTrack':
        this._loadTrack(msg);
        return;
      case 'pause':
        if (this._context && this._running && !this._paused) {
          MXDRV_Pause(this._context);
          this._paused = true;
          this.port.postMessage({ type: 'paused' });
        }
        return;
      case 'resume':
        if (this._context && this._running && this._paused) {
          MXDRV_Cont(this._context);
          this._paused = false;
          this.port.postMessage({ type: 'resumed' });
        }
        return;
      case 'stop':
        if (this._context && this._running) {
          MXDRV_Stop(this._context);
          this._running = false;
          this._paused = false;
          this.port.postMessage({ type: 'stopped' });
        }
        return;
      case 'fadeout':
        if (this._context && this._running) {
          MXDRV_Fadeout(this._context);
        }
        return;
      case 'dispose':
        this._cleanup();
        return;
      default:
        return;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const frames = left.length | 0;

    for (let i = 0; i < frames; i += 1) {
      left[i] = 0;
      right[i] = 0;
    }

    if (!this._context || !this._running || this._paused) {
      this._emitStatusIfNeeded(false);
      return true;
    }

    const pcmI16 = this._ensurePcmBuffer(frames);
    const ret = MXDRV_GetPCM(this._context, pcmI16, frames);
    if (ret === 0) {
      for (let i = 0, j = 0; i < frames; i += 1, j += 2) {
        left[i] = Math.max(-1, Math.min(1, pcmI16[j] / 32768));
        right[i] = Math.max(-1, Math.min(1, pcmI16[j + 1] / 32768));
      }
    }

    const status = this._readStatus();
    if (status) {
      if (status.finished && !this._finishedNotified) {
        this._finishedNotified = true;
        this._running = false;
        this.port.postMessage({ type: 'ended', ...status });
      } else {
        this._statusSamples += frames;
        if (this._statusSamples >= this._statusSamplesStep) {
          this._statusSamples = 0;
          this.port.postMessage({ type: 'status', ...status });
        }
      }
    }

    return true;
  }
}

registerProcessor('mxdrv-worklet', MxdrvWorkletProcessor);
