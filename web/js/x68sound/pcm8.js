const NO_DATA = -2147483648;
const MAX_PCM_VALUE = 2047;
const ADPCM_RATE_BASE = 15625 * 12;

const DLT_L_TABLE = Int32Array.from([
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
  73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
]);

const DCT = Int32Array.from([
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
]);

const ADPCM_RATE_ADD_TABLE = Int32Array.from([
  46875, 62500, 93750, 125000, ADPCM_RATE_BASE, ADPCM_RATE_BASE, ADPCM_RATE_BASE, 0,
]);

const PCM8_VOLUME_TABLE = Int32Array.from([
  2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80,
]);

function toS8(v) {
  const n = v & 0xff;
  return (n & 0x80) ? (n - 0x100) : n;
}

function toS16(v) {
  const n = v & 0xffff;
  return (n & 0x8000) ? (n - 0x10000) : n;
}

function toOffset(value) {
  if (!Number.isFinite(value)) return 0;
  return value >>> 0;
}

class Pcm8Channel {
  constructor(contextImpl) {
    this.m_contextImpl = contextImpl;

    this.Scale = 0;
    this.Pcm = 0;
    this.Pcm16Prev = 0;
    this.InpPcm = 0;
    this.InpPcmPrev = 0;
    this.OutPcm = 0;
    this.OutInpPcm = 0;
    this.OutInpPcmPrev = 0;
    this.AdpcmRate = ADPCM_RATE_BASE;
    this.RateCounter = 0;
    this.N1Data = 0;
    this.N1DataFlag = 0;

    this.Mode = 0x00080403;
    this.Volume = 16;
    this.PcmKind = 4;

    this.DmaLastValue = 0;
    this.AdpcmReg = 0xc7;
    this.DmaMar = 0;
    this.DmaMtc = 0;
    this.DmaBar = 0;
    this.DmaBtc = 0;
    this.DmaOcr = 0;

    this.setMode(this.Mode);
    this.init();
  }

  memRead(addr) {
    const impl = this.m_contextImpl;
    if (!impl || typeof impl.m_MemRead !== 'function') return -1;
    const value = impl.m_MemRead(addr >>> 0);
    if (!Number.isFinite(value)) return -1;
    return value | 0;
  }

  init() {
    this.AdpcmReg = 0xc7;

    this.Scale = 0;
    this.Pcm = 0;
    this.Pcm16Prev = 0;
    this.InpPcm = 0;
    this.InpPcmPrev = 0;
    this.OutPcm = 0;
    this.OutInpPcm = 0;
    this.OutInpPcmPrev = 0;
    this.AdpcmRate = ADPCM_RATE_BASE;
    this.RateCounter = 0;
    this.N1Data = 0;
    this.N1DataFlag = 0;
    this.DmaLastValue = 0;

    this.DmaMar = 0;
    this.DmaMtc = 0;
    this.DmaBar = 0;
    this.DmaBtc = 0;
    this.DmaOcr = 0;
  }

  initSamprate() {
    this.RateCounter = 0;
  }

  reset() {
    this.Scale = 0;
    this.Pcm = 0;
    this.Pcm16Prev = 0;
    this.InpPcm = 0;
    this.InpPcmPrev = 0;
    this.OutPcm = 0;
    this.OutInpPcm = 0;
    this.OutInpPcmPrev = 0;

    this.N1Data = 0;
    this.N1DataFlag = 0;
  }

  dmaArrayChainSetNextMtcMar() {
    if ((this.DmaBtc >>> 0) === 0) {
      return 1;
    }
    this.DmaBtc = (this.DmaBtc - 1) >>> 0;

    const mem0 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem1 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem2 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem3 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem4 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem5 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;

    if ((mem0 | mem1 | mem2 | mem3 | mem4 | mem5) === -1) {
      return 1;
    }

    this.DmaMar = (
      ((mem0 & 0xff) * 0x1000000)
      + ((mem1 & 0xff) << 16)
      + ((mem2 & 0xff) << 8)
      + (mem3 & 0xff)
    ) >>> 0;
    this.DmaMtc = (((mem4 & 0xff) << 8) | (mem5 & 0xff)) >>> 0;

    if (this.DmaMtc === 0) {
      return 1;
    }
    return 0;
  }

