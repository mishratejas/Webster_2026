# The Scarlet Rewrite

A browser-native, text-driven video editor (PS 09). Upload a video, get a word-level
transcript generated in the browser, and edit the video by deleting words. Nothing is
uploaded to a server.

## Run it

Requires Node 20+ and a recent desktop Chrome or Edge.

```bash
npm install
npm run dev      # open the printed http://localhost:5173
npm test         # unit tests for the edit logic (src/lib)
```

The first transcription downloads the Whisper model (~80–150 MB). After that the
browser caches it.

## What works now (Phase 1 + core of Phase 2)

- Upload MP4 / WebM / MOV, with clear errors for unsupported files
- Audio extracted and resampled to 16 kHz mono
- Whisper (Transformers.js) in a Web Worker: WebGPU, falling back to WASM, with a progress bar
- Long audio is split into ≤ 29 s chunks at the quietest moment; silent chunks are skipped
- Read-only transcript: click a word to seek, drag or shift-click to select, Delete to cut, Delete again to restore
- Gap tokens (`[ pause 0.8s ]`, `[ no speech 1:40 ]`) for silences over 0.5 s, deletable like words
- Undo / redo (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y), Space to play/pause
- Preview skips removed ranges while playing; the current word is highlighted
- Edited length shown next to the original length
- **Export MP4**, rendered entirely in the browser in a Web Worker (WebCodecs + mediabunny):
  progress bar, cancel, in-dialog preview, download, and render speed (× real time)

## Timeline (Phase 4)

`src/components/Timeline.jsx`, under the preview:

- **Tracks:** ruler, word track (one chip per word / pause), video filmstrip, audio waveform.
  Thumbnails come from a hidden `<video>` (`src/media/thumbnails.js`); the waveform from the
  same 16 kHz audio Whisper uses (`computePeaks`).
- **Synchronised:** the timeline has no edit state of its own. It reads `words`, `gaps` and
  `removedRanges` from the store, and the playhead reads the `<video>` time every frame. Cutting
  in the transcript shows up on the timeline instantly, and the other way round.
- **Never mid-word:** every time the timeline produces goes through `snapSeek` / `snapCut`
  (`src/lib/timeline.js`, `src/lib/snap.js`). Clicking or scrubbing seeks to the nearest word
  edge (free inside silences). Drag-selections and trim handles snap the same way. The dashed
  hover guide shows where a click will land before you click.
- **Edit:** drag on the tracks to select a range, then Delete. Drag the red handles on a cut to
  trim it. Click a word chip to select it; Shift-click extends the selection.
- **Razor (C) / Selection (V)**, as in Premiere: with the razor, click inside a pause to split it.
  Each piece becomes its own token in the transcript and its own clip on the timeline, so you can
  delete either piece. Words can't be split: over speech the guide turns grey. Cutting the middle
  out of a pause also divides its token, so every remaining piece stays editable. Splits are
  undoable. A split that was used for a cut is saved with the project (as a cut edge); a split
  with nothing cut next to it is a temporary marker and isn't saved.
- **Navigate:** ← / → step word edge by word edge. Ctrl/⌘ + wheel or `+` / `-` zoom, `0` fits.
  The crosshair button follows the playhead during playback.

The preview has custom controls: the scrub bar runs over the *edited* timeline (cut points are
marked), snaps the same way, and a live caption shows the current word.

Light and dark themes: toggle in the header. The choice is remembered per browser and defaults
to the system setting. Colours are CSS variables in `src/index.css` (`--c-*`), used through
Tailwind tokens such as `bg-surface`, `text-fg`, `border-line`.

## Text titles

Select words, then **Title** in the toolbar (or the T+ button on the timeline). The title starts
with the selected words as its text and opens the Title panel at the preview's top-left:

- **Text** (Enter for a new line), **Style** (Headline, Lower third, Boxed, Minimal),
  **Colour** (the lower-third bar and the boxed background; text on light colours turns dark
  automatically), **Position** (top, centre, bottom, lower left), **Size**, and
  **Animation** in (pop, slide, fade or none; everything fades out).
- A **Titles** row on the timeline: click a title to edit it, Delete to remove it.
- Same model as B-roll: anchored to words (follows edits), output time, one title at a time
  (a new one replaces any it overlaps), undoable, not saved with cloud projects yet. Long titles
  shrink to fit the frame.
- Drawn by `drawTitle()` (`src/lib/titles.js`) in the preview and in every exported frame, above
  the B-roll and below the subtitles.

## Background music and audio ducking

**♪** in the preview's control bar opens the Music panel. Add a track (MP3, WAV, M4A, AAC, OGG,
or a video's sound) and it plays under the whole edited video:

