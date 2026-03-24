/**
 * SOAP Voice Recorder — Google Apps Script バックエンド
 * 
 * 機能:
 *   - SOAPデータをスプレッドシートに保存
 *   - NSIPSデータ（患者+処方）の受信・保存
 *   - 患者リストの取得（PWA用）
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
const SPREADSHEET_ID = '1HMTjNvtklfhdLGe1btXyn6f-DTAr30kgMtmR-zhYv4w';
const SHEET_SOAP = 'SOAP記録';
const SHEET_NSIPS = 'NSIPS患者';

/**
 * シートを取得（なければ作成）
 */
function getOrCreateSheet(sheetName, headers, columnWidths) {
  let ss;
  if (SPREADSHEET_ID) {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } else {
    ss = SpreadsheetApp.getActive();
  }
  
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (headers) sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    if (columnWidths) {
      columnWidths.forEach((w, i) => { if (w) sheet.setColumnWidth(i + 1, w); });
    }
  }
  return sheet;
}

function getSOAPSheet() {
  return getOrCreateSheet(SHEET_SOAP, 
    ['タイムスタンプ', '患者名', '要約', '処方薬', '録音時間(秒)',
     'S（主観的情報）', 'O（客観的情報）', 'A（薬学的評価）', 'P（指導計画）', '文字起こし全文'],
    [160, 100, 150, 200, 80, 300, 300, 300, 300, 300]
  );
}

function getNSIPSSheet() {
  return getOrCreateSheet(SHEET_NSIPS,
    ['受信日時', '患者名', 'カナ', '性別', '生年月日', '年齢',
     '医療機関', '処方医', '処方日', '処方内容', '使用済み', 'JSON'],
    [160, 100, 120, 40, 100, 40, 200, 80, 100, 400, 60, 100]
  );
}

/**
 * POST: データを保存
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    
    // NSIPSデータの場合
    if (data.action === 'nsips') {
      return handleNSIPS(data);
    }
    
    // SOAPデータの場合
    return handleSOAP(data);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * SOAP保存
 */
function handleSOAP(data) {
  const sheet = getSOAPSheet();
  
  sheet.appendRow([
    new Date().toLocaleString('ja-JP'),
    data.patientName || '',
    data.summary || '',
    data.drugs || '',
    data.duration || '',
    data.S || '',
    data.O || '',
    data.A || '',
    data.P || '',
    data.transcript || ''
  ]);
  
  // 対応するNSIPS患者を「使用済み」にマーク
  if (data.nsipsRow) {
    try {
      const nsipsSheet = getNSIPSSheet();
      nsipsSheet.getRange(data.nsipsRow, 11).setValue('✅');
    } catch(e) {}
  }
  
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, message: '保存しました' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * NSIPS患者データ保存
 */
function handleNSIPS(data) {
  const sheet = getNSIPSSheet();
  const patient = data.patient || {};
  
  sheet.appendRow([
    new Date().toLocaleString('ja-JP'),
    patient.name || '',
    patient.kana || '',
    patient.gender || '',
    patient.dob || '',
    patient.age || '',
    data.institution || '',
    data.doctor || '',
    data.prescription_date || '',
    data.drug_summary || '',
    '',  // 使用済みフラグ（初期値: 空）
    JSON.stringify(data)
  ]);
  
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, message: '患者データを登録しました' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * GET: データ取得
 */
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'list';
    
    if (action === 'ping') {
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, message: '接続OK' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 未使用の患者リストを取得（PWA用）
    if (action === 'patients') {
      return handleGetPatients();
    }
    
    // SOAP履歴
    const sheet = getSOAPSheet();
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

/**
 * 未使用の患者リストを返す
 */
function handleGetPatients() {
  const sheet = getNSIPSSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  const patients = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const usedFlag = row[10]; // 使用済みカラム
    
    if (!usedFlag) {  // 未使用のみ
      patients.push({
        row: i + 1,  // スプレッドシートの行番号（1-indexed）
        name: row[1],
        kana: row[2],
        gender: row[3],
        dob: row[4],
        age: row[5],
        institution: row[6],
        doctor: row[7],
        prescription_date: row[8],
        drug_summary: row[9]
      });
    }
  }
  
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, patients: patients.reverse() }))
    .setMimeType(ContentService.MimeType.JSON);
}
