/**
 * Recreates the MXWORK_* structs from include/mxdrv.h using plain JS objects.
 * Using factory helpers keeps the driver port readable even without raw memory.
 */

function createMxWorkCh() {
  return {
    S0000: 0,
    S0004_b: 0,
    S0004: 0,
    S0008: 0,
    S000c: 0,
    S0010: 0,
    S0012: 0,
    S0014: 0,
    S0016: 0,
    S0017: 0,
    S0018: 0,
    S0019: 0,
    S001a: 0,
    S001b: 0,
    S001c: 0,
    S001d: 0,
    S001e: 0,
    S001f: 0,
    S0020: 0,
    S0021: 0,
    S0022: 0,
    S0023: 0,
    S0024: 0,
    S0025: 0,
    S0026: 0,
    S002a: 0,
    S002e: 0,
    S0032: 0,
    S0036: 0,
    S003a: 0,
    S003c: 0,
    S003e: 0,
    S0040: 0,
    S0044: 0,
    S0046: 0,
    S0048: 0,
    S004a: 0,
    S004c: 0,
    S004e: 0,
  };
}

function resetMxWorkCh(ch) {
  Object.keys(ch).forEach((key) => {
    ch[key] = 0;
  });
}

function createMxWorkGlobal() {
  return {
    L001ba6: 0,
    L001ba8: 0,
    L001bac: 0,
    L001bb4: new Uint8Array(16),
    L001df4: 0,
    L001df6: new Uint8Array(16),
    L001e06: 0,
    L001e08: 0,
    L001e09: 0,
    L001e0a: 0,
    L001e0b: 0,
    L001e0c: 0,
    L001e0d: 0,
    L001e0e: 0,
    L001e10: 0,
    L001e12: 0,
    L001e13: 0,
    L001e14: 0,
    L001e15: 0,
    L001e17: 0,
    L001e18: 0,
    L001e19: 0,
    L001e1a: 0,
    L001e1c: 0,
    L001e1e: new Uint16Array(2),
    L001e22: 0,
    L001e24: 0,
    L001e28: 0,
    L001e2c: 0,
    L001e30: 0,
    L001e34: 0,
    L001e38: 0,
    L00220c: 0,
    L002218: 0,
    L00221c: 0,
    L002220: 0,
    L002224: 0,
    L002228: 0,
    L00222c: 0,
    L002230: 0,
    L002231: 0,
    L002232: 0,
    L002233: new Uint8Array(9),
    L00223c: new Uint8Array(12),
    L002245: 0,
    L002246: 0,
    FATALERROR: 0,
    FATALERRORADR: 0,
    PLAYTIME: 0,
    MUSICTIMER: 0,
    STOPMUSICTIMER: 0,
    MEASURETIMELIMIT: 0,
  };
}

function resetMxWorkGlobal(global) {
  global.L001ba6 = 0;
  global.L001ba8 = 0;
  global.L001bac = 0;
  global.L001bb4.fill(0);
  global.L001df4 = 0;
  global.L001df6.fill(0);
  global.L001e06 = 0;
  global.L001e08 = 0;
  global.L001e09 = 0;
  global.L001e0a = 0;
  global.L001e0b = 0;
  global.L001e0c = 0;
  global.L001e0d = 0;
  global.L001e0e = 0;
  global.L001e10 = 0;
  global.L001e12 = 0;
  global.L001e13 = 0;
  global.L001e14 = 0;
  global.L001e15 = 0;
  global.L001e17 = 0;
  global.L001e18 = 0;
  global.L001e19 = 0;
  global.L001e1a = 0;
  global.L001e1c = 0;
  global.L001e1e.fill(0);
  global.L001e22 = 0;
  global.L001e24 = 0;
  global.L001e28 = 0;
  global.L001e2c = 0;
  global.L001e30 = 0;
  global.L001e34 = 0;
  global.L001e38 = 0;
  global.L00220c = 0;
  global.L002218 = 0;
  global.L00221c = 0;
  global.L002220 = 0;
  global.L002224 = 0;
  global.L002228 = 0;
  global.L00222c = 0;
  global.L002230 = 0;
  global.L002231 = 0;
  global.L002232 = 0;
  global.L002233.fill(0);
  global.L00223c.fill(0);
  global.L002245 = 0;
  global.L002246 = 0;
  global.FATALERROR = 0;
  global.FATALERRORADR = 0;
  global.PLAYTIME = 0;
  global.MUSICTIMER = 0;
  global.STOPMUSICTIMER = 0;
  global.MEASURETIMELIMIT = 0;
}

function createMxWorkKey() {
  return {
    OPT1: 0,
    OPT2: 0,
    SHIFT: 0,
    CTRL: 0,
    XF3: 0,
    XF4: 0,
    XF5: 0,
  };
}

function resetMxWorkKey(key) {
  key.OPT1 = 0;
  key.OPT2 = 0;
  key.SHIFT = 0;
  key.CTRL = 0;
  key.XF3 = 0;
  key.XF4 = 0;
  key.XF5 = 0;
}

function createMxWorkOpm() {
  return new Uint8Array(256);
}

export {
  createMxWorkCh,
  resetMxWorkCh,
  createMxWorkGlobal,
  resetMxWorkGlobal,
  createMxWorkKey,
  resetMxWorkKey,
  createMxWorkOpm,
};
