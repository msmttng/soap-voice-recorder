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
    aiProvider: 'gemini',
    speechEngine: 'whisper'
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
// リアルタイム音声認識（Web Speech API）— 安定性強化版
// ==============================================
const SpeechTranscriber = {
  recognition: null,
  isListening: false,
  fullTranscript: '',       // 確定済みテキスト
  interimTranscript: '',    // 認識中テキスト
  onUpdate: null,           // テキスト更新コールバック
  onStatusChange: null,     // ステータス変更コールバック

  // 指数バックオフ再起動制御
  _retryCount: 0,
  _maxRetries: 10,
  _baseDelay: 200,         // 初回 200ms
  _maxDelay: 5000,         // 最大 5秒
  _retryTimer: null,

  /**
   * 音声認識を開始
   */
  start(onUpdate, onStatusChange) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('このブラウザは音声認識に対応していません。Chrome を使用してください。');
    }

    this.fullTranscript = '';
    this.interimTranscript = '';
    this.onUpdate = onUpdate;
    this.onStatusChange = onStatusChange;
    this._retryCount = 0;

    this._createRecognition();
    this.recognition.start();
    this.isListening = true;
    this._emitStatus('listening', '音声認識中');
    console.log('[Speech] Started');
  },

  /**
   * SpeechRecognition インスタンスを作成・設定
   */
  _createRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.lang = 'ja-JP';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = (event) => {
      // 結果を受信 → リトライカウンタリセット
      if (this._retryCount > 0) {
        console.log(`[Speech] Result received — retry count reset (was ${this._retryCount})`);
        this._retryCount = 0;
        this._emitStatus('listening', '音声認識中');
      }

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
      // 'no-speech' と 'aborted' は無視（無音期間やstop時に発生）
      if (event.error === 'no-speech') return;
      if (event.error === 'aborted') return;
      // network エラーは再起動で回復を試みる
      if (event.error === 'network') {
        this._emitStatus('restarting', 'ネットワークエラー — 再起動中...');
        return;
      }
      this._emitStatus('error', `音声認識エラー: ${event.error}`);
    };

    this.recognition.onend = () => {
      // continuous=true でも停止することがあるので自動再開（指数バックオフ）
      if (!this.isListening) return;

      if (this._retryCount >= this._maxRetries) {
        console.error(`[Speech] Max retries (${this._maxRetries}) reached — giving up`);
        this._emitStatus('stopped', `音声認識が${this._maxRetries}回再起動に失敗しました。手動入力に切り替えてください。`);
        this.isListening = false;
        return;
      }

      const delay = Math.min(this._baseDelay * Math.pow(2, this._retryCount), this._maxDelay);
      this._retryCount++;

      console.log(`[Speech] Auto-restart #${this._retryCount} in ${delay}ms`);
      this._emitStatus('restarting', `再起動中... (${this._retryCount}/${this._maxRetries})`);

      this._retryTimer = setTimeout(() => {
        if (!this.isListening) return;
        try {
          // 古いインスタンスを破棄して新しく作り直す
          this._createRecognition();
          this.recognition.start();
          console.log(`[Speech] Restart #${this._retryCount} succeeded`);
          this._emitStatus('listening', '音声認識中（再起動済み）');
        } catch(e) {
          console.warn('[Speech] Restart failed:', e);
          // onend が再度呼ばれるので、次のリトライに委ねる
        }
      }, delay);
    };
  },

  /**
   * 音声認識を停止
   */
  stop() {
    this.isListening = false;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.recognition) {
      try { this.recognition.stop(); } catch(e) {}
      this.recognition = null;
    }
    this._emitStatus('stopped', '音声認識停止');
    console.log('[Speech] Stopped');
    return this.fullTranscript;
  },

  /**
   * バックグラウンド復帰時に音声認識を再開
   */
  recover() {
    if (!this.isListening) return;
    console.log('[Speech] Attempting recovery...');
    try {
      if (this.recognition) {
        try { this.recognition.stop(); } catch(e) {}
      }
      this._retryCount = 0;
      this._createRecognition();
      this.recognition.start();
      this._emitStatus('listening', '音声認識復旧');
      console.log('[Speech] ✅ Recovery succeeded');
    } catch(e) {
      console.warn('[Speech] Recovery failed:', e);
      this._emitStatus('error', '音声認識の復旧に失敗しました');
    }
  },

  /**
   * 現在のテキスト（確定 + 途中）
   */
  getCurrentText() {
    return this.fullTranscript + this.interimTranscript;
  },

  _emitStatus(status, detail) {
    console.log(`[Speech] Status: ${status} — ${detail}`);
    if (typeof this.onStatusChange === 'function') {
      try { this.onStatusChange(status, detail); } catch(e) {}
    }
  }
};

