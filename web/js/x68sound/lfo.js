const N_CH = 8;

const SIZELFOTBL = 512;
const SIZELFOTBL_BITS = 9;
const LFOPRECISION = 4096;

const PMSMUL = Int32Array.from([0, 1, 2, 4, 8, 16, 32, 32]);
const PMSSHL = Int32Array.from([0, 0, 0, 0, 0, 0, 1, 2]);

function irnd(contextImpl) {
  const seed = contextImpl?.m_RandSeed ?? 1;
  const next = (Math.imul(seed >>> 0, 1566083941) + 1) >>> 0;
  contextImpl.m_RandSeed = next;
  return next;
}

class Lfo {
  constructor(contextImpl) {
    this.m_contextImpl = contextImpl;

    this.Pmsmul = new Int32Array(N_CH);
    this.Pmsshl = new Int32Array(N_CH);
    this.Ams = new Int32Array(N_CH);
    this.PmdPmsmul = new Int32Array(N_CH);

    this.Pmd = 0;
    this.Amd = 0;

    this.LfoStartingFlag = 0;
    this.LfoOverFlow = 0;
    this.LfoTime = 0;
    this.LfoTimeAdd = 0;
    this.LfoIdx = 0;
    this.LfoSmallCounter = 0;
    this.LfoSmallCounterStep = 0;
    this.Lfrq = 0;
    this.LfoWaveForm = 0;

    this.PmTblValue = 0;
    this.AmTblValue = 255;
    this.PmValue = new Int32Array(N_CH);
    this.AmValue = new Int32Array(N_CH);

    this.PmTbl0 = new Int16Array(SIZELFOTBL);
    this.PmTbl2 = new Int16Array(SIZELFOTBL);
    this.AmTbl0 = new Uint16Array(SIZELFOTBL);
    this.AmTbl2 = new Uint16Array(SIZELFOTBL);

    for (let i = 0; i < N_CH; i++) {
      this.Pmsmul[i] = 0;
      this.Pmsshl[i] = 0;
      this.Ams[i] = 31;
      this.PmdPmsmul[i] = 0;
      this.PmValue[i] = 0;
      this.AmValue[i] = 0;
    }

    for (let i = 0; i <= 127; i++) {
      this.PmTbl0[i] = i;
      this.PmTbl0[i + 128] = i - 127;
      this.PmTbl0[i + 256] = i;
      this.PmTbl0[i + 384] = i - 127;
    }
    for (let i = 0; i <= 255; i++) {
      this.AmTbl0[i] = 255 - i;
      this.AmTbl0[i + 256] = 255 - i;
    }

    for (let i = 0; i <= 127; i++) {
      this.PmTbl2[i] = i;
      this.PmTbl2[i + 128] = 127 - i;
      this.PmTbl2[i + 256] = -i;
      this.PmTbl2[i + 384] = i - 127;
    }
    for (let i = 0; i <= 255; i++) {
      this.AmTbl2[i] = 255 - i;
      this.AmTbl2[i + 256] = i;
    }
  }

  init() {
    const samprate = Math.max(1, this.m_contextImpl?.m_Samprate | 0);
    this.LfoTimeAdd = Math.trunc((LFOPRECISION * 62500) / samprate);
    this.LfoSmallCounter = 0;

    this.setLFRQ(0);
    this.setPMDAMD(0);
    this.setPMDAMD(128);
    this.setWaveForm(0);
    for (let ch = 0; ch < N_CH; ch++) {
      this.setPMSAMS(ch, 0);
    }
    this.lfoReset();
    this.lfoStart();
  }

  initSamprate() {
    const samprate = Math.max(1, this.m_contextImpl?.m_Samprate | 0);
    this.LfoTimeAdd = Math.trunc((LFOPRECISION * 62500) / samprate);
  }

  lfoReset() {
    this.LfoStartingFlag = 0;
    this.LfoIdx = 0;

    this.culcTblValue();
    this.culcAllPmValue();
    this.culcAllAmValue();
  }

  lfoStart() {
    this.LfoStartingFlag = 1;
  }

  setLFRQ(n) {
    this.Lfrq = n & 255;

    this.LfoSmallCounterStep = 16 + (this.Lfrq & 15);
    let shift = 15 - (this.Lfrq >> 4);
    if (shift === 0) {
      shift = 1;
      this.LfoSmallCounterStep <<= 1;
    }
    this.LfoOverFlow = (8 << shift) * LFOPRECISION;

    this.LfoTime = 0;
  }

  setPMDAMD(n) {
    if (n & 0x80) {
      this.Pmd = n & 0x7f;
      for (let ch = 0; ch < N_CH; ch++) {
        this.PmdPmsmul[ch] = this.Pmd * this.Pmsmul[ch];
      }
      this.culcAllPmValue();
    } else {
      this.Amd = n & 0x7f;
      this.culcAllAmValue();
    }
  }

  setWaveForm(n) {
    this.LfoWaveForm = n & 3;

    this.culcTblValue();
    this.culcAllPmValue();
    this.culcAllAmValue();
  }

