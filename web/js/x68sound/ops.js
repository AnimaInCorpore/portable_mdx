import {
  ALPHAZERO,
  MAXSINVAL,
  PRECISION_BITS,
  SIZESINTBL,
  DT2TBL,
  XRTBL,
} from './tables.js';

const KEYON = -1;
const ATACK = 0;
const DECAY = 1;
const SUSTAIN = 2;
const SUSTAIN_MAX = 3;
const RELEASE = 4;
const RELEASE_MAX = 5;

const CULC_DELTA_T = 0x7fffffff;
const CULC_ALPHA = 0x7fffffff;

const NEXTSTAT = Int32Array.from([
  DECAY,
  SUSTAIN,
  SUSTAIN_MAX,
  SUSTAIN_MAX,
  RELEASE_MAX,
  RELEASE_MAX,
]);

const MAXSTAT = Int32Array.from([
  ATACK,
  SUSTAIN_MAX,
  SUSTAIN_MAX,
  SUSTAIN_MAX,
  RELEASE_MAX,
  RELEASE_MAX,
]);

function readIntTable(table, index) {
  if (!ArrayBuffer.isView(table)) return 0;
  const i = index | 0;
  if (i < 0 || i >= table.length) return 0;
  return table[i] | 0;
}

function readUintTable(table, index) {
  if (!ArrayBuffer.isView(table)) return 0;
  const i = index | 0;
  if (i < 0 || i >= table.length) return 0;
  return table[i] >>> 0;
}

function readXr(index) {
  const i = index | 0;
  if (i < 0) return XRTBL[0];
  if (i >= XRTBL.length) return XRTBL[XRTBL.length - 1];
  return XRTBL[i];
}

function toRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  return ref;
}

function setRefValue(ref, value) {
  const r = toRef(ref);
  if (!r) return;
  r.value = value | 0;
}

function addRefValue(ref, value) {
  const r = toRef(ref);
  if (!r) return;
  r.value = ((r.value | 0) + (value | 0)) | 0;
}

function irnd(contextImpl) {
  const seed = contextImpl?.m_RandSeed ?? 1;
  const next = (Math.imul(seed >>> 0, 1566083941) + 1) >>> 0;
  if (contextImpl) {
    contextImpl.m_RandSeed = next;
  }
  return next >>> 0;
}

class Op {
  constructor(contextImpl) {
    this.m_contextImpl = contextImpl;

    this.inp = 0;

    this.LfoPitch = CULC_DELTA_T;
    this.T = 0;
    this.DeltaT = 0;
    this.Ame = 0;
    this.LfoLevel = CULC_ALPHA;
    this.Alpha = 0;

    this.out = null;
    this.out2 = null;
    this.out3 = null;

    this.Pitch = 0;
    this.Dt1Pitch = 0;
    this.Mul = 2;
    this.Tl = (128 - 127) << 3;

    this.Out2Fb = 0;
    this.Inp_last = 0;
    this.Fl = 31;
    this.Fl_mask = 0;
    this.ArTime = 0;

    this.NoiseCounter = 0;
    this.NoiseStep = 0;
    this.NoiseCycle = 0;
    this.NoiseValue = 1;

    this.Xr_stat = RELEASE_MAX;
    this.Xr_el = 1024;
    this.Xr_step = 0;
    this.Xr_and = 4097;
    this.Xr_cmp = 2048;
    this.Xr_add = 0;
    this.Xr_limit = 63;

    this.Note = 0;
    this.Kc = 0;
    this.Kf = 0;
    this.Ar = 0;
    this.D1r = 0;
    this.D2r = 0;
    this.Rr = 0;
    this.Ks = 0;
    this.Dt2 = 0;
    this.Dt1 = 0;
    this.Nfrq = 0;

    this.StatTbl = Array.from({ length: RELEASE_MAX + 1 }, () => ({
      and: 4097,
      cmp: 2048,
      add: 0,
      limit: 63,
    }));

    this.Init();
  }

