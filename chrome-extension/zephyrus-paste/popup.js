/**
 * popup.js — ポップアップ UI ロジック
 */
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');

  // 現在のタブを確認
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && tab.url && tab.url.includes('zephyrus.jp')) {
      statusEl.className = 'status ok';
      statusEl.textContent = '✅ zephyrus.jp で有効 — 右下のボタンをクリック';
    } else {
      statusEl.className = 'status warn';
      statusEl.textContent = '⚠️ zephyrus.jp/dashboard を開いてください';
    }
  });
});
