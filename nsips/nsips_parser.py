"""
nsips_parser.py — JAHIS10形式 NSIPSデータパーサー

レセコンが出力するNSIPSデータ（JAHIS処方データ交換規約）を解析し、
患者情報と処方内容を構造化して返す。

対応レコード:
  1: 医療機関名
  5: 処方医
  11: 患者氏名
  12: 性別
  13: 生年月日
  51: 処方日
  101: RP（処方グループ）
  111: 用法
  181: 補足
  201: 薬品情報
"""

import re
from datetime import datetime


def parse_nsips(text: str) -> dict:
    """
    JAHIS10形式のNSIPSテキストを解析して構造化データを返す。
    
    Returns:
        {
            "format": "JAHIS10",
            "institution": "医療機関名",
            "doctor": "処方医名",
            "patient": {
                "name": "患者名",
                "kana": "カナ",
                "gender": "女",
                "dob": "2014-08-21",
                "age": 11
            },
            "prescription_date": "2026-01-30",
            "prescriptions": [
                {
                    "rp": 1,
                    "type": "内服",
                    "days": 30,
                    "usage": "分２、朝・夕食後服用",
                    "drugs": [
                        {
                            "code": "4490025F4ZZZ",
                            "name": "オロパタジン塩酸塩口腔内崩壊錠５ｍｇ",
                            "quantity": "2",
                            "unit": "Ｔ"
                        }
                    ]
                }
            ],
            "drug_summary": "処方薬の要約テキスト"
        }
    """
    lines = text.strip().split('\n')
    
    result = {
        "format": "",
        "institution": "",
        "doctor": "",
        "patient": {
            "name": "",
            "kana": "",
            "gender": "",
            "dob": "",
            "age": None
        },
        "prescription_date": "",
        "prescriptions": [],
        "drug_summary": ""
    }
    
    current_rp = None
    rp_map = {}  # rp_number -> prescription dict
    
    # 剤形マップ
    type_map = {
        "1": "内服",
        "2": "屯服",
        "3": "外用",
        "4": "注射",
    }
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        
        # ヘッダー行
        if line.startswith('JAHIS'):
            result["format"] = line
            continue
        
        fields = line.split(',')
        if not fields:
            continue
        
        record_type = fields[0].strip()
        
        try:
            if record_type == '1':
                # 医療機関: 1,区分,機関コード,都道府県,名称
                if len(fields) >= 5:
                    result["institution"] = fields[4].strip()
                    
            elif record_type == '5':
                # 処方医: 5,,,医師名
                if len(fields) >= 4:
                    result["doctor"] = fields[3].strip()
                    
            elif record_type == '11':
                # 患者: 11,,氏名,カナ
                if len(fields) >= 3:
                    result["patient"]["name"] = fields[2].strip()
                if len(fields) >= 4:
                    result["patient"]["kana"] = fields[3].strip()
                    
            elif record_type == '12':
                # 性別: 12,性別コード (1=男, 2=女)
                if len(fields) >= 2:
                    gender_code = fields[1].strip()
                    result["patient"]["gender"] = "男" if gender_code == "1" else "女" if gender_code == "2" else gender_code
                    
            elif record_type == '13':
                # 生年月日: 13,YYYYMMDD
                if len(fields) >= 2:
                    dob_str = fields[1].strip()
                    if len(dob_str) == 8:
                        dob = datetime.strptime(dob_str, '%Y%m%d')
                        result["patient"]["dob"] = dob.strftime('%Y-%m-%d')
                        age = (datetime.now() - dob).days // 365
                        result["patient"]["age"] = age
                        
            elif record_type == '51':
                # 処方日: 51,YYYYMMDD
                if len(fields) >= 2:
                    date_str = fields[1].strip()
                    if len(date_str) == 8:
                        pd = datetime.strptime(date_str, '%Y%m%d')
                        result["prescription_date"] = pd.strftime('%Y-%m-%d')
                        
            elif record_type == '101':
                # RP: 101,RP番号,剤形コード,,日数
                rp_num = int(fields[1]) if len(fields) > 1 else 0
                rp_type_code = fields[2].strip() if len(fields) > 2 else ""
                days = fields[4].strip() if len(fields) > 4 else ""
                
                rp = {
                    "rp": rp_num,
                    "type": type_map.get(rp_type_code, rp_type_code),
                    "days": int(days) if days and days.isdigit() else None,
                    "usage": "",
                    "notes": "",
                    "drugs": []
                }
                rp_map[rp_num] = rp
                current_rp = rp_num
                
            elif record_type == '111':
                # 用法: 111,RP番号,連番,,用法テキスト
                rp_num = int(fields[1]) if len(fields) > 1 else current_rp
                usage = fields[4].strip() if len(fields) > 4 else ""
                if rp_num in rp_map and usage:
                    if rp_map[rp_num]["usage"]:
                        rp_map[rp_num]["usage"] += "　" + usage
                    else:
                        rp_map[rp_num]["usage"] = usage
                        
            elif record_type == '181':
                # 補足: 181,RP番号,連番,,補足テキスト
                rp_num = int(fields[1]) if len(fields) > 1 else current_rp
                note = fields[4].strip() if len(fields) > 4 else ""
                if rp_num in rp_map and note:
                    rp_map[rp_num]["notes"] = note
                    
            elif record_type == '201':
                # 薬品: 201,RP番号,連番,枝番,日数,薬品コード,薬品名,数量,単位数,単位
                rp_num = int(fields[1]) if len(fields) > 1 else current_rp
                drug = {
                    "code": fields[5].strip() if len(fields) > 5 else "",
                    "name": fields[6].strip() if len(fields) > 6 else "",
                    "quantity": fields[7].strip() if len(fields) > 7 else "",
                    "unit": fields[9].strip() if len(fields) > 9 else ""
                }
                # 【般】を除去してクリーンな薬品名に
                drug["name_clean"] = re.sub(r'【[^】]*】', '', drug["name"]).strip()
                
                if rp_num in rp_map:
                    rp_map[rp_num]["drugs"].append(drug)
                    
        except (ValueError, IndexError) as e:
            continue
    
    # RP番号順にソート
    result["prescriptions"] = [rp_map[k] for k in sorted(rp_map.keys())]
    
    # 処方要約テキストを生成
    summary_lines = []
    for rx in result["prescriptions"]:
        for drug in rx["drugs"]:
            parts = [f"RP{rx['rp']}: {drug['name_clean']}"]
            if drug["quantity"] and drug["unit"]:
                parts.append(f"{drug['quantity']}{drug['unit']}")
            if rx["usage"]:
                parts.append(rx["usage"])
            if rx["notes"]:
                parts.append(rx["notes"])
            if rx["days"]:
                parts.append(f"{rx['days']}日分")
            summary_lines.append("  ".join(parts))
    
    result["drug_summary"] = "\n".join(summary_lines)
    
    return result


