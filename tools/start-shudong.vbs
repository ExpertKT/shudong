' Shudong desktop entry: launch start-shudong.cmd with a hidden window.
' Why this file exists: if the desktop .url points straight at the .cmd, Explorer
' first opens a cmd.exe console (that console IS the black window that flashes),
' then the .cmd hides only the pwsh it starts. Going through wscript with
' Run(..., 0) creates no console window at all.
' ASCII only on purpose: wscript reads this file in the ANSI codepage.
Option Explicit
Dim shell, dir, extra, i
Set shell = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
extra = ""
For i = 0 To WScript.Arguments.Count - 1
    extra = extra & " " & Chr(34) & WScript.Arguments(i) & Chr(34)
Next
' 0 = hidden window, True = wait so the .cmd exit code becomes wscript's exit code.
WScript.Quit shell.Run(Chr(34) & dir & "start-shudong.cmd" & Chr(34) & extra, 0, True)
