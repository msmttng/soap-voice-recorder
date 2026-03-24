/**
 * SOAP → Zephyrus ペースト — Content Script
 * 
 * zephyrus.jp/dashboard 上でフローティングボタンを表示し、
 * クリップボードのAI薬歴データをテキストエリアに自動ペーストする
 */

(function() {
  'use strict';

  // ダッシュボードページでのみ実行
  if (!location.pathname.startsWith('/dashboard')) return;

  // =============================================
  // ターゲット要素のセレクタ
  // =============================================
  const TARGETS = {
    bulkTextArea: '#bulk-text-area',
    aiInput: '#ai-input',
    voiceTranscription: '#voice-transcription'
  };

  // =============================================
  // クリップボード読み取り (複数方式フォールバック)
  // =============================================
  async function readClipboard() {
    // 方法1: navigator.clipboard API (HTTPS + ユーザーアクションが必要)
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        console.log('[SOAP→Zephyrus] Clipboard read via API');
        return text;
      }
    } catch (e) {
      console.warn('[SOAP→Zephyrus] Clipboard API failed:', e.message);
    }

    // 方法2: execCommand('paste') - Chrome拡張のclipboardRead権限で動作
    try {
      const textarea = document.createElement('textarea');
      textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(textarea);
      textarea.focus();
      const success = document.execCommand('paste');
      const text = textarea.value;
      document.body.removeChild(textarea);
      if (success && text && text.trim()) {
        console.log('[SOAP→Zephyrus] Clipboard read via execCommand');
        return text;
      }
    } catch (e) {
      console.warn('[SOAP→Zephyrus] execCommand paste failed:', e.message);
    }

    // 方法3: 手動入力ダイアログ
    const manual = prompt(
      'クリップボードの自動読み取りに失敗しました。\n\n' +
      'AI薬歴の内容を Ctrl+V で貼り付けてください:',
      ''
    );
    return manual || null;
  }

  // =============================================
  // React/Next.js 対応のテキストエリア入力
  // =============================================
  function setTextAreaValue(el, value) {
    // React の synthetic event 対策: ネイティブ setter を使う
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }

    // イベントを発火してフレームワークに変更を認識させる
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // React 17+ 用の追加イベント
    try {
      const nativeInputEvent = new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'insertText',
        data: value
      });
      el.dispatchEvent(nativeInputEvent);
    } catch (e) {}
  }

  // =============================================
  // フローティングボタンを生成
  // =============================================
  function createFloatingButton() {
    const container = document.createElement('div');
    container.id = 'soap-zephyrus-fab';
    container.innerHTML = `
      <button id="soap-paste-btn" title="AI薬歴をペースト">
        <span class="soap-fab-icon">📋</span>
        <span class="soap-fab-label">AI薬歴<br>ペースト</span>
      </button>
      <div id="soap-paste-menu" class="soap-hidden">
        <button class="soap-menu-item" data-target="bulkTextArea">
          📝 SOAP一括入力へ
        </button>
        <button class="soap-menu-item" data-target="aiInput">
          🤖 AI指示欄へ
        </button>
        <button class="soap-menu-item" data-target="voiceTranscription">
          🎤 書き起こし欄へ
        </button>
      </div>
      <div id="soap-toast" class="soap-toast soap-hidden"></div>
    `;
    document.body.appendChild(container);

    const btn = document.getElementById('soap-paste-btn');
    const menu = document.getElementById('soap-paste-menu');

    // クリック → SOAP一括入力へ直接ペースト
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('[SOAP→Zephyrus] Button clicked');
      await pasteToTarget('bulkTextArea');
    });

    // 右クリック → メニュー展開
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu.classList.toggle('soap-hidden');
    });

    // メニュー項目
    document.querySelectorAll('.soap-menu-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const targetKey = item.dataset.target;
        await pasteToTarget(targetKey);
        menu.classList.add('soap-hidden');
      });
    });

    // 外側クリックでメニューを閉じる
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        menu.classList.add('soap-hidden');
      }
    });
  }

  // =============================================
  // ペースト処理
  // =============================================
  async function pasteToTarget(targetKey) {
    const selector = TARGETS[targetKey];
    const el = document.querySelector(selector);

    if (!el) {
      // ターゲットが見つからない場合、他のターゲットを試す
      const labels = {
        bulkTextArea: 'SOAP一括入力',
        aiInput: 'AI指示',
        voiceTranscription: '書き起こし'
      };

      // 存在するターゲットを探す
      let foundKey = null;
      let foundEl = null;
      for (const [key, sel] of Object.entries(TARGETS)) {
        const target = document.querySelector(sel);
        if (target) {
          foundKey = key;
          foundEl = target;
          break;
        }
      }

      if (foundEl) {
        showToast(`⚠️ ${labels[targetKey]}が見つかりません。${labels[foundKey]}を使用します。`, 'warn');
        return pasteToTargetElement(foundEl, foundKey);
      }

      showToast('⚠️ 入力フィールドが見つかりません。\n患者を選択してからクリックしてください。', 'error');
      return;
    }

    await pasteToTargetElement(el, targetKey);
  }

  async function pasteToTargetElement(el, targetKey) {
    const labels = {
      bulkTextArea: 'SOAP一括入力',
      aiInput: 'AI指示',
      voiceTranscription: '書き起こし'
    };

    showToast('📋 クリップボード読み取り中...');

    try {
      const text = await readClipboard();
      if (!text || !text.trim()) {
        showToast('⚠️ クリップボードが空です。\nPWAでAI薬歴をコピーしてください。', 'error');
        return;
      }

      // 既存の値がある場合は確認
      if (el.value && el.value.trim()) {
        const overwrite = confirm(
          `${labels[targetKey]}に既存の内容があります。上書きしますか？\n\n` +
          '既存: ' + el.value.substring(0, 80) + '...'
        );
        if (!overwrite) return;
      }

      setTextAreaValue(el, text);

      // フォーカスを当てる
      el.focus();
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // 成功エフェクト
      el.style.transition = 'box-shadow 0.3s, border-color 0.3s';
      el.style.boxShadow = '0 0 0 3px rgba(124, 58, 237, 0.3)';
      el.style.borderColor = '#7c3aed';
      setTimeout(() => {
        el.style.boxShadow = '';
        el.style.borderColor = '';
      }, 2000);

      showToast(`✅ ${labels[targetKey]}にペーストしました（${text.length}文字）`);
      console.log(`[SOAP→Zephyrus] Pasted ${text.length} chars to ${targetKey}`);
    } catch (err) {
      console.error('[SOAP→Zephyrus] Paste error:', err);
      showToast('❌ ペーストに失敗: ' + err.message, 'error');
    }
  }

  // =============================================
  // トースト通知
  // =============================================
  function showToast(message, type = 'success') {
    let toast = document.getElementById('soap-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'soap-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `soap-toast ${type}`;
    // 強制リフロー
    toast.offsetHeight;
    toast.classList.add('soap-toast-show');
    setTimeout(() => {
      toast.classList.remove('soap-toast-show');
    }, 4000);
  }

  // =============================================
  // 初期化
  // =============================================
  function init() {
    if (document.getElementById('soap-zephyrus-fab')) return;
    createFloatingButton();
    console.log('[SOAP→Zephyrus] ✅ Extension loaded on', location.pathname);
  }

  // SPA対応: URL変更を監視
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (location.pathname.startsWith('/dashboard')) {
        setTimeout(init, 500);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 初期実行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
