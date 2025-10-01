# Implementation Plan — Phase Scrubbing (Paused‑Only) + Unified Semantics Stabilization

Owner: Claude

Goal: Ship paused‑only phase scrubbing driven by portamento time, and stabilize
the unified (scope‑free) parameter model by fixing the broken paths called out
in recent logs.

Scope: Controller (ctrl), Synth (synth), Protocol (message validators). Keep
changes minimal and focused. No legacy compatibility — we want breakages to
surface and be fixed.

---

## 1) Paused‑Only Scrubbing

Design:

- Only allow scrubbing when transport is paused.
- Controller sends target phase at 30–60 Hz during drag with a scrub duration
  (ms) derived from the portamento slider.
- Each synth, when paused, ramps its unified worklet `phase` AudioParam to the
  target (`linearRampToValueAtTime` over `scrubMs`) and aligns its phasor
  worklet’s internal phase via `set-phase`. Play resumes from the scrubbed phase
  everywhere.

Controller (public/ctrl/ctrl-main.ts):

- Add `setupScrubHandlers()` and call it during initialization.
- Use `phasorBar` (or the bar container) for pointer events:
  - `pointerdown`: if `!this.isPlaying`, set `this.isScrubbing = true`.
  - `pointermove`: if `this.isScrubbing`, map clientX → `phase ∈ [0,1]`, set
    `this.phasor` (for UI) and call `broadcastScrubPhase(phase, scrubMs)`;
    throttle via `requestAnimationFrame`.
  - `pointerup/pointercancel`: set `this.isScrubbing = false`.
- Implement `broadcastScrubPhase(phase, scrubMs)`:
  - Build a PHASOR_SYNC message via
    `MessageBuilder.phasorSync(phase, null, this.stepsPerCycle, this.cycleLength, false)`
    and attach `{ scrubbing: true, scrubMs }` fields before send.
  - Send over `sync` channel.
  - `scrubMs` = `parseInt(this.elements.portamentoTime.value) || 100`.

Synth (public/synth/synth-main.js):

- In `handlePhasorSync(message)` add a paused+scrubbing branch:
  - Guard: `if (!message.isPlaying && message.scrubbing === true)`.
  - Stop phasor worklet if needed (you already do this when `isPlaying` is
    false).
  - Align phasor worklet phase:
    `this.phasorWorklet?.port.postMessage({ type: 'set-phase', phase: message.phasor });`.
  - Smooth UI/DSP phase:
    `const p = this.unifiedSynthNode.parameters.get('phase'); p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(message.phasor, now + (message.scrubMs||100)/1000);`
  - Update local fields:
    `this.receivedPhasor = message.phasor; this.lastPhasorMessage = performance.now();`

Validation:

- While paused, scrubbing should glide to the pointer with smoothing controlled
  by portamento.
- On play, phasor starts from the last scrubbed phase on all synths.

---

## 2) Fix HRG (frequency) Updates Not Taking Effect

Observed: Changing frequency SIN numerators to 2 and blurring does not result in
octave jump at EOC or during paused apply.

Required fixes:

- Controller (public/ctrl/ctrl-main.ts):
  - Ensure HRG input changes send a PROGRAM_UPDATE immediately:
    - Paused: call the existing targeted single‑param PROGRAM_UPDATE with
      `portamentoTime` (control channel), so synth resolves and ramps now.
    - Playing: send a single‑param PROGRAM_UPDATE (control channel) for EOC
      staging. Do this on input/change (with light debounce) so synth has the
      new config before the next EOC.
  - Confirm `directValue` (frequency base) is copied into `baseValue` for both
    `startValueGenerator` and `endValueGenerator` of type `periodic` in the
    outbound payload builder.

- Synth (public/synth/synth-main.js):
  - Remove any leftover “routing/staging to program” logs and branches (legacy
    scope). There should be no code referring to `scope` or to switching
    routing.
  - At EOC in `handleCycleReset`, always:
    - For frequency with `periodic` generators: resolve via HRG state, but first
      copy `directValue` → `baseValue` for both start/end generators if present.
    - Set `frequency_start` (and `frequency_end` when cosine) at the precise
      `resetTime`.
  - Paused immediate apply for frequency: on PROGRAM_UPDATE with
    `portamentoTime`, resolve interpolated current value using the latest HRG
    config and ramp the `frequency_start` param accordingly (exponential ramp,
    since it’s frequency).

Validation:

- Paused: edit frequency n=2, blur → ramp to 2× base.
- Playing: edit frequency n=3; at next EOC resolves to 3× base and applies
  cleanly.

---

## 3) Purge Legacy Scope and “Routing Change” Code Paths

Observed: Logs like “📋 Staging routing change: frequency → program (at next
EOC)” indicate old scope logic still runs.