  dmaLinkArrayChainSetNextMtcMar() {
    if ((this.DmaBar >>> 0) === 0) {
      return 1;
    }

    const mem0 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem1 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem2 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem3 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem4 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem5 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem6 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem7 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem8 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;
    const mem9 = this.memRead(this.DmaBar);
    this.DmaBar = (this.DmaBar + 1) >>> 0;

    if ((mem0 | mem1 | mem2 | mem3 | mem4 | mem5 | mem6 | mem7 | mem8 | mem9) === -1) {
      return 1;
    }

    this.DmaMar = (
      ((mem0 & 0xff) * 0x1000000)
      + ((mem1 & 0xff) << 16)
      + ((mem2 & 0xff) << 8)
      + (mem3 & 0xff)
    ) >>> 0;
    this.DmaMtc = (((mem4 & 0xff) << 8) | (mem5 & 0xff)) >>> 0;
    this.DmaBar = (
      ((mem6 & 0xff) * 0x1000000)
      + ((mem7 & 0xff) << 16)
      + ((mem8 & 0xff) << 8)
      + (mem9 & 0xff)
    ) >>> 0;

    if (this.DmaMtc === 0) {
      return 1;
    }
    return 0;
  }

  dmaGetByte() {
    if ((this.DmaMtc >>> 0) === 0) {
      return NO_DATA;
    }

    const mem = this.memRead(this.DmaMar);
    if (mem === -1) {
      return NO_DATA;
    }
    this.DmaLastValue = mem & 0xff;
    this.DmaMar = (this.DmaMar + 1) >>> 0;
    this.DmaMtc = (this.DmaMtc - 1) >>> 0;

    if (this.DmaMtc === 0 && (this.DmaOcr & 0x08)) {
      if ((this.DmaOcr & 0x04) === 0) {
        this.dmaArrayChainSetNextMtcMar();
      } else {
        this.dmaLinkArrayChainSetNextMtcMar();
      }
    }

    return this.DmaLastValue & 0xff;
  }

  adpcm2pcm(adpcm) {
    const nibble = adpcm & 0x0f;
    let dltL = DLT_L_TABLE[this.Scale];
    dltL = (dltL & ((nibble & 4) ? -1 : 0))
      + ((dltL >> 1) & ((nibble & 2) ? -1 : 0))
      + ((dltL >> 2) & ((nibble & 1) ? -1 : 0))
      + (dltL >> 3);

    const sign = (nibble & 8) ? -1 : 0;
    dltL = (dltL ^ sign) + (sign & 1);
    this.Pcm = (this.Pcm + dltL) | 0;

    if (this.Pcm > MAX_PCM_VALUE) {
      this.Pcm = MAX_PCM_VALUE;
    } else if (this.Pcm < -MAX_PCM_VALUE) {
      this.Pcm = -MAX_PCM_VALUE;
    }

    this.InpPcm = ((this.Pcm & 0xfffffffc) << 8) | 0;

    this.Scale = (this.Scale + DCT[nibble]) | 0;
    if (this.Scale > 48) {
      this.Scale = 48;
    } else if (this.Scale < 0) {
      this.Scale = 0;
    }
  }

  pcm16ToPcm(pcm16) {
    this.Pcm = (this.Pcm + ((pcm16 | 0) - (this.Pcm16Prev | 0))) | 0;
    this.Pcm16Prev = pcm16 | 0;

    if (this.Pcm > MAX_PCM_VALUE) {
      this.Pcm = MAX_PCM_VALUE;
    } else if (this.Pcm < -MAX_PCM_VALUE) {
      this.Pcm = -MAX_PCM_VALUE;
    }

    this.InpPcm = ((this.Pcm & 0xfffffffc) << 8) | 0;
  }

