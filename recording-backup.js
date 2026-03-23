/**
 * recording-backup.js — IndexedDB による録音データバックアップ
 * 
 * 録音中のチャンクをIndexedDBに自動保存し、
 * クラッシュ時にも録音データを復旧可能にする。
 */
const RecordingBackup = {
  DB_NAME: 'soap_recorder_backup',
  DB_VERSION: 1,
  STORE_NAME: 'chunks',
  db: null,

  /**
   * IndexedDB を初期化
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('[Backup] IndexedDB initialized');
        resolve();
      };

      request.onerror = (event) => {
        console.warn('[Backup] IndexedDB init failed:', event.target.error);
        reject(event.target.error);
      };
    });
  },

  /**
   * 録音セッション開始 — 古いデータをクリア
   */
  async startSession() {
    if (!this.db) await this.init();
    await this.clear();
    console.log('[Backup] Session started');
  },

  /**
   * チャンクを保存
   */
  async saveChunk(blob, index) {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      store.add({
        index: index,
        blob: blob,
        timestamp: Date.now()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => {
        console.warn('[Backup] Chunk save failed:', e.target.error);
        reject(e.target.error);
      };
    });
  },

  /**
   * 保存されたチャンクからBlobを復旧
   */
  async recover() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const chunks = request.result;
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        // index順にソートしてBlobを結合
        chunks.sort((a, b) => a.index - b.index);
        const blobs = chunks.map(c => c.blob);
        const combined = new Blob(blobs, { type: blobs[0].type || 'audio/webm' });
        console.log(`[Backup] Recovered ${chunks.length} chunks, ${(combined.size / 1024).toFixed(1)}KB`);
        resolve({
          blob: combined,
          chunks: chunks.length,
          size: combined.size
        });
      };

      request.onerror = (e) => {
        console.warn('[Backup] Recovery failed:', e.target.error);
        reject(e.target.error);
      };
    });
  },

  /**
   * バックアップデータの有無を確認
   */
  async hasBackup() {
    if (!this.db) await this.init();

    return new Promise((resolve) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.count();
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror = () => resolve(false);
    });
  },

  /**
   * バックアップをクリア
   */
  async clear() {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      store.clear();
      tx.oncomplete = () => {
        console.log('[Backup] Cleared');
        resolve();
      };
      tx.onerror = (e) => reject(e.target.error);
    });
  }
};

window.RecordingBackup = RecordingBackup;
