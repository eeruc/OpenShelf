/**
 * OpenShelf TTS Engine
 * Runs Kokoro 82M entirely in a Web Worker so the UI never freezes.
 * The main thread only handles audio playback via AudioContext.
 * 
 * iOS Safari Audio Strategy:
 * - AudioContext output routed through MediaStreamDestination → <audio> element
 *   so iOS treats it as a media stream and allows background/lock screen playback
 * - AudioContext "warmed up" on first user gesture (silent buffer play)
 * - Global touch/click/keydown listeners persist until audio is confirmed unlocked
 * - "interrupted" state (iOS screen lock) handled with suspend→resume cycle
 * - webkitAudioContext fallback for older iOS
 * - Media Session API provides lock screen controls and book metadata
 */

// Curated Kokoro v1.0 voice catalog — only high-quality voices
export const VOICES = [
  // American English — Female (top tier)
  { id: 'af_heart',   name: 'Heart',   gender: 'F', accent: 'US', emoji: '💛', grade: 'A',  desc: 'Warm, natural' },
  { id: 'af_bella',   name: 'Bella',   gender: 'F', accent: 'US', emoji: '🌸', grade: 'A-', desc: 'Soft, clear' },
  { id: 'af_nicole',  name: 'Nicole',  gender: 'F', accent: 'US', emoji: '🎵', grade: 'B-', desc: 'Bright, expressive' },
  { id: 'af_sarah',   name: 'Sarah',   gender: 'F', accent: 'US', emoji: '🌺', grade: 'B-', desc: 'Calm, articulate' },
  { id: 'af_nova',    name: 'Nova',    gender: 'F', accent: 'US', emoji: '✨', grade: 'B',  desc: 'Smooth, modern' },
  { id: 'af_sky',     name: 'Sky',     gender: 'F', accent: 'US', emoji: '☁️', grade: 'B',  desc: 'Light, gentle' },

  // American English — Male (top tier)
  { id: 'am_michael', name: 'Michael', gender: 'M', accent: 'US', emoji: '📘', grade: 'B',  desc: 'Deep, authoritative' },
  { id: 'am_fenrir',  name: 'Fenrir',  gender: 'M', accent: 'US', emoji: '🐺', grade: 'B',  desc: 'Strong, resonant' },
  { id: 'am_puck',    name: 'Puck',    gender: 'M', accent: 'US', emoji: '🎭', grade: 'B',  desc: 'Lively, dynamic' },
  { id: 'am_eric',    name: 'Eric',    gender: 'M', accent: 'US', emoji: '📻', grade: 'B-', desc: 'Clear, steady' },

  // British English — Female
  { id: 'bf_emma',     name: 'Emma',     gender: 'F', accent: 'UK', emoji: '🫖', grade: 'B',  desc: 'Elegant, refined' },
  { id: 'bf_isabella', name: 'Isabella', gender: 'F', accent: 'UK', emoji: '🌹', grade: 'B-', desc: 'Rich, composed' },

  // British English — Male
  { id: 'bm_george',  name: 'George', gender: 'M', accent: 'UK', emoji: '📖', grade: 'B-', desc: 'Classic, warm' },
  { id: 'bm_fable',   name: 'Fable',  gender: 'M', accent: 'UK', emoji: '📕', grade: 'B-', desc: 'Storyteller tone' },
];

