
# ASCII only. Tries to capture the suite's main window via PrintWindow (PW_RENDERFULLCONTENT)
# instead of grabbing the screen. Runs inside the interactive session.
$log = 'C:\Users\niwawa\AppData\Local\Temp\nova-printwin.txt'
$out = 'C:\Users\niwawa\AppData\Local\Temp\nova-printwin.png'
$lines = @()
$lines += 'session: ' + (Get-Process -Id $PID).SessionId

$sig = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing

$procs = Get-Process NovAtelApplicationSuite -ErrorAction SilentlyContinue
if (-not $procs) { $lines += 'suite not running'; Set-Content $log $lines -Encoding ASCII; exit }
$withWin = $procs | Where-Object { $_.MainWindowHandle -ne 0 }
$lines += ('procs with window: ' + $(if ($withWin) { $withWin.Count } else { 0 }))
if (-not $withWin) { $lines += 'no main window handle'; Set-Content $log $lines -Encoding ASCII; exit }

$p = $withWin | Select-Object -First 1
$hwnd = $p.MainWindowHandle
$rect = New-Object W+RECT
[void][W]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
$lines += ('hwnd=' + $hwnd + ' rect=' + $w + 'x' + $h + ' visible=' + [W]::IsWindowVisible($hwnd))
if ($w -le 0 -or $h -le 0) { $lines += 'window has no size'; Set-Content $log $lines -Encoding ASCII; exit }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [W]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$lines += ('PrintWindow ok=' + $ok)

# brightness probe
$sum = 0; $n = 0
for ($x = [int]($w/2) - 20; $x -lt [int]($w/2) + 20; $x += 5) {
  for ($y = [int]($h/2) - 20; $y -lt [int]($h/2) + 20; $y += 5) {
    if ($x -ge 0 -and $y -ge 0 -and $x -lt $w -and $y -lt $h) {
      $c = $bmp.GetPixel($x, $y); $sum += ($c.R + $c.G + $c.B); $n++
    }
  }
}
$lines += ('center brightness: ' + [math]::Round($sum / (3 * [math]::Max($n,1)), 1))
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$lines += 'saved'
Set-Content -Path $log -Value $lines -Encoding ASCII
