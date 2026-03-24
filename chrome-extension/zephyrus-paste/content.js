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
    const nativeInputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: value
    });
    el.dispatchEvent(nativeInputEvent);
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
      <div id="soap-paste-menu" class="soap-menu hidden">
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
      <div id="soap-toast" class="soap-toast hidden"></div>
    `;
    document.body.appendChild(container);

    // メインボタン — クリックで一括入力へペースト or メニュー展開
    const btn = document.getElementById('soap-paste-btn');
    const menu = document.getElementById('soap-paste-menu');

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 一括入力が存在する場合は直接ペースト、なければメニュー展開
      const target = document.querySelector(TARGETS.bulkTextArea);
      if (target) {
        await pasteToTarget('bulkTextArea');
      } else {
        menu.classList.toggle('hidden');
      }
    });

    // 長押しでメニュー展開
    let pressTimer = null;
    btn.addEventListener('mousedown', () => {
      pressTimer = setTimeout(() => {
        menu.classList.remove('hidden');
        pressTimer = null;
      }, 500);
    });
    btn.addEventListener('mouseup', () => {
      if (pressTimer) clearTimeout(pressTimer);
    });
    btn.addEventListener('mouseleave', () => {
      if (pressTimer) clearTimeout(pressTimer);
    });

    // メニュー項目
    document.querySelectorAll('.soap-menu-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const targetKey = item.dataset.target;
        await pasteToTarget(targetKey);
        menu.classList.add('hidden');
      });
    });

    // 外側クリックでメニューを閉じる
    document.addEventListener('click', () => {
      menu.classList.add('hidden');
    });
  }

  // =============================================
  // ペースト処理
  // =============================================
  async function pasteToTarget(targetKey) {
    const selector = TARGETS[targetKey];
    const el = document.querySelector(selector);

    if (!el) {
      showToast('⚠️ 入力フィールドが見つかりません。患者を選択してください。', 'error');
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        showToast('⚠️ クリップボードが空です。PWAでAI薬歴をコピーしてください。', 'error');
        return;
      }

      // 既存の値がある場合は確認
      if (el.value && el.value.trim()) {
        const overwrite = confirm(
          '既存の内容があります。上書きしますか？\n\n' +
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

      const labels = {
        bulkTextArea: 'SOAP一括入力',
        aiInput: 'AI指示',
        voiceTranscription: '書き起こし'
      };
      showToast(`✅ ${labels[targetKey]}にペーストしました（${text.length}文字）`);
    } catch (err) {
      console.error('[SOAP→Zephyrus] Paste error:', err);
      showToast('❌ クリップボード読み取りに失敗しました。ページを再読み込みしてください。', 'error');
    }
  }

  // =============================================
  // トースト通知
  // =============================================
  function showToast(message, type = 'success') {
    const toast = document.getElementById('soap-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `soap-toast ${type}`;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3500);
  }

  // =============================================
  // 初期化: DOM が準備できたら実行
  // =============================================
  function init() {
    // すでに追加されている場合はスキップ
    if (document.getElementById('soap-zephyrus-fab')) return;
    createFloatingButton();
    console.log('[SOAP→Zephyrus] ✅ Extension loaded');
  }

  // SPA対応: URL変更を監視
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // ダッシュボードページに遷移したらボタンを追加
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
