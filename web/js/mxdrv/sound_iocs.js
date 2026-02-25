import {
  X68Sound_OpmPeek,
  X68Sound_OpmReg,
  X68Sound_OpmPoke,
  X68Sound_OpmInt,
  X68Sound_DmaPeek,
  X68Sound_DmaPoke,
  X68Sound_DmaInt,
  X68Sound_DmaErrInt,
  X68Sound_PpiPeek,
  X68Sound_PpiPoke,
  X68Sound_PpiCtrl,
  X68Sound_AdpcmPoke,
  X68Sound_InternalTriggerDmaInt,
} from '../x68sound/index.js';
import { MxdrvContext } from './context.js';

const PANTBL = Uint8Array.from([3, 1, 2, 0]);

function ensureContext(context) {
  if (!(context instanceof MxdrvContext)) {
    throw new Error('context must be MxdrvContext');
  }
  if (!context.m_impl || !context.m_impl.m_x68SoundContext) {
    throw new Error('MxdrvContext is not initialized');
  }
}

function toOffset(addr) {
  if (typeof addr === 'number') return addr >>> 0;
  if (addr && typeof addr.offset === 'number') return addr.offset >>> 0;
  throw new Error('addr must be numeric offset');
}

function x68(context) {
  return context.m_impl.m_x68SoundContext;
}

function dmaPokeW(context, adrs, data) {
  X68Sound_DmaPoke(x68(context), adrs, (data >>> 8) & 0xff);
  X68Sound_DmaPoke(x68(context), adrs + 1, data & 0xff);
}

function dmaPokeL(context, adrs, data) {
  X68Sound_DmaPoke(x68(context), adrs, (data >>> 24) & 0xff);
  X68Sound_DmaPoke(x68(context), adrs + 1, (data >>> 16) & 0xff);
  X68Sound_DmaPoke(x68(context), adrs + 2, (data >>> 8) & 0xff);
  X68Sound_DmaPoke(x68(context), adrs + 3, data & 0xff);
}

function waitForAdpcmIdle(context) {
  let guard = 0;
  while (context.m_impl.m_AdpcmStat) {
    const beforeStat = context.m_impl.m_AdpcmStat;
    const beforeLen = context.m_impl.m_Adpcmcot_len;
    const triggered = X68Sound_InternalTriggerDmaInt(x68(context));

    guard += 1;
    if (!triggered) {
      context.m_impl.m_AdpcmStat = 0;
      break;
    }
    if (guard > 4096) {
      throw new Error('ADPCM busy wait overflow');
    }
    if (
      context.m_impl.m_AdpcmStat === beforeStat &&
      context.m_impl.m_Adpcmcot_len === beforeLen
    ) {
      context.m_impl.m_AdpcmStat = 0;
      break;
    }
  }
}

function OpmWait_(context) {
  while (X68Sound_OpmPeek(x68(context)) & 0x80) {
    // Busy wait to match IOCS semantics.
  }
}

function _iocs_opmset(context, addr, data) {
  ensureContext(context);
  const reg = addr & 0xff;
  let val = data & 0xff;

  if (reg === 0x1b) {
    context.m_impl.m_OpmReg1B = (context.m_impl.m_OpmReg1B & 0xc0) | (val & 0x3f);
    val = context.m_impl.m_OpmReg1B;
  }

  OpmWait_(context);
  X68Sound_OpmReg(x68(context), reg);
  OpmWait_(context);
  X68Sound_OpmPoke(x68(context), val);

  context.m_impl.m_opmRegs[reg] = val;
  context.m_impl.m_opmRegsUpdated[reg] = true;

  if (reg === 0x08) {
    const ch = val & 0x07;
    const keyOn = (val & 0x78) !== 0;
    context.m_impl.m_keyOnFlagsForFm[ch] = keyOn;
    context.m_impl.m_logicalSumOfKeyOnFlagsForFm[ch] ||= keyOn;
  }
}

function _iocs_opmsns(context) {
  ensureContext(context);
  return X68Sound_OpmPeek(x68(context));
}

function _iocs_opmintst(context, addr, arg) {
  ensureContext(context);

  if (!addr) {
    context.m_impl.m_OpmIntProc = null;
    context.m_impl.m_OpmIntArg = null;
    X68Sound_OpmInt(x68(context), null, null);
    return 0;
  }

  if (context.m_impl.m_OpmIntProc) {
    return context.m_impl.m_OpmIntProc;
  }

  context.m_impl.m_OpmIntProc = addr;
  context.m_impl.m_OpmIntArg = arg ?? null;
  X68Sound_OpmInt(x68(context), context.m_impl.m_OpmIntProc, context.m_impl.m_OpmIntArg);
  return 0;
}

