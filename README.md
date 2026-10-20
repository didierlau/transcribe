# Transcribe

A practice tool for musicians that runs entirely in your browser:

1. **Open a song.** MP3, WAV, FLAC, M4A or OGG. The audio never leaves your computer.
2. **Split it into instruments.** Drums, bass, piano, guitar, vocals and everything else, each on its own channel strip.
3. **Make your own mix.** Pull a part down to play along in its place, solo a part to hear it clearly, loop a passage between A and B, or download any part as a WAV.
4. **Transcribe.** Turn the piano part (or bass, guitar, vocals, other) into sheet music on a grand staff. Fix the tempo and bar lines if needed, then download it as MIDI or ABC, or print it.

Live site: https://didierlau.github.io/transcribe/

## Using it

| Control | What it does |
| --- | --- |
| Space | Play / pause |
| ← / → | Jump back / forward 5 seconds |
| A, B, L | Set loop start, set loop end, turn the loop on or off |
| Double-click a fader | Reset it to 0 dB |
| Click a note in the score | Jump to that spot in the song |

**First run:** splitting downloads the separation model once, about 136 MB (processor engine) or 285 MB (graphics card engine). The browser keeps it, so later songs start right away.

**Speed:** the graphics card engine (WebGPU, in Chrome or Edge) is the fast one. On the processor, expect separation to take a few minutes for a typical song, longer on older machines; the progress bar shows the time left. If the graphics card engine fails, the app switches to the processor engine automatically.

**Getting a clean score:** split first, then transcribe the Piano stem. If the bar lines land in the wrong place, use −1 beat / +1 beat. If the tempo is off by half or double, use ½× and 2×, or tap along with Tap while the song plays. Raise Sensitivity to catch quiet notes, lower it to drop ghost notes.

### What about Spotify?

Spotify tracks can’t be used. Spotify streams are DRM-protected and its API doesn’t give apps access to the audio, so no web app can separate them. Use an audio file you own instead, such as an MP3 from a purchase or your own recording.

## How it works

- **Separation:** [HT-Demucs 6-stem](https://github.com/facebookresearch/demucs) (Meta AI, MIT) exported to ONNX, run with [ONNX Runtime Web](https://onnxruntime.ai/) on WebGPU or multi-threaded WebAssembly. Models are loaded from Hugging Face: [adowu/htdemucs-6s-onnx](https://huggingface.co/adowu/htdemucs-6s-onnx) (processor) and [kramp/htdemucs-6s-webgpu-onnx](https://huggingface.co/kramp/htdemucs-6s-webgpu-onnx) (graphics card). Audio is processed in 7.8-second windows with 25% overlap.
- **Transcription:** [Basic Pitch](https://github.com/spotify/basic-pitch-ts) by Spotify (Apache-2.0), a polyphonic note detector, run with TensorFlow.js. The model ships in `public/basic-pitch`.
- **Score:** notes are quantized to the detected beat grid, the key is estimated (Krumhansl–Schmuckler), and the result is written as ABC notation and drawn with [abcjs](https://www.abcjs.net/).
- **Hosting:** a static site on GitHub Pages. `coi-serviceworker` enables the cross-origin isolation that multi-threaded WebAssembly needs, since Pages can’t set those headers itself.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs dist/
```

Every push to `main` builds and deploys to GitHub Pages through `.github/workflows/deploy.yml`. If the first deploy fails, open **Settings → Pages** in the repository and set **Source** to **GitHub Actions**.

For testing without downloading the real model, add `?model=<url>` to the address to load any ONNX file with the same input (`mix`, `[1, 2, 343980]`) and output (`stems`, `[1, 6, 2, 343980]`).

## Ideas for later

- Slow down playback without changing pitch
- Remember separated stems between visits
- MusicXML export for MuseScore and Sibelius
