# SOAP Voice Recorder — チェンジログ

## セッション概要
- **日付:** 2026-03-23 ～ 2026-03-24
- **リポジトリ:** https://github.com/msmttng/soap-voice-recorder
- **デプロイ:** https://msmttng.github.io/soap-voice-recorder/
- **GAS URL:** `https://script.google.com/macros/s/AKfycbwCGoQvI3IeKZEEWBV5x-vpVF1sFRnKG1p6O4eZ9OFNqsqgyph1l5aRnSwb_4tbmM3D/exec`
- **スプレッドシートID:** `1HMTjNvtklfhdLGe1btXyn6f-DTAr30kgMtmR-zhYv4w`

---

## 変更履歴

### Phase 1: 録音安定性 + UIテーマ (2026-03-23)
| ファイル | 内容 |
|----------|------|
| `recorder.js` | Wake Lock API, AudioContext自動復帰, 指数バックオフ付きSpeechRecognition |
| `style.css` | ダーク → ライトテーマ全面変更 |
| `manifest.json` | テーマカラー変更 |
| `icons/` | PWAアイコン 192x192, 512x512 作成 |

### Phase 2: クラウドバックアップ (2026-03-23)
| ファイル | 内容 |
|----------|------|
| `recording-backup.js` | IndexedDB録音チャンクバックアップ |
| `gas/Code.gs` | GASバックエンド（SOAP保存+履歴取得） |
| `app.js` | GASClient統合, testConnection拡張 |
| `sw.js` | recording-backup.jsキャッシュ追加 |
| `index.html` | script参照追加 |

### Phase 3: メディクス連携 (2026-03-23)
| ファイル | 内容 |
|----------|------|
| `bookmarklet/medixs-input.js` | クリップボード自動読取, 上書き確認, React/Vue対応 |

### Phase 4: NSIPS連携 (2026-03-24)
| ファイル | 内容 |
|----------|------|
| `nsips/nsips_parser.py` | VER010401形式パーサー（実データ対応） |
| `nsips/nsips_watcher.py` | フォルダ監視デーモン（`\\VER7\gemini連携`対応） |
| `gas/Code.gs` | NSIPS患者シート追加, 患者リストAPI, 使用済みフラグ |
| `index.html` | 患者選択プルダウン追加 |
| `app.js` | loadPatients, renderPatients(プルダウン), selectPatient |
| `start_nsips_watcher.bat` | 起動バッチファイル |

---

## アーキテクチャ

```
レセコン → \\VER7\gemini連携\SIPS12\DATA\
  ↓ (nsips_watcher.py)
GAS スプレッドシート (NSIPS患者シート)
  ↓ (?action=patients)
📱 PWA → 患者プルダウン選択 → 録音 → SOAP生成
  ↓ (GASClient.saveSOAP)
GAS スプレッドシート (SOAP記録シート)
  ↓
💻 Chrome拡張 → メディクス自動入力
```

## 環境情報
- **NSIPSフォルダ:** `\\VER7\gemini連携\SIPS12\DATA\`
- **NSIPSフォーマット:** VER010401 (CSV, Shift-JIS)
- **Service Worker:** `soap-recorder-v5`