function DmaIntProc(arg) {
  const context = arg;
  if (!context || !context.m_impl) return;

  const csr = X68Sound_DmaPeek(x68(context), 0x00);

  if (context.m_impl.m_AdpcmStat === 0x32 && (csr & 0x40) !== 0) {
    X68Sound_DmaPoke(x68(context), 0x00, 0x40);
    if (context.m_impl.m_Adpcmcot_len > 0) {
      let dmalen = context.m_impl.m_Adpcmcot_len;
      if (dmalen > 0xff00) dmalen = 0xff00;

      dmaPokeL(context, 0x1c, toOffset(context.m_impl.m_Adpcmcot_adrs));
      dmaPokeW(context, 0x1a, dmalen);

      context.m_impl.m_Adpcmcot_adrs = (toOffset(context.m_impl.m_Adpcmcot_adrs) + dmalen) >>> 0;
      context.m_impl.m_Adpcmcot_len -= dmalen;

      X68Sound_DmaPoke(x68(context), 0x07, 0x48);
    }
    return;
  }

  if ((context.m_impl.m_AdpcmStat & 0x80) === 0) {
    X68Sound_PpiCtrl(x68(context), 0x01);
    X68Sound_PpiCtrl(x68(context), 0x03);
    X68Sound_AdpcmPoke(x68(context), 0x01);
  }

  context.m_impl.m_AdpcmStat = 0;
  X68Sound_DmaPoke(x68(context), 0x00, 0xff);
}

function DmaErrIntProc(arg) {
  const context = arg;
  if (!context || !context.m_impl) return;

  context.m_impl.m_DmaErrCode = X68Sound_DmaPeek(x68(context), 0x01);

  X68Sound_PpiCtrl(x68(context), 0x01);
  X68Sound_PpiCtrl(x68(context), 0x03);
  X68Sound_AdpcmPoke(x68(context), 0x01);

  context.m_impl.m_AdpcmStat = 0;
  X68Sound_DmaPoke(x68(context), 0x00, 0xff);
}

function SetAdpcmMode(context, mode, ccr) {
  let localMode = mode & 0xffff;

  if (localMode >= 0x0200) {
    localMode -= 0x0200;
    context.m_impl.m_OpmReg1B &= 0x7f;
  } else {
    context.m_impl.m_OpmReg1B |= 0x80;
  }

  OpmWait_(context);
  X68Sound_OpmReg(x68(context), 0x1b);
  OpmWait_(context);
  X68Sound_OpmPoke(x68(context), context.m_impl.m_OpmReg1B & 0xff);

  const pan = PANTBL[localMode & 0x03];
  let ppireg = (((localMode >> 6) & 0x0c) | pan) & 0x0f;
  ppireg |= X68Sound_PpiPeek(x68(context)) & 0xf0;

  X68Sound_DmaPoke(x68(context), 0x07, ccr & 0xff);
  X68Sound_PpiPoke(x68(context), ppireg);
}

function AdpcmoutMain(context, stat, mode, len, adrs) {
  waitForAdpcmIdle(context);

  context.m_impl.m_AdpcmStat = ((stat & 0xff) + 2) & 0xff;

  X68Sound_DmaPoke(x68(context), 0x05, 0x32);
  X68Sound_DmaPoke(x68(context), 0x00, 0xff);
  dmaPokeL(context, 0x0c, toOffset(adrs));
  dmaPokeW(context, 0x0a, len & 0xffff);
  SetAdpcmMode(context, mode, 0x88);
  X68Sound_AdpcmPoke(x68(context), 0x02);
}

function _iocs_adpcmout(context, addr, mode, len) {
  ensureContext(context);

  let remaining = len | 0;
  let dmaadrs = toOffset(addr);

  waitForAdpcmIdle(context);

  while (remaining > 0xff00) {
    AdpcmoutMain(context, 0x80, mode, 0xff00, dmaadrs);
    dmaadrs = (dmaadrs + 0xff00) >>> 0;
    remaining -= 0xff00;
  }

  AdpcmoutMain(context, 0x00, mode, remaining, dmaadrs);
}

