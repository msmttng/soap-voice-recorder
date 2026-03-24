# CHANGELOG — SOAP Voice Recorder

## 2026-03-24

### feat: iOS録音対応 — 2段階方式 (`a994190`)
- `GeminiClient.transcribeAudio()` 追加 — 音声→テキストのみ（トークン95%削減）
- 録音フロー: Speech API 成功→テキスト生成 / 失敗→Gemini音声文字起こし→テキスト生成
- iOS Safari の `audio/mp4` MIME対応（`recorder.js` 既存）

### fix: Chrome拡張ペースト先変更 (`598693f`)
- デフォルトペースト先を `#bulk-text-area` → `#voice-transcription` に変更

### fix: Chrome拡張クリップボード修正 (`31926cd`)
- 3段階フォールバック: Clipboard API → execCommand → 手動ダイアログ
- CSS `.hidden` → `.soap-hidden` に変更（Zephyrus側との競合回避）

### feat: Zephyrus Chrome拡張 (`e4ecf89`)
- Manifest V3 Chrome拡張を新規作成
- フローティングボタン + コンテキストメニュー
- React/Next.js 対応のテキストエリア入力

### feat: AI薬歴モデルフォールバック (`3ca17ae`)
- `_callAPIRaw` メソッド追加
- 4モデル順次試行 + 15秒待機リトライ
