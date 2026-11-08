using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;

namespace DevChatApp;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        InitializeComponent();

        // 任何未捕获异常都写盘，否则 WinUI 直接崩掉、什么都不留。
        UnhandledException += (_, e) =>
        {
            LogCrash("UnhandledException", e.Exception);
            e.Handled = false;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            LogCrash("AppDomain", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            LogCrash("Task", e.Exception);
            e.SetObserved();
        };
    }

    private static void LogCrash(string where, Exception? ex)
    {
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DevChat");
            Directory.CreateDirectory(dir);
            var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {where}\n{ex}\n\n";
            File.AppendAllText(Path.Combine(dir, "crash.log"), line);
        }
        catch { /* 记日志本身不能抛 */ }
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            _window = new MainWindow();
            _window.Activate();
        }
        catch (Exception ex)
        {
            LogCrash("OnLaunched", ex);
            throw;
        }
    }
}