def parse_nsips_file(filepath: str) -> dict:
    """ファイルパスからNSIPSデータを読み込んでパース"""
    with open(filepath, 'r', encoding='shift_jis', errors='replace') as f:
        text = f.read()
    return parse_nsips(text)


if __name__ == '__main__':
    # テスト用サンプルデータ
    sample = """JAHIS10
1,1,5621206,13,医療法人社団元亨会てらお耳鼻咽喉科
2,144-0052,大田区蒲田四丁目１番１号　エクセルダイア蒲田ネクスト２階
3,03-3734-4133,,
4,2,27,耳鼻咽喉科
5,,,寺尾　元
11,,高橋　ハナ,ﾀｶﾊｼ ﾊﾅ
12,2
13,20140821
21,1
22,06134167
23,１００,１１２０２,2,01
27,88135116,7785520
51,20260130
101,1,1,,30
111,1,1,,分２、朝・夕食後服用,
201,1,1,1,7,4490025F4ZZZ,【般】オロパタジン塩酸塩口腔内崩壊錠５ｍｇ,2,1,Ｔ
101,2,3,,1
111,2,1,,１日２回,
181,2,1,,（点眼両目）,,
201,2,1,1,7,1319762Q2ZZZ,【般】エピナスチン塩酸塩点眼液０．１％,10,1,ｍＬ
101,3,3,,1
111,3,1,,１日１回点鼻※各鼻１回１噴霧寝る前,
201,3,1,1,7,1329710Q1ZZZ,【般】モメタゾン点鼻液５０μｇ５６噴霧用,1,1,Ｖ"""

    import json
    result = parse_nsips(sample)
    print(json.dumps(result, ensure_ascii=False, indent=2))
