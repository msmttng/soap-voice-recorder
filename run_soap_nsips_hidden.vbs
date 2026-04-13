Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\masam\.gemini\antigravity\scratch\soap-voice-recorder"
WshShell.Run "cmd.exe /c start_soap_nsips.bat", 0, False
