/**
 * OpenShelf TTS Web Worker
 * Runs Kokoro ONNX inference off the main thread so the browser never freezes.
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

    // Dynamic import of kokoro-js (latest stable)
    const module = await import('https://esm.sh/kokoro-js@1.2.1');
    const KokoroTTS = module.KokoroTTS;

    self.postMessage({
      type: 'progress',
      payload: { stage: 'downloading_model', percent: 10, message: 'Downloading Kokoro model...' },
      id
    });

    tts = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      {
        dtype: dtype || 'q8',
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
    const audio = await tts.generate(text, { voice: v });

    // Extract raw PCM Float32 samples and sample rate
    // This avoids the WAV encode → decode round-trip that can degrade quality
    const sampleRate = audio.sampling_rate || 24000;
    let samples;

    if (audio.audio && audio.audio instanceof Float32Array) {
      // kokoro-js >= 1.2 returns .audio as Float32Array directly
      samples = audio.audio;
    } else if (typeof audio.toFloat32Array === 'function') {
      samples = audio.toFloat32Array();
    } else if (audio.data && audio.data instanceof Float32Array) {
      samples = audio.data;
    } else {
      // Fallback: encode to WAV and send that
      const wavData = audio.toWav();
      const buffer = wavData.buffer.slice(0);
      self.postMessage(
        { type: 'audio', payload: { wav: buffer, sampleRate }, id },
        [buffer]
      );
      return;
    }

    // Transfer the Float32Array's underlying buffer (zero-copy)
    const copy = new Float32Array(samples);
    self.postMessage(
      {
        type: 'audio',
        payload: { samples: copy, sampleRate },
        id
      },
      [copy.buffer]
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      payload: { message: error.message || 'Generation failed', stage: 'generate' },
      id
    });
  }
}
