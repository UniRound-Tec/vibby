# Capture Vibby Electron windows for README screenshots.
# Prefers the largest visible Electron window (content frame), then a small
# always-on-top floating panel if present.

param(
    [string]$DashboardName = "dashboard.png",
    [string]$FloatingName = "floating-window.png"
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

public class VibbyShot2 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  public const uint PW_RENDERFULLCONTENT = 2;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; public int W { get { return Right-Left; } } public int H { get { return Bottom-Top; } } }
  public class Info { public IntPtr Handle; public string Title; public RECT Rect; public int Area { get { return Math.Max(0,Rect.W)*Math.Max(0,Rect.H); } } }

  public static List<Info> ElectronWindows() {
    var pids = new HashSet<int>(Process.GetProcessesByName("electron").Select(p => p.Id));
    var list = new List<Info>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid = 0; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains((int)pid)) return true;
      int len = GetWindowTextLength(h);
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      RECT rect;
      if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0)
        GetWindowRect(h, out rect);
      if (rect.W < 160 || rect.H < 160) return true;
      list.Add(new Info { Handle = h, Title = sb.ToString(), Rect = rect });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool Capture(IntPtr hWnd, string path) {
    RECT rect;
    if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0)
      GetWindowRect(hWnd, out rect);
    if (rect.W < 160 || rect.H < 160) return false;
    using (var bmp = new Bitmap(rect.W, rect.H, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT);
      g.ReleaseHdc(hdc);
      if (!ok) g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(rect.W, rect.H), CopyPixelOperation.SourceCopy);
      bmp.Save(path, ImageFormat.Png);
      return true;
    }
  }

  public static void FocusAndSize(IntPtr hWnd, int x, int y, int w, int h) {
    ShowWindow(hWnd, 9);
    SetWindowPos(hWnd, IntPtr.Zero, x, y, w, h, 0x0044);
    SetForegroundWindow(hWnd);
  }
}
"@ -ReferencedAssemblies System.Drawing,System.Linq

$outDir = Join-Path $PSScriptRoot "..\docs\readme"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$wins = [VibbyShot2]::ElectronWindows()
if (-not $wins -or $wins.Count -eq 0) { throw "No Electron windows found" }
$wins | ForEach-Object { Write-Host ("{0}x{1} '{2}'" -f $_.Rect.W, $_.Rect.H, $_.Title) }

$main = $wins | Sort-Object Area -Descending | Select-Object -First 1
[VibbyShot2]::FocusAndSize($main.Handle, 40, 20, 1360, 900)
Start-Sleep -Seconds 2

$wins = [VibbyShot2]::ElectronWindows()
$main = $wins | Sort-Object Area -Descending | Select-Object -First 1
# Floating panel is the smaller Electron window (not the main content frame)
$floating = $wins |
  Where-Object { $_.Handle -ne $main.Handle -and $_.Rect.W -ge 260 -and $_.Rect.W -le 520 -and $_.Rect.H -ge 180 -and $_.Rect.H -le 700 } |
  Sort-Object Area -Descending |
  Select-Object -First 1

$dashPath = Join-Path $outDir $DashboardName
Write-Host ("Capturing dashboard {0}x{1} '{2}' -> {3}" -f $main.Rect.W, $main.Rect.H, $main.Title, $DashboardName)
if (-not [VibbyShot2]::Capture($main.Handle, $dashPath)) { throw "dashboard capture failed" }

if ($floating) {
  # Nudge floating into a clear spot and bring to front
  [VibbyShot2]::FocusAndSize($floating.Handle, 980, 120, $floating.Rect.W, $floating.Rect.H)
  Start-Sleep -Milliseconds 400
  $floatPath = Join-Path $outDir $FloatingName
  Write-Host ("Capturing floating {0}x{1} -> {2}" -f $floating.Rect.W, $floating.Rect.H, $FloatingName)
  if (-not [VibbyShot2]::Capture($floating.Handle, $floatPath)) { throw "floating capture failed" }
} else {
  Write-Warning "Floating window not found"
}

Get-ChildItem $outDir -Filter *.png | Format-Table Name, Length -AutoSize
