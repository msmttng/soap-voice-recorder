Set WshShell = CreateObject("WScript.Shell")
startupFolder = WshShell.SpecialFolders("Startup")
Set shortcut = WshShell.CreateShortcut(startupFolder & "\NSIPS_Watcher.lnk")
shortcut.TargetPath = "C:\Users\masam\.gemini\antigravity\scratch\soap-voice-recorder\start_nsips_watcher.bat"
shortcut.WorkingDirectory = "C:\Users\masam\.gemini\antigravity\scratch\soap-voice-recorder"
shortcut.WindowStyle = 7 ' 最小化状態で起動する場合は7、通常は1
shortcut.Save
MsgBox "PCのスタートアップフォルダに自動起動ショートカットを登録しました。" & vbCrLf & "次回PC起動時（ログイン時）から、NSIPS監視がバックグラウンド（最小化された状態）で自動的に開始されます。", 64, "自動起動の設定完了"