function _iocs_adpcmaot(context, tbl, mode, cnt) {
  ensureContext(context);

  waitForAdpcmIdle(context);

  context.m_impl.m_AdpcmStat = 0x12;
  X68Sound_DmaPoke(x68(context), 0x05, 0x3a);
  X68Sound_DmaPoke(x68(context), 0x00, 0xff);
  dmaPokeL(context, 0x1c, toOffset(tbl));
  dmaPokeW(context, 0x1a, cnt & 0xffff);
  SetAdpcmMode(context, mode, 0x88);
  X68Sound_AdpcmPoke(x68(context), 0x02);
}

function _iocs_adpcmlot(context, tbl, mode) {
  ensureContext(context);

  waitForAdpcmIdle(context);

  context.m_impl.m_AdpcmStat = 0x22;
  X68Sound_DmaPoke(x68(context), 0x05, 0x3e);
  X68Sound_DmaPoke(x68(context), 0x00, 0xff);
  dmaPokeL(context, 0x1c, toOffset(tbl));
  SetAdpcmMode(context, mode, 0x88);
  X68Sound_AdpcmPoke(x68(context), 0x02);
}

function _iocs_adpcmcot(context, addr, mode, len) {
  ensureContext(context);

  context.m_impl.m_Adpcmcot_adrs = toOffset(addr);
  context.m_impl.m_Adpcmcot_len = len | 0;
  waitForAdpcmIdle(context);
  context.m_impl.m_AdpcmStat = 0x32;

  X68Sound_DmaPoke(x68(context), 0x05, 0x32);

  let dmalen = context.m_impl.m_Adpcmcot_len;
  if (dmalen > 0xff00) dmalen = 0xff00;

  X68Sound_DmaPoke(x68(context), 0x00, 0xff);
  dmaPokeL(context, 0x0c, toOffset(context.m_impl.m_Adpcmcot_adrs));
  dmaPokeW(context, 0x0a, dmalen);

  context.m_impl.m_Adpcmcot_adrs = (toOffset(context.m_impl.m_Adpcmcot_adrs) + dmalen) >>> 0;
  context.m_impl.m_Adpcmcot_len -= dmalen;

  if (context.m_impl.m_Adpcmcot_len <= 0) {
    SetAdpcmMode(context, mode, 0x88);
  } else {
    dmalen = context.m_impl.m_Adpcmcot_len;
    if (dmalen > 0xff00) dmalen = 0xff00;
    dmaPokeL(context, 0x1c, toOffset(context.m_impl.m_Adpcmcot_adrs));
    dmaPokeW(context, 0x1a, dmalen);

    context.m_impl.m_Adpcmcot_adrs = (toOffset(context.m_impl.m_Adpcmcot_adrs) + dmalen) >>> 0;
    context.m_impl.m_Adpcmcot_len -= dmalen;
    SetAdpcmMode(context, mode, 0xc8);
  }

  X68Sound_AdpcmPoke(x68(context), 0x02);
}

function _iocs_adpcmsns(context) {
  ensureContext(context);
  return context.m_impl.m_AdpcmStat & 0x7f;
}

function _iocs_adpcmmod(context, mode) {
  ensureContext(context);

  switch (mode | 0) {
    case 0:
      context.m_impl.m_AdpcmStat = 0;
      X68Sound_PpiCtrl(x68(context), 0x01);
      X68Sound_PpiCtrl(x68(context), 0x03);
      X68Sound_AdpcmPoke(x68(context), 0x01);
      X68Sound_DmaPoke(x68(context), 0x07, 0x10);
      break;
    case 1:
      X68Sound_DmaPoke(x68(context), 0x07, 0x20);
      break;
    case 2:
      X68Sound_DmaPoke(x68(context), 0x07, 0x08);
      break;
    default:
      break;
  }
}

function sound_iocs_init(context) {
  ensureContext(context);
  X68Sound_DmaInt(x68(context), DmaIntProc, context);
  X68Sound_DmaErrInt(x68(context), DmaErrIntProc, context);
}

export {
  sound_iocs_init,
  _iocs_opmset,
  _iocs_opmsns,
  _iocs_opmintst,
  _iocs_adpcmout,
  _iocs_adpcmaot,
  _iocs_adpcmlot,
  _iocs_adpcmcot,
  _iocs_adpcmsns,
  _iocs_adpcmmod,
  DmaIntProc,
  DmaErrIntProc,
  SetAdpcmMode,
  AdpcmoutMain,
};
