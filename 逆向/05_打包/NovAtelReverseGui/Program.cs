namespace NasGui;

static class Program
{
    [STAThread]
    static void Main()
    {
        // One window per desktop session: a second launch would start a second Node server and a
        // second WebView2 profile against the same %LOCALAPPDATA% tree.
        using var mutex = new Mutex(initiallyOwned: true, @"Local\AllPoweredFSA.SingleInstance",
                                   out var isFirst);
        if (!isFirst) return;

        // DPI awareness comes from <ApplicationHighDpiMode>PerMonitorV2</ApplicationHighDpiMode>
        // in NasGui.csproj; ApplicationConfiguration.Initialize applies it.
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