  getPcm() {
    if (this.AdpcmReg & 0x80) {
      return NO_DATA;
    }

    this.RateCounter = (this.RateCounter - this.AdpcmRate) | 0;
    while (this.RateCounter < 0) {
      if (this.PcmKind === 5) {
        const dataH = this.dmaGetByte();
        if (dataH === NO_DATA) {
          this.RateCounter = 0;
          this.AdpcmReg = 0xc7;
          return NO_DATA;
        }
        const dataL = this.dmaGetByte();
        if (dataL === NO_DATA) {
          this.RateCounter = 0;
          this.AdpcmReg = 0xc7;
          return NO_DATA;
        }
        this.pcm16ToPcm(toS16(((dataH & 0xff) << 8) | (dataL & 0xff)));
      } else if (this.PcmKind === 6) {
        const data = this.dmaGetByte();
        if (data === NO_DATA) {
          this.RateCounter = 0;
          this.AdpcmReg = 0xc7;
          return NO_DATA;
        }
        this.pcm16ToPcm(toS8(data));
      } else {
        if (this.N1DataFlag === 0) {
          const packed = this.dmaGetByte();
          if (packed === NO_DATA) {
            this.RateCounter = 0;
            this.AdpcmReg = 0xc7;
            return NO_DATA;
          }
          this.adpcm2pcm(packed & 0x0f);
          this.N1Data = (packed >> 4) & 0x0f;
          this.N1DataFlag = 1;
        } else {
          this.adpcm2pcm(this.N1Data & 0x0f);
          this.N1DataFlag = 0;
        }
      }

      this.RateCounter = (this.RateCounter + ADPCM_RATE_BASE) | 0;
    }

    this.OutPcm = (
      ((this.InpPcm << 9) - (this.InpPcmPrev << 9) + 459 * this.OutPcm) >> 9
    ) | 0;
    this.InpPcmPrev = this.InpPcm | 0;

    const totalVolume = this.m_contextImpl ? (this.m_contextImpl.m_TotalVolume | 0) : 0;
    return ((((this.OutPcm * this.Volume) >> 4) * totalVolume) >> 8) | 0;
  }

  getPcm62() {
    if (this.AdpcmReg & 0x80) {
      return NO_DATA;
    }

    this.RateCounter = (this.RateCounter - this.AdpcmRate) | 0;
    while (this.RateCounter < 0) {
      if (this.PcmKind === 5) {
        const dataH = this.dmaGetByte();
        if (dataH === NO_DATA) {
          this.RateCounter = 0;
          this.AdpcmReg = 0xc7;
          return NO_DATA;
        }
        const dataL = this.dmaGetByte();
        if (dataL === NO_DATA) {
          this.RateCounter = 0;
          this.AdpcmReg = 0xc7;
          return NO_DATA;
        }
        this.pcm16ToPcm(toS16(((dataH & 0xff) << 8) | (dataL & 0xff)));
      } else if (this.PcmKind === 6) {
        const data = this.dmaGetByte();
        if (data === NO_DATA) {
          this.RateCounter = 0;
          this.AdpcmReg = 0xc7;
          return NO_DATA;
        }
        this.pcm16ToPcm(toS8(data));
      } else {
        if (this.N1DataFlag === 0) {
          const packed = this.dmaGetByte();
          if (packed === NO_DATA) {
            this.RateCounter = 0;
            this.AdpcmReg = 0xc7;
            return NO_DATA;
          }
          this.adpcm2pcm(packed & 0x0f);
          this.N1Data = (packed >> 4) & 0x0f;
          this.N1DataFlag = 1;
        } else {
          this.adpcm2pcm(this.N1Data & 0x0f);
          this.N1DataFlag = 0;
        }
      }

      this.RateCounter = (this.RateCounter + ADPCM_RATE_BASE * 4) | 0;
    }

    this.OutInpPcm = (
      (this.InpPcm << 9)
      - (this.InpPcmPrev << 9)
      + this.OutInpPcm
      - (this.OutInpPcm >> 5)
      - (this.OutInpPcm >> 10)
    ) | 0;
    this.InpPcmPrev = this.InpPcm | 0;
    this.OutPcm = (
      this.OutInpPcm
      - this.OutInpPcmPrev
      + this.OutPcm
      - (this.OutPcm >> 8)
      - (this.OutPcm >> 9)
      - (this.OutPcm >> 12)
    ) | 0;
    this.OutInpPcmPrev = this.OutInpPcm | 0;
    return (((this.OutPcm >> 9) * this.Volume) >> 4) | 0;
  }