  setPMSAMS(ch, n) {
    const channel = ch | 0;
    if (channel < 0 || channel >= N_CH) return;

    const pms = (n >> 4) & 7;
    this.Pmsmul[channel] = PMSMUL[pms];
    this.Pmsshl[channel] = PMSSHL[pms];
    this.PmdPmsmul[channel] = this.Pmd * this.Pmsmul[channel];
    this.culcPmValue(channel);

    this.Ams[channel] = ((n & 3) - 1) & 31;
    this.culcAmValue(channel);
  }

  update() {
    if (this.LfoStartingFlag === 0) return;

    this.LfoTime += this.LfoTimeAdd;
    if (this.LfoTime < this.LfoOverFlow) return;

    this.LfoTime = 0;
    this.LfoSmallCounter += this.LfoSmallCounterStep;

    switch (this.LfoWaveForm) {
      case 0: {
        const idxadd = this.LfoSmallCounter >> 4;
        this.LfoIdx = (this.LfoIdx + idxadd) & (SIZELFOTBL - 1);
        this.PmTblValue = this.PmTbl0[this.LfoIdx];
        this.AmTblValue = this.AmTbl0[this.LfoIdx];
        break;
      }
      case 1: {
        const idxadd = this.LfoSmallCounter >> 4;
        this.LfoIdx = (this.LfoIdx + idxadd) & (SIZELFOTBL - 1);
        if ((this.LfoIdx & ((SIZELFOTBL / 2) - 1)) < (SIZELFOTBL / 4)) {
          this.PmTblValue = 128;
          this.AmTblValue = 256;
        } else {
          this.PmTblValue = -128;
          this.AmTblValue = 0;
        }
        break;
      }
      case 2: {
        const idxadd = this.LfoSmallCounter >> 4;
        this.LfoIdx = (this.LfoIdx + idxadd + idxadd) & (SIZELFOTBL - 1);
        this.PmTblValue = this.PmTbl2[this.LfoIdx];
        this.AmTblValue = this.AmTbl2[this.LfoIdx];
        break;
      }
      case 3: {
        this.LfoIdx = irnd(this.m_contextImpl) >>> (32 - SIZELFOTBL_BITS);
        this.PmTblValue = this.PmTbl0[this.LfoIdx];
        this.AmTblValue = this.AmTbl0[this.LfoIdx];
        break;
      }
      default:
        break;
    }

    this.LfoSmallCounter &= 15;

    this.culcAllPmValue();
    this.culcAllAmValue();
  }

  getPmValue(ch) {
    const channel = ch | 0;
    if (channel < 0 || channel >= N_CH) return 0;
    return this.PmValue[channel] | 0;
  }

  getAmValue(ch) {
    const channel = ch | 0;
    if (channel < 0 || channel >= N_CH) return 0;
    return this.AmValue[channel] | 0;
  }

  culcTblValue() {
    switch (this.LfoWaveForm) {
      case 0:
        this.PmTblValue = this.PmTbl0[this.LfoIdx];
        this.AmTblValue = this.AmTbl0[this.LfoIdx];
        break;
      case 1:
        if ((this.LfoIdx & ((SIZELFOTBL / 2) - 1)) < (SIZELFOTBL / 4)) {
          this.PmTblValue = 128;
          this.AmTblValue = 256;
        } else {
          this.PmTblValue = -128;
          this.AmTblValue = 0;
        }
        break;
      case 2:
        this.PmTblValue = this.PmTbl2[this.LfoIdx];
        this.AmTblValue = this.AmTbl2[this.LfoIdx];
        break;
      case 3:
        this.PmTblValue = this.PmTbl0[this.LfoIdx];
        this.AmTblValue = this.AmTbl0[this.LfoIdx];
        break;
      default:
        break;
    }
  }

  culcPmValue(ch) {
    const channel = ch | 0;
    if (channel < 0 || channel >= N_CH) return;

    if (this.PmTblValue >= 0) {
      this.PmValue[channel] = (
        ((this.PmTblValue * this.PmdPmsmul[channel]) >> (7 + 5)) << this.Pmsshl[channel]
      ) | 0;
    } else {
      this.PmValue[channel] = -(
        (((-this.PmTblValue) * this.PmdPmsmul[channel]) >> (7 + 5)) << this.Pmsshl[channel]
      );
    }
  }

  culcAmValue(ch) {
    const channel = ch | 0;
    if (channel < 0 || channel >= N_CH) return;

    this.AmValue[channel] = ((((this.AmTblValue * this.Amd) >> 7) << this.Ams[channel]) & 0x7fffffff) | 0;
  }

  culcAllPmValue() {
    for (let ch = 0; ch < N_CH; ch++) {
      this.culcPmValue(ch);
    }
  }

  culcAllAmValue() {
    for (let ch = 0; ch < N_CH; ch++) {
      this.culcAmValue(ch);
    }
  }
}

export {
  Lfo,
  N_CH,
  SIZELFOTBL,
  SIZELFOTBL_BITS,
  LFOPRECISION,
  PMSMUL,
  PMSSHL,
};