  setOutputRefs(outRef, out2Ref = outRef, out3Ref = outRef) {
    this.out = toRef(outRef);
    this.out2 = toRef(out2Ref);
    this.out3 = toRef(out3Ref);
  }

  Init() {
    const impl = this.m_contextImpl;
    const samprate = Math.max(1, impl?.m_Samprate | 0);
    const opmRate = Math.max(1, impl?.m_OpmRate | 0);

    this.Note = 5 * 12 + 8;
    this.Kc = 5 * 16 + 8 + 1;
    this.Kf = 5;
    this.Ar = 10;
    this.D1r = 10;
    this.D2r = 5;
    this.Rr = 12;
    this.Ks = 1;
    this.Dt2 = 0;
    this.Dt1 = 0;

    this.ArTime = 0;
    this.Fl = 31;
    this.Fl_mask = 0;
    this.Out2Fb = 0;
    this.inp = 0;
    this.Inp_last = 0;
    this.DeltaT = 0;
    this.LfoPitch = CULC_DELTA_T;
    this.T = 0;
    this.LfoLevel = CULC_ALPHA;
    this.Alpha = 0;
    this.Tl = (128 - 127) << 3;
    this.Xr_el = 1024;
    this.Xr_step = 0;
    this.Mul = 2;
    this.Ame = 0;

    this.NoiseStep = Math.trunc(((1 << 26) * opmRate) / samprate);
    this.SetNFRQ(0);
    this.NoiseValue = 1;

    this.StatTbl[ATACK].limit = 0;
    this.StatTbl[DECAY].limit = readIntTable(impl?.m_D1LTBL, 0);
    this.StatTbl[SUSTAIN].limit = 63;
    this.StatTbl[SUSTAIN_MAX].limit = 63;
    this.StatTbl[RELEASE].limit = 63;
    this.StatTbl[RELEASE_MAX].limit = 63;

    this.StatTbl[SUSTAIN_MAX].and = 4097;
    this.StatTbl[SUSTAIN_MAX].cmp = 2048;
    this.StatTbl[SUSTAIN_MAX].add = 0;

    this.StatTbl[RELEASE_MAX].and = 4097;
    this.StatTbl[RELEASE_MAX].cmp = 2048;
    this.StatTbl[RELEASE_MAX].add = 0;

    this.Xr_stat = RELEASE_MAX;
    this.Xr_and = this.StatTbl[this.Xr_stat].and;
    this.Xr_cmp = this.StatTbl[this.Xr_stat].cmp;
    this.Xr_add = this.StatTbl[this.Xr_stat].add;
    this.Xr_limit = this.StatTbl[this.Xr_stat].limit;

    this.CulcArStep();
    this.CulcD1rStep();
    this.CulcD2rStep();
    this.CulcRrStep();
    this.CulcPitch();
    this.CulcDt1Pitch();
  }

  InitSamprate() {
    const impl = this.m_contextImpl;
    const samprate = Math.max(1, impl?.m_Samprate | 0);
    const opmRate = Math.max(1, impl?.m_OpmRate | 0);

    this.LfoPitch = CULC_DELTA_T;
    this.NoiseStep = Math.trunc(((1 << 26) * opmRate) / samprate);
    this.CulcNoiseCycle();

    this.CulcArStep();
    this.CulcD1rStep();
    this.CulcD2rStep();
    this.CulcRrStep();
    this.CulcPitch();
    this.CulcDt1Pitch();
  }

  syncXrStep() {
    this.Xr_and = this.StatTbl[this.Xr_stat].and;
    this.Xr_cmp = this.StatTbl[this.Xr_stat].cmp;
    this.Xr_add = this.StatTbl[this.Xr_stat].add;
    this.Xr_limit = this.StatTbl[this.Xr_stat].limit;
  }

