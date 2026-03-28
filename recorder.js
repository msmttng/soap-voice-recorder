/**
 * recorder.js — 録音安定性強化版 音声録音モジュール
 * 
 * 改善点:
 *   - Wake Lock API で画面ロック防止（Android Chrome対応）
 *   - visibilitychange で AudioContext / MediaRecorder を自動復旧
 *   - ステータスコールバックでUI側に状態を通知
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
    this._chunkIndex = 0;  // IndexedDBバックアップ用カウンタ

    // Wake Lock
    this.wakeLock = null;

    // ステータスコールバック: (status, detail) => void
    // status: 'recording' | 'suspended' | 'resumed' | 'wake-lock-lost' | 'error'
    this.onStatusChange = null;

    // visibilitychange ハンドラの参照を保持（removeEventListener用）
    this._visibilityHandler = this._handleVisibilityChange.bind(this);
  }

  /**
   * MIME型を検出（Android Chrome優先）
   */
  getPreferredMimeType() {
    const types = [
      'audio/webm;codecs=opus',
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
      // マイクAPIの事前チェック
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('このブラウザはマイクAPIに対応していません。HTTPSでアクセスしているか確認してください。');
      }

      // マイクアクセスを要求（10秒タイムアウト付き）
      const getUserMediaPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(
          'マイクへのアクセスがタイムアウトしました。ブラウザのアドレスバー付近に表示される許可ダイアログを確認してください。'
        )), 10000)
      );

      this.stream = await Promise.race([getUserMediaPromise, timeoutPromise]);

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
          // IndexedDB にバックアップ
          if (window.RecordingBackup) {
            RecordingBackup.saveChunk(event.data, this._chunkIndex++).catch(() => {});
          }
        }
      };

      // MediaRecorderの予期しない停止を検知
      this.mediaRecorder.onerror = (event) => {
        console.error('[Recorder] MediaRecorder error:', event.error);
        this._emitStatus('error', `MediaRecorder: ${event.error?.name || 'unknown'}`);
      };

      // 1秒ごとにチャンクを収集（安定性向上）
      this.mediaRecorder.start(1000);
      this.isRecording = true;
      this.isPaused = false;
      this.startTime = Date.now();
      this._chunkIndex = 0;
      this._startTimer();

      // IndexedDB バックアップセッション開始
      if (window.RecordingBackup) {
        RecordingBackup.startSession().catch(() => {});
      }

      // Wake Lock 取得
      await this._acquireWakeLock();

      // visibilitychange リスナー登録
      document.addEventListener('visibilitychange', this._visibilityHandler);

      this._emitStatus('recording', '録音開始');
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
      this._emitStatus('suspended', '一時停止');
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
      this._emitStatus('resumed', '録音再開');
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

        // Wake Lock 解放
        this._releaseWakeLock();

        // visibilitychange リスナー解除
        document.removeEventListener('visibilitychange', this._visibilityHandler);

        // IndexedDB バックアップをクリア（正常停止なので不要）
        if (window.RecordingBackup) {
          RecordingBackup.clear().catch(() => {});
        }

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
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // =========================================
  //  Wake Lock API
  // =========================================

  async _acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      console.warn('[Recorder] Wake Lock API not supported');
      return;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      console.log('[Recorder] ✅ Wake Lock acquired');

      this.wakeLock.addEventListener('release', () => {
        console.log('[Recorder] Wake Lock released');
        // 録音中にWake Lockが失われた場合は通知
        if (this.isRecording) {
          this._emitStatus('wake-lock-lost', '画面ロック防止が解除されました');
        }
      });
    } catch (err) {
      console.warn('[Recorder] Wake Lock failed:', err.message);
    }
  }

  _releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
      console.log('[Recorder] Wake Lock released (manual)');
    }
  }

  // =========================================
  //  Visibility Change — バックグラウンド復旧
  // =========================================

  async _handleVisibilityChange() {
    if (!this.isRecording) return;

    if (document.visibilityState === 'visible') {
      console.log('[Recorder] Page became visible — recovering...');

      // AudioContext 復旧
      if (this.audioContext && this.audioContext.state === 'suspended') {
        try {
          await this.audioContext.resume();
          console.log('[Recorder] ✅ AudioContext resumed');
        } catch (e) {
          console.warn('[Recorder] AudioContext resume failed:', e);
        }
      }

      // MediaRecorder 復旧（paused → resume）
      if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
        try {
          this.mediaRecorder.resume();
          console.log('[Recorder] ✅ MediaRecorder resumed from paused');
        } catch (e) {
          console.warn('[Recorder] MediaRecorder resume failed:', e);
        }
      }

      // Wake Lock 再取得
      if (!this.wakeLock) {
        await this._acquireWakeLock();
      }

      this._emitStatus('resumed', 'バックグラウンドから復帰');
    } else {
      // バックグラウンドに移行
      console.log('[Recorder] Page hidden — recording may be affected');
      this._emitStatus('suspended', 'バックグラウンド移行');
    }
  }

  // =========================================
  //  ステータス通知
  // =========================================

  _emitStatus(status, detail) {
    console.log(`[Recorder] Status: ${status} — ${detail}`);
    if (typeof this.onStatusChange === 'function') {
      try { this.onStatusChange(status, detail); } catch (e) {}
    }
  }

  // =========================================
  //  Timer
  // =========================================

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
