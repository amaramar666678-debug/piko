# Opens the notification-area flyout and captures it, in one process.
#
# Splitting these across separate shell invocations does not work: each PowerShell
# process is a fresh session, the flyout closes when focus moves, and PrintWindow on
# a XAML island window returns a blank frame if it is mid-transition even while
# IsWindowVisible still reports true.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File dev/icon/shot-tray.ps1 -Out <path>

param([Parameter(Mandatory = $true)][string]$Out)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

Add-Type @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class Tray {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  public struct RECT { public int L, T, R, B; }

  public static IntPtr Flyout() {
    SetProcessDPIAware();
    return FindWindow("TopLevelWindowForOverflowXamlIsland", null);
  }
  public static bool Visible(IntPtr h) { return IsWindowVisible(h); }

  // Screen capture rather than PrintWindow: the flyout is a DComp/XAML island, and
  // PrintWindow on it returns either blank or wallpaper depending on timing. The
  // screen has it composited for sure, because the user is looking at it.
  public static void Screen(IntPtr h, string path, int pad) {
    RECT r; GetWindowRect(h, out r);
    int w = (r.R - r.L) + pad * 2, ht = (r.B - r.T) + pad * 2;
    using (var bmp = new Bitmap(w, ht))
    using (var g = Graphics.FromImage(bmp)) {
      g.CopyFromScreen(r.L - pad, r.T - pad, 0, 0, new Size(w, ht));
      bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
    System.Console.WriteLine("captured " + w + "x" + ht + " from " + r.L + "," + r.T);
  }
}
'@ -ReferencedAssemblies System.Drawing

$root = [System.Windows.Automation.AutomationElement]::RootElement
$tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, "Shell_TrayWnd")))
if (-not $tray) { throw "no Shell_TrayWnd" }

$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$chev = $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
  Where-Object { $_.Current.Name -eq "Show Hidden Icons" } |
  Select-Object -First 1
if (-not $chev) { throw "no 'Show Hidden Icons' button in the tray" }

$h = [Tray]::Flyout()
if ([Tray]::Visible($h)) {
  # Already open from a previous run: leave it alone and just shoot.
} else {
  $chev.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

# Poll rather than sleep a fixed amount: the window exists before it is on screen,
# and capturing during the fade-in is what produced the blank frames.
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  $h = [Tray]::Flyout()
  if ($h -ne [IntPtr]::Zero -and [Tray]::Visible($h)) { break }
}
Start-Sleep -Milliseconds 1200

$h = [Tray]::Flyout()
if ($h -eq [IntPtr]::Zero -or -not [Tray]::Visible($h)) { throw "flyout never became visible" }

[Tray]::Screen($h, $Out, 8)
"-> $Out"