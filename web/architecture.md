# Web Port Architecture

Design target: run the legacy MXDRV + X68Sound stack inside a browser with no
native build tooling (no Emscripten, no WASM). The entire pipeline stays in
JavaScript/TypeScript and standard Web APIs so that `web/` can be hosted as
static assets.

## Goals & Constraints
- ⚙️ **Pure JS/DOM runtime** – no asm.js/WASM blobs, no native threads. All
  modules must be authored as ES modules that modern browsers can import.
- 🎚️ **Feature parity** – MDX+PDX parsing, MXDRV sequencing, X68Sound OPM/PCM
  synthesis, fades, loops, and the SDL visualizer must behave like
  `examples/simple_mdx_player`.
- 🎧 **Deterministic audio** – sample-accurate scheduling through WebAudio’s
  `AudioWorklet`, double-buffered control messages, and watchdog resync.
- 🎨 **Faithful UI** – the grid/meter layout from `screen_shot.png`
  (drag-and-drop loader, playback controls, visualizer, stats).
- 📦 **Portable build** – `web/` ships ready-to-serve; bundling is optional.

## Translation Unit → Module Map

| Native source                       | Responsibility                             | Planned JS module(s)                                  | Notes |
|------------------------------------|--------------------------------------------|-------------------------------------------------------|-------|
| `src/mdx_util.c`                   | Parse MDX headers, locate chunks           | `web/js/mdx_util.js` *(already ported)*               | Exposes `mdxSeekFileImage`, etc. |
| `src/mxdrv/mxdrv_context.cpp`      | Context lifetime, memory pool, locks       | `web/js/mxdrv/context.js`                             | Wraps stateful JS objects instead of raw pools. |
| `src/mxdrv/mxdrv_context.internal.h` | Internal structures, register mirrors     | `web/js/mxdrv/context_internal.js`                    | Encapsulates CPU register emulation + typed arrays. |
| `src/mxdrv/sound_iocs.cpp`         | IOCS shims for OPM/DMA/adpcm               | `web/js/mxdrv/sound_iocs.js`                          | Pure JS helpers that talk to `x68sound`. |
| `src/mxdrv/mxdrv.cpp`              | MXDRV main driver (sequencer, commands)    | `web/js/mxdrv/driver_core.js`, `cmd_table.js`, `op_handlers/*.js` | Split by functional area to keep files <2k lines. |
| `src/mxdrv/mxdrv_depend.h`         | Host-provided callbacks                    | `web/js/mxdrv/deps.js`                                | Defines the browser-facing API surface. |
| `src/x68sound/x68sound_context.cpp`| Context glue and entry points              | `web/js/x68sound/context.js`                          | Mirrors `MxdrvContext` style, but for sound core. |
| `src/x68sound/x68sound.cpp`        | Public API forwarding to subsystems        | `web/js/x68sound/index.js`                            | Thin wrapper exported to MXDRV modules. |
| `src/x68sound/x68sound_opm.cpp`    | YM2151 emulation, PCM ring buffers         | `web/js/x68sound/opm.js`                              | Uses typed arrays + precalc tables. |
| `src/x68sound/x68sound_op.cpp`     | Operator calculation helpers               | `web/js/x68sound/ops.js`                              | Shared by `opm.js`. |
| `src/x68sound/x68sound_lfo.cpp`    | LFO waveforms                              | `web/js/x68sound/lfo.js`                              | Precomputes wave tables on module load. |
| `src/x68sound/x68sound_adpcm.cpp`  | ADPCM DMA state machine                    | `web/js/x68sound/adpcm.js`                            | Writes into `opm`’s PCM buffer. |
| `src/x68sound/x68sound_pcm8.cpp`   | 8-bit PCM helper                           | `web/js/x68sound/pcm8.js`                             | Handles (de)interleaving + key on flags. |
| `src/x68sound/x68sound_opm.h/.cpp` | Low-pass filter tables, interpolation      | `web/js/x68sound/filters.js`, `tables/opm_tables.js`  | Binary `.dat` files become JSON/Uint16 preloaders. |
| `src/x68sound/x68sound_global.h`   | Constants, macros                          | `web/js/x68sound/constants.js`                        | Shared enumerations + bit masks. |
| `examples/simple_mdx_player/main.c`| SDL front-end (UI + loop)                  | `web/js/app.js`, `web/js/ui/*.js`, `web/shaders/*`, `web/css/app.css` | Web UI uses same state structure for simplicity. |

