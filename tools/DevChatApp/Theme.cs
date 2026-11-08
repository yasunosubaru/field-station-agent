using System;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace DevChatApp;

/// <summary>
/// 主题资源取值。优先从窗口根元素的 Resources 查（那里会解析 ThemeDictionaries），
/// 查不到才退回 Application 级；再取不到才用兜底色。
/// </summary>
public static class Theme
{
    private static FrameworkElement? _root;

    /// <summary>窗口启动后调一次，之后 Res() 都从这里取。</summary>
    public static void Attach(FrameworkElement root) => _root = root;

    public static SolidColorBrush Res(string key, string fallback = "#808080")
    {
        if (_root is not null && _root.Resources.TryGetValue(key, out var v1) && v1 is SolidColorBrush b1)
            return b1;

        if (Application.Current?.Resources is { } res)
        {
            if (res.TryGetValue(key, out var v2) && v2 is SolidColorBrush b2)
                return b2;
        }
        return Brush(fallback);
    }

    public static SolidColorBrush Brush(string hex)
    {
        var h = hex.TrimStart('#');
        if (h.Length < 6) h = "808080";
        byte r = System.Convert.ToByte(h.Substring(0, 2), 16);
        byte g = System.Convert.ToByte(h.Substring(2, 2), 16);
        byte b = System.Convert.ToByte(h.Substring(4, 2), 16);
        return new SolidColorBrush(Color.FromArgb(255, r, g, b));
    }

    /// <summary>成员颜色，取主题资源（暗色用更亮的同色系）。</summary>
    public static SolidColorBrush MemberBrush(string who) => who switch
    {
        "A" => Res("MemberA", "#6FA8DC"),
        "B" => Res("MemberB", "#7FBF6A"),
        "C" => Res("MemberC", "#C08BD0"),
        "D" => Res("MemberD", "#E0A94F"),
        _   => Res("MemberUser", "#E8896A"),
    };

    public static SolidColorBrush Ink() => Res("InkBrush", "#E9E7E3");
    public static SolidColorBrush Ink2() => Res("Ink2Brush", "#A8A5A0");
    public static SolidColorBrush Dim() => Res("DimBrush", "#78756F");
    public static SolidColorBrush CodeBg() => Res("CodeBgBrush", "#26251F");
    public static SolidColorBrush HoverBg() => Res("HoverBrush", "#232220");
    public static SolidColorBrush SelBg() => Res("SelBrush", "#2B2A26");
    public static SolidColorBrush TagBg() => Res("TagBgBrush", "#2E2D2A");
    public static SolidColorBrush Ok() => Res("OkBrush", "#63A855");
    public static SolidColorBrush Bad() => Res("BadBrush", "#D1685A");

    /// <summary>把窗口调到指定客户区尺寸（按 DPI 换算）。</summary>
    public static void ResizeClient(Window window, double width, double height)
    {
        try
        {
            var hwnd = Win32Interop.GetWindowFromWindowId(window.AppWindow.Id);
            var dpi = GetDpiForWindow(hwnd);
            double scale = dpi <= 0 ? 1.0 : dpi / 96.0;

            // 别超过工作区，否则一开就顶到屏幕边缘外
            var area = DisplayArea.GetFromWindowId(window.AppWindow.Id, DisplayAreaFallback.Primary);
            double maxW = area.WorkArea.Width / scale - 80;
            double maxH = area.WorkArea.Height / scale - 80;
            double w = width <= 0 ? 1000 : Math.Min(width, maxW);
            double h = height <= 0 ? 720 : Math.Min(height, maxH);
            w = Math.Max(w, 720);
            h = Math.Max(h, 520);

            window.AppWindow.Resize(new Windows.Graphics.SizeInt32(
                (int)(w * scale), (int)(h * scale)));
        }
        catch { /* 尺寸失败不影响使用 */ }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(System.IntPtr hwnd);

    /// <summary>标题栏跟随暗色，避免白底黑字压暗界面。</summary>
    public static void ApplyTitleBar(Window window, bool dark)
    {
        try
        {
            if (!AppWindowTitleBar.IsCustomizationSupported()) return;
            var tb = window.AppWindow.TitleBar;
            tb.ExtendsContentIntoTitleBar = false;

            var bg = dark ? Windows.UI.Color.FromArgb(255, 0x1C, 0x1C, 0x1A)
                          : Windows.UI.Color.FromArgb(255, 0xFF, 0xFF, 0xFF);
            var fg = dark ? Windows.UI.Color.FromArgb(255, 0xE9, 0xE7, 0xE3)
                          : Windows.UI.Color.FromArgb(255, 0x1C, 0x1B, 0x19);

            tb.BackgroundColor = bg;
            tb.ForegroundColor = fg;
            tb.ButtonBackgroundColor = bg;
            tb.ButtonForegroundColor = fg;
            tb.ButtonHoverBackgroundColor =
                dark ? Windows.UI.Color.FromArgb(255, 0x2B, 0x2A, 0x26)
                     : Windows.UI.Color.FromArgb(255, 0xF0, 0xEE, 0xE9);
            tb.ButtonHoverForegroundColor = fg;
            tb.ButtonPressedBackgroundColor =
                dark ? Windows.UI.Color.FromArgb(255, 0x33, 0x32, 0x2D)
                     : Windows.UI.Color.FromArgb(255, 0xE7, 0xE6, 0xE3);
            tb.ButtonPressedForegroundColor = fg;
        }
        catch { /* 老系统忽略 */ }
    }
}