  CulcArStep() {
    if (this.Ar !== 0) {
      const ks = (this.Ar << 1) + (this.Kc >> (5 - this.Ks));
      const xr = readXr(ks);
      this.StatTbl[ATACK].and = xr.and;
      this.StatTbl[ATACK].cmp = xr.and >> 1;
      this.StatTbl[ATACK].add = ks < 62 ? xr.add : 128;
    } else {
      this.StatTbl[ATACK].and = 4097;
      this.StatTbl[ATACK].cmp = 2048;
      this.StatTbl[ATACK].add = 0;
    }
    if (this.Xr_stat === ATACK) {
      this.syncXrStep();
    }
  }

  CulcD1rStep() {
    if (this.D1r !== 0) {
      const ks = (this.D1r << 1) + (this.Kc >> (5 - this.Ks));
      const xr = readXr(ks);
      this.StatTbl[DECAY].and = xr.and;
      this.StatTbl[DECAY].cmp = xr.and >> 1;
      this.StatTbl[DECAY].add = xr.add;
    } else {
      this.StatTbl[DECAY].and = 4097;
      this.StatTbl[DECAY].cmp = 2048;
      this.StatTbl[DECAY].add = 0;
    }
    if (this.Xr_stat === DECAY) {
      this.syncXrStep();
    }
  }

  CulcD2rStep() {
    if (this.D2r !== 0) {
      const ks = (this.D2r << 1) + (this.Kc >> (5 - this.Ks));
      const xr = readXr(ks);
      this.StatTbl[SUSTAIN].and = xr.and;
      this.StatTbl[SUSTAIN].cmp = xr.and >> 1;
      this.StatTbl[SUSTAIN].add = xr.add;
    } else {
      this.StatTbl[SUSTAIN].and = 4097;
      this.StatTbl[SUSTAIN].cmp = 2048;
      this.StatTbl[SUSTAIN].add = 0;
    }
    if (this.Xr_stat === SUSTAIN) {
      this.syncXrStep();
    }
  }

  CulcRrStep() {
    const ks = (this.Rr << 2) + 2 + (this.Kc >> (5 - this.Ks));
    const xr = readXr(ks);
    this.StatTbl[RELEASE].and = xr.and;
    this.StatTbl[RELEASE].cmp = xr.and >> 1;
    this.StatTbl[RELEASE].add = xr.add;
    if (this.Xr_stat === RELEASE) {
      this.syncXrStep();
    }
  }

  CulcPitch() {
    this.Pitch = (this.Note << 6) + this.Kf + this.Dt2;
  }

  CulcDt1Pitch() {
    const dt1Tbl = this.m_contextImpl?.m_DT1TBL;
    const idx = (this.Kc & 0xfc) + (this.Dt1 & 3);
    this.Dt1Pitch = readIntTable(dt1Tbl, idx);
    if (this.Dt1 & 0x04) {
      this.Dt1Pitch = -this.Dt1Pitch;
    }
  }

  SetFL(n) {
    const value = (n >> 3) & 7;
    if (value === 0) {
      this.Fl = 31;
      this.Fl_mask = 0;
    } else {
      this.Fl = 7 - value + 1 + 1;
      this.Fl_mask = -1;
    }
  }

  SetKC(n) {
    this.Kc = n & 127;
    const note = this.Kc & 15;
    this.Note = ((this.Kc >> 4) + 1) * 12 + note - (note >> 2);
    this.Kc++;
    this.CulcPitch();
    this.CulcDt1Pitch();
    this.LfoPitch = CULC_DELTA_T;
    this.CulcArStep();
    this.CulcD1rStep();
    this.CulcD2rStep();
    this.CulcRrStep();
  }

  SetKF(n) {
    this.Kf = ((n & 255) >> 2);
    this.CulcPitch();
    this.LfoPitch = CULC_DELTA_T;
  }

  SetDT1MUL(n) {
    this.Dt1 = (n >> 4) & 7;
    this.CulcDt1Pitch();
    this.Mul = (n & 15) << 1;
    if (this.Mul === 0) {
      this.Mul = 1;
    }
    this.LfoPitch = CULC_DELTA_T;
  }