export const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 2.0];

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
    this.dtype = 'fp16';  // fp16 for best quality/size balance
    this._aborted = false;
    this._msgId = 0;
    this._pending = new Map();
    this._pregenBuffer = null;
    this._pregenerating = false;
    this._isDownloading = false;  // true if actually downloading model (not cached)

    // MediaStream routing for background/lock screen playback
    this._mediaStreamDest = null;
    this._mediaAudioEl = null;

    // Media Session metadata
    this._bookTitle = '';
    this._chapterTitle = '';

    // Callbacks
    this.onProgress = null;
    this.onSentenceStart = null;
    this.onSentenceEnd = null;
    this.onComplete = null;
    this.onStateChange = null;
    this.onError = null;
  }

  // ——— Audio Context (iOS-safe, must be created from user gesture) ———

  /**
   * Create or resume the AudioContext. On iOS Safari, simply creating the context
   * and calling resume() is NOT enough — we must also play a silent buffer to
   * "warm up" the audio hardware. This must happen synchronously inside a user
   * gesture handler (touchend, click, keydown).
   */
  ensureAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    if (!this.audioContext) {
      this.audioContext = new AC();
      this._audioUnlocked = false;
      this._setupVisibilityHandler();
      this._setupMediaStreamRouting();
    }

    // Always attempt resume + silent buffer on user gesture
    this._unlockAudioContext();

    return this.audioContext;
  }

  /**
   * Play a silent buffer to "warm up" iOS audio hardware.
   * This is the critical trick: iOS Safari won't output real audio from
   * AudioContext unless a buffer has been played during a user gesture.
   */
  _unlockAudioContext() {
    if (!this.audioContext) return;

    const ctx = this.audioContext;

    // Handle iOS "interrupted" state (occurs after screen lock/unlock)
    if (ctx.state === 'interrupted') {
      ctx.resume().catch(() => {});
    }

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    // Play a silent buffer — this is what actually unlocks iOS audio
    try {
      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(ctx.destination);
      source.start(0);
      source.onended = () => {
        this._audioUnlocked = true;
      };
    } catch (e) {
      // Ignore — older browsers may not support createBuffer
    }

    // Also poke the helper <audio> element
    this._pokeHelperAudio();
  }

  /**
   * Route AudioContext output through a MediaStreamDestination → <audio> element.
   * This is the critical trick for iOS background/lock screen playback:
   * Safari treats MediaStream-backed <audio> elements as "live streams" 
   * (like a WebRTC call) and keeps them alive when the screen locks or
   * the app goes to background. Without this, AudioContext.destination
   * output is silenced immediately when iOS suspends the page.
   */
  _setupMediaStreamRouting() {
    if (this._mediaStreamDest || !this.audioContext) return;

    const ctx = this.audioContext;

    // Create a MediaStreamDestination — audio nodes connect here instead of ctx.destination
    try {
      this._mediaStreamDest = ctx.createMediaStreamDestination();
    } catch (e) {
      // Fallback: some older browsers don't support createMediaStreamDestination
      console.warn('MediaStreamDestination not supported, using direct output');
      this._mediaStreamDest = null;
      return;
    }

    // Create a hidden <audio> element that plays the MediaStream
    const audio = document.createElement('audio');
    audio.setAttribute('x-webkit-airplay', 'deny');
    audio.style.display = 'none';
    audio.srcObject = this._mediaStreamDest.stream;
    document.body.appendChild(audio);
    this._mediaAudioEl = audio;

    // Start playing the stream — must happen in a user gesture context
    // (ensureAudioContext is called from gesture handlers)
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
  }

  /**
   * Connect an audio source node to the output.
   * Uses DUAL routing: always connects to AudioContext.destination for
   * immediate playback on all platforms, AND to the MediaStreamDestination
   * for iOS background/lock screen persistence. The MediaStream routing
   * is additive — if it fails or isn't supported, audio still plays normally.
   */
  _connectToOutput(sourceNode) {
    if (!this.audioContext) return;
    // Primary: always connect to the hardware destination
    sourceNode.connect(this.audioContext.destination);
    // Secondary: also feed the MediaStream for iOS background audio
    if (this._mediaStreamDest) {
      try { sourceNode.connect(this._mediaStreamDest); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Ensure the media <audio> element is playing.
   * Called before each PCM/WAV playback to make sure the stream is active.
   */
  _ensureMediaStreamPlaying() {
    if (!this._mediaAudioEl) return;
    if (this._mediaAudioEl.paused) {
      const p = this._mediaAudioEl.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  /**
   * Play the silent helper <audio> element. On iOS this helps keep the
   * audio session alive and is another unlock vector.
   */
  _pokeHelperAudio() {
    this._ensureMediaStreamPlaying();
  }

  /**
   * Handle page visibility changes — when iOS suspends/resumes the page,
   * AudioContext can get stuck. We do a suspend→resume cycle to recover.
   */
  _setupVisibilityHandler() {
    if (this._visibilityHandlerSet) return;
    this._visibilityHandlerSet = true;

    document.addEventListener('visibilitychange', () => {
      if (!this.audioContext) return;

      if (document.visibilityState === 'visible') {
        const ctx = this.audioContext;
        const state = ctx.state;

        // iOS "interrupted" state — need to resume
        if (state === 'interrupted' || state === 'suspended') {
          ctx.resume().catch(() => {});
        }

        // If state is "running" but audio is actually broken (Safari bug),
        // do a suspend→resume cycle to force-reset the audio device
        if (state === 'running' && this.isPlaying) {
          ctx.suspend().then(() => {
            return ctx.resume();
          }).catch(() => {});
        }
      }
    });
  }

  // ——— Initialization ———

  get isDownloading() { return this._isDownloading; }

  async initialize(dtype = 'fp16') {
    if (this.isReady && this.dtype === dtype) return;
    if (this.isLoading) return;

    this.isLoading = true;
    this.dtype = dtype;
    this._aborted = false;
    this._isDownloading = false;

    try {
      await this._initWorker(dtype);
    } catch (err) {
      console.warn('Web Worker TTS failed, falling back to native speech:', err);
      if (typeof speechSynthesis !== 'undefined') {
        this.usingNativeFallback = true;
        this.isReady = true;
        this.onProgress?.({ stage: 'ready', percent: 100, message: 'Using device speech synthesis' });
      } else {
        this.onError?.(err);
      }
    } finally {
      this.isLoading = false;
      this._isDownloading = false;
    }
  }

  async _initWorker(dtype) {
    return new Promise((resolve, reject) => {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }

      try {
        this.worker = new Worker('./tts-worker.js', { type: 'module' });
      } catch (e) {
        reject(new Error('Web Workers not supported or worker failed to load'));
        return;
      }

      const timeoutMs = 600_000; // 10 min for fp16/fp32 model downloads
      let initTimeout = setTimeout(() => {
        reject(new Error('Model loading timed out'));
        this.worker?.terminate();
        this.worker = null;
      }, timeoutMs);

      this.worker.onmessage = (e) => {
        const { type, payload, id } = e.data;

        switch (type) {
          case 'progress':
            // Detect if we're actually downloading (vs loading from cache)
            if (payload.stage === 'downloading_model' && payload.percent > 10 && payload.percent < 85) {
              this._isDownloading = true;
            }
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

      this.worker.postMessage({ type: 'init', payload: { dtype }, id: this._nextId() });
    });
  }

  cancelLoading() {
    this._aborted = true;
    this.isLoading = false;
    this._isDownloading = false;
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
    this._updateMediaSessionState('playing');

    // Ensure AudioContext is ready (should already be created from user gesture)
    this.ensureAudioContext();

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

    await new Promise(r => setTimeout(r, 60));
    await this._playNext();
  }

  async _playKokoro(sentence) {
    let audioData;

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
      await this._playPCM(audioData.samples, audioData.sampleRate);
    } else if (audioData.wav) {
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
    } catch (e) { /* ignore */ }
    finally { this._pregenerating = false; }
  }

  async _playPCM(samples, sampleRate) {
    if (!this.audioContext) return;

    const ctx = this.audioContext;

    // iOS recovery: handle interrupted/suspended states before playback
    if (ctx.state === 'interrupted' || ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* */ }
    }

    // If still not running after resume, try suspend→resume cycle (Safari bug workaround)
    if (ctx.state !== 'running') {
      try {
        await ctx.suspend();
        await ctx.resume();
      } catch (e) { /* */ }
    }

    // Make sure the media stream <audio> element is playing
    this._ensureMediaStreamPlaying();

    return new Promise((resolve) => {
      const sr = sampleRate || 24000;
      const audioBuffer = ctx.createBuffer(1, samples.length, sr);
      audioBuffer.getChannelData(0).set(samples);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = this.speed;
      this._connectToOutput(source);
      this.currentSource = source;

      source.onended = () => {
        this.currentSource = null;
        resolve();
      };

      // Safety timeout in case onended never fires (iOS edge case)
      const durationMs = (samples.length / sr) * 1000 / this.speed + 2000;
      const safetyTimer = setTimeout(() => {
        if (this.currentSource === source) {
          this.currentSource = null;
          resolve();
        }
      }, durationMs);

      source.addEventListener('ended', () => clearTimeout(safetyTimer));

      source.start(0);
    });
  }

  async _playWAV(arrayBuffer) {
    if (!this.audioContext) return;

    const ctx = this.audioContext;

    // iOS recovery: handle interrupted/suspended states
    if (ctx.state === 'interrupted' || ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* */ }
    }

    if (ctx.state !== 'running') {
      try {
        await ctx.suspend();
        await ctx.resume();
      } catch (e) { /* */ }
    }

    // Make sure the media stream <audio> element is playing
    this._ensureMediaStreamPlaying();

    return new Promise((resolve) => {
      ctx.decodeAudioData(arrayBuffer,
        (audioBuffer) => {
          if (this._aborted || !this.isPlaying) { resolve(); return; }

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.playbackRate.value = this.speed;
          this._connectToOutput(source);
          this.currentSource = source;

          source.onended = () => {
            this.currentSource = null;
            resolve();
          };

          source.start(0);
        },
        () => resolve()
      );
    });
  }

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
    this._updateMediaSessionState('paused');
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
    this._updateMediaSessionState('playing');
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
    this._updateMediaSessionState('stopped');
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

  // ——— Media Session (lock screen controls) ———

  /**
   * Set book metadata for Media Session lock screen display.
   * Call this when TTS starts playing to show book info on lock screen.
   */
  setMediaSessionMetadata(bookTitle, chapterTitle, coverUrl) {
    this._bookTitle = bookTitle || '';
    this._chapterTitle = chapterTitle || '';

    if (!('mediaSession' in navigator)) return;

    const artwork = [];
    if (coverUrl) {
      artwork.push({ src: coverUrl, sizes: '512x512', type: 'image/png' });
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapterTitle || bookTitle || 'OpenShelf',
      artist: bookTitle && chapterTitle ? bookTitle : 'OpenShelf',
      album: 'OpenShelf',
      artwork: artwork.length > 0 ? artwork : [
        { src: './assets/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: './assets/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
  }

  /**
   * Set up Media Session action handlers for lock screen controls.
   * Must be called once — maps lock screen buttons to TTS engine controls.
   */
  setupMediaSessionHandlers({ onPlay, onPause, onStop, onNextTrack, onPrevTrack }) {
    if (!('mediaSession' in navigator)) return;

    const tryHandler = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); }
      catch (e) { /* action not supported */ }
    };

    tryHandler('play', () => {
      if (onPlay) onPlay();
    });
    tryHandler('pause', () => {
      if (onPause) onPause();
    });
    tryHandler('stop', () => {
      if (onStop) onStop();
    });
    tryHandler('nexttrack', () => {
      if (onNextTrack) onNextTrack();
    });
    tryHandler('previoustrack', () => {
      if (onPrevTrack) onPrevTrack();
    });
  }

  /**
   * Update Media Session playback state to sync lock screen UI.
   */
  _updateMediaSessionState(state) {
    if (!('mediaSession' in navigator)) return;
    switch (state) {
      case 'playing': navigator.mediaSession.playbackState = 'playing'; break;
      case 'paused':  navigator.mediaSession.playbackState = 'paused';  break;
      case 'stopped': navigator.mediaSession.playbackState = 'none';    break;
    }
  }

  shutdown() {
    this.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    // Clean up media stream routing
    if (this._mediaAudioEl) {
      this._mediaAudioEl.pause();
      this._mediaAudioEl.srcObject = null;
      this._mediaAudioEl.remove();
      this._mediaAudioEl = null;
    }
    this._mediaStreamDest = null;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.isReady = false;
    this._updateMediaSessionState('stopped');
  }
}

// Singleton
export const ttsEngine = new TTSEngine();
