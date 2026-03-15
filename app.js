/**
 * app.js — SOAP Voice Recorder メインアプリケーション
 * 
 * アーキテクチャ:
 *   1. Web Speech API（ブラウザ内蔵・無料）でリアルタイム文字起こし
 *   2. 文字起こしテキスト → Gemini API（テキストのみ）でSOAP生成
 *   → 音声トークンを使わないため、API制限に引っかからない
 */

// ==============================================
// 設定管理
// ==============================================
const Config = {
  STORAGE_KEY: 'soap_recorder_settings',
  HISTORY_KEY: 'soap_recorder_history',
  MEDIXS_DATA_KEY: 'soap_medixs_data',

  defaults: {
    geminiApiKey: '',
    openaiApiKey: '',
    gasUrl: '',
    aiProvider: 'gemini'
  },

  load() {
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY);
      return saved ? { ...this.defaults, ...JSON.parse(saved) } : { ...this.defaults };
    } catch {
      return { ...this.defaults };
    }
  },

  save(settings) {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
  }
};

// ==============================================
// リアルタイム音声認識（Web Speech API）
// ==============================================
const SpeechTranscriber = {
  recognition: null,
  isListening: false,
  fullTranscript: '',       // 確定済みテキスト
  interimTranscript: '',    // 認識中テキスト
  onUpdate: null,           // コールバック

  /**
   * 音声認識を開始
   */
  start(onUpdate) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('このブラウザは音声認識に対応していません。Chrome または Safari を使用してください。');
    }

    this.recognition = new SpeechRecognition();
    this.recognition.lang = 'ja-JP';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;

    this.fullTranscript = '';
    this.interimTranscript = '';
    this.onUpdate = onUpdate;

    this.recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          this.fullTranscript += transcript;
          console.log('[Speech] Final:', transcript);
        } else {
          interim += transcript;
        }
      }
      this.interimTranscript = interim;
      
      if (this.onUpdate) {
        this.onUpdate(this.fullTranscript, this.interimTranscript);
      }
    };

    this.recognition.onerror = (event) => {
      console.warn('[Speech] Error:', event.error);
      // 'no-speech' は無視（無音期間で発生する）
      if (event.error === 'no-speech') return;
      if (event.error === 'aborted') return;
    };

    this.recognition.onend = () => {
      // continuous=true でも停止することがあるので自動再開
      if (this.isListening) {
        console.log('[Speech] Auto-restart');
        try {
          this.recognition.start();
        } catch(e) {
          console.warn('[Speech] Restart failed:', e);
        }
      }
    };

    this.recognition.start();
    this.isListening = true;
    console.log('[Speech] Started');
  },

  /**
   * 音声認識を停止
   */
  stop() {
    this.isListening = false;
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
    console.log('[Speech] Stopped');
    return this.fullTranscript;
  },

  /**
   * 現在のテキスト（確定 + 途中）
   */
  getCurrentText() {
    return this.fullTranscript + this.interimTranscript;
  }
};

