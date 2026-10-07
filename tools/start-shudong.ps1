# 述洞 · 一键进洞
# 双击 start-shudong.cmd（等价于运行 pwsh/powershell -File start-shudong.ps1）。
#
# 不带开关：只做三件 —— 没人听就隐藏起后端/前端 → 等两个都听上 → 开浏览器。
#           不按命令行匹配杀任何进程，只"没人听才起"；服务那半可以重复跑。
#           30 秒还没起来：点名是哪个口没起、收掉"这次自己起的"进程、退非 0。
#           前端直接跑 web\node_modules\vite\bin\vite.js —— 不走 pnpm
#           （包 pin 的 pnpm 版本不在 corepack 缓存里，隐藏窗口里会卡在下载询问）。
# -NoOpen   ：同上，但不开浏览器（给自动化取证用；双击的默认行为不变）。
# -Install  ：在桌面建一个「述洞」快捷方式（述洞.url，指向 start-shudong.vbs →
#            start-shudong.cmd，图标 tools\shudong.ico）。只装东西，不碰服务、也不开浏览器。
# -Uninstall：删掉那个快捷方式。只删"目标确实是本脚本这套（.vbs 或 .cmd）"的；
#            桌面上别的同名文件一律不动。

param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Continue'
$ServerDir = 'F:\shudong\server'
$WebDir    = 'F:\shudong\web'
$ViteJs    = Join-Path $WebDir 'node_modules\vite\bin\vite.js'
$LogDir    = 'F:\tmp'
# vite 只监听 [::1]，所以地址必须是 localhost 而不是 127.0.0.1
$Url       = 'http://localhost:5173/'

$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$CmdPath  = Join-Path $Here 'start-shudong.cmd'
# 双击入口用 .vbs 而不是直接指 .cmd：Explorer 直接跑 .cmd 会先开一个 cmd.exe 控制台
# （那就是用户看见的"闪一下黑窗"）。wscript 用 Run(...,0) 拉起则全程没有窗口。
$VbsPath  = Join-Path $Here 'start-shudong.vbs'
$IcoPath  = Join-Path $Here 'shudong.ico'
$LinkName = '述洞.url'

function Test-Listening([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

if ($Install -and $Uninstall) {
    Write-Warning '-Install 和 -Uninstall 只能给一个。'
    exit 2
}

if ($Install -or $Uninstall) {
    $link = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) $LinkName

    if ($Install) {
        if (-not (Test-Path -LiteralPath $CmdPath)) {
            Write-Warning "找不到 $CmdPath —— 没法装。"
            exit 3
        }
        if (-not (Test-Path -LiteralPath $VbsPath)) {
            Write-Warning "找不到 $VbsPath —— 没法装（双击不闪窗靠它）。"
            exit 3
        }
        # .url（InternetShortcut）是纯文本，不需要 COM；内容用 ASCII 写，
        # 免得 BOM 落到第一行让 Shell 认不出来。
        $uri  = ([uri]$VbsPath).AbsoluteUri
        $body = @('[InternetShortcut]', "URL=$uri")
        if (Test-Path -LiteralPath $IcoPath) {
            $body += "IconFile=$IcoPath"
            $body += 'IconIndex=0'
        }
        try {
            Set-Content -LiteralPath $link -Value $body -Encoding ASCII
        } catch {
            Write-Warning "建快捷方式失败：$($_.Exception.Message)"
            exit 5
        }
        Write-Host "装好了：$link  →  $VbsPath  →  $CmdPath"
        exit 0
    }

    if (-not (Test-Path -LiteralPath $link)) {
        Write-Host "桌面上没有 $LinkName —— 不用删。"
        exit 0
    }
    try {
        $url = (Get-Content -LiteralPath $link -ErrorAction Stop |
                Where-Object { $_ -match '^\s*URL\s*=' } |
                Select-Object -First 1)
    } catch {
        Write-Warning "读不了那个快捷方式：$($_.Exception.Message)"
        exit 5
    }
    $url = if ($url) { ($url -replace '^\s*URL\s*=', '').Trim() } else { '' }
    # 认两种目标：现在的 .vbs，和早期装过的 .cmd（旧快捷方式也要删得掉）
    if (($url -ieq ([uri]$VbsPath).AbsoluteUri) -or ($url -ieq ([uri]$CmdPath).AbsoluteUri)) {
        Remove-Item -LiteralPath $link -Force
        Write-Host "删掉了：$link"
        exit 0
    }
    Write-Warning "桌面上的 $LinkName 指向的是「$url」，不是本脚本 —— 没动它。"
    exit 4
}

# 这次自己起的进程记在这里 —— 超时只收自己起的，别人的一律不碰
$started = @()

if (Test-Listening 8787) {
    Write-Host '8787 已经有人在听 —— 不动它。'
} else {
    Write-Host "起述洞后端（8787）… 日志 $LogDir\live-8787.out / live-8787.err"
    $p = Start-Process -WindowStyle Hidden -FilePath cmd -WorkingDirectory $ServerDir -PassThru `
        -ArgumentList '/c', "node --env-file-if-exists=.env src/index.ts > $LogDir\live-8787.out 2> $LogDir\live-8787.err"
    $started += [pscustomobject]@{ Id = $p.Id; Port = 8787; What = '后端' }
}

if (Test-Listening 5173) {
    Write-Host '5173 已经有人在听 —— 不动它。'
} elseif (-not (Test-Path -LiteralPath $ViteJs)) {
    Write-Warning "找不到 $ViteJs —— 前端起不来（先在 F:\shudong 装一次依赖）。"
    exit 6
} else {
    Write-Host "起述洞前端（5173）… 日志 $LogDir\live-5173.out"
    $p = Start-Process -WindowStyle Hidden -FilePath cmd -WorkingDirectory $WebDir -PassThru `
        -ArgumentList '/c', "node `"$ViteJs`" > $LogDir\live-5173.out 2>&1"
    $started += [pscustomobject]@{ Id = $p.Id; Port = 5173; What = '前端' }
}

# 等两个口都听上（最多 30 秒；起得来通常 1~2 秒）
for ($i = 0; $i -lt 30; $i++) {
    if ((Test-Listening 8787) -and (Test-Listening 5173)) { break }
    Start-Sleep -Seconds 1
}
$missing = @()
if (-not (Test-Listening 8787)) { $missing += '8787（后端）' }
if (-not (Test-Listening 5173)) { $missing += '5173（前端）' }
if ($missing.Count -gt 0) {
    Write-Warning ("等了 30 秒还没起来：" + ($missing -join '、') + "。看 $LogDir\live-8787.out/.err（后端）和 $LogDir\live-5173.out（前端）。")
    foreach ($s in $started) {
        $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($s.Id)" -ErrorAction SilentlyContinue)
        foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $s.Id -Force -ErrorAction SilentlyContinue
        $kidIds = ($kids | ForEach-Object { $_.ProcessId }) -join ','
        $tail = if ($kidIds) { "，子进程 pid=$kidIds" } else { '' }
        Write-Host "收掉自己起的$($s.What)（$($s.Port)）：cmd pid=$($s.Id)$tail"
    }
    exit 1
}

if ($NoOpen) {
    Write-Host "（-NoOpen：不开浏览器）地址 $Url"
} else {
    Start-Process $Url
}
exit 0