## MXDRV Module Boundaries

1. **`context.js`** – Public `MxdrvContext` class. Manages:
   - memory pool (Uint8Array backing store, mirrors pointer arithmetic),
   - exported lock helpers (using `Atomics` on `SharedArrayBuffer` fallback to JS locks),
   - loop/fadeout bookkeeping mirrored from the C struct.

2. **`context_internal.js`** – Keeps packed representations of the original
   registers and MXWORK buffers. Each buffer is a `DataView`/`Uint8Array`.
   Provides `toOffset`/`toPointer` helpers so converted driver code can remain
   pointer-agnostic.

3. **`driver_core.js`** – Direct translation of the high-level entry points
   (`mxdrv_start`, `_mdx_setpdx`, `_play`, `_stop`, etc.). The goal is to
   preserve label/function names (e.g., `L_0A`) as small ES module exports to
   aide verification. These functions operate on `MxdrvContext` plus IO helpers.

4. **`op_handlers/*.js`** – Each file owns a logical group of the `L_xx`
   labels (e.g., channel control, effect commands, ADPCM). This mirrors the
   structure of the disassembled driver and keeps files manageable for review.

5. **`sound_iocs.js`** – Hosts the equivalent of `_iocs_opmset`,
   `_iocs_opmsns`, DMA interrupt proxies, and timer scheduling. Instead of
   locking threads, it pushes jobs onto the AudioWorklet ring buffer so the DSP
   step runs in time with the audio callback.

6. **`deps.js`** – Defines the host callbacks the web app must provide
   (`mxdrvLog`, `mxdrvOnLoop`, etc.) and falls back to no-ops to keep the core
   testable in isolation.

## X68Sound Module Boundaries

1. **`constants.js`** – Direct port of macros/constants shared across the
   engine, including YM2151 clock dividers, PCM buffer sizes, DMA registers.

2. **`tables/opm_tables.js` + `filters.js`** – Converts `opmlowpass_44.dat` and
   `opmlowpass_48.dat` into JS-friendly typed arrays (loaded via `fetch` once
   at boot). Lazily populates derived tables (log sin, exp, etc.).

3. **`ops.js`** – Implements the pure math helpers used by an operator.
   Because this code is hot, it will use `Float32Array` scratch buffers and is
   kept separate for easy benchmarking.

4. **`lfo.js`** – Constructs the LFO shapes and exposes methods to step
   through them using fixed-point arithmetic aligned with the C version.

5. **`opm.js`** – The heart of the synth: channel state, timers, PCM ring
   buffers, and mixing routines (`pcmset62`, `betwint`, etc.). It imports
   `ops`, `lfo`, `adpcm`, `pcm8`, and `filters`.

6. **`adpcm.js`** – Ports the DMA/ADPCM decoder, including the split between
   continue and single-shot transfers. Interacts with MXDRV through callbacks
   that mimic the IOCS interrupts.

7. **`pcm8.js`** – Manages the 8-bit PCM voices, zero-cross detection, and
   key-on aggregation so that MXDRV can query PCM channel state exactly as in
   native builds.

8. **`context.js` / `index.js`** – Mirror the public X68Sound API (`Start`,
   `GetPcm`, `OpmReg`, etc.) but run entirely in JS and surface promises for
   asynchronous resource loading (tables/audio buffers).

## Shared Runtime Layout (`web/`)

