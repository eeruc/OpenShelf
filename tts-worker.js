/**
 * OpenShelf TTS Web Worker
 * Runs Kokoro ONNX inference off the main thread so the browser never freezes.
 * Uses tts.stream() for efficient chunked generation of longer text.
 * Sends raw Float32 PCM samples back — no WAV encoding overhead.
 */

let tts = null;
let currentVoice = 'af_heart';

self.onmessage = async (e) => {
  const { type, payload, id } = e.data;

  switch (type) {
    case 'init':
      await handleInit(payload, id);
      break;
    case 'generate':
      await handleGenerate(payload, id);
      break;
    case 'set_voice':
      currentVoice = payload.voice;
      self.postMessage({ type: 'voice_set', id });
      break;
    case 'ping':
      self.postMessage({ type: 'pong', id });
      break;
  }
};

async function handleInit({ dtype }, id) {
  try {
    self.postMessage({
      type: 'progress',
      payload: { stage: 'loading_library', percent: 5, message: 'Loading TTS library...' },
      id
    });

    // Dynamic import of kokoro-js
    const module = await import('https://esm.sh/kokoro-js@1.2.1');
    const KokoroTTS = module.KokoroTTS;

    self.postMessage({
      type: 'progress',
      payload: { stage: 'downloading_model', percent: 10, message: 'Loading Kokoro model...' },
      id
    });

    tts = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      {
        dtype: dtype || 'fp16',
        device: 'wasm',
        progress_callback: (progress) => {
          if (progress.status === 'progress' && progress.total) {
            const pct = 10 + Math.round((progress.loaded / progress.total) * 75);
            const mbLoaded = (progress.loaded / 1024 / 1024).toFixed(1);
            const mbTotal = (progress.total / 1024 / 1024).toFixed(1);
            self.postMessage({
              type: 'progress',
              payload: {
                stage: 'downloading_model',
                percent: Math.min(pct, 88),
                message: `Downloading model: ${mbLoaded} / ${mbTotal} MB`
              },
              id
            });
          } else if (progress.status === 'ready') {
            self.postMessage({
              type: 'progress',
              payload: { stage: 'initializing', percent: 92, message: 'Initializing model...' },
              id
            });
          }
          // 'initiate' status means starting to load — could be from cache (fast) or network
        }
      }
    );

    self.postMessage({
      type: 'progress',
      payload: { stage: 'ready', percent: 100, message: 'Ready!' },
      id
    });
    self.postMessage({ type: 'init_done', id });

  } catch (error) {
    self.postMessage({
      type: 'error',
      payload: { message: error.message || 'Failed to load TTS model', stage: 'init' },
      id
    });
  }
}

/**
 * Extract raw PCM Float32 samples from a kokoro-js audio result.
 * Returns { samples: Float32Array, sampleRate: number } or null.
 */
function extractSamples(audio) {
  const sampleRate = audio.sampling_rate || 24000;
  let samples = null;

  if (audio.audio instanceof Float32Array) {
    samples = audio.audio;
  } else if (audio.audio && typeof audio.audio === 'object' && audio.audio.data instanceof Float32Array) {
    samples = audio.audio.data;
  } else if (typeof audio.toFloat32Array === 'function') {
    samples = audio.toFloat32Array();
  } else if (audio.data instanceof Float32Array) {
    samples = audio.data;
  } else if (audio.audio && ArrayBuffer.isView(audio.audio)) {
    const rawData = audio.audio;
    samples = new Float32Array(rawData.buffer, rawData.byteOffset, rawData.byteLength / 4);
  }

  if (samples && samples.length > 0) {
    return { samples, sampleRate };
  }
  return null;
}

async function handleGenerate({ text, voice }, id) {
  if (!tts) {
    self.postMessage({
      type: 'error',
      payload: { message: 'Model not loaded', stage: 'generate' },
      id
    });
    return;
  }

  try {
    const v = voice || currentVoice;

    // Use tts.stream() for efficient chunked generation if available.
    // This lets kokoro-js handle optimal internal text splitting, and we get
    // audio chunks as they're generated rather than waiting for the full text.
    if (typeof tts.stream === 'function') {
      const stream = tts.stream(text, { voice: v });
      const allSamples = [];
      let sampleRate = 24000;

      for await (const chunk of stream) {
        const audio = chunk.audio || chunk;
        const result = extractSamples(audio);
        if (result) {
          allSamples.push(result.samples);
          sampleRate = result.sampleRate;
        }
      }

      if (allSamples.length > 0) {
        // Concatenate all chunks into a single Float32Array
        const totalLength = allSamples.reduce((sum, s) => sum + s.length, 0);
        const merged = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of allSamples) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        const copy = new Float32Array(merged);
        self.postMessage(
          { type: 'audio', payload: { samples: copy, sampleRate }, id },
          [copy.buffer]
        );
        return;
      }
    }

    // Fallback: use tts.generate() for single-shot generation
    const audio = await tts.generate(text, { voice: v });
    const result = extractSamples(audio);

    if (result) {
      const copy = new Float32Array(result.samples);
      self.postMessage(
        { type: 'audio', payload: { samples: copy, sampleRate: result.sampleRate }, id },
        [copy.buffer]
      );
      return;
    }

    // WAV fallback
    if (typeof audio.toWav === 'function') {
      const wavData = audio.toWav();
      const buffer = wavData instanceof ArrayBuffer ? wavData : wavData.buffer.slice(0);
      self.postMessage(
        { type: 'audio', payload: { wav: buffer, sampleRate: audio.sampling_rate || 24000 }, id },
        [buffer]
      );
      return;
    }

    self.postMessage({
      type: 'error',
      payload: { message: 'Could not extract audio data from model output', stage: 'generate' },
      id
    });

  } catch (error) {
    self.postMessage({
      type: 'error',
      payload: { message: error.message || 'Generation failed', stage: 'generate' },
      id
    });
  }
}
