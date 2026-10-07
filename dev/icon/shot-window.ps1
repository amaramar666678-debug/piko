param(
  [Parameter(Mandatory = $true)][string]$Class,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$ForceWidth = 0,
  [int]$ForceHeight = 0
)

# PrintWindow capture of a shell window (the taskbar, or the tray overflow
# flyout). CopyFromScreen is not usable here: the taskbar does not appear in a
# desktop screenshot on this machine — the pixels come back as wallpaper — so the
# window is asked to render itself into a DC instead, with PW_RENDERFULLCONTENT.
#
# The C# carries no drawing code on purpose: keeping it free of System.Drawing
# means it can be added with -ReferencedAssemblies out of the way, which is the
# part that reliably breaks here-string quoting on PowerShell 5.1.

Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr h);
  public struct RECT { public int L, T, R, B; }
}
'@

[void][WinCap]::SetProcessDPIAware()

$h = [WinCap]::FindWindow($Class, $null)
if ($h -eq [IntPtr]::Zero) { throw "no window of class '$Class'" }

$r = New-Object 'WinCap+RECT'
[void][WinCap]::GetWindowRect($h, [ref]$r)

$w = if ($ForceWidth -gt 0) { $ForceWidth } else { $r.R - $r.L }
$hgt = if ($ForceHeight -gt 0) { $ForceHeight } else { $r.B - $r.T }
if ($w -le 0 -or $hgt -le 0) { throw "window reports no area" }

"class=$Class visible=$([WinCap]::IsWindowVisible($h)) rect=$($r.L),$($r.T) ${w}x${hgt}"

$bmp = New-Object System.Drawing.Bitmap($w, $hgt)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [WinCap]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$g.Dispose()

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"PrintWindow=$ok -> $Out"