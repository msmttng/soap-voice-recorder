/**
 * app.js — SOAP Voice Recorder メインアプリケーション
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
// Gemini API クライアント（直接呼び出し版）
// ==============================================
const GeminiClient = {
  /**
   * 音声ファイルからSOAPを生成
   * GASを使わず、PWAから直接Gemini APIを呼び出す
   */
  async generateSOAP(audioBase64, mimeType, drugInfo) {
    const settings = Config.load();
    const apiKey = settings.geminiApiKey;

    if (!apiKey) {
      throw new Error('Gemini APIキーが設定されていません。設定画面でAPIキーを入力してください。');
    }

    const systemPrompt = this._buildPrompt(drugInfo);

    const requestBody = {
      contents: [{
        parts: [
          {
            inlineData: {
              mimeType: mimeType,
              data: audioBase64
            }
          },
          {
            text: systemPrompt
          }
        ]
      }],
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json'
      }
    };

    const model = 'gemini-2.0-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error('[Gemini] API Error:', error);
      if (response.status === 403) {
        throw new Error('APIキーが無効です。設定画面で正しいキーを入力してください。');
      } else if (response.status === 429) {
        throw new Error('API制限に達しました。しばらく待ってからお試しください。');
      }
      throw new Error(`Gemini APIエラー: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
      throw new Error('AIからの応答が空でした。もう一度お試しください。');
    }

    try {
      return JSON.parse(text);
    } catch {
      // JSONパースに失敗した場合、テキストから抽出を試みる
      console.warn('[Gemini] JSON parse failed, attempting extraction');
      return this._extractSOAPFromText(text);
    }
  },

  /**
   * SOAP生成用プロンプト
   */
  _buildPrompt(drugInfo) {
    const drugSection = drugInfo 
      ? `\n\n## 処方薬情報（NSIPSから取得）\n${drugInfo}\nこの薬品情報を元に、A（薬学的評価）とP（指導計画）を具体的に提案してください。`
      : '';

    return `あなたは日本の保険薬局に勤務するベテラン薬剤師です。
以下の音声は、薬剤師と患者の服薬指導時の会話です。

この会話を聞き取り、以下の作業を行ってください：
1. 会話を正確に文字起こしする
2. 文字起こし結果をSOAP形式の薬歴に変換する
${drugSection}

## SOAP記載ルール
- S（主観的情報）: 患者自身の言葉による訴え、自覚症状、生活状況、服薬状況、副作用の有無
- O（客観的情報）: 処方内容、外見的観察、お薬手帳の情報、バイタルサイン（言及があれば）
- A（薬学的評価）: 薬学的観点からの評価・分析。副作用の可能性、相互作用、効果判定、問題点の抽出
- P（指導計画）: 実施した服薬指導の内容、患者への助言、次回確認事項、処方医への情報提供の必要性

## 重要な注意
- 日本語で出力すること
- 医薬品名は正確に記載すること
- 患者の発言はできるだけ原文に近い表現で記載すること
- 推測や創作は行わないこと（会話に含まれない情報は記載しない）

## 出力形式（JSON）
以下のJSON形式で出力してください:
{
  "transcript": "文字起こし全文",
  "S": "主観的情報",
  "O": "客観的情報",
  "A": "薬学的評価",
  "P": "指導計画",
  "summary": "一行要約（20文字以内）"
}`;
  },

  /**
   * テキストからSOAP構造を抽出（フォールバック）
   */
  _extractSOAPFromText(text) {
    // JSONブロックがあればそれを抽出
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        return JSON.parse(jsonStr);
      } catch {}
    }

    // フォールバック: プレーンテキストとして返す
    return {
      transcript: text,
      S: '（自動抽出に失敗しました。文字起こし全文を確認してください）',
      O: '',
      A: '',
      P: '',
      summary: '要確認'
    };
  },

  /**
   * 接続テスト
   */
  async testConnection() {
    const settings = Config.load();
    if (!settings.geminiApiKey) {
      throw new Error('Gemini APIキーが設定されていません');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${settings.geminiApiKey}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error('APIキーが無効です');
    }
    
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
    } catch {
      return [];
    }
  },

  save(records) {
    // 最大50件保持
    const trimmed = records.slice(0, 50);
    localStorage.setItem(Config.HISTORY_KEY, JSON.stringify(trimmed));
  },

  add(record) {
    const records = this.load();
    records.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      ...record
    });
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
    console.log('[App] Initialized');
  },

  // --- イベントバインド ---
  bindEvents() {
    // 録音ボタン
    document.getElementById('recordBtn').addEventListener('click', () => this.toggleRecording());
    document.getElementById('pauseBtn').addEventListener('click', () => this.togglePause());

    // 画面遷移
    document.getElementById('settingsBtn').addEventListener('click', () => this.showScreen('settingsScreen'));
    document.getElementById('backBtn').addEventListener('click', () => this.showScreen('recordScreen'));
    document.getElementById('settingsBackBtn').addEventListener('click', () => this.showScreen('recordScreen'));

    // 設定
    document.getElementById('saveSettingsBtn').addEventListener('click', () => this.saveSettings());
    document.getElementById('testConnectionBtn').addEventListener('click', () => this.testConnection());

    // SOAP操作
    document.getElementById('copyAllBtn').addEventListener('click', () => this.copySOAP());
    document.getElementById('copySOAPBtn').addEventListener('click', () => this.copySOAP());
    document.getElementById('sendToMedixsBtn').addEventListener('click', () => this.sendToMedixs());
    document.getElementById('saveOnlyBtn').addEventListener('click', () => this.saveSOAP());

    // 編集ボタン
    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => this.toggleEdit(btn.dataset.target));
    });
  },

  // --- 画面遷移 ---
  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
    
    // ヘッダー表示/非表示
    const header = document.getElementById('header');
    header.style.display = (screenId === 'recordScreen') ? '' : 'none';
  },

  // --- Canvas初期化 ---
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

  // --- 波形アニメーション ---
  startWaveformAnimation() {
    const canvas = document.getElementById('waveformCanvas');
    const ctx = canvas.getContext('2d');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      
      const data = this.recorder.getWaveformData();
      if (!data) {
        this.waveformAnimId = requestAnimationFrame(draw);
        return;
      }

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

      // ボリュームに応じたグロー
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
    if (this.waveformAnimId) {
      cancelAnimationFrame(this.waveformAnimId);
      this.waveformAnimId = null;
    }
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
      await this.recorder.start();
      
      // UI更新
      const btn = document.getElementById('recordBtn');
      btn.classList.add('recording');
      document.getElementById('micIcon').classList.add('hidden');
      document.getElementById('stopIcon').classList.remove('hidden');
      document.getElementById('recordLabel').textContent = 'タップして停止 & SOAP生成';
      document.getElementById('pauseBtn').classList.remove('hidden');
      
      this.startWaveformAnimation();
      this.toast('🎙️ 録音を開始しました');
    } catch (err) {
      this.toast(`❌ ${err.message}`, 'error');
    }
  },

  async stopRecording() {
    try {
      const result = await this.recorder.stop();
      
      // UI復帰
      const btn = document.getElementById('recordBtn');
      btn.classList.remove('recording');
      document.getElementById('micIcon').classList.remove('hidden');
      document.getElementById('stopIcon').classList.add('hidden');
      document.getElementById('recordLabel').textContent = 'タップして録音開始';
      document.getElementById('pauseBtn').classList.add('hidden');
      document.getElementById('recordTime').textContent = '00:00';
      
      this.stopWaveformAnimation();
      this.toast('✅ 録音完了 — SOAP生成中...');

      // SOAP生成画面へ
      await this.processRecording(result);
    } catch (err) {
      this.toast(`❌ ${err.message}`, 'error');
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

  // --- SOAP処理 ---
  async processRecording(recording) {
    this.showScreen('soapScreen');
    document.getElementById('processingIndicator').classList.remove('hidden');
    document.getElementById('soapContent').classList.add('hidden');

    try {
      // 音声をBase64に変換
      document.getElementById('processingStatus').textContent = '音声データを準備中...';
      const audioBase64 = await AudioRecorder.blobToBase64(recording.blob);

      // Gemini APIでSOAP生成
      document.getElementById('processingStatus').textContent = 'AIが文字起こし＆SOAP生成中...';
      const drugInfo = document.getElementById('drugInput').value.trim();
      
      const soapData = await GeminiClient.generateSOAP(
        audioBase64, 
        recording.mimeType, 
        drugInfo
      );

      this.currentSOAP = soapData;
      this.displaySOAP(soapData);

      // 履歴に保存
      History.add({
        summary: soapData.summary || '記録',
        drugs: drugInfo,
        duration: recording.duration,
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

  // --- 編集 ---
  toggleEdit(targetId) {
    const el = document.getElementById(targetId);
    const isEditable = el.contentEditable === 'true';
    el.contentEditable = isEditable ? 'false' : 'true';
    
    if (!isEditable) {
      el.focus();
      this.toast('✏️ 編集モード ON');
    } else {
      // 編集内容をcurrentSOAPに反映
      const section = targetId.replace('soap', '');
      if (this.currentSOAP) {
        this.currentSOAP[section] = el.textContent;
      }
      this.toast('✅ 編集を保存しました');
    }
  },

  // --- コピー ---
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
      // clipboard API が使えない場合のフォールバック
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      this.toast('📋 SOAPをコピーしました');
    }
  },

  // --- メディクスへ送信 ---
  sendToMedixs() {
    if (!this.currentSOAP) return;

    // localStorageにSOAPデータを保存（ブックマークレットが読み取る）
    const medixsData = {
      S: this.currentSOAP.S || '',
      O: this.currentSOAP.O || '',
      A: this.currentSOAP.A || '',
      P: this.currentSOAP.P || '',
      timestamp: new Date().toISOString()
    };
    
    localStorage.setItem(Config.MEDIXS_DATA_KEY, JSON.stringify(medixsData));
    
    this.toast('💊 メディクスへの送信データを準備しました\nPCのメディクス画面でブックマークレットを実行してください');
    
    // クリップボードにもコピー
    this.copySOAP();
  },

  // --- 保存のみ ---
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
    
    const providerRadios = document.querySelectorAll('input[name="aiProvider"]');
    providerRadios.forEach(r => {
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

  // --- 履歴 ---
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

    // 履歴クリックで表示
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

  // --- トースト通知 ---
  toast(message, type = 'info') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast show';
    if (type === 'error') {
      el.style.borderColor = 'var(--danger)';
    } else {
      el.style.borderColor = 'rgba(255,255,255,0.1)';
    }
    setTimeout(() => { el.className = 'toast'; }, 3500);
  }
};

// ==============================================
// 起動
// ==============================================
document.addEventListener('DOMContentLoaded', () => App.init());
