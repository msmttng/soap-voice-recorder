/**
 * SOAP Voice Recorder — Google Apps Script バックエンド
 * 
 * 機能:
 *   - SOAPデータをスプレッドシートに保存
 *   - 履歴の取得
 * 
 * デプロイ手順:
 *   1. Google Spreadsheet を新規作成
 *   2. 拡張機能 → Apps Script
 *   3. このコードを貼り付け
 *   4. SPREADSHEET_ID を自分のスプレッドシートIDに変更
 *   5. デプロイ → 新しいデプロイ → ウェブアプリ
 *      - 実行ユーザー: 自分
 *      - アクセスできるユーザー: 全員
 *   6. URLをPWAの設定画面に入力
 */

// ============================================
// 設定
// ============================================
const SPREADSHEET_ID = ''; // ← 自分のスプレッドシートIDを設定
const SHEET_NAME = 'SOAP記録';

/**
 * スプレッドシートを取得（なければシート作成）
 */
function getSheet() {
  let ss;
  if (SPREADSHEET_ID) {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } else {
    ss = SpreadsheetApp.getActive();
  }
  
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    // ヘッダー行を作成
    sheet.appendRow([
      'タイムスタンプ', '要約', '処方薬', '録音時間(秒)',
      'S（主観的情報）', 'O（客観的情報）', 'A（薬学的評価）', 'P（指導計画）',
      '文字起こし全文'
    ]);
    sheet.setFrozenRows(1);
    // 列幅の調整
    sheet.setColumnWidth(1, 160);  // タイムスタンプ
    sheet.setColumnWidth(2, 150);  // 要約
    sheet.setColumnWidth(3, 200);  // 処方薬
    sheet.setColumnWidth(5, 300);  // S
    sheet.setColumnWidth(6, 300);  // O
    sheet.setColumnWidth(7, 300);  // A
    sheet.setColumnWidth(8, 300);  // P
  }
  return sheet;
}

/**
 * POST: SOAPデータを保存
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = getSheet();
    
    sheet.appendRow([
      new Date().toLocaleString('ja-JP'),
      data.summary || '',
      data.drugs || '',
      data.duration || '',
      data.S || '',
      data.O || '',
      data.A || '',
      data.P || '',
      data.transcript || ''
    ]);
    
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, message: '保存しました' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * GET: 最新の記録を取得
 */
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'list';
    
    if (action === 'ping') {
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, message: '接続OK' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const records = data.slice(1).reverse().slice(0, 20).map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = row[i]);
      return obj;
    });
    
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, records }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