  SetTL(n) {
    this.Tl = (128 - (n & 127)) << 3;
    this.LfoLevel = CULC_ALPHA;
  }

  SetKSAR(n) {
    this.Ks = (n & 255) >> 6;
    this.Ar = n & 31;
    this.CulcArStep();
    this.CulcD1rStep();
    this.CulcD2rStep();
    this.CulcRrStep();
  }

  SetAMED1R(n) {
    this.D1r = n & 31;
    this.CulcD1rStep();
    this.Ame = (n & 0x80) ? -1 : 0;
  }

  SetDT2D2R(n) {
    this.Dt2 = readIntTable(DT2TBL, (n & 255) >> 6);
    this.CulcPitch();
    this.LfoPitch = CULC_DELTA_T;
    this.D2r = n & 31;
    this.CulcD2rStep();
  }

  SetD1LRR(n) {
    const d1lTbl = this.m_contextImpl?.m_D1LTBL;
    this.StatTbl[DECAY].limit = readIntTable(d1lTbl, (n & 255) >> 4);
    if (this.Xr_stat === DECAY) {
      this.Xr_limit = this.StatTbl[DECAY].limit;
    }

    this.Rr = n & 15;
    this.CulcRrStep();
  }

  KeyON() {
    if (this.Xr_stat >= RELEASE) {
      this.T = 0;

      if (this.Xr_el === 0) {
        this.Xr_stat = DECAY;
        this.syncXrStep();
        if ((this.Xr_el >> 4) === this.Xr_limit) {
          this.Xr_stat = NEXTSTAT[this.Xr_stat];
          this.syncXrStep();
        }
      } else {
        this.Xr_stat = ATACK;
        this.syncXrStep();
      }
    }
  }

  KeyOFF() {
    this.Xr_stat = RELEASE;
    this.syncXrStep();
    if ((this.Xr_el >> 4) >= 63) {
      this.Xr_el = 1024;
      this.Xr_stat = MAXSTAT[this.Xr_stat];
      this.syncXrStep();
    }
  }

  Envelope(env_counter) {
    if ((env_counter & this.Xr_and) !== this.Xr_cmp) {
      return;
    }

    if (this.Xr_stat === ATACK) {
      this.Xr_step += this.Xr_add;
      this.Xr_el += (((~this.Xr_el) * (this.Xr_step >> 3)) >> 4);
      this.LfoLevel = CULC_ALPHA;
      this.Xr_step &= 7;

      if (this.Xr_el <= 0) {
        this.Xr_el = 0;
        this.Xr_stat = DECAY;
        this.syncXrStep();
        if ((this.Xr_el >> 4) === this.Xr_limit) {
          this.Xr_stat = NEXTSTAT[this.Xr_stat];
          this.syncXrStep();
        }
      }
      return;
    }

    this.Xr_step += this.Xr_add;
    this.Xr_el += (this.Xr_step >> 3);
    this.LfoLevel = CULC_ALPHA;
    this.Xr_step &= 7;

    const e = this.Xr_el >> 4;
    if (e === 63) {
      this.Xr_el = 1024;
      this.Xr_stat = MAXSTAT[this.Xr_stat];
      this.syncXrStep();
    } else if (e === this.Xr_limit) {
      this.Xr_stat = NEXTSTAT[this.Xr_stat];
      this.syncXrStep();
    }
  }

  SetNFRQ(nfrq) {
    if (((this.Nfrq ^ nfrq) & 0x80) !== 0) {
      this.LfoLevel = CULC_ALPHA;
    }
    this.Nfrq = nfrq | 0;
    this.CulcNoiseCycle();
  }

  CulcNoiseCycle() {
    if (this.Nfrq & 0x80) {
      this.NoiseCycle = (32 - (this.Nfrq & 31)) << 25;
      if (this.NoiseCycle < this.NoiseStep) {
        this.NoiseCycle = this.NoiseStep;
      }
      this.NoiseCounter = this.NoiseCycle;
    } else {
      this.NoiseCycle = 0;
    }
  }

