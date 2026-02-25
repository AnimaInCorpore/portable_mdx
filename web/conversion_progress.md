# C to JavaScript Conversion Progress

Last updated: 2026-02-25

## Scope

Track progress of the native C/C++ implementation under `src/` to the JavaScript port under `web/js/`.

## Porting Rules (from `web/architecture.md`)

- Keep it simple: prefer direct, maintainable ports over clever rewrites.
- No external dependencies for core runtime logic unless explicitly approved.
- Use browser-native tech only for web runtime and UI (HTML5/WebAudio/WebGL).
- Do not use Emscripten (or any native-to-WASM transpilation path).
- Keep runtime pure JS/Web APIs only: no WASM/asm.js blobs and no native-thread assumptions.
- Preserve behavior parity with native stack (`MDX+PDX` parsing, sequencing, synthesis, loop/fade behavior).
- Preserve deterministic audio behavior: scheduling must remain compatible with `AudioWorklet`-driven timing.
- Keep mapping traceable: each native translation unit should map to a clear JS module boundary.
- Preserve MXDRV label/function identity where practical (for example `L_0A` style naming) to aid verification.
- Maintain pointer-style semantics via typed arrays/offset helpers instead of rewriting core logic into unrelated abstractions.
- Keep IOCS-side behavior equivalent for OPM/DMA/ADPCM control paths.
- Update architecture mapping when introducing new JS modules so native-to-JS traceability is not lost.
- Verify conversion with the planned workflow: unit checks, native comparison harness, and manual browser regression.
- Log each conversion step in this file under **Recent Updates** with date and impacted files.

## Current Status

- [x] MDX utility layer ported (`src/mdx_util.c` -> `web/js/mdx_util.js`)
- [x] MXDRV context structures and memory-pool model ported
- [x] MXDRV core driver logic ported to `web/js/mxdrv/driver_core.js` (major label/function set present)
- [x] MXDRV IOCS bridge ported to `web/js/mxdrv/sound_iocs.js`
- [x] X68Sound context/wrapper layer ported
- [x] X68Sound PCM8/LFO/OPS/tables modules present in JS
- [ ] End-to-end native-vs-JS parity verification (register traces/audio fixtures)
- [ ] Browser runtime app/worklet/UI integration files from architecture plan
- [ ] Automated regression tests for converted runtime

## Recent Updates

- 2026-02-25: Aligned MXDRV memory-pool reset/release semantics with native portable C:
  - `MxdrvContextImpl.resetMemoryPool()` no longer clears pool bytes; it now only rewinds the reservation pointer.
  - `MxdrvContextImpl.releaseMemory()` no longer zeroes released ranges; it now only moves the reservation pointer.
  - This matches native `MxdrvContextImpl_ResetMemoryPool` / `MxdrvContextImpl_ReleaseMemory` behavior.
  - File:
    - `web/js/mxdrv/context_internal.js`

- 2026-02-25: Fixed a native parity bug in MXDRV FM/PCM volume handling (`mxdrv.cpp` `L000dfe` / `L000e7e` paths) that muted JS output:
  - Corrected bit-7 volume semantics to match native code:
    - clear bit 7 before evaluating `raw` vs table-mapped volume
    - use table-mapped path only when bit 7 is clear
  - Applied this in both FM TL update flow and PCM8 level flow.
  - Result: JS conversion output is no longer silent and now produces expected non-zero PCM amplitude.
  - File:
    - `web/js/mxdrv/driver_core.js`

- 2026-02-25: Ported native `x68sound_opm.cpp` PCM render/mix equations more directly into JS runtime:
  - Replaced simplified JS render path with native-style `pcmset62` / `pcmset22` behavior in `X68Sound_GetPcm`.
  - Added separate ADPCM decode/output paths matching native routines:
    - `GetPcm`-style (`22k`) filtering/volume path
    - `GetPcm62`-style (`62k` internal) filtering path
  - Ported native OPM post-processing differences by sample-rate path:
    - `62k` path high-pass + one-pole stage before FIR resampling
    - `22k` path IIR chain with native coefficient flow
  - Aligned PCM8 mixing gate to native `UseAdpcmFlag` behavior (PCM8 mixed only when ADPCM path is enabled).
  - File:
    - `web/js/x68sound/index.js`

