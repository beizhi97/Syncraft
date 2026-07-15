using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace SyncraftClient
{
    internal static class Launcher
    {
        [STAThread]
        private static int Main()
        {
            bool ownsMutex = false;
            Mutex mutex = null;
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string nodeExe = Path.Combine(root, "runtime", "node.exe");
            string appEntry = Path.Combine(root, "app", "client", "src", "clientServer.js");
            string port = Environment.GetEnvironmentVariable("SFSC_CLIENT_PORT");
            if (String.IsNullOrWhiteSpace(port))
            {
                port = "5188";
            }
            string url = "http://127.0.0.1:" + port + "/";
            bool openBrowser = Environment.GetEnvironmentVariable("SFSC_OPEN_BROWSER") != "0"
                && Environment.GetEnvironmentVariable("SFSC_PACKAGE_SMOKE") != "1";

            if (!File.Exists(nodeExe))
            {
                MessageBox.Show("找不到内置 Node 运行时:\n" + nodeExe, "Syncraft", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            if (!File.Exists(appEntry))
            {
                MessageBox.Show("找不到客户端入口:\n" + appEntry, "Syncraft", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            try
            {
                mutex = new Mutex(true, "Global\\SyncraftClient-" + port, out ownsMutex);
                if (!ownsMutex)
                {
                    WaitForClient(url, 8000);
                    if (openBrowser)
                    {
                        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                    }
                    return 0;
                }

                if (!IsClientReady(url))
                {
                    StartClient(nodeExe, appEntry, root, port);
                    WaitForClient(url, 12000);
                }

                if (openBrowser)
                {
                    Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                }
                return 0;
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "Syncraft", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally
            {
                if (ownsMutex && mutex != null)
                {
                    mutex.ReleaseMutex();
                }
                if (mutex != null)
                {
                    mutex.Dispose();
                }
            }
        }

        private static void StartClient(string nodeExe, string appEntry, string root, string port)
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = nodeExe;
            start.Arguments = Quote(appEntry);
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.EnvironmentVariables["SFSC_PORTABLE_ROOT"] = root;
            start.EnvironmentVariables["SFSC_CLIENT_PORT"] = port;
            start.EnvironmentVariables["SFSC_OPEN_BROWSER"] = "0";
            if (Environment.GetEnvironmentVariable("SFSC_PACKAGE_SMOKE") == "1")
            {
                start.EnvironmentVariables["SFSC_PACKAGE_SMOKE"] = "1";
            }
            string dataRoot = Environment.GetEnvironmentVariable("SFSC_CLIENT_DATA_ROOT");
            if (!String.IsNullOrWhiteSpace(dataRoot))
            {
                start.EnvironmentVariables["SFSC_CLIENT_DATA_ROOT"] = dataRoot;
            }
            string legacyDataRoot = Environment.GetEnvironmentVariable("SFSC_DATA_ROOT");
            if (!String.IsNullOrWhiteSpace(legacyDataRoot))
            {
                start.EnvironmentVariables["SFSC_DATA_ROOT"] = legacyDataRoot;
            }
            Process.Start(start);
        }

        private static void WaitForClient(string url, int timeoutMs)
        {
            Stopwatch watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < timeoutMs)
            {
                if (IsClientReady(url))
                {
                    return;
                }
                Thread.Sleep(300);
            }
            throw new TimeoutException("客户端服务启动超时:\n" + url);
        }

        private static bool IsClientReady(string url)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "api/health");
                request.Method = "GET";
                request.Timeout = 800;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK)
                    {
                        return false;
                    }
                    using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                    {
                        return IsSfscClientHealth(reader.ReadToEnd());
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool IsSfscClientHealth(string body)
        {
            return HasJsonBoolean(body, "ok", true)
                && HasJsonString(body, "mode", "client-exe-runtime")
                && HasJsonString(body, "role", "client");
        }

        private static bool HasJsonBoolean(string body, string key, bool value)
        {
            return Regex.IsMatch(body ?? "", "\\\"" + Regex.Escape(key) + "\\\"\\s*:\\s*" + (value ? "true" : "false"));
        }

        private static bool HasJsonString(string body, string key, string value)
        {
            return Regex.IsMatch(body ?? "", "\\\"" + Regex.Escape(key) + "\\\"\\s*:\\s*\\\"" + Regex.Escape(value) + "\\\"");
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
