# CHANGELOG — SOAP Voice Recorder

## 2026-04-13

### feat: プロンプトの大幅改修と堅牢性の向上
- **プロンプト構造化の改善 (`app.js`)**
  - Gemini STT（文字起こし）、話者分離、SOAP生成の全プロンプトを「禁止事項・許可事項」を明確に分けた構造化プロンプトへ刷新
  - ハルシネーション（無音・ノイズ時の繰り返しループ等）を防止するため、「架空の会話生成の厳禁」「ループ出力の絶対禁止」を厳格に指定
  - Whisper API のフォールバック用事前プロンプトに会話文体のサンプルを与え、医療用語の認識精度(WER)を向上
- **JSONパースとエラーハンドリングの強化 (`app.js`)**
  - SOAP出力時の JSON `parseSOAPResponse` 抽出ロジックで、複数・階層的トライ（Markdownフェンス除去、ブラケット抽出）を経てパースするよう堅牢化し、全て失敗した場合は `null` を返す仕様に変更
- **UI/UX の改善 (`app.js`)**
  - SOAP生成において会話から抽出すべき情報がなくS/O/A/Pいずれかが空となった場合、`⚠️ 情報不足（会話に記載なし）` と表示するUIバッジを追加
  - 話者分離結果においてAIの判断がつかず `不明:` とラベリングされた行に対して、視覚的な危険色（薄赤）でハイライト表示する処理を追加

## 2026-04-08

### fix: 音声認識精度の向上およびAI連携の最適化
- **録音品質の改善 (`recorder.js`)**
  - MediaRecorder に `audioBitsPerSecond: 128000` を明示指定
  - AudioConstraints で `noiseSuppression`, `autoGainControl` を有効化し、薬局環境の周辺音と患者の声量差に最適化
  - 録音 Blob 結合後にファイルサイズの妥当性検証を追加
- **AI連携フォーマットの最適化 (`app.js`)**
  - Gemini API へ送信する MIME Type から不要なコーデック指定を除去
  - Whisper API の `prompt` に渡す辞書情報（処方薬リスト）を、カンマ区切りの単語羅列から自然なコンテキスト文へ変更し、意図的なトークン丸め処理を実装
  - Gemini SOAP変換 API コールに `responseMimeType: "application/json"` を指定し、Markdownエラーを確実に防止
  - SOAP変換プロンプト内の A（薬学的評価）における「推測・創作不可」の指示矛盾を解消
  - iOS 等を考慮し、拡張子マッピングを行う `getAudioExtension()` を関数化して堅牢な動作を担保
## 2026-03-31

### fix: NSIPSリストの患者名重複表示バグ修正
- 薬局のレセコンシステムからの仕様により、同一患者の処方変更データが短い期間に複数回（複数ファイル）出力・同期された場合、PWAの「患者選択ドロップダウン」に同じ名前が重複して並んでしまう不具合を修正。
- フロントエンド（`app.js`の `renderPatients`）にて、名前ベースの `Set` オブジェクトを用いた重複排除（デドゥプリケーション）ロジックを実装。スプレッドシート上の全ての未確定データを読み込んだ後、必ず「最新1件のデータだけ」を抽出しリスト表示するように動作を改善。

## 2026-03-30

### fix: NSIPS連携のProcess Monitorへの完全統合・自動化
- デスクトップの「黒い画面(コマンドプロンプト)」を出さずに裏でNSIPS連携を実行する隠しスクリプト (`run_soap_nsips_hidden.vbs`) を追加
- 在庫管理用と識別するため、プロセス名を `soap_nsips_watcher.py` へ変更しWMI(プロセス監視)の誤検知をゼロに修正
- Python出力時に発生する絵文字(🗑️/✅)での`UnicodeEncodeError`クラッシュを防ぐため、実行バッチ内で `PYTHONIOENCODING=utf-8` を強制
- `NSIPS Watcher` を `process_monitor.ps1` (PC起動時自動起動) の監視対象リストへ完全登録
- ログファイル (`soap_nsips.log`) へリアルタイム出力 (`-u` オプション) するよう改善

### feat: AI音声認識エンジンの精度向上（辞書プロンプト注入）
- `Whisper API` および `Gemini API` 利用時、NSIPSで選択中の「患者処方薬リスト」を事前辞書としてプロンプトへ動的に結合する仕組みを実装
- 設定画面に「カスタム医療辞書」入力欄を追加し、共通して使われる病名やローカル用語を一括登録してAIの認識精度を飛躍的に向上させる機能を追加

### fix: 音声テキスト履歴と患者選択のバグ修正
- `yakurekiPatientSelect` 更新時に「更新🔄」ボタンが意図せず無効化されたままになる不具合を修正
- 音声テキストの文字起こし完了時、即座に保存履歴（History）へ自動登録されるよう修正

## 2026-03-24

### refactor: AI薬歴機能を話者分離テキスト出力に特化
- `app.js` の `yakurekiGenerateSummary` において、要約および情報抽出を行うプロンプトを削除
- 代わりに「薬剤師:」「患者:」の話者分離のみを行うプロンプトへ変更
- 不要となった「AI薬歴」としての患者選択UI（`yakurekiPatientArea`）を削除し、純粋な「音声テキスト（話者分離）」ツールとして機能するように修正
- 関連するUIのラベルを「AI薬歴」から「音声テキスト」「文字起こしデータ」へ変更
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