  calculateDeltaT(lfopitch) {
    if (this.LfoPitch === (lfopitch | 0)) {
      return;
    }

    const stepTbl = this.m_contextImpl?.m_STEPTBL;
    const base = readIntTable(stepTbl, this.Pitch + (lfopitch | 0));
    this.DeltaT = ((base + this.Dt1Pitch) * this.Mul) >> (6 + 1);
    this.LfoPitch = lfopitch | 0;
  }

  calculateAlpha(lfolevel, useNoiseTable = false) {
    const lfolevelame = (lfolevel | 0) & this.Ame;
    if (this.LfoLevel !== lfolevelame) {
      const table = useNoiseTable ? this.m_contextImpl?.m_NOISEALPHATBL : this.m_contextImpl?.m_ALPHATBL;
      const idx = ALPHAZERO + this.Tl - this.Xr_el - lfolevelame;
      this.Alpha = readUintTable(table, idx) | 0;
      this.LfoLevel = lfolevelame;
    }
    return this.Alpha | 0;
  }

  Output0(lfopitch, lfolevel) {
    this.calculateDeltaT(lfopitch);
    this.T = (this.T + this.DeltaT) | 0;

    const alpha = this.calculateAlpha(lfolevel, false);
    const sinTbl = this.m_contextImpl?.m_SINTBL;
    const phase = ((this.T + this.Out2Fb) >> PRECISION_BITS) & (SIZESINTBL - 1);
    const o = (alpha * readIntTable(sinTbl, phase)) | 0;

    this.Out2Fb = ((o + this.Inp_last) & this.Fl_mask) >> this.Fl;
    this.Inp_last = o;

    setRefValue(this.out, o);
    setRefValue(this.out2, o);
    setRefValue(this.out3, o);
  }

  Output(lfopitch, lfolevel) {
    this.calculateDeltaT(lfopitch);
    this.T = (this.T + this.DeltaT) | 0;

    const alpha = this.calculateAlpha(lfolevel, false);
    const sinTbl = this.m_contextImpl?.m_SINTBL;
    const phase = ((this.T + this.inp) >> PRECISION_BITS) & (SIZESINTBL - 1);
    const o = (alpha * readIntTable(sinTbl, phase)) | 0;

    addRefValue(this.out, o);
  }

  Output32(lfopitch, lfolevel) {
    this.calculateDeltaT(lfopitch);
    this.T = (this.T + this.DeltaT) | 0;

    let o = 0;
    if (this.NoiseCycle === 0) {
      const alpha = this.calculateAlpha(lfolevel, false);
      const sinTbl = this.m_contextImpl?.m_SINTBL;
      const phase = ((this.T + this.inp) >> PRECISION_BITS) & (SIZESINTBL - 1);
      o = (alpha * readIntTable(sinTbl, phase)) | 0;
    } else {
      this.NoiseCounter -= this.NoiseStep;
      if (this.NoiseCounter <= 0) {
        this.NoiseValue = ((irnd(this.m_contextImpl) >> 30) & 2) - 1;
        this.NoiseCounter += this.NoiseCycle;
      }

      const alpha = this.calculateAlpha(lfolevel, true);
      o = (alpha * this.NoiseValue * MAXSINVAL) | 0;
    }

    addRefValue(this.out, o);
  }

  Output0_22(lfopitch, lfolevel) {
    this.Output0(lfopitch, lfolevel);
  }

  Output_22(lfopitch, lfolevel) {
    this.Output(lfopitch, lfolevel);
  }

  Output32_22(lfopitch, lfolevel) {
    this.Output32(lfopitch, lfolevel);
  }
}

export {
  Op,
  KEYON,
  ATACK,
  DECAY,
  SUSTAIN,
  SUSTAIN_MAX,
  RELEASE,
  RELEASE_MAX,
  CULC_DELTA_T,
  CULC_ALPHA,
};
