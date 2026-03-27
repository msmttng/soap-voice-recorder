"""
nsips_parser.py — NSIPS VER010401 形式パーサー

レセコンが出力するNSIPSデータを解析し、
患者情報と処方内容を構造化して返す。

VER010401フォーマット:
  行0: ヘッダ（バージョン, 日時, 薬局名, 住所等）
  行1: 患者情報（患者コード, カナ, 氏名, 性別, 生年月日, 住所等）
  行2+: 処方データ（レコードタイプ別）
    2: 処方ヘッダ
    3: 用法
    4: 薬品
    5: 請求
    6: 調剤明細
    7: 加算
"""

import re
import os
from datetime import datetime


def parse_nsips(text: str) -> dict:
    """
    NSIPS VER010401形式のテキストを解析して構造化データを返す。
    """
    lines = [l.rstrip() for l in text.strip().split('\n') if l.strip()]
    
    result = {
        "format": "",
        "pharmacy": "",
        "pharmacy_address": "",
        "pharmacy_tel": "",
        "patient": {
            "code": "",
            "name": "",
            "kana": "",
            "gender": "",
            "dob": "",
            "age": None,
            "address": "",
            "tel": ""
        },
        "institution": "",
        "doctor": "",
        "prescription_date": "",
        "drugs": [],
        "drug_summary": ""
    }
    
    if not lines:
        return result
    
    # === 行0: ヘッダ ===
    # VER010401,20260324082602,,VER7,13,4,1158526,丸山薬局,1440052,東京都大田区...,電話,
    h = lines[0].split(',')
    result["format"] = h[0] if len(h) > 0 else ""
    if len(h) > 1 and len(h[1]) >= 8:
        result["prescription_date"] = f"{h[1][:4]}-{h[1][4:6]}-{h[1][6:8]}"
    result["pharmacy"] = h[7] if len(h) > 7 else ""
    result["pharmacy_address"] = h[9] if len(h) > 9 else ""
    result["pharmacy_tel"] = h[10] if len(h) > 10 else ""
    
    # === 行1: 患者情報 ===
    # 1,患者コード,カナ,氏名,性別(1=男,2=女),生年月日(YYYYMMDD),郵便番号,住所,...,電話,...
    if len(lines) > 1:
        p = lines[1].split(',')
        if len(p) > 1:
            result["patient"]["code"] = p[1] if len(p) > 1 else ""
            result["patient"]["kana"] = p[2] if len(p) > 2 else ""
            result["patient"]["name"] = (p[3] if len(p) > 3 else "").replace("　", " ").strip()
            
            if len(p) > 4:
                gender_code = p[4].strip()
                result["patient"]["gender"] = "男" if gender_code == "1" else "女" if gender_code == "2" else gender_code
            
            if len(p) > 5 and len(p[5]) == 8:
                try:
                    dob = datetime.strptime(p[5], '%Y%m%d')
                    result["patient"]["dob"] = dob.strftime('%Y-%m-%d')
                    result["patient"]["age"] = (datetime.now() - dob).days // 365
                except ValueError:
                    pass
            
            result["patient"]["address"] = p[7] if len(p) > 7 else ""
            # 電話番号を探す（複数のフィールドにある可能性）
            for idx in range(8, min(len(p), 14)):
                if p[idx] and re.match(r'^[\d\-]+$', p[idx]) and len(p[idx]) > 5:
                    result["patient"]["tel"] = p[idx]
                    break
    
    # === 行2以降: 処方・薬品データ ===
    # 各行のレコードタイプ（最初のフィールド）で判別
    drugs_found = []
    
    for line in lines[2:]:
        fields = line.split(',')
        record_type = fields[0].strip() if fields else ""
        
        # 薬品名を含む行を検索（フィールドの中に日本語薬品名が含まれる行）
        for i, field in enumerate(fields):
            field = field.strip()
            # 薬品名パターン: 日本語+英数字を含む、「錠」「mg」「カプセル」等
            if field and len(field) >= 4 and re.search(r'(錠|ｍｇ|mg|カプセル|顆粒|散|液|軟膏|クリーム|テープ|パッチ|点眼|点鼻|噴霧|ＯＤ)', field):
                # 重複チェック
                if field not in [d["name"] for d in drugs_found]:
                    # 薬品コード（前のフィールドがコードっぽい場合）
                    code = ""
                    if i > 0 and re.match(r'^[0-9A-Za-z]{7,}', fields[i-1].strip()):
                        code = fields[i-1].strip()
                    
                    drugs_found.append({
                        "name": field,
                        "name_clean": re.sub(r'【[^】]*】', '', field).strip(),
                        "code": code
                    })
        
        # 行5に医療機関名が含まれることがある
        if record_type == '5':
            # 末尾に医療機関名がある場合
            for field in reversed(fields):
                field = field.strip()
                if field and re.search(r'(病院|クリニック|医院|科)', field):
                    # 「0）」等のプレフィックスを除去
                    clean = re.sub(r'^[\d\)）]+', '', field).strip()
                    if clean:
                        result["institution"] = clean
                    break
    
    result["drugs"] = drugs_found
    
    # 処方要約テキスト生成
    summary_lines = []
    for i, drug in enumerate(drugs_found, 1):
        summary_lines.append(f"{drug['name_clean']}")
    
    result["drug_summary"] = "\n".join(summary_lines)
    
    return result


def parse_nsips_file(filepath: str) -> dict:
    """ファイルパスからNSIPSデータを読み込んでパース"""
    # Shift-JISで試行、失敗したらUTF-8
    for enc in ['shift_jis', 'cp932', 'utf-8']:
        try:
            with open(filepath, 'r', encoding=enc, errors='replace') as f:
                text = f.read()
            return parse_nsips(text)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"ファイルのエンコーディングを検出できません: {filepath}")


if __name__ == '__main__':
    import json
    import sys
    
    if len(sys.argv) > 1:
        filepath = sys.argv[1]
    else:
        # テスト: 実際のNSIPSファイル
        filepath = r'\\Ver7\ai音声録音\SIPS12\DATA\A99112036056171400000.txt'
    
    result = parse_nsips_file(filepath)
    print(json.dumps(result, ensure_ascii=False, indent=2))