- 2026-02-25: Ported native OPM low-pass FIR table path from `x68sound_global.h` / `x68sound_opm.cpp` into JS runtime:
  - Added JS low-pass coefficient tables converted from native assets:
    - `src/x68sound/opmlowpass_44.dat` -> `web/js/x68sound/opm_lowpass_tables.js`
    - `src/x68sound/opmlowpass_48.dat` -> `web/js/x68sound/opm_lowpass_tables.js`
  - Wired profile selection (`44.1k` / `48k`) to native row/table mapping in sample-rate profile setup.
  - Updated OPM render path to native-style resampling flow:
    - generate intermediate OPM samples at internal rate (`Samprate`)
    - push into 64-tap ring buffers
    - apply per-sample FIR with rotating `OPMLOWPASS` row phase
  - Updated context/reset state to allocate and clear FIR ring/phase state for deterministic restart behavior.
  - Files:
    - `web/js/x68sound/opm_lowpass_tables.js`
    - `web/js/x68sound/context.js`
    - `web/js/x68sound/index.js`

- 2026-02-25: Ported native `simple_mdx_player` visualizer behavior more directly into web runtime:
  - Extended AudioWorklet status payload to expose native-style runtime state snapshots:
    - OPM register values + per-register update flags
    - FM current-key state and FM/PCM logical key-on pulses
    - per-channel note, pitch-offset, key-active, and volume fields
  - Updated `web/js/app.js` canvas renderer to follow the native SDL visualization logic:
    - OPM 256-register bit-grid with update-decay coloring
    - FM/PCM key display with pitch-offset/key-on overlays
    - per-channel on/off level meters with native-like decay behavior
  - Added keyboard transport parity (`Space` pause/resume, `F` fadeout).
- 2026-02-25: Ported initial browser runtime/player from native `examples/simple_mdx_player/main.c` into web assets:
  - Added browser entry and UI shell:
    - `web/index.html`
    - `web/css/app.css`
    - `web/js/app.js`
  - Added AudioWorklet playback core:
    - `web/js/audio/worklet.js`
  - Implemented JS playback pipeline equivalent to native flow:
    - MDX/PDX file ingestion and auto PDX resolution by filename variants
    - MDX/PDX buffer construction via `mdx_util`
    - MXDRV init/load/play/stop/pause/resume/fadeout command bridge
    - Live playback status + channel meter visualization using runtime work-state
- 2026-02-25: Ported `examples/simple_mdx2wav/main.c` workflow to JavaScript CLI (`web/js/tools/simple_mdx2wav.mjs`):
  - Added Node-based MDX->WAV conversion flow using the JS runtime modules (`mdx_util`, `mxdrv`, `x68sound`).
  - Ported CLI behavior for `-i/-o` arguments, MDX title logging, optional PDX loading, playback-time measurement, and PCM rendering.
  - Added WAV serialization output (16-bit stereo, 48kHz) equivalent to native converter output format.
- 2026-02-25: Ported core OPM execution/mixing path into JS runtime (`x68sound_opm.cpp` -> `web/js/x68sound/index.js`):
  - Added OPM operator-engine wiring with native algorithm routing (`SetConnection`) and slot mapping (`SLOTTBL` equivalent).
  - Added queued OPM register execution (`ExecuteCmnd`-style handling) for:
    - LFO control (`0x01/0x18/0x19/0x1B`)
    - key on/off (`0x08`)
    - channel control (`0x20-0x3F`)
    - operator params (`0x40-0xFF` via slot table)
  - Added OPM sample rendering loop in `X68Sound_GetPcm`:
    - OPM clock stepping with timer/command/envelope progression
    - LFO+operator output pass and stereo pan mix
    - native-style 22kHz-path post-filter/volume shaping approximation
  - Added rate-change reinitialization for operator/LFO state (`ResetSamprate`-style) on:
    - `X68Sound_Samprate`
    - active `X68Sound_OpmClock`
  - Existing ADPCM/PCM8 path remains active and is now mixed with OPM output.
  - File: `web/js/x68sound/index.js`