- **Ducking, keyed to the transcript:** the music lowers itself while words are spoken and comes
  back up in the pauses. "Speech" is the kept words mapped to output time, so cutting a sentence
  also removes its dip. Settings: on/off and how much (4–30 dB). Ramps: 0.15 s down before a word,
  0.4 s back up after; words closer than 0.35 s count as one phrase, so the music doesn't pump.
- **Volume**, **Start music at**, **Loop if the video is longer**; a 0.5 s fade in at the start
  and 1.5 s fade out at the end.
- A **Music** row on the timeline draws the actual volume curve, so you can see each dip.
- The music runs on **output time**, like B-roll: it plays straight through cuts.

How it works (`src/lib/ducking.js`): `speechIntervals()` → `duckFactor()` / `musicGain()`. The
preview (`media/musicPreview.js`) sets a hidden `<audio>` element's volume from `musicGain()` every
frame. The exporter (`media/musicMix.js`) decodes just the part of the music the edit needs with
mediabunny, then mixes it into each block of main audio with the same gain (computed at both ends
of each ~20 ms block and blended), clamped so it never clips. Music is a setting like framing:
not part of undo and not saved with cloud projects yet. It needs the main video to have a sound
track.

## B-roll

Select words (transcript, word chips, or a range on the timeline), then **B-roll** in the
toolbar (or the film button on the timeline) and pick a video or image. It's shown while those
words are spoken.

- **Show as:** full screen (cutaway) or picture-in-picture, with a corner and size.
- **Fade** in and out (0.3 s), on by default. Images get a slow zoom so they don't look frozen.
- **Start clip at:** which part of a B-roll video to use.
- **Timeline:** a B-roll row at the top. Click a chip to select it (opens the B-roll panel over
  the preview); Delete removes it. **Replace media** keeps the words, mode and position.

Decisions (agreed by the team):
- **Anchored to words, so it follows edits.** Cut words before it and it moves; cut words inside
  it and it gets shorter; cut all of its words and it disappears (and comes back on undo).
- **Runs on output time.** The clip plays continuously through cuts in the main video (no jump
  cuts in the B-roll) and holds its last frame if it's shorter than its words.
- **One B-roll layer.** A new B-roll replaces any B-roll it overlaps.
- **No transcript and no sound.** B-roll is muted; only the main video is transcribed and edited
  by text. (Audio ducking is handled separately.)
- **Undoable** like any edit: overlays have their own history stack in step with the cuts.
- **Not saved with cloud projects yet:** the media files only exist in this browser.

How it works: `src/lib/overlays.js` resolves each overlay's words to source and output times and
draws it with `drawBroll()`. The preview (`PreviewCanvas.jsx`) keeps one hidden, muted `<video>`
per clip in step with the playhead (`media/brollPreview.js`). The exporter
(`media/brollExport.js`) decodes each clip in the worker with mediabunny through a forward-only
frame cursor and draws it with the same `drawBroll()`. Draw order for every frame: framed main
video → B-roll → subtitles.

## Aspect ratio and framing

The **ratio button** (shows `RATIO`, or the current ratio) in the preview's control bar opens the
Format panel:

- **Aspect ratio:** Original, 16:9 (YouTube), 9:16 (Reels / Shorts), 1:1 (square), 4:5 (feed).
- **Fill:**
  - **Crop** fills the frame. Drag the box on the small navigator to choose which part of the
    picture to keep, and zoom in up to 3×.
  - **Fit** shows the whole picture, centred over a blurred, darkened copy of itself (no black
    bars).
- The panel header shows the export size, e.g. `608×1080`.

How it works (`src/lib/frame.js`): `drawFramed()` draws a source image into an output of the
chosen ratio, in crop or fit mode. The preview (`PreviewCanvas.jsx`) calls it every frame with the
`<video>` as the source, and the exporter calls it for every frame in the worker, so the preview is
exactly what's exported. Subtitles are placed relative to the output frame in both, so they follow
the new ratio automatically. Output sizes: crop exports the source pixels inside the crop (no
upscaling; e.g. 9:16 from 1920×1080 → 608×1080), fit exports a padded frame with its long side
capped at 1920 (e.g. 1080×1920). The fit background is blurred cheaply by drawing the picture at
1/16 size and scaling it back up. Framing is per video and isn't saved with cloud projects yet.

## Subtitles

**CC** in the preview's control bar turns subtitles on with one click. **Aa** opens the style panel.