```
web/
  index.html            # boots the app, registers the AudioWorklet
  css/app.css           # layout + retro palette
  js/
    app.js              # orchestrates UI, file loading, scheduling
    audio/
      worklet.js        # AudioWorkletProcessor, pulls PCM blocks from driver
      ring_buffer.js    # Lock-free shared buffer for control messages
    mdx_util.js
    mxdrv/
      ...               # modules listed above
    x68sound/
      ...               # modules listed above
    ui/
      controls.js       # play/pause/fade buttons
      file_loader.js    # drag & drop + file input
      visualizer.js     # wraps WebGL renderer
  shaders/
    visualizer.vert
    visualizer.frag
  assets/
    opmlowpass_44.bin
    opmlowpass_48.bin
    palette_lut.json    # optional precomputed colors
```

## WebAudio Pipeline
1. **Main thread orchestration**
   - Load MDX (and optional PDX) via drag-and-drop or `<input type="file">`.
   - Use `mdx_util.js` to detect the PDX requirement, allocate buffers in the
     `MxdrvContext` memory pool, and call `MxdrvContext_setMdx/Pdx`.
   - Spawn an `AudioWorklet` (`mxdrv-worklet`) with shared memory for PCM
     output and control commands.

2. **Scheduling strategy**
   - Worklet pulls PCM frames (`GetPcm` equivalent) in fixed blocks
     (default 512 samples @ 48 kHz).
   - When the block boundary crosses an MXDRV tick (1/600 sec), the worklet
     asks `driver_core` to advance sequencing (`L_OPMINT`).
   - Control messages (play/pause, seek, fadeout, loop limit) flow through a
     small ring buffer so UI actions never touch audio thread state directly.
   - A watchdog timer on the main thread monitors `currentTime` vs.
     `MxdrvContext` playback position; if drift > 2 ms, it nudges the driver by
     queuing `betwint` steps.

3. **WebAudio nodes**
   - `AudioWorkletNode` → `GainNode` (master volume / fade) → destination.
   - Optional `DynamicsCompressorNode` for user-friendly levels (defaults off).

4. **Loop/fade handling**
   - Worklet notifies UI via `postMessage` when `LoopCount` increments or when
     fadeout completes so the UI can display counters identical to SDL build.

## WebGL / UI Pipeline
1. **Canvas setup**
   - Single `<canvas>` using WebGL2 if available, otherwise WebGL1.
   - Vertex shader renders a grid of instanced quads representing FM/PCM
     tracks (8 FM + 4 PCM). Fragment shader samples a 1D palette texture to
     recreate the purple gradient from the SDL screenshot.

2. **Data feed**
   - Every animation frame, main thread queries `MxdrvContext` for:
     - OPM register mirrors (for envelope display),
     - key-on bitfields (for piano roll),
     - PCM meter values.
   - Data stored in `Float32Array` UBOs uploaded with `gl.bufferSubData`.

3. **UI components**
   - React-less vanilla JS components:
     - Transport buttons (play/stop/pause, fadeout, loop limit),
     - File loader & current track info,
     - Stats panel (tempo, sample rate, CPU % estimated from scheduling),
     - Drag-and-drop overlay instructions.

4. **Visualizer parity**
   - Top area: 8 columns of 16x16 tiles, animated via shader palette shifts to
     mimic the SDL dithering.
   - Bottom area: falling-note piano roll colored per channel, plus PCM meters
     on the left.

5. **Accessibility**
   - Keyboard shortcuts mirroring SDL build (`Space` play/pause, `F` fadeout,
     `L` toggle loop limit).

## Testing & Verification Workflow
1. **Unit tests** – Node-based tests run with `vitest` (or plain `node:test`)
   to validate mdx/pdx parsing, memory pool behavior, and low-level operator
   math against captured fixtures from the native build.
2. **Comparison harness** – `web/js/devtools/native_compare.js` loads golden
   dumps (OPM register traces, PCM buffers) produced by the desktop player to
   assert bit-identical sequencing for short excerpts.
3. **Manual regression** – Use the bundled `SI3.MDX` / `SILK2.PDX` samples in
   Chrome/Edge/Firefox stable:
   - Verify load, loop, fadeout,
   - Confirm WebGL view matches `screen_shot.png`,
   - Inspect console for underruns (audio watchdog logs).

This document is the reference for all future work inside `web/`. Any module
added later must extend the tables/sections above so contributors can trace a
JS file back to its native origin quickly.
