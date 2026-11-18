# setup_display.ps1 -- pin the primary display to a fixed mode (virtual display first).
#
# WHY: the RPA coordinates are only meaningful if the physical resolution is a constant.
# A physical monitor is NOT a constant: it changes on plug/unplug, RDP connect/disconnect,
# screen blanking, laptop lid close, and "no monitor attached" servers. A virtual display
# whose mode we choose IS a constant.
#
# This script is meant to run on every launch, from the shell startup chain, before the
# original suite is started. It must not silently fall back to the physical screen: if the
# target mode cannot be applied, exit non-zero and let the caller report "environment".
#
# ASCII only on purpose: PS 5.1 reads a BOM-less .ps1 as ANSI and mangles non-ASCII literals.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\setup_display.ps1
#   ... -Width 1920 -Height 1080 -Refresh 60
#   ... -List          # only enumerate adapters and modes, change nothing
#   ... -DryRun        # show what would be done
#
# Exit codes:
#   0  target mode already active, or applied successfully
#   2  no suitable adapter / mode (caller should report environment)
#   3  applying the mode failed
#   4  invalid arguments

[CmdletBinding()]
param(
    [int]$Width = 1920,
    [int]$Height = 1080,
    [int]$Refresh = 60,
    [switch]$List,
    [switch]$DryRun,
    [switch]$PreferPhysical
)

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------- Win32
$signature = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class FsaDisplay {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public uint dmFields;
        public int dmPositionX, dmPositionY;
        public uint dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public ushort dmLogPixels;
        public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType;
        public uint dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAY_DEVICE {
        public uint cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public uint StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplayDevicesW(string device, uint num,
        ref DISPLAY_DEVICE dd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplaySettingsW(string device, int mode,
        ref DEVMODE devmode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int ChangeDisplaySettingsExW(string device,
        ref DEVMODE devmode, IntPtr hwnd, uint flags, IntPtr param);

    public const uint ATTACHED_TO_DESKTOP = 0x1;
    public const uint PRIMARY_DEVICE = 0x4;
    public const int ENUM_CURRENT_SETTINGS = -1;
    public const uint DM_PELSWIDTH = 0x80000;
    public const uint DM_PELSHEIGHT = 0x100000;
    public const uint DM_DISPLAYFREQUENCY = 0x400000;
    public const uint CDS_UPDATEREGISTRY = 0x1;
    public const int DISP_CHANGE_SUCCESSFUL = 0;

    public static int DevModeSize() { return Marshal.SizeOf(typeof(DEVMODE)); }

    public static string[] Adapters() {
        var outList = new List<string>();
        var dd = new DISPLAY_DEVICE();
        dd.cb = (uint)Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        for (uint i = 0; i < 64; i++) {
            if (!EnumDisplayDevicesW(null, i, ref dd, 0)) break;
            outList.Add(dd.DeviceName + "|" + dd.DeviceString + "|" + dd.StateFlags);
        }
        return outList.ToArray();
    }

    public static string CurrentMode(string device) {
        var dm = new DEVMODE();
        dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
        if (!EnumDisplaySettingsW(device, ENUM_CURRENT_SETTINGS, ref dm)) return null;
        return dm.dmPelsWidth + "x" + dm.dmPelsHeight + "@" + dm.dmDisplayFrequency;
    }

    public static string[] Modes(string device) {
        var list = new List<string>();
        var dm = new DEVMODE();
        dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
        for (int i = 0; i < 500; i++) {
            if (!EnumDisplaySettingsW(device, i, ref dm)) break;
            list.Add(dm.dmPelsWidth + "x" + dm.dmPelsHeight + "@" + dm.dmDisplayFrequency);
        }
        return list.ToArray();
    }

    public static bool Supports(string device, int w, int h, int r) {
        foreach (var m in Modes(device)) {
            if (m == (w + "x" + h + "@" + r)) return true;
        }
        return false;
    }

    public static int Apply(string device, int w, int h, int r) {
        var dm = new DEVMODE();
        dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
        dm.dmDeviceName = device;
        dm.dmPelsWidth = (uint)w;
        dm.dmPelsHeight = (uint)h;
        dm.dmDisplayFrequency = (uint)r;
        dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
        return ChangeDisplaySettingsExW(device, ref dm, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero);
    }
}
'@

try {
    Add-Type -TypeDefinition $signature -ErrorAction Stop
} catch {
    # already loaded in this session
}

if ($Width -le 0 -or $Height -le 0 -or $Refresh -le 0) {
    Write-Output "ERROR invalid mode: ${Width}x${Height}@${Refresh}"
    exit 4
}

$target = "$Width" + "x" + "$Height" + "@" + "$Refresh"

# --------------------------------------------------------------------------- adapters
$adapters = @()
foreach ($raw in [FsaDisplay]::Adapters()) {
    $parts = $raw.Split('|')
    $flags = [uint32]$parts[2]
    $adapters += [PSCustomObject]@{
        Device    = $parts[0]
        Name      = $parts[1]
        Attached  = (($flags -band [FsaDisplay]::ATTACHED_TO_DESKTOP) -ne 0)
        Primary   = (($flags -band [FsaDisplay]::PRIMARY_DEVICE) -ne 0)
        IsVirtual = ($parts[1] -match 'Virtual|Idd|Indirect|Mirror|Parsec|GameViewer|Oray')
        Current   = [FsaDisplay]::CurrentMode($parts[0])
    }
}

if ($List) {
    Write-Output "target mode : $target"
    foreach ($a in $adapters) {
        $tag = @()
        if ($a.Attached) { $tag += 'attached' }
        if ($a.Primary) { $tag += 'primary' }
        if ($a.IsVirtual) { $tag += 'virtual' }
        Write-Output ("  {0,-14} {1,-42} current={2,-16} {3}" -f `
            $a.Device, $a.Name, $a.Current, ($tag -join ','))
        # Only expand modes for adapters that are actually usable: printing them for all
        # 28 devices would drown the output, and a device that is not attached cannot
        # report a mode anyway.
        if ($a.Attached) {
            $all = @([FsaDisplay]::Modes($a.Device))
            $sameSize = @($all | Where-Object { $_ -like ($Width.ToString() + 'x' + $Height + '@*') } | Select-Object -Unique | Sort-Object)
            $variants = '(none)'
            if ($sameSize.Count -gt 0) { $variants = $sameSize -join ', ' }
            Write-Output ("      modes={0}  {1}x{2} variants: {3}" -f `
                $all.Count, $Width, $Height, $variants)
            Write-Output ("      supports target {0}: {1}" -f $target, [FsaDisplay]::Supports($a.Device, $Width, $Height, $Refresh))
        }
    }
    exit 0
}

# --------------------------------------------------------------------------- pick adapter
# Preference: a virtual adapter that is attached to the desktop. The whole point is to
# stop depending on the physical screen. -PreferPhysical exists only for debugging.
$candidates = @()
if ($PreferPhysical) {
    $candidates = @($adapters | Where-Object { $_.Attached })
} else {
    $candidates = @($adapters | Where-Object { $_.Attached -and $_.IsVirtual })
    if ($candidates.Count -eq 0) {
        $virtualSeen = @($adapters | Where-Object { $_.IsVirtual })
        Write-Output "ERROR no virtual display adapter attached to the desktop"
        Write-Output ""
        if ($virtualSeen.Count -gt 0) {
            # This is the observed state on this machine: the vendor drivers register
            # their adapters with EnumDisplayDevices, but no source/target path exists
            # until the vendor client attaches them. ChangeDisplaySettingsEx then has
            # nothing to act on (they enumerate 0 modes).
            Write-Output ("      {0} virtual adapter(s) exist but NONE is attached:" -f $virtualSeen.Count)
            $byName = $virtualSeen | Group-Object Name
            foreach ($g in $byName) {
                Write-Output ("        {0} x{1}  e.g. {2}" -f $g.Name, $g.Count, $g.Group[0].Device)
            }
            Write-Output ""
            Write-Output "      why: the IDD driver is installed and its ROOT\\DISPLAY device"
            Write-Output "           instance exists, but the driver itself never calls"
            Write-Output "           IddCxMonitorArrival. Until it does, Windows has no monitor,"
            Write-Output "           so no source/target path, so EnumDisplaySettings returns 0"
            Write-Output "           modes and ChangeDisplaySettingsEx cannot change anything."
            Write-Output ""
            Write-Output "      fix A (self-contained): bundle our own IDD driver that reports"
            Write-Output "           a monitor unconditionally at startup (IddSampleDriver or"
            Write-Output "           Virtual Display Driver), install once with pnputil."
            Write-Output "      fix B (vendor): start the vendor client and let it attach a"
            Write-Output "           virtual monitor, then re-run this script."
            Write-Output "      workaround      : -PreferPhysical (single machine, single"
            Write-Output "           screen only -- see plan section 3.3, it DOES drift across"
            Write-Output "           machines and when displays are plugged/unplugged)"
        } else {
            Write-Output "      no virtual display adapter was enumerated at all."
            Write-Output "      install a signed IDD driver (IddSampleDriver / Virtual Display Driver)"
        }
        exit 2
    }
}

$chosen = $null
foreach ($a in $candidates) {
    if ([FsaDisplay]::Supports($a.Device, $Width, $Height, $Refresh)) { $chosen = $a; break }
}
if (-not $chosen) {
    Write-Output "ERROR target mode $target not supported by any candidate adapter"
    foreach ($a in $candidates) {
        $modes = [FsaDisplay]::Modes($a.Device) | Select-Object -Unique | Sort-Object
        Write-Output ("  {0} ({1}) supports {2} modes" -f $a.Device, $a.Name, $modes.Count)
        $hit = $modes | Where-Object { $_ -like ($Width.ToString() + 'x' + $Height + '@*') }
        if ($hit) { Write-Output ("    same size: " + ($hit -join ', ')) }
    }
    exit 2
}

Write-Output ("adapter     : {0} ({1}){2}" -f $chosen.Device, $chosen.Name,
    $(if ($chosen.IsVirtual) { ' [virtual]' } else { ' [PHYSICAL]' }))
Write-Output ("current     : {0}" -f $chosen.Current)
Write-Output ("target      : {0}" -f $target)

# --------------------------------------------------------------------------- apply
if ($chosen.Current -eq $target) {
    Write-Output "result      : already at target mode (no change)"
    exit 0
}

if ($DryRun) {
    Write-Output "result      : dry-run, would apply $target to $($chosen.Device)"
    exit 0
}

$rc = [FsaDisplay]::Apply($chosen.Device, $Width, $Height, $Refresh)
if ($rc -ne [FsaDisplay]::DISP_CHANGE_SUCCESSFUL) {
    Write-Output "ERROR ChangeDisplaySettingsEx returned $rc"
    exit 3
}

# Verify by reading back -- never trust the return code alone.
Start-Sleep -Milliseconds 800
$after = [FsaDisplay]::CurrentMode($chosen.Device)
Write-Output ("after       : {0}" -f $after)
if ($after -ne $target) {
    Write-Output "ERROR mode did not stick: expected $target, read back $after"
    exit 3
}

Write-Output "result      : applied $target on $($chosen.Device)"
exit 0