  out(adrs, mode, len) {
    const sampleLen = len | 0;
    if (sampleLen <= 0) {
      if (sampleLen < 0) {
        return this.getRest();
      }
      this.DmaMtc = 0;
      return 0;
    }

    this.AdpcmReg = 0xc7;
    this.DmaMtc = 0;
    this.DmaMar = toOffset(adrs);
    this.setMode(mode);
    if ((mode & 3) !== 0) {
      this.DmaMtc = sampleLen >>> 0;
      this.reset();
      this.AdpcmReg = 0x47;
    }
    return 0;
  }

  aot(tbl, mode, cnt) {
    const chainCount = cnt | 0;
    if (chainCount <= 0) {
      if (chainCount < 0) {
        return this.getRest();
      }
      this.DmaMtc = 0;
      return 0;
    }

    this.AdpcmReg = 0xc7;
    this.DmaMtc = 0;
    this.DmaBar = toOffset(tbl);
    this.DmaBtc = chainCount >>> 0;
    this.setMode(mode);
    if ((mode & 3) !== 0) {
      this.dmaArrayChainSetNextMtcMar();
      this.reset();
      this.AdpcmReg = 0x47;
    }
    return 0;
  }

  lot(tbl, mode) {
    this.AdpcmReg = 0xc7;
    this.DmaMtc = 0;
    this.DmaBar = toOffset(tbl);
    this.setMode(mode);
    if ((mode & 3) !== 0) {
      this.dmaLinkArrayChainSetNextMtcMar();
      this.reset();
      this.AdpcmReg = 0x47;
    }
    return 0;
  }

  setMode(mode) {
    let m = (mode >> 16) & 0xff;
    if (m !== 0xff) {
      m &= 0x0f;
      this.Volume = PCM8_VOLUME_TABLE[m] | 0;
      this.Mode = ((this.Mode & 0xff00ffff) | (m << 16)) | 0;
    }

    m = (mode >> 8) & 0xff;
    if (m !== 0xff) {
      m &= 0x07;
      this.AdpcmRate = ADPCM_RATE_ADD_TABLE[m] | 0;
      this.PcmKind = m;
      this.Mode = ((this.Mode & 0xffff00ff) | (m << 8)) | 0;
    }

    m = mode & 0xff;
    if (m !== 0xff) {
      m &= 0x03;
      if (m === 0) {
        this.AdpcmReg = 0xc7;
        this.DmaMtc = 0;
      } else {
        this.Mode = ((this.Mode & 0xffffff00) | m) | 0;
      }
    }

    return 0;
  }

  getRest() {
    if ((this.DmaMtc >>> 0) === 0) {
      return 0;
    }
    if (this.DmaOcr & 0x08) {
      if ((this.DmaOcr & 0x04) === 0) {
        return -1;
      }
      return -2;
    }
    return this.DmaMtc | 0;
  }

  getMode() {
    return this.Mode | 0;
  }
}

export {
  Pcm8Channel,
  NO_DATA,
};
