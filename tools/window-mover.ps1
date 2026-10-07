# window-mover.ps1 -- keep console windows that our tooling spawns out of the user's face.
#
# Why: running commands through the cmd channel creates visible WindowsTerminal /
# OpenConsole / cmd / conhost windows. The user works on this machine and does not
# want to see them, so we minimize them the moment they appear (and hide the ones
# that refuse to stay minimized).
#
# Rules (task-17):
#   * resident + hidden, one round every 150 ms
#   * only TOP-LEVEL, VISIBLE, not-yet-minimized windows
#   * only processes in $Targets; the user's Edge, our own headless Edge and any
#     hidden process are never touched (a hidden window fails IsWindowVisible)
#   * two guards against touching a terminal the user is using:
#       (a) every window that already exists at startup is sealed and never touched
#       (b) the title must look like a console default title ($TitleOk) -- a user
#           terminal opened by hand is titled after its profile, so it gets one
#           "action=skip" line (the evidence that we left it alone) and nothing else
#   * action 1: ShowWindow(SW_SHOWMINNOACTIVE) -> minimize WITHOUT stealing focus
#   * action 2: if that window is still in front of the user 1.5 s later, upgrade
#     to ShowWindow(SW_HIDE). Windows are NEVER moved off-screen.
#   * idempotent: already minimized / invisible windows are skipped (no flicker)
#   * a failed round is logged and swallowed: a resident watcher must not die
#     silently on one bad window (that bug cost a whole verification round)
#   * every 60 s one "action=heartbeat" line, so a silent death is visible
#   * log real actions only: F:\tmp\window-mover.log
#   * create F:\tmp\window-mover.stop to make it exit (fresh log each start)
#
# Start (one line, hidden):
#   Start-Process -WindowStyle Hidden -FilePath powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','F:\shudong\tools\window-mover.ps1'
#
# Pure ASCII on purpose: PowerShell 5.1 reads a BOM-less file as ANSI, and a stray
# byte in a non-ASCII comment can break the parser.

$ErrorActionPreference = 'Stop'

$LogPath   = 'F:\tmp\window-mover.log'
$StopPath  = 'F:\tmp\window-mover.stop'
$Targets   = @('WindowsTerminal', 'OpenConsole', 'cmd', 'conhost')
$RoundMs   = 150
$UpgradeMs = 1500
$BeatMs    = 60000
# A terminal the user opened by hand is titled after its profile ("Windows
# PowerShell"), not like a console host. Empty titles pass: our own console
# windows can be briefly title-less while they start up.
$TitleOk   = '^[A-Za-z]:\\Windows\\system32\\(cmd|OpenConsole|conhost)\.exe$'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public class WinMover
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public class Info
    {
        public long H;
        public uint Pid;
        public string Title;
        public string Rect;
    }

    public const int SW_HIDE = 0;
    public const int SW_SHOWMINNOACTIVE = 7;

    // Top-level, visible windows only. A hidden window is invisible to the user and
    // therefore never a candidate -- that is what protects our hidden helpers.
    public static List<Info> VisibleTopLevel()
    {
        List<Info> list = new List<Info>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            RECT r;
            GetWindowRect(h, out r);
            Info i = new Info();
            i.H = h.ToInt64();
            i.Pid = pid;
            i.Title = sb.ToString();
            i.Rect = r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
            list.Add(i);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // Every top-level window that already exists, visible or not. Taken once at
    // startup and sealed: whatever the user had open when we started stays theirs.
    public static List<long> AllTopLevel()
    {
        List<long> list = new List<long>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            list.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static string RectOf(long h)
    {
        RECT r;
        if (!GetWindowRect(new IntPtr(h), out r)) return "?";
        return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
    }
}
'@

function Write-Log([string]$Who, [string]$Action, [string]$Detail) {
    $line = '{0} pid={1} action={2} {3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Who, $Action, $Detail
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

if (Test-Path -LiteralPath $LogPath) { Remove-Item -LiteralPath $LogPath -Force }
if (Test-Path -LiteralPath $StopPath) { Remove-Item -LiteralPath $StopPath -Force }

# Sealed: every window that already exists right now. Whatever the user had open
# when we started stays untouched for the whole run, whatever its title becomes.
$sealed = @{}
foreach ($h in [WinMover]::AllTopLevel()) { $sealed[$h] = $true }
$skipped = @{}
$nextBeat = (Get-Date).AddMilliseconds($BeatMs)
Write-Log '0' 'start' ('sealed=' + $sealed.Count)

# hWnd -> deadline by which the minimize must have taken effect, otherwise hide.
$pending = @{}
$lastErr = ''

while (-not (Test-Path -LiteralPath $StopPath)) {
    $roundStart = Get-Date
    try {
        if ($roundStart -ge $nextBeat) {
            Write-Log '0' 'heartbeat' ('sealed=' + $sealed.Count + ' pending=' + $pending.Count)
            $nextBeat = $roundStart.AddMilliseconds($BeatMs)
        }

        # 1) upgrade windows we already minimized but that are still in front of the user
        foreach ($key in @($pending.Keys)) {
            $p = $pending[$key]
            if ($roundStart -lt $p.Deadline) { continue }
            $pending.Remove($key)
            $h = [IntPtr]$p.H
            if ([WinMover]::IsWindowVisible($h) -and -not [WinMover]::IsIconic($h)) {
                # minimize did not hold -> hide it (never moved off-screen)
                $null = [WinMover]::ShowWindow($h, [WinMover]::SW_HIDE)
                Write-Log $p.Pid 'hide' ('hwnd=' + $p.H + ' from=(' + [WinMover]::RectOf($p.H) + ') title="' + $p.Title + '"')
            }
        }

        # 2) minimize fresh console windows
        foreach ($w in [WinMover]::VisibleTopLevel()) {
            if ($sealed.ContainsKey($w.H)) { continue }    # existed before we started: not ours
            if ($pending.ContainsKey($w.H)) { continue }
            if ([WinMover]::IsIconic([IntPtr]$w.H)) { continue }   # already minimized: idempotent
            $name = $null
            try { $name = (Get-Process -Id $w.Pid -ErrorAction Stop).ProcessName } catch { continue }
            if ($Targets -notcontains $name) { continue }
            if (-not ($w.Title -eq '' -or $w.Title -match $TitleOk)) {
                # a hand-opened terminal: leave it alone, but say so once (the
                # evidence that we did not touch the user's window)
                if (-not $skipped.ContainsKey($w.H)) {
                    Write-Log $w.Pid 'skip' ('hwnd=' + $w.H + ' title="' + $w.Title + '"')
                    $skipped[$w.H] = $true
                }
                continue
            }
            $null = [WinMover]::ShowWindow([IntPtr]$w.H, [WinMover]::SW_SHOWMINNOACTIVE)
            Write-Log $w.Pid 'min' ('hwnd=' + $w.H + ' from=(' + $w.Rect + ') title="' + $w.Title + '"')
            $pending[$w.H] = @{ Deadline = (Get-Date).AddMilliseconds($UpgradeMs); Pid = $w.Pid; Title = $w.Title; H = $w.H }
        }
        $lastErr = ''
    } catch {
        $msg = $_.Exception.Message
        if ($msg -ne $lastErr) { Write-Log '0' 'error' ('text="' + $msg.Replace('"', "'") + '"'); $lastErr = $msg }
    }

    $spent = ((Get-Date) - $roundStart).TotalMilliseconds
    $wait = $RoundMs - $spent
    if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
}

Write-Log '0' 'stop' '-'
