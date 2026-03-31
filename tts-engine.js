/**
 * OpenShelf TTS Engine
 * Runs Kokoro 82M entirely in a Web Worker so the UI never freezes.
 * The main thread only handles audio playback via AudioContext.
 */

// Full Kokoro v1.0 voice catalog — sorted by quality grade
export const VOICES = [
  // American English — Female
  { id: 'af_heart',   name: 'Heart',   gender: 'F', accent: 'US', emoji: '💛', grade: 'A' },
  { id: 'af_bella',   name: 'Bella',   gender: 'F', accent: 'US', emoji: '🌸', grade: 'A-' },
  { id: 'af_nicole',  name: 'Nicole',  gender: 'F', accent: 'US', emoji: '🎵', grade: 'B-' },
  { id: 'af_aoede',   name: 'Aoede',   gender: 'F', accent: 'US', emoji: '🎶', grade: 'C+' },
  { id: 'af_kore',    name: 'Kore',    gender: 'F', accent: 'US', emoji: '🌿', grade: 'C+' },
  { id: 'af_sarah',   name: 'Sarah',   gender: 'F', accent: 'US', emoji: '🌺', grade: 'C+' },
  { id: 'af_sky',     name: 'Sky',     gender: 'F', accent: 'US', emoji: '☁️', grade: 'C-' },
  { id: 'af_nova',    name: 'Nova',    gender: 'F', accent: 'US', emoji: '✨', grade: 'C' },
  { id: 'af_alloy',   name: 'Alloy',   gender: 'F', accent: 'US', emoji: '🔗', grade: 'C' },
  { id: 'af_river',   name: 'River',   gender: 'F', accent: 'US', emoji: '🌊', grade: 'D' },
  { id: 'af_jessica', name: 'Jessica', gender: 'F', accent: 'US', emoji: '💜', grade: 'D' },

  // American English — Male
  { id: 'am_fenrir',  name: 'Fenrir',  gender: 'M', accent: 'US', emoji: '🐺', grade: 'C+' },
  { id: 'am_puck',    name: 'Puck',    gender: 'M', accent: 'US', emoji: '🎭', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', gender: 'M', accent: 'US', emoji: '📘', grade: 'C+' },
  { id: 'am_adam',    name: 'Adam',    gender: 'M', accent: 'US', emoji: '🎙️', grade: 'F+' },
  { id: 'am_echo',    name: 'Echo',    gender: 'M', accent: 'US', emoji: '🔊', grade: 'D' },
  { id: 'am_eric',    name: 'Eric',    gender: 'M', accent: 'US', emoji: '📻', grade: 'D' },
  { id: 'am_liam',    name: 'Liam',    gender: 'M', accent: 'US', emoji: '📚', grade: 'D' },
  { id: 'am_onyx',    name: 'Onyx',    gender: 'M', accent: 'US', emoji: '🖤', grade: 'D' },
  { id: 'am_santa',   name: 'Santa',   gender: 'M', accent: 'US', emoji: '🎅', grade: 'D-' },

  // British English — Female
  { id: 'bf_emma',     name: 'Emma',     gender: 'F', accent: 'UK', emoji: '🫖', grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', gender: 'F', accent: 'UK', emoji: '🌹', grade: 'C' },
  { id: 'bf_alice',    name: 'Alice',    gender: 'F', accent: 'UK', emoji: '🐇', grade: 'D' },
  { id: 'bf_lily',     name: 'Lily',     gender: 'F', accent: 'UK', emoji: '🌷', grade: 'D' },

  // British English — Male
  { id: 'bm_george',  name: 'George', gender: 'M', accent: 'UK', emoji: '📖', grade: 'C' },
  { id: 'bm_fable',   name: 'Fable',  gender: 'M', accent: 'UK', emoji: '📕', grade: 'C' },
  { id: 'bm_daniel',  name: 'Daniel', gender: 'M', accent: 'UK', emoji: '🎩', grade: 'D' },
  { id: 'bm_lewis',   name: 'Lewis',  gender: 'M', accent: 'UK', emoji: '🎭', grade: 'D+' },
];

export const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 2.0];

// Use a native fallback for browsers where the Worker/WASM model fails
const USE_NATIVE_FALLBACK = typeof speechSynthesis !== 'undefined';

class TTSEngine {
  constructor() {
    this.worker = null;
    this.isLoading = false;
    this.isReady = false;
    this.isPlaying = false;
    this.isPaused = false;
    this.usingNativeFallback = false;
    this.currentSentenceIndex = 0;
    this.sentences = [];
    this.audioContext = null;
    this.currentSource = null;
    this.voice = 'af_heart';
    this.speed = 1.0;
    this.dtype = 'q8';  // q8 balances quality + size well for most devices
    this._aborted = false;
    this._msgId = 0;
    this._pending = new Map();    // id → { resolve }
    this._pregenBuffer = null;    // { index, audioData }
    this._pregenerating = false;

    // Callbacks
    this.onProgress = null;
    this.onSentenceStart = null;
    this.onSentenceEnd = null;
    this.onComplete = null;
    this.onStateChange = null;
    this.onError = null;
  }

  // ——— Initialization ———

  async initialize(dtype = 'q8') {
    if (this.isReady && this.dtype === dtype) return;
    if (this.isLoading) return;

    this.isLoading = true;
    this.dtype = dtype;
    this._aborted = false;

    try {
      // Attempt the Web Worker path first
      await this._initWorker(dtype);
    } catch (err) {
      console.warn('Web Worker TTS failed, falling back to native speech:', err);
      // Fall back to browser's built-in speech synthesis
      if (USE_NATIVE_FALLBACK) {
        this.usingNativeFallback = true;
        this.isReady = true;
        this.onProgress?.({ stage: 'ready', percent: 100, message: 'Using device speech synthesis' });
      } else {
        this.onError?.(err);
      }
    } finally {
      this.isLoading = false;
    }
  }

  async _initWorker(dtype) {
    return new Promise((resolve, reject) => {
      // Kill any existing worker
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }

      // Create worker
      try {
        this.worker = new Worker('./tts-worker.js', { type: 'module' });
      } catch (e) {
        reject(new Error('Web Workers not supported or worker failed to load'));
        return;
      }

      const timeoutMs = 300_000; // 5 min max for model download (q8/fp32 are larger)
      let initTimeout = setTimeout(() => {
        reject(new Error('Model loading timed out'));
        this.worker?.terminate();
        this.worker = null;
      }, timeoutMs);

      this.worker.onmessage = (e) => {
        const { type, payload, id } = e.data;

        switch (type) {
          case 'progress':
            this.onProgress?.(payload);
            break;
          case 'init_done':
            clearTimeout(initTimeout);
            this.isReady = true;
            resolve();
            break;
          case 'error':
            if (payload.stage === 'init') {
              clearTimeout(initTimeout);
              reject(new Error(payload.message));
            } else {
              // Generation error — resolve the pending promise with null
              const pendingErr = this._pending.get(id);
              if (pendingErr) {
                this._pending.delete(id);
                pendingErr.resolve(null);
              }
            }
            break;
          case 'audio': {
            const pending = this._pending.get(id);
            if (pending) {
              this._pending.delete(id);
              // payload is { samples: Float32Array, sampleRate: number }
              pending.resolve(payload);
            }
            break;
          }
          case 'voice_set':
          case 'pong':
            break;
        }
      };

      this.worker.onerror = (e) => {
        clearTimeout(initTimeout);
        reject(new Error(e.message || 'Worker error'));
      };

      // Send init message
      this.worker.postMessage({ type: 'init', payload: { dtype }, id: this._nextId() });
    });
  }

  cancelLoading() {
    this._aborted = true;
    this.isLoading = false;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  // ——— Speech Generation (via Worker) ———

  _nextId() { return ++this._msgId; }

  async _generateInWorker(text, voice) {
    if (!this.worker) return null;

    const id = this._nextId();
    return new Promise((resolve) => {
      // Timeout per sentence — 60s generous for longer sentences
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve(null);
      }, 60_000);

      this._pending.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
      });

      this.worker.postMessage({
        type: 'generate',
        payload: { text, voice: voice || this.voice },
        id
      });
    });
  }

  // ——— Playback ———

  async playSentences(sentences, startIndex = 0) {
    this.sentences = sentences;
    this.currentSentenceIndex = startIndex;
    this.isPlaying = true;
    this.isPaused = false;
    this._aborted = false;
    this._pregenBuffer = null;
    this.onStateChange?.('playing');

    // Ensure AudioContext — use native sample rate, we'll handle resampling if needed
    if (!this.audioContext && !this.usingNativeFallback) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }

    await this._playNext();
  }

  async _playNext() {
    if (this._aborted || !this.isPlaying) return;
    if (this.currentSentenceIndex >= this.sentences.length) {
      this.stop();
      this.onComplete?.();
      return;
    }

    const sentence = this.sentences[this.currentSentenceIndex];
    this.onSentenceStart?.(this.currentSentenceIndex, sentence);

    if (this.usingNativeFallback) {
      await this._playNative(sentence);
    } else {
      await this._playKokoro(sentence);
    }

    if (this._aborted || !this.isPlaying) return;

    this.onSentenceEnd?.(this.currentSentenceIndex);
    this.currentSentenceIndex++;

    // Small yield to keep UI responsive between sentences
    await new Promise(r => setTimeout(r, 60));

    await this._playNext();
  }

  async _playKokoro(sentence) {
    let audioData;

    // Use pre-generated buffer if available
    if (this._pregenBuffer && this._pregenBuffer.index === this.currentSentenceIndex) {
      audioData = this._pregenBuffer.audioData;
      this._pregenBuffer = null;
    } else {
      audioData = await this._generateInWorker(sentence, this.voice);
    }

    if (!audioData || this._aborted || !this.isPlaying) return;

    // Start pre-generating the next sentence in background
    this._pregenNext();

    if (audioData.samples) {
      // Raw PCM Float32 path (best quality)
      await this._playPCM(audioData.samples, audioData.sampleRate);
    } else if (audioData.wav) {
      // WAV fallback path
      await this._playWAV(audioData.wav);
    }
  }

  async _pregenNext() {
    const nextIndex = this.currentSentenceIndex + 1;
    if (nextIndex >= this.sentences.length || this._pregenerating) return;

    this._pregenerating = true;
    try {
      const nextSentence = this.sentences[nextIndex];
      const audioData = await this._generateInWorker(nextSentence, this.voice);
      if (audioData && this.isPlaying && !this._aborted) {
        this._pregenBuffer = { index: nextIndex, audioData };
      }
    } catch (e) {
      // Ignore pre-gen failures
    } finally {
      this._pregenerating = false;
    }
  }

  /**
   * Play raw PCM Float32 samples directly — no WAV encoding/decoding.
   * This avoids any quality loss from WAV round-trip and is the cleanest path.
   */
  _playPCM(samples, sampleRate) {
    return new Promise((resolve) => {
      if (!this.audioContext) { resolve(); return; }

      const sr = sampleRate || 24000;
      const audioBuffer = this.audioContext.createBuffer(1, samples.length, sr);
      audioBuffer.getChannelData(0).set(samples);

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = this.speed;
      source.connect(this.audioContext.destination);
      this.currentSource = source;

      source.onended = () => {
        this.currentSource = null;
        resolve();
      };

      source.start(0);
    });
  }

  /**
   * Fallback: play a WAV ArrayBuffer via decodeAudioData.
   */
  _playWAV(arrayBuffer) {
    return new Promise((resolve) => {
      if (!this.audioContext) { resolve(); return; }

      this.audioContext.decodeAudioData(arrayBuffer,
        (audioBuffer) => {
          if (this._aborted || !this.isPlaying) { resolve(); return; }

          const source = this.audioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.playbackRate.value = this.speed;
          source.connect(this.audioContext.destination);
          this.currentSource = source;

          source.onended = () => {
            this.currentSource = null;
            resolve();
          };

          source.start(0);
        },
        () => resolve() // Decode error — skip sentence
      );
    });
  }

  // ——— Native Fallback (SpeechSynthesis) ———

  _playNative(sentence) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) { resolve(); return; }

      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.rate = this.speed;
      utterance.pitch = 1.0;
      utterance.lang = 'en-US';

      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();

      window.speechSynthesis.speak(utterance);
    });
  }

  // ——— Controls ———

  pause() {
    if (!this.isPlaying || this.isPaused) return;
    this.isPaused = true;

    if (this.usingNativeFallback) {
      window.speechSynthesis?.pause();
    } else if (this.audioContext?.state === 'running') {
      this.audioContext.suspend();
    }
    this.onStateChange?.('paused');
  }

  resume() {
    if (!this.isPlaying || !this.isPaused) return;
    this.isPaused = false;

    if (this.usingNativeFallback) {
      window.speechSynthesis?.resume();
    } else if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume();
    }
    this.onStateChange?.('playing');
  }

  stop() {
    this._aborted = true;
    this.isPlaying = false;
    this.isPaused = false;
    this._pregenBuffer = null;
    this._pending.clear();

    if (this.usingNativeFallback) {
      window.speechSynthesis?.cancel();
    }

    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (e) { /* */ }
      this.currentSource = null;
    }

    this.onStateChange?.('stopped');
  }

  skipForward() {
    if (!this.isPlaying) return;
    if (this.usingNativeFallback) {
      window.speechSynthesis?.cancel();
    }
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (e) { /* */ }
      this.currentSource = null;
    }
  }

  skipBackward() {
    if (!this.isPlaying) return;
    if (this.currentSentenceIndex > 0) {
      this.currentSentenceIndex = Math.max(0, this.currentSentenceIndex - 2);
    }
    if (this.usingNativeFallback) {
      window.speechSynthesis?.cancel();
    }
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (e) { /* */ }
      this.currentSource = null;
    }
  }

  setVoice(voiceId) {
    this.voice = voiceId;
    this._pregenBuffer = null;
    if (this.worker) {
      this.worker.postMessage({ type: 'set_voice', payload: { voice: voiceId }, id: this._nextId() });
    }
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  get state() {
    if (this.isLoading) return 'loading';
    if (!this.isReady) return 'uninitialized';
    if (this.isPaused) return 'paused';
    if (this.isPlaying) return 'playing';
    return 'ready';
  }

  get engineLabel() {
    if (this.usingNativeFallback) return 'Device TTS';
    return `Kokoro (${this.dtype})`;
  }

  shutdown() {
    this.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.isReady = false;
  }
}

// Singleton
export const ttsEngine = new TTSEngine();