// ==============================================
// Gemini API クライアント（テキストのみ版）
// ==============================================
const GeminiClient = {
  // クォータがあるモデルのみ使用（2.x系はlimit:0で使用不可）
  MODEL_CONFIGS: [
    { model: 'gemini-2.5-flash-lite', api: 'v1beta' },
    { model: 'gemini-2.5-flash', api: 'v1beta' },
    { model: 'gemini-2.0-flash-lite', api: 'v1beta' },
    { model: 'gemini-2.0-flash', api: 'v1beta' },
  ],

  /**
   * テキストからSOAPを生成（複数モデル+APIバージョンフォールバック）
   */
  async generateSOAP(transcript, drugInfo) {
    const settings = Config.load();
    const apiKey = settings.geminiApiKey;

    if (!apiKey) {
      throw new Error('Gemini APIキーが設定されていません。設定画面でAPIキーを入力してください。');
    }

    const prompt = this._buildPrompt(transcript, drugInfo);

    const requestBody = {
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        maxOutputTokens: 2048
      }
    };

    // 全設定を順に試行
    const errors = [];
    const statusEl = document.getElementById('processingStatus');
    
    for (let i = 0; i < this.MODEL_CONFIGS.length; i++) {
      const cfg = this.MODEL_CONFIGS[i];
      const label = `${cfg.model} (${cfg.api})`;
      
      console.log(`[Gemini] Trying ${i + 1}/${this.MODEL_CONFIGS.length}: ${label}`);
      if (statusEl) {
        statusEl.textContent = `${cfg.model} で生成中...`;
      }

      try {
        return await this._callAPI(cfg.model, cfg.api, apiKey, requestBody);
      } catch (err) {
        console.warn(`[Gemini] ${label} failed:`, err.message);
        errors.push(`${label}: ${err.message}`);
        
        // 少し待って次へ
        if (i < this.MODEL_CONFIGS.length - 1) {
          if (statusEl && err.isRateLimit) {
            statusEl.textContent = `${cfg.model}: 制限。次のモデルへ...`;
          }
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
      }
    }

    // 最終手段: 30秒待って最初のモデルでリトライ
    if (statusEl) {
      for (let sec = 30; sec > 0; sec--) {
        statusEl.textContent = `全モデル制限中...${sec}秒後に最終リトライ`;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    // もう1回だけ全パターン試行
    for (const cfg of this.MODEL_CONFIGS) {
      try {
        if (statusEl) statusEl.textContent = `${cfg.model} で最終リトライ中...`;
        return await this._callAPI(cfg.model, cfg.api, apiKey, requestBody);
      } catch (e) {
        continue;
      }
    }

    throw new Error(`全モデルで生成に失敗しました。しばらく時間をおいてお試しください。\n${errors.slice(0, 3).join('\n')}`);
  },

  /**
   * 単一モデルでのAPI呼び出し
   */
  async _callAPI(model, apiVersion, apiKey, requestBody) {
    const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error?.message || response.statusText;
      console.error(`[Gemini] ${model}(${apiVersion}) Error ${response.status}:`, errorMsg);

      if (response.status === 429) {
        const err = new Error(`レート制限: ${errorMsg}`);
        err.isRateLimit = true;
        throw err;
      }
      
      if (response.status === 403 || response.status === 400) {
        throw new Error(`APIエラー: ${errorMsg}`);
      }
      
      throw new Error(`APIエラー (${response.status}): ${errorMsg}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('AIからの応答が空でした。');

    console.log(`[Gemini] ✅ ${model}(${apiVersion}) success!`);
    return this._parseSOAPResponse(text);
  },

  /**
   * 単一モデルでのAPI呼び出し（生テキスト返却版）
   */
  async _callAPIRaw(model, apiVersion, apiKey, requestBody) {
    const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error?.message || response.statusText;
      if (response.status === 429) {
        const err = new Error(`レート制限: ${errorMsg}`);
        err.isRateLimit = true;
        throw err;
      }
      throw new Error(`APIエラー (${response.status}): ${errorMsg}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('AIからの応答が空でした。');

    console.log(`[Gemini] ✅ ${model}(${apiVersion}) raw success!`);
    return text;
  },

  /**
   * AIレスポンスからSOAP JSONを抽出
   */
  _parseSOAPResponse(text) {
    // JSONブロックを探す
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[1]); } catch {}
    }

    // 直接JSONの場合
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch {}
    }

    // パース失敗 → テキストをそのまま使う
    return {
      transcript: text,
      S: '（自動パースに失敗しました。文字起こし全文を確認してください）',
      O: '', A: '', P: '',
      summary: '要確認'
    };
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
  },

  /**
   * 音声→文字起こしのみ（トークン節約版）
   * SOAP生成は行わず、テキストのみ返却
   */
  async transcribeAudio(audioBlob, mimeType) {
    const settings = Config.load();
    const apiKey = settings.geminiApiKey;
    if (!apiKey) throw new Error('APIキーが設定されていません');

    const audioBase64 = await AudioRecorder.blobToBase64(audioBlob);

    const requestBody = {
      contents: [{
        parts: [
          { inlineData: { mimeType: mimeType, data: audioBase64 } },
          { text: '以下の音声を日本語で文字起こししてください。薬剤師と患者の会話です。文字起こしのみを出力し、他の情報は不要です。' }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2000
      }
    };

    // 複数モデルフォールバック
    for (let i = 0; i < this.MODEL_CONFIGS.length; i++) {
      const cfg = this.MODEL_CONFIGS[i];
      try {
        const text = await this._callAPIRaw(cfg.model, cfg.api, apiKey, requestBody);
        console.log(`[Gemini] ✅ Transcription via ${cfg.model}: ${text.length} chars`);
        return text;
      } catch (err) {
        console.warn(`[Gemini] Transcription ${cfg.model} failed:`, err.message);
        if (i < this.MODEL_CONFIGS.length - 1) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }
    throw new Error('全モデルで文字起こしに失敗しました');
  }
};

// ==============================================
// OpenAI API クライアント (Whisper 連携)
// ==============================================
const OpenAIClient = {
  async transcribeAudio(audioBlob, mimeType) {
    const settings = Config.load();
    const apiKey = settings.openaiApiKey;
    if (!apiKey) throw new Error('OpenAI APIキーが設定されていません。設定画面でAPIキーを入力してください。');

    // MIMEタイプに合わせて拡張子を決定
    const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';
    const audioFile = new File([audioBlob], `audio.${ext}`, { type: mimeType });

    const formData = new FormData();
    formData.append('file', audioFile);
    formData.append('model', 'whisper-1');
    formData.append('language', 'ja');

    const url = 'https://api.openai.com/v1/audio/transcriptions';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error?.message || response.statusText;
      if (response.status === 401) {
         throw new Error('OpenAI APIキーが無効です。');
      }
      throw new Error(`APIエラー (${response.status}): ${errorMsg}`);
    }

    const data = await response.json();
    console.log('[OpenAI] Whisper transcription successful');
    return data.text;
  }
};

// ==============================================
// GAS バックエンドクライアント
// ==============================================
const GASClient = {
  /**
   * SOAPデータをGASに保存
   */
  async saveSOAP(soapData, drugInfo, duration, patientName, nsipsRow) {
    const settings = Config.load();
    if (!settings.gasUrl) {
      console.log('[GAS] URL not configured, skipping cloud save');
      return null;
    }

    const payload = {
      S: soapData.S || '',
      O: soapData.O || '',
      A: soapData.A || '',
      P: soapData.P || '',
      transcript: soapData.transcript || '',
      summary: soapData.summary || '',
      drugs: drugInfo || '',
      duration: duration || 0,
      patientName: patientName || '',
      nsipsRow: nsipsRow || null
    };

    try {
      const response = await fetch(settings.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        mode: 'no-cors' // GAS requires no-cors for POST
      });

      // no-cors の場合 response.ok は常に false なので opaque response をチェック
      console.log('[GAS] ✅ Save request sent');
      return { success: true };
    } catch (err) {
      console.error('[GAS] Save failed:', err);
      throw new Error(`クラウド保存に失敗: ${err.message}`);
    }
  },

  /**
   * 接続テスト
   */
  async testConnection() {
    const settings = Config.load();
    if (!settings.gasUrl) throw new Error('GAS URLが設定されていません');

    try {
      const response = await fetch(`${settings.gasUrl}?action=ping`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.success) throw new Error(data.error || '不明なエラー');
      return true;
    } catch (err) {
      throw new Error(`GAS接続エラー: ${err.message}`);
    }
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
  yakurekiRecorder: null,
  currentSOAP: null,
  waveformAnimId: null,
  selectedPatient: null,
  currentTab: 'soap',
  yakurekiTranscript: '',

  init() {
    this.recorder = new AudioRecorder();
    this.yakurekiRecorder = new AudioRecorder();
    this.bindEvents();
    this.loadSettings();
    this.renderHistory();
    this.initCanvas();
    this.checkSpeechSupport();
    this.loadPatients();
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
    document.getElementById('refreshPatientsBtn').addEventListener('click', () => this.loadPatients());

    document.getElementById('copyAllBtn').addEventListener('click', () => this.copySOAP());
    document.getElementById('copySOAPBtn').addEventListener('click', () => this.copySOAP());
    document.getElementById('sendToMedixsBtn').addEventListener('click', () => this.sendToMedixs());
    document.getElementById('saveOnlyBtn').addEventListener('click', () => this.saveSOAP());

    // AI薬歴タブ
    document.getElementById('yakurekiRecordBtn').addEventListener('click', () => this.yakurekiToggleRecording());
    document.getElementById('yakurekiCopyBtn').addEventListener('click', () => this.yakurekiCopy());
    document.getElementById('yakurekiClearBtn').addEventListener('click', () => this.yakurekiClear());

    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => this.toggleEdit(btn.dataset.target));
    });

    // テキスト直接入力からSOAP生成
    document.getElementById('generateFromTextBtn').addEventListener('click', () => this.generateFromText());
  },

  // --- タブ切り替え ---
  switchTab(tab) {
    this.currentTab = tab;
    
    // タブボタンの状態更新
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    
    // 画面の表示切替
    const recordScreen = document.getElementById('recordScreen');
    const yakurekiScreen = document.getElementById('yakurekiScreen');
    
    if (tab === 'soap') {
      recordScreen.classList.add('active');
      yakurekiScreen.classList.remove('active');
    } else {
      recordScreen.classList.remove('active');
      yakurekiScreen.classList.add('active');
      // 患者プルダウンを同期
      this.syncYakurekiPatients();
    }
    
    // 設定・SOAP画面を非表示
    document.getElementById('soapScreen').classList.remove('active');
    document.getElementById('settingsScreen').classList.remove('active');
    document.getElementById('tabBar').style.display = '';
  },

  syncYakurekiPatients() {
    // 話者分離に特化したため患者選択の同期は不要になりました
  },

  // --- AI薬歴: 録音 ---
  yakurekiToggleRecording() {
    if (this.yakurekiRecorder.isRecording) {
      this.yakurekiStopRecording();
    } else {
      this.yakurekiStartRecording();
    }
  },

  async yakurekiStartRecording() {
    this.yakurekiTranscript = '';
    this._yakurekiSpeechWorked = false;
    document.getElementById('yakurekiTranscriptArea').classList.remove('hidden');
    document.getElementById('yakurekiOutputArea').classList.add('hidden');

    try {
      const settings = Config.load();
      const useWhisper = settings.speechEngine === 'whisper';

      // マイク録音開始（音声Blob用 — iOSフォールバック用に常に保持）
      await this.yakurekiRecorder.start();

      // タイマー表示
      this.yakurekiRecorder.onStatusChange = (status, detail) => {
        // タイマーは不要（タイマー表示は汎用的に行う）
      };
      this._yakurekiTimerInterval = setInterval(() => {
        const el = document.getElementById('yakurekiRecordTime');
        if (el) el.textContent = this.yakurekiRecorder.getFormattedTime();
      }, 500);

      if (!useWhisper) {
        // Web Speech API も並行開始（失敗しても録音は続行）
        try {
          SpeechTranscriber.start(
            (final, interim) => {
              this.yakurekiTranscript = final + interim;
              this._yakurekiSpeechWorked = true;
              const el = document.getElementById('yakurekiTranscriptText');
              if (el) el.textContent = this.yakurekiTranscript || '🎤 音声を認識中...';
            },
            (status, detail) => {
              console.log(`[Yakureki Speech] ${status}: ${detail}`);
            }
          );
        } catch (speechErr) {
          console.warn('[Yakureki] Speech API not available:', speechErr);
          document.getElementById('yakurekiTranscriptText').textContent = '🎤 録音中（音声認識非対応 — AI文字起こしを使用）';
        }
      } else {
        document.getElementById('yakurekiTranscriptText').innerHTML = '🎙 録音中...<br><span style="font-size:12px; color:var(--text-muted)">（終了後にWhisper高精度エンジンで一括文字起こしを実行します）</span>';
      }

      // UI更新
      document.getElementById('yakurekiMicIcon').classList.add('hidden');
      document.getElementById('yakurekiStopIcon').classList.remove('hidden');
      document.getElementById('yakurekiRecordBtn').classList.add('recording');
      document.getElementById('yakurekiRecordLabel').textContent = 'タップして停止';
      this.toast('🎤 録音開始');
    } catch (err) {
      this.toast('❌ マイクへのアクセスに失敗しました', 'error');
      console.error('[Yakureki] Start error:', err);
    }
  },

  async yakurekiStopRecording() {
    // 録音停止 → Blob取得
    const recording = await this.yakurekiRecorder.stop();

    // タイマー停止
    if (this._yakurekiTimerInterval) {
      clearInterval(this._yakurekiTimerInterval);
      this._yakurekiTimerInterval = null;
    }

    // UI復帰
    document.getElementById('yakurekiMicIcon').classList.remove('hidden');
    document.getElementById('yakurekiStopIcon').classList.add('hidden');
    document.getElementById('yakurekiRecordBtn').classList.remove('recording');
    document.getElementById('yakurekiRecordLabel').textContent = 'タップして録音開始';
    document.getElementById('yakurekiRecordTime').textContent = '00:00';

    const settings = Config.load();
    const useWhisper = settings.speechEngine === 'whisper';
    let speechText = '';

    if (useWhisper) {
        document.getElementById('yakurekiTranscriptText').innerHTML = '⏳ OpenAI Whisperで文字起こし中...<br><span style="font-size:12px; color:var(--text-muted)">（数秒〜10秒程度かかります）</span>';
        try {
          speechText = await OpenAIClient.transcribeAudio(recording.blob, recording.mimeType);
          document.getElementById('yakurekiTranscriptText').textContent = speechText;
        } catch (whisperErr) {
          console.error('[Yakureki] Whisper error:', whisperErr);
          document.getElementById('yakurekiTranscriptText').textContent = `❌ Whisper文字起こし失敗: ${whisperErr.message}`;
        }
    } else {
      // Speech API 停止
      try {
        speechText = SpeechTranscriber.stop();
      } catch(e) {}
    }

    // === 2段階方式 ===
    const transcript = speechText || (!useWhisper ? this.yakurekiTranscript : '');

    if (transcript && transcript.trim().length > 0) {
      // ✅ Stage 1: API成功 → テキストでAI薬歴生成
      this.toast(`✅ 文字起こし完了（${transcript.length}文字）`);
      await this.yakurekiGenerateSummary(transcript);
    } else if (recording && recording.blob && recording.blob.size > 0 && !useWhisper) {
      // ✅ Stage 2: (WebSpeech利用時のみのフォールバック) 音声をGeminiで文字起こし
      this.toast('🧠 音声をAIで文字起こし中...');
      document.getElementById('yakurekiTranscriptText').textContent = '⏳ AIが音声を文字起こし中...';

      try {
        const transcribedText = await GeminiClient.transcribeAudio(
          recording.blob, recording.mimeType
        );
        document.getElementById('yakurekiTranscriptText').textContent = transcribedText;
        this.toast(`✅ AI文字起こし完了（${transcribedText.length}文字）`);
        await this.yakurekiGenerateSummary(transcribedText);
      } catch (err) {
        console.error('[Yakureki] Audio transcription failed:', err);
        document.getElementById('yakurekiTranscriptText').textContent = `❌ 文字起こし失敗: ${err.message}`;
        this.toast('❌ 音声の文字起こしに失敗しました', 'error');
      }
    } else {
      this.toast('⚠️ 音声を認識できませんでした', 'error');
    }
  },

  // --- AI薬歴: 話者分離テキスト生成 ---
  async yakurekiGenerateSummary(transcript) {
    const settings = Config.load();
    if (!settings.geminiApiKey) {
      this.toast('⚠️ APIキーを設定してください', 'error');
      // APIキーがない場合はそのまま出力
      document.getElementById('yakurekiOutputArea').classList.remove('hidden');
      document.getElementById('yakurekiOutput').textContent = transcript;
      return;
    }

    const prompt = `あなたは医療テキストの文字起こしアシスタントです。
以下のテキストは薬剤師と患者の会話の文字起こしです。
会話から話者を推測し、「薬剤師:」と「患者:」のラベルを付けて会話を再構成してください。
その他の解説、要約、注釈は一切出力せず、話者分離された会話のテキストのみを出力してください。

## 会話テキスト
${transcript}`;

    this.toast('🧠 AI話者分離中...');
    document.getElementById('yakurekiOutputArea').classList.remove('hidden');
    document.getElementById('yakurekiOutput').textContent = '⏳ AIが話者を分離中...';

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2, // 低めのtemperatureで事実重視
        maxOutputTokens: 2000
      }
    };

    const errors = [];
    const outputEl = document.getElementById('yakurekiOutput');

    for (let i = 0; i < GeminiClient.MODEL_CONFIGS.length; i++) {
      const cfg = GeminiClient.MODEL_CONFIGS[i];
      console.log(`[Yakureki] Trying ${i + 1}/${GeminiClient.MODEL_CONFIGS.length}: ${cfg.model}`);
      outputEl.textContent = `⏳ ${cfg.model} で話者分離中...`;

      try {
        const text = await GeminiClient._callAPIRaw(cfg.model, cfg.api, settings.geminiApiKey, requestBody);
        outputEl.textContent = text;
        this.toast('✅ 話者分離完了');
        return;
      } catch (err) {
        console.warn(`[Yakureki] ${cfg.model} failed:`, err.message);
        errors.push(`${cfg.model}: ${err.message}`);
        if (i < GeminiClient.MODEL_CONFIGS.length - 1) {
          outputEl.textContent = `⏳ ${cfg.model} が制限中...次のモデルへ`;
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    // 最終リトライ: 15秒待って再試行
    for (let sec = 15; sec > 0; sec--) {
      outputEl.textContent = `⏳ 全モデル制限中...${sec}秒後に最終リトライ`;
      await new Promise(r => setTimeout(r, 1000));
    }
    for (const cfg of GeminiClient.MODEL_CONFIGS) {
      try {
        outputEl.textContent = `⏳ ${cfg.model} で最終リトライ中...`;
        const text = await GeminiClient._callAPIRaw(cfg.model, cfg.api, settings.geminiApiKey, requestBody);
        outputEl.textContent = text;
        this.toast('✅ 話者分離完了');
        return;
      } catch (e) { continue; }
    }

    // 全て失敗した場合はプレーンテキストをそのまま表示
    outputEl.textContent = transcript;
    this.toast('❌ AI分離に失敗したため、そのままテキストを表示します', 'error');
  },

  // --- AI薬歴: コピー ---
  async yakurekiCopy() {
    const text = document.getElementById('yakurekiOutput').textContent;
    if (!text) {
      this.toast('⚠️ コピーするデータがありません', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.toast('📋 クリップボードにコピーしました');
    } catch (err) {
      // フォールバック
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.toast('📋 コピーしました');
    }
  },

  // --- AI薬歴: クリア ---
  yakurekiClear() {
    document.getElementById('yakurekiOutput').textContent = '';
    document.getElementById('yakurekiOutputArea').classList.add('hidden');
    document.getElementById('yakurekiTranscriptArea').classList.add('hidden');
    this.yakurekiTranscript = '';
    this.toast('🗑 クリアしました');
  },

  /**
   * テキスト直接入力からSOAP生成
   */
  async generateFromText() {
    const text = document.getElementById('manualTranscriptInput').value.trim();
    if (!text) {
      this.toast('⚠️ 会話内容を入力してください', 'error');
      return;
    }
    this.toast('🧠 テキストからSOAP生成中...');
    await this.processTranscript(text);
  },

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');

    // ヘッダーとタブバーの表示制御
    const isMainScreen = (screenId === 'recordScreen' || screenId === 'yakurekiScreen');
    document.getElementById('header').style.display = isMainScreen ? '' : 'none';
    document.getElementById('tabBar').style.display = isMainScreen ? '' : 'none';
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
      const settings = Config.load();
      const useWhisper = settings.speechEngine === 'whisper';

      // マイク録音開始（波形表示 + 音声バックアップ用）
      await this.recorder.start();
      this.lastRecording = null;

      // レコーダーのステータス変更をUIに反映
      this.recorder.onStatusChange = (status, detail) => {
        this.updateRecorderStatus(status, detail);
      };

      if (!useWhisper) {
        // リアルタイム音声認識も同時開始（失敗しても録音は続行）
        try {
          SpeechTranscriber.start(
            (final, interim) => {
              this.updateLiveTranscript(final, interim);
            },
            (status, detail) => {
              this.updateSpeechStatus(status, detail);
            }
          );
        } catch (speechErr) {
          console.warn('[App] Speech API not available:', speechErr);
        }

        // visibilitychange で Speech API も復旧
        this._visibilityRecovery = () => {
          if (document.visibilityState === 'visible' && this.recorder.isRecording) {
            console.log('[App] Page visible — recovering Speech API');
            SpeechTranscriber.recover();
            this.toast('🔄 バックグラウンドから復帰しました');
          }
        };
        document.addEventListener('visibilitychange', this._visibilityRecovery);
      }
      
      // UI更新
      const btn = document.getElementById('recordBtn');
      btn.classList.add('recording');
      document.getElementById('micIcon').classList.add('hidden');
      document.getElementById('stopIcon').classList.remove('hidden');
      document.getElementById('recordLabel').textContent = 'タップして停止 & SOAP生成';
      document.getElementById('pauseBtn').classList.remove('hidden');
      
      // リアルタイム表示エリアを表示
      document.getElementById('liveTranscriptArea').classList.remove('hidden');
      
      if (useWhisper) {
        document.getElementById('liveTranscriptText').innerHTML = '🎙 録音中...<br><span style="font-size:12px; color:var(--text-muted)">（終了後にWhisper高精度エンジンで一括文字起こしを実行します）</span>';
        this.updateSpeechStatus('listening', 'Whisper録音中');
      } else {
        document.getElementById('liveTranscriptText').textContent = '🎤 音声を認識中...';
        this.updateSpeechStatus('listening', '音声認識中');
      }
      
      this.startWaveformAnimation();
      this.toast('🎙️ 録音開始（画面ロック防止ON）');
    } catch (err) {
      this.toast(`❌ ${err.message}`, 'error');
    }
  },

  async stopRecording() {
    try {
      const settings = Config.load();
      const useWhisper = settings.speechEngine === 'whisper';

      // 録音停止 → Blobを取得
      const recording = await this.recorder.stop();
      this.lastRecording = recording;
      
      // UI復帰
      const btn = document.getElementById('recordBtn');
      btn.classList.remove('recording');
      document.getElementById('micIcon').classList.remove('hidden');
      document.getElementById('stopIcon').classList.add('hidden');
      document.getElementById('recordLabel').textContent = 'タップして録音開始';
      document.getElementById('pauseBtn').classList.add('hidden');
      document.getElementById('recordTime').textContent = '00:00';
      this.stopWaveformAnimation();

      let transcript = '';

      if (useWhisper) {
        // Whisper APIへ送信
        const liveArea = document.getElementById('liveTranscriptArea');
        liveArea.classList.remove('hidden');
        document.getElementById('liveTranscriptText').innerHTML = '⏳ OpenAI Whisperで文字起こし中...<br><span style="font-size:12px; color:var(--text-muted)">（数秒〜10秒程度かかります）</span>';
        this.updateSpeechStatus('listening', 'Whisper解析中');

        try {
          transcript = await OpenAIClient.transcribeAudio(recording.blob, recording.mimeType);
        } catch (whisperErr) {
          console.error('[App] Whisper error:', whisperErr);
          this.toast(`❌ Whisper文字起こし失敗: ${whisperErr.message}`, 'error');
        }
      } else {
        // Web Speech APIの結果取得を試みる
        try {
          transcript = SpeechTranscriber.stop();
        } catch(e) {
          console.warn('[App] SpeechTranscriber.stop() error:', e);
        }

        // visibilitychange リスナー解除
        if (this._visibilityRecovery) {
          document.removeEventListener('visibilitychange', this._visibilityRecovery);
          this._visibilityRecovery = null;
        }
      }

      // === 処理フロー ===
      if (transcript && transcript.trim().length > 0) {
        // 成功 → テキストでSOAP生成
        document.getElementById('liveTranscriptArea').classList.add('hidden');
        this.toast(`✅ 文字起こし完了（${transcript.length}文字）— SOAP生成中...`);
        await this.processTranscript(transcript);
      } else {
        // 失敗 → フォールバックUI表示
        console.log('[App] Transcript is empty, showing options');
        this.showTranscriptFallback(recording);
      }
    } catch (err) {
      this.toast(`❌ ${err.message}`, 'error');
    }
  },

  /**
   * Speech API失敗時のフォールバックUI
   */
  showTranscriptFallback(recording) {
    const liveArea = document.getElementById('liveTranscriptArea');
    liveArea.classList.remove('hidden');
    liveArea.innerHTML = `
      <div class="card-header">
        <span class="card-icon">⚠️</span>
        <h2>音声認識がテキストを取得できませんでした</h2>
      </div>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:12px;">
        以下のいずれかの方法で進めてください：
      </p>
      <div style="margin-bottom:12px;">
        <label style="font-size:13px; font-weight:500; color:var(--text-primary); display:block; margin-bottom:6px;">
          ✍️ 方法1: 会話内容を手入力
        </label>
        <textarea id="manualTranscript" rows="4" style="width:100%; background:var(--bg-input); border:1px solid rgba(0,0,0,0.08); border-radius:8px; padding:12px; color:var(--text-primary); font-family:var(--font-main); font-size:14px; resize:vertical;" 
          placeholder="患者との会話の要点を入力してください&#10;例: 患者「最近血圧が高くて...」&#10;薬剤師「お薬はちゃんと飲めていますか？」"></textarea>
      </div>
      <button id="submitManualBtn" class="action-btn primary-btn" style="margin-bottom:8px;">
        ✍️ この内容でSOAP生成
      </button>
      <button id="submitAudioBtn" class="action-btn secondary-btn" style="margin-bottom:8px;">
        🤖 録音音声をAIに送信（API制限注意）
      </button>
      <button id="cancelFallbackBtn" class="action-btn tertiary-btn">
        ← やり直す
      </button>
    `;

    // 手動入力でSOAP生成
    document.getElementById('submitManualBtn').addEventListener('click', async () => {
      const text = document.getElementById('manualTranscript').value.trim();
      if (!text) {
        this.toast('⚠️ テキストを入力してください', 'error');
        return;
      }
      liveArea.classList.add('hidden');
      this.toast('✅ テキストからSOAP生成中...');
      await this.processTranscript(text);
    });

    // 音声ファイルをGemini送信（フォールバック）
    document.getElementById('submitAudioBtn').addEventListener('click', async () => {
      liveArea.classList.add('hidden');
      this.toast('🤖 録音音声をAIに送信中...');
      await this.processAudioFallback(recording);
    });

    // キャンセル
    document.getElementById('cancelFallbackBtn').addEventListener('click', () => {
      liveArea.classList.add('hidden');
      // リセット
      liveArea.innerHTML = `
        <div class="card-header">
          <span class="card-icon">📝</span>
          <h2>リアルタイム文字起こし</h2>
          <span style="font-size:11px; color:var(--success); margin-left:auto;">● LIVE</span>
        </div>
        <div id="liveTranscriptText" style="font-size:14px; line-height:1.7; color:var(--text-primary); max-height:150px; overflow-y:auto; white-space:pre-wrap;">
          🎤 音声を認識中...
        </div>
      `;
    });
  },

  /**
   * 音声ファイルをGeminiに直接送信（フォールバック）
   */
  async processAudioFallback(recording) {
    this.showScreen('soapScreen');
    document.getElementById('processingIndicator').classList.remove('hidden');
    document.getElementById('soapContent').classList.add('hidden');
    document.getElementById('processingStatus').textContent = '音声データを準備中...';

    try {
      const audioBase64 = await AudioRecorder.blobToBase64(recording.blob);
      document.getElementById('processingStatus').textContent = 'AIが音声を分析中...（15秒程度かかります）';
      
      const drugInfo = document.getElementById('drugInput').value.trim();
      const settings = Config.load();
      const apiKey = settings.geminiApiKey;
      
      if (!apiKey) throw new Error('APIキーが設定されていません');

      // 音声送信用のリクエスト
      const requestBody = {
        contents: [{
          parts: [
            { inlineData: { mimeType: recording.mimeType, data: audioBase64 } },
            { text: GeminiClient._buildPrompt('（音声データから文字起こしして以下の形式で出力してください）', drugInfo) }
          ]
        }],
        generationConfig: {
          temperature: 0.3, topP: 0.8, maxOutputTokens: 4096,
          responseMimeType: 'application/json'
        }
      };

      // モデルを順番に試行
      let soapData = null;
      for (const model of GeminiClient.MODELS) {
        try {
          soapData = await GeminiClient._callAPI(model, apiKey, requestBody);
          break;
        } catch (err) {
          if (err.status === 429) {
            document.getElementById('processingStatus').textContent = `${model} が制限中...5秒待って次のモデルを試行`;
            await new Promise(r => setTimeout(r, 5000));
          } else if (err.status === 403) throw err;
        }
      }

      if (!soapData) throw new Error('すべてのモデルでAPI制限に達しました。数分待ってからお試しください。');

      this.currentSOAP = soapData;
      this.displaySOAP(soapData);
      History.add({ summary: soapData.summary || '記録', drugs: drugInfo, soap: soapData });
      this.renderHistory();

    } catch (err) {
      console.error('[App] Audio fallback failed:', err);
      document.getElementById('processingIndicator').classList.add('hidden');
      this.toast(`❌ ${err.message}`, 'error');
      this.showScreen('recordScreen');
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

  /**
   * 音声認識ステータスをUIに反映
   */
  updateSpeechStatus(status, detail) {
    const statusEl = document.getElementById('speechStatus');
    if (!statusEl) return;

    const statusMap = {
      'listening':   { icon: '🟢', text: '認識中' },
      'restarting':  { icon: '🟡', text: '再起動中...' },
      'stopped':     { icon: '🔴', text: '停止' },
      'error':       { icon: '🔴', text: 'エラー' }
    };
    const s = statusMap[status] || { icon: '⚪', text: status };
    statusEl.textContent = `${s.icon} ${s.text}`;
    statusEl.title = detail || '';

    // 停止・エラー時にtoast通知
    if (status === 'stopped' || status === 'error') {
      this.toast(`⚠️ ${detail}`, 'error');
    }
  },

  /**
   * レコーダーステータスをUIに反映
   */
  updateRecorderStatus(status, detail) {
    if (status === 'wake-lock-lost') {
      this.toast('⚠️ 画面ロック防止が解除されました。画面をタップして復旧してください。', 'error');
    } else if (status === 'resumed') {
      this.toast(`🔄 ${detail}`);
    } else if (status === 'error') {
      this.toast(`❌ 録音エラー: ${detail}`, 'error');
    }
  },

  // --- NSIPS 患者選択 ---
  async loadPatients() {
    const settings = Config.load();
    if (!settings.gasUrl) {
      document.getElementById('patientSelectArea').classList.add('hidden');
      return;
    }

    const btn = document.getElementById('refreshPatientsBtn');
    if (btn) {
      btn.textContent = '⏳ 更新中...';
      btn.disabled = true;
    }

    try {
      // キャッシュを回避するためにタイムスタンプを付与
      const response = await fetch(`${settings.gasUrl}?action=patients&t=${Date.now()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      
      document.getElementById('patientSelectArea').classList.remove('hidden');

      if (data.success && data.patients && data.patients.length > 0) {
        this.renderPatients(data.patients);
        this.toast('✅ 最新の患者情報を受信しました');
      } else {
        const select = document.getElementById('patientSelect');
        if (select) select.innerHTML = '<option value="">(待機中のNSIPSデータはありません)</option>';
        this._patientMap = {};
        this.selectedPatient = null;
        this.toast('ℹ️ 待機中のデータはありません');
      }
    } catch (err) {
      console.warn('[App] Patient list fetch failed:', err);
      this.toast('❌ リストの更新に失敗しました', 'error');
    } finally {
      if (btn) {
        btn.textContent = '🔄 更新';
        btn.disabled = false;
      }
    }
  },

  renderPatients(patients) {
    const select = document.getElementById('patientSelect');
    select.innerHTML = '<option value="">-- 患者を選択 --</option>';
    
    // 患者データをマップに保存
    this._patientMap = {};
    patients.forEach(p => {
      this._patientMap[p.row] = p;
      const opt = document.createElement('option');
      opt.value = p.row;
      opt.textContent = p.name;
      select.appendChild(opt);
    });

    // 選択イベント
    select.onchange = () => {
      const row = select.value;
      if (row && this._patientMap[row]) {
        const patient = this._patientMap[row];
        this.selectedPatient = patient;
        document.getElementById('drugInput').value = patient.drug_summary || '';
        this.toast(`👤 ${patient.name} さんを選択しました`);
      } else {
        this.selectedPatient = null;
      }
    };
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

  async saveSOAP() {
    if (!this.currentSOAP) return;
    
    // GASにクラウド保存を試行
    const drugInfo = document.getElementById('drugInput').value.trim();
    const patientName = this.selectedPatient ? this.selectedPatient.name : '';
    const nsipsRow = this.selectedPatient ? this.selectedPatient.row : null;
    
    try {
      const result = await GASClient.saveSOAP(
        this.currentSOAP, drugInfo, this.recorder.getElapsedTime(),
        patientName, nsipsRow
      );
      if (result) {
        this.toast(`💾 ☁️ ${patientName ? patientName + 'さんの' : ''}SOAPを保存しました`);
      } else {
        this.toast('💾 ローカルに保存しました（GAS未設定）');
      }
    } catch (err) {
      console.warn('[App] Cloud save failed:', err);
      this.toast('💾 ローカル保存済み（クラウド保存失敗）');
    }
    
    // 患者選択をリセット
    this.selectedPatient = null;
    this.loadPatients();
    
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
    document.querySelectorAll('input[name="speechEngine"]').forEach(r => {
      r.checked = r.value === (settings.speechEngine || 'whisper');
    });
  },

  saveSettings() {
    const settings = {
      geminiApiKey: document.getElementById('geminiApiKey').value.trim(),
      openaiApiKey: document.getElementById('openaiApiKey').value.trim(),
      gasUrl: document.getElementById('gasUrl').value.trim(),
      aiProvider: document.querySelector('input[name="aiProvider"]:checked')?.value || 'gemini',
      speechEngine: document.querySelector('input[name="speechEngine"]:checked')?.value || 'whisper'
    };
    Config.save(settings);
    this.toast('💾 設定を保存しました');
  },

  async testConnection() {
    try {
      this.toast('🔗 接続テスト中...');
      const results = [];
      
      // Gemini API テスト
      try {
        await GeminiClient.testConnection();
        results.push('✅ Gemini API: OK');
      } catch (err) {
        results.push(`❌ Gemini: ${err.message}`);
      }
      
      // GAS テスト
      const settings = Config.load();
      if (settings.gasUrl) {
        try {
          await GASClient.testConnection();
          results.push('✅ GAS: OK');
        } catch (err) {
          results.push(`❌ GAS: ${err.message}`);
        }
      } else {
        results.push('⚪ GAS: 未設定');
      }
      
      this.toast(results.join('\n'));
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
    el.style.borderColor = type === 'error' ? 'var(--danger)' : 'rgba(0,0,0,0.08)';
    setTimeout(() => { el.className = 'toast'; }, 3500);
  }
};

// ==============================================
// 起動
// ==============================================
document.addEventListener('DOMContentLoaded', () => App.init());