Actions (public/synth/synth-main.js):

- Remove all references to `paramData.scope` and any routing/staging logs tied
  to scope.
- Normalize all parameter handling to interpolation semantics only:
  - `step`: resolve start only.
  - `cosine`: resolve start and end; interpolation handled by unified worklet
    using `*_start`/`*_end` AudioParams.
- In `handleProgramUpdate`, reject configs containing `scope`; otherwise, store
  unified config and proceed.

Actions (public/ctrl/ctrl-main.ts):

- Ensure outbound payloads never include `scope`.
- Remove dead code paths for “direct parameters” broadcasts.

---

## 4) Address “Softer Synthesis” Regression

Hypothesis: Amplitude or per‑path scaling changed due to unified parameter
plumbing/routing.

Audit and fixes:

- Verify controller sends amplitude as a normalized param (step/cosine) and
  synth resolves `amplitude_start`/`_end` correctly at EOC/paused.
- In unified worklet (public/synth/worklets/unified-synth-worklet.js):
  - Confirm the mixing gains (`formantGain`, `zingGain`) are unchanged.
  - Confirm the final mix multiplies by `10.0 * amplitude` as before.
  - Ensure parameter resolution loop correctly updates
    `this.currentValues.amplitude` each block from the AudioParams (start/end
    interpolation path) — no fallback to defaults.
- Add a temporary debug log gated behind a `verbose` flag printing resolved
  amplitude every ~1s. Remove after verification.

Acceptance:

- With the same UI settings as pre‑change, perceived loudness should match
  (within a small tolerance). If it differs, adjust internal scaling minimally
  to match prior reference.

---

## 5) Protocol — Keep It Simple and Strict

- PROGRAM_UPDATE: only unified fields: `interpolation`, `startValueGenerator`,
  `endValueGenerator?`, `directValue?`, `synthesisActive`, optional
  `portamentoTime`.
- PHASOR_SYNC: accept extra fields (`scrubbing`, `scrubMs`) without validator
  rejection.
- Reject any `scope` in incoming messages (controller and synth log a clear
  error).

Note: The current validators in `src/common/message-protocol.js` already accept
extra fields. Keep strict rejection of `scope` for PROGRAM_UPDATE.

---

## 6) Rate Limiting and UX Polish

- Use control channel for PROGRAM_UPDATE (single‑param and bulk) for
  reliability.
- Throttle HRG and normalized param inputs: debounce `input` (50–100ms); commit
  on `blur/change` immediately.
- Optional: Bulk edits checkbox (disabled by default):
  - When enabled, suppress all sends and collect dirty params (visual asterisk).
  - On disable, emit one PROGRAM_UPDATE with all changes (if paused, include
    `portamentoTime`).

---

## 7) Testing Checklist

Functional:

- Paused scrubbing glides with portamento time and resumes play from scrubbed
  phase.
- Frequency HRG edits (n/d) apply:
  - Paused: immediate ramp to new ratio × base.
  - Playing: staged; resolved at next EOC.
- Normalized params with single values do not re‑randomize at phase 0.
- Scene save/load: restores HRG sequence state and normalized values without
  scope.
- Re‑resolve at EOC still randomizes static HRG indices only at cycle
  boundaries.

Stability/Logs:

- No “routing change … program” logs remain.
- No `scope` present in outbound/inbound payloads; validator errors if present.

Audio:

- Loudness comparable to pre‑change reference for default program.

---

## 8) Deliverables (File Touch List)

- Controller: `public/ctrl/ctrl-main.ts`
  - Add `setupScrubHandlers()`, `broadcastScrubPhase()`
  - Ensure HRG input handlers send single‑param PROGRAM_UPDATE (paused = with
    portamento; playing = staged) over control channel
  - Remove any lingering scope references and direct‑param broadcast paths

- Synth: `public/synth/synth-main.js`
  - `handlePhasorSync`: paused+scrubbing ramp + phasor worklet `set-phase`
  - `handleProgramUpdate`: no scope paths; store unified config
  - `handleCycleReset`: unified EOC resolve + AudioParam set; copy
    `directValue → baseValue` for periodic gens before resolve
  - Immediate paused apply: resolve current interpolated value and ramp (exp for
    frequency, linear for normalized)

- Worklet: `public/synth/worklets/unified-synth-worklet.js`
  - Verify amplitude and mixing gains; add temporary verbose debug if needed

- Protocol: `src/common/message-protocol.js`
  - Keep strict rejection of `scope` in PROGRAM_UPDATE; allow extra fields in
    PHASOR_SYNC

---

## 9) Notes for Rollout

- This is a breaking change. No legacy scope support is retained.
- Keep changes surgical; avoid touching unrelated systems.
- Prefer control channel for PROGRAM_UPDATE; sync channel for PHASOR_SYNC.
