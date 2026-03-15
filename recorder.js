/**
 * recorder.js — iPhone Safari対応の音声録音モジュール
 */
class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.startTime = null;
    this.timerInterval = null;
    this.analyser = null;
    this.audioContext = null;
    this.isRecording = false;
    this.isPaused = false;
  }

  /**
   * iPhone Safari対応のMIME型を検出
   */
  getPreferredMimeType() {
    const types = [
      'audio/webm;codecs=opus',   // iPhone Safari 推奨
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/wav'
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log(`[Recorder] Using MIME type: ${type}`);
        return type;
      }
    }
    console.warn('[Recorder] No preferred MIME type found, using default');
    return '';
  }

  /**
   * 録音開始
   */
  async start() {
    try {
      // マイクアクセスを要求
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000 // Whisper/Gemini推奨
        }
      });

      // AudioContext & Analyser（波形表示用）
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      // MediaRecorder設定
      const mimeType = this.getPreferredMimeType();
      const options = mimeType ? { mimeType } : {};
      this.mediaRecorder = new MediaRecorder(this.stream, options);
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      // 1秒ごとにチャンクを収集（安定性向上）
      this.mediaRecorder.start(1000);
      this.isRecording = true;
      this.isPaused = false;
      this.startTime = Date.now();
      this._startTimer();

      console.log('[Recorder] Recording started');
      return true;
    } catch (err) {
      console.error('[Recorder] Failed to start:', err);
      if (err.name === 'NotAllowedError') {
        throw new Error('マイクへのアクセスが許可されていません。設定からマイクの権限を許可してください。');
      } else if (err.name === 'NotFoundError') {
        throw new Error('マイクが見つかりません。デバイスにマイクが接続されているか確認してください。');
      }
      throw new Error(`録音の開始に失敗しました: ${err.message}`);
    }
  }

  /**
   * 一時停止
   */
  pause() {
    if (this.mediaRecorder && this.isRecording && !this.isPaused) {
      this.mediaRecorder.pause();
      this.isPaused = true;
      this._stopTimer();
      console.log('[Recorder] Paused');
    }
  }

  /**
   * 再開
   */
  resume() {
    if (this.mediaRecorder && this.isRecording && this.isPaused) {
      this.mediaRecorder.resume();
      this.isPaused = false;
      this._startTimer();
      console.log('[Recorder] Resumed');
    }
  }

  /**
   * 録音停止 & Blobを返す
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || !this.isRecording) {
        reject(new Error('録音が開始されていません'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(this.audioChunks, { type: mimeType });
        
        // ストリームを解放
        if (this.stream) {
          this.stream.getTracks().forEach(track => track.stop());
          this.stream = null;
        }
        if (this.audioContext) {
          this.audioContext.close();
          this.audioContext = null;
        }

        this.isRecording = false;
        this.isPaused = false;
        this._stopTimer();

        const duration = this.getElapsedTime();
        console.log(`[Recorder] Stopped. Duration: ${duration}s, Size: ${(audioBlob.size / 1024).toFixed(1)}KB`);
        
        resolve({
          blob: audioBlob,
          mimeType: mimeType,
          duration: duration,
          size: audioBlob.size
        });
      };

      this.mediaRecorder.stop();
    });
  }

  /**
   * 経過時間（秒）
   */
  getElapsedTime() {
    if (!this.startTime) return 0;
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * フォーマットされた時間表示
   */
  getFormattedTime() {
    const elapsed = this.getElapsedTime();
    const min = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const sec = (elapsed % 60).toString().padStart(2, '0');
    return `${min}:${sec}`;
  }

  /**
   * 波形データ取得（Canvas描画用）
   */
  getWaveformData() {
    if (!this.analyser) return null;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(dataArray);
    return dataArray;
  }

  /**
   * 音量レベル取得（0-1）
   */
  getVolumeLevel() {
    if (!this.analyser) return 0;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const val = (dataArray[i] - 128) / 128;
      sum += val * val;
    }
    return Math.sqrt(sum / dataArray.length);
  }

  /**
   * Blob → Base64変換
   */
  static blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        // 'data:audio/webm;base64,...' から base64部分だけ取得
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // --- Private ---
  _startTimer() {
    this._stopTimer();
    this.timerInterval = setInterval(() => {
      const timeEl = document.getElementById('recordTime');
      if (timeEl) timeEl.textContent = this.getFormattedTime();
    }, 500);
  }

  _stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
}

// グローバルに公開
window.AudioRecorder = AudioRecorder;