// ==============================================
// Gemini API クライアント（テキストのみ版）
// ==============================================
const GeminiClient = {
  MODELS: [
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-2.0-flash-lite'
  ],

  /**
   * テキストからSOAPを生成（音声トークン不要！）
   */
  async generateSOAP(transcript, drugInfo) {
    const settings = Config.load();
    const apiKey = settings.geminiApiKey;

    if (!apiKey) {
      throw new Error('Gemini APIキーが設定されていません。設定画面でAPIキーを入力してください。');
    }

    const systemPrompt = this._buildPrompt(transcript, drugInfo);

    const requestBody = {
      contents: [{
        parts: [{
          text: systemPrompt
        }]
      }],
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json'
      }
    };

    // 各モデルを順番に試行
    let lastError = null;
    for (const model of this.MODELS) {
      try {
        console.log(`[Gemini] Trying model: ${model}`);
        const result = await this._callAPI(model, apiKey, requestBody);
        console.log(`[Gemini] Success with model: ${model}`);
        return result;
      } catch (err) {
        console.warn(`[Gemini] ${model} failed:`, err.message);
        lastError = err;
        if (err.status === 429) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        if (err.status === 403) throw err;
      }
    }
    throw lastError || new Error('すべてのAIモデルでエラーが発生しました');
  },

  async _callAPI(model, apiKey, requestBody) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error(`[Gemini] ${model} Error:`, error);
      const err = new Error(
        response.status === 403 ? 'APIキーが無効です。設定画面で正しいキーを入力してください。' :
        response.status === 429 ? `${model}: レート制限。別モデルで再試行中...` :
        `Gemini APIエラー (${model}): ${error.error?.message || response.statusText}`
      );
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('AIからの応答が空でした');

    try {
      return JSON.parse(text);
    } catch {
      return this._extractSOAPFromText(text);
    }
  },

  _buildPrompt(transcript, drugInfo) {
    const drugSection = drugInfo 
      ? `\n\n## 処方薬情報（NSIPSから取得）\n${drugInfo}\nこの薬品情報を元に、A（薬学的評価）とP（指導計画）を具体的に提案してください。`
      : '';

    return `あなたは日本の保険薬局に勤務するベテラン薬剤師です。
以下は、薬剤師と患者の服薬指導時の会話を文字起こししたテキストです。

## 会話テキスト
${transcript}
${drugSection}

## 指示
上記の会話テキストをSOAP形式の薬歴に変換してください。

## SOAP記載ルール
- S（主観的情報）: 患者自身の言葉による訴え、自覚症状、生活状況、服薬状況、副作用の有無
- O（客観的情報）: 処方内容、外見的観察、お薬手帳の情報、バイタルサイン（言及があれば）
- A（薬学的評価）: 薬学的観点からの評価・分析。副作用の可能性、相互作用、効果判定、問題点の抽出
- P（指導計画）: 実施した服薬指導の内容、患者への助言、次回確認事項、処方医への情報提供の必要性

## 重要な注意
- 日本語で出力すること
- 医薬品名は正確に記載すること
- 患者の発言はできるだけ原文に近い表現で記載すること
- 推測や創作は行わないこと

## 出力形式（JSON）
{
  "transcript": "整形した会話テキスト",
  "S": "主観的情報",
  "O": "客観的情報",
  "A": "薬学的評価",
  "P": "指導計画",
  "summary": "一行要約（20文字以内）"
}`;
  },

  _extractSOAPFromText(text) {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1] || jsonMatch[0]);
      } catch {}
    }
    return {
      transcript: text,
      S: '（自動抽出に失敗しました。文字起こし全文を確認してください）',
      O: '', A: '', P: '',
      summary: '要確認'
    };
  },

  async testConnection() {
    const settings = Config.load();
    if (!settings.geminiApiKey) throw new Error('Gemini APIキーが設定されていません');
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${settings.geminiApiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('APIキーが無効です');
    return true;
  }
};

// ==============================================
// 履歴管理
// ==============================================
const History = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(Config.HISTORY_KEY) || '[]');
    } catch { return []; }
  },
  save(records) {
    localStorage.setItem(Config.HISTORY_KEY, JSON.stringify(records.slice(0, 50)));
  },
  add(record) {
    const records = this.load();
    records.unshift({ id: Date.now(), timestamp: new Date().toISOString(), ...record });
    this.save(records);
  }
};

