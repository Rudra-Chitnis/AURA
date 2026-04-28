' AURA Silent Launcher
' Starts AURA with no visible terminal windows.
' Used by the Desktop shortcut created by create-shortcut.bat.

Option Explicit

Dim WshShell, fso, projectDir, desktopDir, cmd

Set WshShell = CreateObject("WScript.Shell")
Set fso      = CreateObject("Scripting.FileSystemObject")

' Resolve the project root from this script's own location
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
desktopDir = projectDir & "\desktop"

' Verify the desktop directory exists before trying to launch
If Not fso.FolderExists(desktopDir) Then
    WshShell.Popup "AURA desktop folder not found at:" & vbCrLf & desktopDir, 8, "AURA Launch Error", 16
    WScript.Quit 1
End If

' Use "cmd /c cd /d <dir> && npm run start" which is the most reliable
' approach on all Windows configurations.  "npm run start" = "electron ."
' and electron reads main.js which loads dist/index.html (production build).
' windowStyle = 0  → hidden cmd window (user never sees a terminal)
' bWaitOnReturn = False → non-blocking (launcher exits, AURA runs independently)
cmd = "cmd /c cd /d """ & desktopDir & """ && npm run start"
WshShell.Run cmd, 0, False

Set WshShell = Nothing
Set fso      = Nothing