- 2026-02-25: Ported additional X68Sound lifecycle/PCM API semantics from `x68sound_opm.cpp`:
  - Reset/start now clear runtime hooks and restore native defaults:
    - clears OPM/BETW/DMA/Wave callbacks
    - restores default `MemRead` callback
    - reset now restores `TotalVolume=256`
  - `X68Sound_GetPcm` parity updates:
    - returns `X68SNDERR_NOTACTIVE` unless running in PCM mode (`StartPcm`)
    - `WaveFunc` contribution is now mixed per output sample (packed LR int), instead of a single post-call
  - PCM8 channel addressing now matches native mask semantics (`ch & 7`) for:
    - `X68Sound_Pcm8_Out`, `X68Sound_Pcm8_Aot`, `X68Sound_Pcm8_Lot`
    - `X68Sound_Pcm8_SetMode`, `X68Sound_Pcm8_GetRest`, `X68Sound_Pcm8_GetMode`
  - `X68Sound_TotalVolume(v)` now matches native range guard (`0..65535` only).
  - File: `web/js/x68sound/index.js`
- 2026-02-25: Ported additional `x68sound_opm.cpp` start/config semantics to JS:
  - Native sample-rate profile mapping:
    - request `44100` -> internal `Samprate=62500`, `WaveOutSamp=44100`
    - request `48000` -> internal `Samprate=62500`, `WaveOutSamp=48000`
    - other values -> `Samprate=22050`, `WaveOutSamp=22050`
  - Native timing profile formulas (`WaveAndTimerStart`) for:
    - `Late_Time`, `Late_Samples`, `Blk_Samples`
    - `Betw_Samples_(Slower/Faster/VerySlower)`
    - `Slower_Limit` / `Faster_Limit`
  - Native API-mode semantics aligned:
    - `X68Sound_Start` sets running mode `1`
    - `X68Sound_StartPcm` sets running mode `2` and default `(betw=5, late=200, rev=1)`
    - `X68Sound_Samprate` returns `X68SNDERR_NOTACTIVE` when inactive
    - `X68Sound_OpmClock` returns `0` on success and applies `clock >> 6` rate
  - Files: `web/js/x68sound/context.js`, `web/js/x68sound/index.js`
- 2026-02-25: Ported OPM command-buffer pacing model from `x68sound_opm.cpp`:
  - Added command ring-buffer state (`CmndBuf` equivalent) to JS context
  - Added `CmndRate` calculation tied to `X68Sound_OpmWait`
  - `X68Sound_OpmPoke` now enqueues OPM register writes into the command queue
  - `X68Sound_GetPcm` now advances queue execution pacing per OPM tick
  - Files: `web/js/x68sound/context.js`, `web/js/x68sound/index.js`
- 2026-02-25: Aligned additional X68Sound API return semantics with native C:
  - `X68Sound_GetPcm` now returns `0` on success (instead of sample count)
  - `X68Sound_OpmWait(wait)` now matches `SetOpmWait` behavior:
    - `wait == -1` returns current wait
    - otherwise sets and returns the new wait value
  - File: `web/js/x68sound/index.js`
- 2026-02-25: Ported additional OPM timer/status behavior from `x68sound_opm.cpp` to JS:
  - Timer register handling in `X68Sound_OpmPoke` for `0x10/0x11/0x12/0x14`
  - Timer tick progression during `X68Sound_GetPcm` based on `m_OpmRate`
  - Status flag set/clear behavior and interrupt callback gating (trigger on zero->nonzero status transition)
  - Reset defaults aligned for timer/ADPCM-side state (`PPI` default and OPM timer reset)
  - Files: `web/js/x68sound/index.js`, `web/js/x68sound/context.js`
- 2026-02-25: Added missing IOCS ADPCM chain routines to JS:
  - `_iocs_adpcmaot`
  - `_iocs_adpcmlot`
  - File: `web/js/mxdrv/sound_iocs.js`

## Notes

- This file is the source of truth for conversion tracking going forward.
- Add each conversion step under **Recent Updates** with date, files changed, and brief behavior summary.