// ==============================================
// UI コントローラー
// ==============================================
const App = {
  recorder: null,
  currentSOAP: null,
  waveformAnimId: null,

  init() {
    this.recorder = new AudioRecorder();
    this.bindEvents();
    this.loadSettings();
    this.renderHistory();
    this.initCanvas();
    this.checkSpeechSupport();
    console.log('[App] Initialized');
  },

  checkSpeechSupport() {
    const supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!supported) {
      this.toast('⚠️ このブラウザは音声認識に非対応です。Chrome を使用してください。', 'error');
    }
  },

  // --- イベントバインド ---
  bindEvents() {
    document.getElementById('recordBtn').addEventListener('click', () => this.toggleRecording());
    document.getElementById('pauseBtn').addEventListener('click', () => this.togglePause());

    document.getElementById('settingsBtn').addEventListener('click', () => this.showScreen('settingsScreen'));
    document.getElementById('backBtn').addEventListener('click', () => this.showScreen('recordScreen'));
    document.getElementById('settingsBackBtn').addEventListener('click', () => this.showScreen('recordScreen'));

    document.getElementById('saveSettingsBtn').addEventListener('click', () => this.saveSettings());
    document.getElementById('testConnectionBtn').addEventListener('click', () => this.testConnection());

    document.getElementById('copyAllBtn').addEventListener('click', () => this.copySOAP());
    document.getElementById('copySOAPBtn').addEventListener('click', () => this.copySOAP());
    document.getElementById('sendToMedixsBtn').addEventListener('click', () => this.sendToMedixs());
    document.getElementById('saveOnlyBtn').addEventListener('click', () => this.saveSOAP());

    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => this.toggleEdit(btn.dataset.target));
    });
  },

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
    document.getElementById('header').style.display = (screenId === 'recordScreen') ? '' : 'none';
  },

  // --- Canvas ---
  initCanvas() {
    const canvas = document.getElementById('waveformCanvas');
    const container = canvas.parentElement;
    canvas.width = container.clientWidth * window.devicePixelRatio;
    canvas.height = container.clientHeight * window.devicePixelRatio;
    canvas.style.width = container.clientWidth + 'px';
    canvas.style.height = container.clientHeight + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    this.drawIdleWaveform(ctx, container.clientWidth, container.clientHeight);
  },

  drawIdleWaveform(ctx, width, height) {
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(124, 58, 237, 0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const mid = height / 2;
    for (let x = 0; x < width; x++) {
      const y = mid + Math.sin(x * 0.03) * 8 * Math.sin(x * 0.01);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  },

  startWaveformAnimation() {
    const canvas = document.getElementById('waveformCanvas');
    const ctx = canvas.getContext('2d');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const data = this.recorder.getWaveformData();
      if (!data) { this.waveformAnimId = requestAnimationFrame(draw); return; }

      ctx.strokeStyle = '#7c3aed';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const sliceWidth = width / data.length;
      let x = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128.0;
        const y = (v * height) / 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();

      const vol = this.recorder.getVolumeLevel();
      if (vol > 0.05) {
        ctx.strokeStyle = `rgba(124, 58, 237, ${Math.min(vol * 3, 0.6)})`;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      this.waveformAnimId = requestAnimationFrame(draw);
    };
    draw();
  },

  stopWaveformAnimation() {
    if (this.waveformAnimId) { cancelAnimationFrame(this.waveformAnimId); this.waveformAnimId = null; }
    this.initCanvas();
  },

  // --- 録音制御 ---
  async toggleRecording() {
    if (!this.recorder.isRecording) {
      await this.startRecording();
    } else {
      await this.stopRecording();
    }
  },

  async startRecording() {
    try {
      // マイク録音開始（波形表示用）
      await this.recorder.start();

      // リアルタイム音声認識も同時開始
      SpeechTranscriber.start((final, interim) => {
        this.updateLiveTranscript(final, interim);
      });
      
      // UI更新
      const btn = document.getElementById('recordBtn');
      btn.classList.add('recording');
      document.getElementById('micIcon').classList.add('hidden');
      document.getElementById('stopIcon').classList.remove('hidden');
      document.getElementById('recordLabel').textContent = 'タップして停止 & SOAP生成';
      document.getElementById('pauseBtn').classList.remove('hidden');
      
      // リアルタイム表示エリアを表示
      document.getElementById('liveTranscriptArea').classList.remove('hidden');
      document.getElementById('liveTranscriptText').textContent = '🎤 音声を認識中...';
      
      this.startWaveformAnimation();
      this.toast('🎙️ 録音 & リアルタイム文字起こし開始');
    } catch (err) {
      this.toast(`❌ ${err.message}`, 'error');
    }
  },

  async stopRecording() {
    try {
      // 録音と音声認識を停止
      await this.recorder.stop();
      const transcript = SpeechTranscriber.stop();
      
      // UI復帰
      const btn = document.getElementById('recordBtn');
      btn.classList.remove('recording');
      document.getElementById('micIcon').classList.remove('hidden');
      document.getElementById('stopIcon').classList.add('hidden');
      document.getElementById('recordLabel').textContent = 'タップして録音開始';
      document.getElementById('pauseBtn').classList.add('hidden');
      document.getElementById('recordTime').textContent = '00:00';
      document.getElementById('liveTranscriptArea').classList.add('hidden');
      
      this.stopWaveformAnimation();

      if (!transcript || transcript.trim().length === 0) {
        this.toast('⚠️ 音声が認識されませんでした。もう一度録音してください。', 'error');
        return;
      }

      this.toast(`✅ 文字起こし完了（${transcript.length}文字）— SOAP生成中...`);
      await this.processTranscript(transcript);
    } catch (err) {
      this.toast(`❌ ${err.message}`, 'error');
    }
  },

  /**
   * リアルタイム文字起こし表示を更新
   */
  updateLiveTranscript(finalText, interimText) {
    const el = document.getElementById('liveTranscriptText');
    if (el) {
      const display = finalText + (interimText ? `<span style="color: var(--text-muted)">${interimText}</span>` : '');
      el.innerHTML = display || '🎤 音声を認識中...';
      // 自動スクロール
      el.scrollTop = el.scrollHeight;
    }
  },

  togglePause() {
    if (this.recorder.isPaused) {
      this.recorder.resume();
      document.getElementById('pauseBtn').innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> 一時停止';
    } else {
      this.recorder.pause();
      document.getElementById('pauseBtn').innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> 再開';
    }
  },

  // --- SOAP処理（テキストのみ → Gemini） ---
  async processTranscript(transcript) {
    this.showScreen('soapScreen');
    document.getElementById('processingIndicator').classList.remove('hidden');
    document.getElementById('soapContent').classList.add('hidden');

    try {
      document.getElementById('processingStatus').textContent = 'テキストからSOAP生成中...';
      const drugInfo = document.getElementById('drugInput').value.trim();
      
      // テキストのみ送信（音声トークン不要！）
      const soapData = await GeminiClient.generateSOAP(transcript, drugInfo);

      this.currentSOAP = soapData;
      this.displaySOAP(soapData);

      History.add({
        summary: soapData.summary || '記録',
        drugs: drugInfo,
        duration: this.recorder.getElapsedTime(),
        soap: soapData
      });
      this.renderHistory();

    } catch (err) {
      console.error('[App] SOAP generation failed:', err);
      document.getElementById('processingIndicator').classList.add('hidden');
      this.toast(`❌ ${err.message}`, 'error');
      this.showScreen('recordScreen');
    }
  },

  displaySOAP(data) {
    document.getElementById('processingIndicator').classList.add('hidden');
    document.getElementById('soapContent').classList.remove('hidden');
    document.getElementById('soapS').textContent = data.S || '';
    document.getElementById('soapO').textContent = data.O || '';
    document.getElementById('soapA').textContent = data.A || '';
    document.getElementById('soapP').textContent = data.P || '';
    document.getElementById('transcriptText').textContent = data.transcript || '';
  },

  toggleEdit(targetId) {
    const el = document.getElementById(targetId);
    const isEditable = el.contentEditable === 'true';
    el.contentEditable = isEditable ? 'false' : 'true';
    if (!isEditable) {
      el.focus();
      this.toast('✏️ 編集モード ON');
    } else {
      const section = targetId.replace('soap', '');
      if (this.currentSOAP) this.currentSOAP[section] = el.textContent;
      this.toast('✅ 編集を保存しました');
    }
  },

  async copySOAP() {
    if (!this.currentSOAP) return;
    const text = [
      `【S】${this.currentSOAP.S || ''}`,
      `【O】${this.currentSOAP.O || ''}`,
      `【A】${this.currentSOAP.A || ''}`,
      `【P】${this.currentSOAP.P || ''}`
    ].join('\n\n');

    try {
      await navigator.clipboard.writeText(text);
      this.toast('📋 SOAPをクリップボードにコピーしました');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      this.toast('📋 SOAPをコピーしました');
    }
  },

  sendToMedixs() {
    if (!this.currentSOAP) return;
    const medixsData = {
      S: this.currentSOAP.S || '',
      O: this.currentSOAP.O || '',
      A: this.currentSOAP.A || '',
      P: this.currentSOAP.P || '',
      timestamp: new Date().toISOString()
    };
    localStorage.setItem(Config.MEDIXS_DATA_KEY, JSON.stringify(medixsData));
    this.toast('💊 メディクスへの送信データを準備しました\nPCのメディクス画面でブックマークレットを実行してください');
    this.copySOAP();
  },

  saveSOAP() {
    if (!this.currentSOAP) return;
    this.toast('💾 保存しました');
    this.showScreen('recordScreen');
  },

  // --- 設定 ---
  loadSettings() {
    const settings = Config.load();
    document.getElementById('geminiApiKey').value = settings.geminiApiKey || '';
    document.getElementById('openaiApiKey').value = settings.openaiApiKey || '';
    document.getElementById('gasUrl').value = settings.gasUrl || '';
    document.querySelectorAll('input[name="aiProvider"]').forEach(r => {
      r.checked = r.value === settings.aiProvider;
    });
  },

  saveSettings() {
    const settings = {
      geminiApiKey: document.getElementById('geminiApiKey').value.trim(),
      openaiApiKey: document.getElementById('openaiApiKey').value.trim(),
      gasUrl: document.getElementById('gasUrl').value.trim(),
      aiProvider: document.querySelector('input[name="aiProvider"]:checked')?.value || 'gemini'
    };
    Config.save(settings);
    this.toast('💾 設定を保存しました');
  },

  async testConnection() {
    try {
      this.toast('🔗 接続テスト中...');
      await GeminiClient.testConnection();
      this.toast('✅ 接続成功！APIキーは有効です');
    } catch (err) {
      this.toast(`❌ ${err.message}`, 'error');
    }
  },

  renderHistory() {
    const list = document.getElementById('historyList');
    const records = History.load();
    
    if (records.length === 0) {
      list.innerHTML = '<p class="empty-state">まだ記録がありません</p>';
      return;
    }

    list.innerHTML = records.slice(0, 10).map(record => {
      const date = new Date(record.timestamp);
      const timeStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
      const durStr = record.duration ? `${Math.floor(record.duration/60)}:${String(record.duration%60).padStart(2,'0')}` : '';
      return `
        <div class="history-item" data-id="${record.id}">
          <div class="history-item-info">
            <h4>${record.summary || '記録'}</h4>
            <p>${record.drugs ? '💊 ' + record.drugs.substring(0, 30) : ''} ${durStr ? '⏱ ' + durStr : ''}</p>
          </div>
          <span class="history-item-time">${timeStr}</span>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = parseInt(item.dataset.id);
        const record = records.find(r => r.id === id);
        if (record?.soap) {
          this.currentSOAP = record.soap;
          this.showScreen('soapScreen');
          this.displaySOAP(record.soap);
        }
      });
    });
  },

  toast(message, type = 'info') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast show';
    el.style.borderColor = type === 'error' ? 'var(--danger)' : 'rgba(255,255,255,0.1)';
    setTimeout(() => { el.className = 'toast'; }, 3500);
  }
};

// ==============================================
// 起動
// ==============================================
document.addEventListener('DOMContentLoaded', () => App.init());