- **Styles:** Classic, Boxed, Karaoke (spoken words fill in), Pop (uppercase, the active word
  pops), Highlight (a box behind the active word), Reveal (words appear as they're spoken). Each
  card in the panel is drawn by the real renderer, so it looks exactly like the output.
- **Position and size:** drag the subtitles in the preview to move them (they snap to the centre),
  and drag the corner square to resize. You can also use the Top / Middle / Bottom presets and the
  size slider.
- **Words per caption:** 1–8. A new caption also starts at a sentence end or a real pause. Pauses
  you cut don't count, and cut words never appear.
- **Export:** when subtitles are on, they're burned into the MP4 with the same style and layout.

How it works (`src/lib/captions.js`, `src/lib/captionStyles.js`): `buildCaptionPages()` groups
the kept words into captions, rebuilt from `removedRanges` whenever you edit. `drawCaption()`
draws a caption at a given time on any 2D canvas. The preview calls it on a canvas over the
video, inside the visible picture area, and the exporter calls it on each frame's
OffscreenCanvas in the worker. Sizes are fractions of the frame's shorter side, so the result
matches at any resolution and in portrait. Only system fonts are used, because a worker can't
see the page's web fonts. Settings live in `src/store/useSubtitleStore.js`: they're remembered
per browser, aren't part of undo, and aren't saved with cloud projects yet.

## Filler removal

**Transcript → Remove fillers**. The app finds hesitations, discourse markers, repeated words
and restarts, and lists them for review. Confident items are pre-selected and uncertain ones are
not. **Remove N** applies the selection as one edit. Nothing is cut until you apply, and **Undo**
(in the panel or Ctrl+Z) reverts the whole batch in one step.

Everything runs locally: no API, no model download, no new dependency. Ambiguous cases go to
review instead of to an LLM. There is no AI backend, sending transcripts out would break
"nothing is uploaded", an LLM can't hear the audio, and its confidence isn't calibrated.

### How a decision is made (`src/lib/fillers.js`, `src/lib/acoustics.js`)

1. **Candidates** come from the Whisper words:
   - hesitations: um, uh, erm (strong); ah, hmm, er (weak, can be reactions)
   - context words: like, well, so, you know, I mean, kind of / sort of, actually, basically, literally
   - repeated words, restarted 2–3 word phrases, and cut-off words ("th- the")
   - audio only: voiced sound inside a pause with no transcribed word (Whisper often drops "um")
2. **Context rules** use neighbouring words and Whisper's punctuation. For example, "I like" /
   "looks like" / "the like button" → KEEP, ", like," → filler-leaning, "as well" → KEEP, "a kind of" → KEEP,
   and "that that" / "very very" → review.
3. **Acoustic evidence** comes from a 10 ms RMS envelope computed from the audio we already decode:
   - silence before/after the word (measured in the audio, not from timestamps)
   - how drawn out the word is relative to this speaker's own pace
   - steadiness (a held vowel)
   - loudness (a stressed word is less likely to be a filler)
   - timestamp sanity checks: no sound where the word should be, or a word stretched past 1.5 s, downgrades it to review

   Pitch isn't used: it would mean keeping the raw samples (~230 MB per hour).
4. **Labels:** score ≥ 0.75 → FILLER, ≤ 0.3 → KEEP, otherwise UNCERTAIN. Context words reach FILLER
   only with audio evidence. Hedges and adverbs (kind of, basically…) never do. Unlabelled sounds
   are always UNCERTAIN.

The scores are rule scores, not probabilities. The thresholds in `src/lib/config.js` are hand-set
starting points and haven't been tuned on labelled data.

### Cuts

Each candidate's cut is a source-time interval, clipped so it never overlaps a neighbouring word.
Repeats also absorb the short gap before the second copy. Applying merges the selected cuts into
`removedRanges` with one `commit()`. That's the one rule above, so preview skipping, the timeline,
the transcript, autosave and the export EDL all follow without new media code. Silence removal is
deliberately not part of this feature.

### Limitations

- Whisper (base) often leaves out "um"/"uh". Transformers.js 3.8.1 doesn't implement `prompt_ids`,
  so it can't be prompted to transcribe verbatim. Unlabelled-sound detection only partly covers this.
- Whisper word timestamps (cross-attention DTW) can be off by tens to hundreds of ms. Cuts follow them.
- Self-repairs with different wording ("I went — we went") and stutters inside one Whisper word
  ("I-I") aren't detected. English only.
- Tested on synthetic transcripts and tone-burst audio, not on real labelled speech.

### Evaluating accuracy on real recordings

1. Record or collect 20–30 clips (several speakers, accents, mics), transcribe them in the app, and
   label each Whisper word as filler / not filler. Also mark fillers missing from the transcript,
   with their times.
2. Run `detectFillers` on the saved words plus energy. Count:
   - **false positives:** meaningful words labelled FILLER. This is the costly error, because it deletes speech.
   - **false negatives:** labelled fillers that are KEEP or missing.
   - how many items land in UNCERTAIN (the review workload)
3. Report precision of FILLER (target ≥ 0.95) and recall over FILLER + UNCERTAIN, per category.
   Report fillers Whisper never transcribed separately, since they're an ASR limit, not a classifier limit.
4. Tune the thresholds and weights on half the clips and report on the other half.

## Export pipeline

`src/media/exporter.js`, run from `src/workers/export.worker.js`:

1. Build the EDL from `removedRanges` (the same function the preview uses).
2. For each kept range, decode video frames and audio samples separately (WebCodecs via mediabunny).
3. Rebase timestamps: both tracks share one running offset, so the output is continuous and in sync.
4. Video frames are drawn onto an OffscreenCanvas of the output size, framed by `drawFramed()` (aspect ratio, crop or
   fit), then B-roll (`drawBroll()`), the title (`drawTitle()`) and subtitles (`drawCaption()`) are drawn on top, with
   the same functions the preview uses, then encoded.
5. Audio is trimmed to the exact sample at each cut, with a 5 ms fade so cuts don't click. Background music (when
   added) is mixed in with the ducking curve before encoding.
