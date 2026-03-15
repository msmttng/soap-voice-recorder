/**
 * メディクス薬歴 ブックマークレット
 * 
 * 使い方:
 * 1. PWAで「メディクスへ送信」ボタンを押す
 * 2. メディクスの薬歴入力画面を開く
 * 3. このブックマークレットを実行する
 * 
 * ブックマークレットとして登録する際は、以下のコードを
 * ブラウザのブックマークURLに貼り付けてください。
 * 
 * 注意: メディクスのDOM構造に合わせてセレクタを調整する必要があります。
 * 初回は開発者ツール（F12）でメディクスの入力フィールドのセレクタを確認してください。
 */

// === ブックマークレット本体 ===
// 以下を1行にまとめてブックマークのURLに設定:

javascript:(function(){
  'use strict';
  
  /* ==========================================
     設定: メディクスのDOM要素セレクタ
     ※ 実際の画面に合わせて変更してください
     ========================================== */
  const SELECTORS = {
    // テキストエリアのセレクタ（例）
    // メディクスの実際のフィールドに合わせて変更
    S: 'textarea[name="subjective"], #subjective, [data-field="S"]',
    O: 'textarea[name="objective"], #objective, [data-field="O"]',
    A: 'textarea[name="assessment"], #assessment, [data-field="A"]',
    P: 'textarea[name="plan"], #plan, [data-field="P"]',
  };

  /* ==========================================
     SOAPデータの取得
     ========================================== */
  
  // 方法1: localStorageから取得（同一ドメインの場合）
  let soapData = null;
  try {
    const stored = localStorage.getItem('soap_medixs_data');
    if (stored) {
      soapData = JSON.parse(stored);
    }
  } catch(e) {}

  // 方法2: クリップボードから取得（異なるドメインの場合）
  if (!soapData) {
    const clipText = prompt(
      'SOAPデータを貼り付けてください\n\n' +
      '（PWAで「SOAPをコピー」ボタンを押してから、ここに貼り付け）',
      ''
    );
    
    if (!clipText) {
      alert('キャンセルされました');
      return;
    }
    
    // 【S】【O】【A】【P】形式をパース
    const sections = {};
    const regex = /【([SOAP])】([\s\S]*?)(?=【[SOAP]】|$)/g;
    let match;
    while ((match = regex.exec(clipText)) !== null) {
      sections[match[1]] = match[2].trim();
    }
    
    if (Object.keys(sections).length > 0) {
      soapData = sections;
    } else {
      // パースできない場合はそのままSに入れる
      soapData = { S: clipText, O: '', A: '', P: '' };
    }
  }

  if (!soapData) {
    alert('SOAPデータが見つかりません。\nPWAで「メディクスへ送信」を押してからやり直してください。');
    return;
  }

  /* ==========================================
     メディクスへの入力
     ========================================== */
  let filled = 0;
  
  function fillField(soapKey) {
    const value = soapData[soapKey];
    if (!value) return;
    
    const selector = SELECTORS[soapKey];
    if (!selector) return;

    // 複数のセレクタを試行
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
          } catch(e) {
            // クロスオリジンの場合はスキップ
          }
        }
      }
      
      if (el) {
        // 値を設定
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        
        filled++;
        console.log(`[SOAP] ${soapKey} filled:`, value.substring(0, 50) + '...');
        return;
      }
    }
    
    console.warn(`[SOAP] ${soapKey} field not found with selectors: ${selector}`);
  }

  // 各フィールドに入力
  fillField('S');
  fillField('O');
  fillField('A');
  fillField('P');

  /* ==========================================
     結果表示
     ========================================== */
  if (filled > 0) {
    alert(
      `✅ SOAP入力完了！（${filled}項目）\n\n` +
      '内容を確認してから保存してください。\n' +
      '※ セレクタが合わない場合は、開発者ツール(F12)で\n' +
      '   メディクスの入力フィールドを確認し、\n' +
      '   ブックマークレットのSELECTORSを調整してください。'
    );
  } else {
    // フィールドが見つからない場合のヘルプ
    alert(
      '⚠️ 入力フィールドが見つかりませんでした。\n\n' +
      '以下を確認してください:\n' +
      '1. メディクスの薬歴入力画面を開いていますか？\n' +
      '2. ブックマークレットのセレクタを\n' +
      '   メディクスの実際のフィールドに合わせて\n' +
      '   変更する必要があります。\n\n' +
      '【手動入力の方法】\n' +
      'SOAPデータはクリップボードにコピー済みです。\n' +
      '各フィールドに手動で貼り付けてください。'
    );
  }

  // localStorageのデータをクリア
  try {
    localStorage.removeItem('soap_medixs_data');
  } catch(e) {}
  
})();
