"""
nsips_watcher.py — NSIPSフォルダ監視 + GAS送信スクリプト

レセコンが出力するNSIPSフォルダを監視し、
新しいDATAファイルが検出されたらパースしてGASに送信するデーモン。

使い方:
  python nsips_watcher.py --folder C:\\NSIPS --gas-url https://script.google.com/macros/s/xxx/exec

設定ファイル（nsips_config.json）でも指定可能。
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime

# 同じフォルダの nsips_parser をインポート
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nsips_parser import parse_nsips_file, parse_nsips


CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nsips_config.json')
DEFAULT_POLL_INTERVAL = 3  # 秒


def load_config():
    """設定ファイルを読み込み"""
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def save_config(config):
    """設定ファイルを保存"""
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def send_to_gas(gas_url: str, data: dict) -> bool:
    """GASにNSIPSデータをPOST送信"""
    payload = json.dumps({
        "action": "nsips",
        "patient": data["patient"],
        "institution": data["institution"],
        "doctor": data["doctor"],
        "prescription_date": data["prescription_date"],
        "drug_summary": data["drug_summary"],
        "prescriptions": data["prescriptions"],
        "timestamp": datetime.now().isoformat()
    }, ensure_ascii=False).encode('utf-8')

    req = urllib.request.Request(
        gas_url,
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode('utf-8')
            print(f'  [GAS] Response: {body[:200]}')
            return True
    except urllib.error.HTTPError as e:
        # GAS redirects on success (302), urllib follows it
        print(f'  [GAS] HTTP {e.code}: {e.read().decode("utf-8", errors="replace")[:200]}')
        return True  # GAS often returns redirect on success
    except Exception as e:
        print(f'  [GAS] Error: {e}')
        return False


def watch_folder(folder: str, gas_url: str, poll_interval: int = DEFAULT_POLL_INTERVAL):
    """NSIPSフォルダを監視して新しいファイルを処理"""
    folder_path = Path(folder)
    
    if not folder_path.exists():
        print(f'[ERROR] フォルダが存在しません: {folder}')
        print(f'  作成しますか？ フォルダを作成して再実行してください。')
        sys.exit(1)

    print(f'[NSIPS Watcher] 監視開始')
    print(f'  フォルダ: {folder}')
    print(f'  GAS URL: {gas_url[:50]}...')
    print(f'  ポーリング間隔: {poll_interval}秒')
    print(f'  Ctrl+C で停止')
    print()

    processed_files = set()
    last_mtime = {}

    while True:
        try:
            # DATA ファイルを探す（SIPS12/DATA/ 配下 or 直接 or 複数パターン）
            for pattern in [
                'SIPS*/DATA/*.txt',  # 実環境の構造
                'DATA/*.txt',
                'DATA',
                'DATA.*',
                'data',
                '*.dat'
            ]:
                for filepath in folder_path.glob(pattern):
                    if not filepath.is_file():
                        continue
                    
                    mtime = filepath.stat().st_mtime
                    file_key = str(filepath)
                    
                    # 新しいファイルまたは更新されたファイル
                    if file_key not in last_mtime or last_mtime[file_key] < mtime:
                        last_mtime[file_key] = mtime
                        
                        print(f'[{datetime.now().strftime("%H:%M:%S")}] 新しいデータ検出: {filepath.name}')
                        
                        try:
                            data = parse_nsips_file(str(filepath))
                            
                            patient_name = data["patient"]["name"]
                            drug_count = sum(len(rx["drugs"]) for rx in data["prescriptions"])
                            
                            print(f'  患者: {patient_name}')
                            print(f'  処方: {drug_count}剤')
                            print(f'  処方日: {data["prescription_date"]}')
                            print(f'  薬品:')
                            for line in data["drug_summary"].split('\n'):
                                print(f'    {line}')
                            
                            # GASに送信
                            if gas_url:
                                print(f'  → GASに送信中...')
                                success = send_to_gas(gas_url, data)
                                if success:
                                    print(f'  ✅ 送信完了')
                                else:
                                    print(f'  ❌ 送信失敗')
                            else:
                                print(f'  ⚠️ GAS URL未設定（ローカル表示のみ）')
                            
                            print()
                            
                        except Exception as e:
                            print(f'  ❌ パースエラー: {e}')
                            print()
            
            time.sleep(poll_interval)
            
        except KeyboardInterrupt:
            print('\n[NSIPS Watcher] 停止しました')
            break


def main():
    parser = argparse.ArgumentParser(description='NSIPS フォルダ監視 + GAS送信')
    parser.add_argument('--folder', '-f', help='NSIPSフォルダのパス')
    parser.add_argument('--gas-url', '-g', help='GAS Web App URL')
    parser.add_argument('--interval', '-i', type=int, default=DEFAULT_POLL_INTERVAL, help='ポーリング間隔（秒）')
    parser.add_argument('--setup', action='store_true', help='設定ファイルを対話的に作成')
    
    args = parser.parse_args()
    config = load_config()
    
    if args.setup:
        print('=== NSIPS Watcher セットアップ ===')
        folder = input(f'NSIPSフォルダのパス [{config.get("folder", "")}]: ').strip()
        if folder:
            config['folder'] = folder
        gas_url = input(f'GAS Web App URL [{config.get("gas_url", "")}]: ').strip()
        if gas_url:
            config['gas_url'] = gas_url
        interval = input(f'ポーリング間隔（秒）[{config.get("interval", DEFAULT_POLL_INTERVAL)}]: ').strip()
        if interval:
            config['interval'] = int(interval)
        save_config(config)
        print(f'✅ 設定を保存しました: {CONFIG_FILE}')
        return
    
    folder = args.folder or config.get('folder', '')
    gas_url = args.gas_url or config.get('gas_url', '')
    interval = args.interval or config.get('interval', DEFAULT_POLL_INTERVAL)
    
    if not folder:
        print('[ERROR] NSIPSフォルダを指定してください')
        print(f'  使い方: python {sys.argv[0]} --folder C:\\NSIPS --gas-url https://...')
        print(f'  または: python {sys.argv[0]} --setup')
        sys.exit(1)
    
    watch_folder(folder, gas_url, interval)


if __name__ == '__main__':
    main()