6. Mux to MP4 and download. Codec choice: H.264 (falls back to VP9 / AV1), AAC (falls back to Opus).

## How the code is organised

```
src/
  lib/            Pure logic, no React, no browser APIs. Fully unit-tested.
    config.js       every tunable number (gap threshold, padding, model id…)
    ranges.js       add / subtract / merge / complement time ranges
    edl.js          EDL, isSpanRemoved, nextPlayableTime, source<->output time
    transcript.js   gap derivation, transcript items, word lookup
    snap.js         snapCut for timeline mode
    timeline.js     snapSeek, word-edge stepping, ruler ticks, range-selection helpers
    chunkAudio.js   splitting audio for Whisper
    fillers.js      filler / disfluency detection and review -> cuts
    acoustics.js    energy envelope, pauses, voiced runs (evidence for fillers.js)
  store/          Zustand store: words, removedRanges, undo/redo, selection
  media/          Browser media code: audio extraction, worker wrapper, ingest flow, player handle
  workers/        Web Workers (Whisper now; export later)
  components/     React UI
```

**The one rule:** edits only ever change `removedRanges` in the store, through
`removeRange` / `restoreRange`. Transcript, timeline, preview and export all read from
it with the functions in `src/lib/edl.js`. If you need a new kind of edit, add a
function to `src/lib`, test it, and call `commit()`.

## Team split (3 people)

| Person | Owns | First task |
| --- | --- | --- |
| **A: Media / AI** | `workers/whisper`, `media/extractAudio`, VAD, filler detection, Hinglish later | Record test videos; check whether Whisper keeps "um"/"uh" |
| **B: Export** | `workers/export` (new), WebCodecs + mediabunny | Standalone spike: one MP4 + a hard-coded EDL → cut MP4 that plays in sync |
| **C: Editor UI** | `components/`, canvas preview, aspect ratios, timeline mode, subtitles | Canvas preview with 16:9 / 9:16 / 1:1 |

Export is the biggest risk, so it starts on day 1 in parallel, not after the UI.

## 7-day plan

| Day | Goal | Done when |
| --- | --- | --- |
| 1 | Everyone runs this repo. A records 3 test clips (talking head with fillers; long silent middle; music intro). B starts the export spike. | Transcript appears for all 3 clips |
| 2 | Canvas preview + aspect ratios (C). Export spike cuts video correctly (B). Fillers tested (A). | Spike outputs a cut MP4 |
| 3 | Export wired into the app with a progress bar. | **Pass tier complete end to end** |
| 4 | Timeline mode: playhead, razor, select-delete, drag-trim with `snapCut`. Silero VAD. | Timeline and transcript edits stay in sync |
| 5 | One-click filler & pause removal. Animated word-by-word subtitles on canvas, burned in at export. | Victory features 1 and 2 |
| 6 | B-roll / titles / ducking (stretch). Performance: 1080p export speed, smooth scrubbing. | Measured export speed |
| 7 | Feature freeze. README sections below, sample export, tool disclosure, demo recording. | Submitted |

## Still to write for submission

- Rendering pipeline (WebCodecs / mediabunny), with a diagram
- Transcript sync logic (removedRanges → EDL → preview + export)
- Design choices: read-only transcript, cut snapping, no clip reordering
- Supported browsers: Chrome / Edge first; Firefox and Safari best effort
- Tool disclosure, and a sample export with verification notes