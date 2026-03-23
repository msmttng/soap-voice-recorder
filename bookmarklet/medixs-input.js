/**
 * メディクス薬歴 ブックマークレット — 改善版
 * 
 * 使い方:
 *   1. PWAで「SOAPをコピー」ボタンを押す
 *   2. メディクスの薬歴入力画面を開く
 *   3. このブックマークレットを実行する
 * 
 * ブックマークへの登録方法:
 *   1. 以下のコード全体を選択
 *   2. ブラウザのブックマークバーを右クリック → 「ページを追加」
 *   3. 名前: 「SOAP入力」
 *   4. URL: 以下のコードを貼り付け
 *
 * セレクタの調整方法:
 *   1. メディクスの薬歴入力画面を開く
 *   2. F12 で開発者ツールを開く
 *   3. S/O/A/P 各フィールドを右クリック → 「検証」
 *   4. textarea や input のセレクタを確認
 *   5. 下記 SELECTORS を書き換え
 */

javascript:(function(){
  'use strict';
  
  /* ==========================================
     設定: メディクスのDOM要素セレクタ
     ========================================== */
  const SELECTORS = {
    // 薬歴入力のSOAP各フィールド
    // ※ メディクスの実際のフィールドに合わせて変更してください
    // 複数セレクタをカンマ区切りで指定（上から順に試行）
    S: 'textarea[name="subjective"], #subjective, [data-field="S"], textarea:nth-of-type(1)',
    O: 'textarea[name="objective"], #objective, [data-field="O"], textarea:nth-of-type(2)',
    A: 'textarea[name="assessment"], #assessment, [data-field="A"], textarea:nth-of-type(3)',
    P: 'textarea[name="plan"], #plan, [data-field="P"], textarea:nth-of-type(4)',
  };

  /* ==========================================
     SOAPデータの取得（クリップボードから）
     ========================================== */
  async function getSOAPData() {
    // 方法1: クリップボードからの自動取得を試みる
    try {
      const clipText = await navigator.clipboard.readText();
      if (clipText && clipText.includes('【S】')) {
        const parsed = parseSOAP(clipText);
        if (Object.keys(parsed).length > 0) {
          return parsed;
        }
      }
    } catch(e) {
      // clipboard API が使えない場合はスキップ
    }
    
    // 方法2: ダイアログで手動貼り付け
    const clipText = prompt(
      'SOAPデータを貼り付けてください\n\n' +
      '（PWAで「SOAPをコピー」ボタンを押してから、Ctrl+V で貼り付け）',
      ''
    );
    
    if (!clipText) return null;
    
    const parsed = parseSOAP(clipText);
    if (Object.keys(parsed).length > 0) return parsed;
    
    // パースできない場合はSに全文を入れる
    return { S: clipText, O: '', A: '', P: '' };
  }
  
  /**
   * 【S】【O】【A】【P】形式をパース
   */
  function parseSOAP(text) {
    const sections = {};
    const regex = /【([SOAP])】([\s\S]*?)(?=【[SOAP]】|$)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      sections[match[1]] = match[2].trim();
    }
    return sections;
  }

  /* ==========================================
     メディクスへの入力
     ========================================== */
  function fillField(soapKey, soapData) {
    const value = soapData[soapKey];
    if (!value) return false;
    
    const selector = SELECTORS[soapKey];
    if (!selector) return false;

    const selectors = selector.split(',').map(s => s.trim());
    
    for (const sel of selectors) {
      // メインドキュメント
      let el = document.querySelector(sel);
      
      // iframe内を検索
      if (!el) {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            el = iframe.contentDocument?.querySelector(sel);
            if (el) break;
          } catch(e) {}
        }
      }
      
      if (el) {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          // 既存の値がある場合は末尾に追加するか確認
          if (el.value && el.value.trim()) {
            if (!confirm(`${soapKey}フィールドに既存の内容があります。上書きしますか？\n\n既存: ${el.value.substring(0, 50)}...`)) {
              return false;
            }
          }
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          // React/Vue 対策
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        
        console.log(`[SOAP] ${soapKey} filled:`, value.substring(0, 50) + '...');
        return true;
      }
    }
    
    console.warn(`[SOAP] ${soapKey} field not found: ${selector}`);
    return false;
  }

  /* ==========================================
     実行
     ========================================== */
  (async function main() {
    const soapData = await getSOAPData();
    if (!soapData) {
      alert('キャンセルされました');
      return;
    }
    
    let filled = 0;
    ['S', 'O', 'A', 'P'].forEach(key => {
      if (fillField(key, soapData)) filled++;
    });

    if (filled > 0) {
      alert(
        `✅ SOAP入力完了！（${filled}/4項目）\n\n` +
        '内容を確認してから保存してください。\n' +
        (filled < 4 ? `\n⚠️ ${4 - filled}項目はフィールドが見つかりませんでした。\nF12 → 検証 でセレクタを確認してください。` : '')
      );
    } else {
      alert(
        '⚠️ 入力フィールドが見つかりません。\n\n' +
        '【セレクタの調整が必要です】\n' +
        '1. メディクスの薬歴入力画面で F12 を押す\n' +
        '2. S/O/A/P のテキストエリアを右クリック → 「検証」\n' +
        '3. ブックマークレットのSELECTORSを書き換え\n\n' +
        '【手動入力の方法】\n' +
        'SOAPデータはクリップボードにコピー済みです。\n' +
        '各フィールドに Ctrl+V で貼り付けてください。'
      );
    }
  })();
})();
