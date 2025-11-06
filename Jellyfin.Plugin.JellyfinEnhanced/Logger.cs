using System;
using System.IO;
using System.Linq;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced
{
    public class Logger
    {
        private readonly IApplicationPaths _appPaths;
        private readonly Microsoft.Extensions.Logging.ILogger _jfLogger;
        private static readonly object _writeLock = new object();
        private const int LogRetentionDays = 3; // How many days of logs to keep
        private const string LogFilePrefix = "JellyfinEnhanced_";

        public Logger(IApplicationPaths appPaths, ILoggerFactory loggerFactory)
        {
            _appPaths = appPaths;
            // Category chosen so lines are discoverable in Jellyfin's main log
            _jfLogger = loggerFactory.CreateLogger("Jellyfin.Plugin.JellyfinEnhanced");
            RotateLogs(); // Clean up old logs on startup
        }

        public string CurrentLogFilePath => Path.Combine(_appPaths.LogDirectoryPath, $"{LogFilePrefix}{DateTime.Now:yyyy-MM-dd}.log");

        public void Info(string msg)
        {
            Log(msg, "INFO");
        }

        public void Debug(string msg)
        {
            Log(msg, "DEBUG");
        }

        public void Error(string msg)
        {
            Log(msg, "ERROR");
        }

        public void Warning(string msg)
        {
            Log(msg, "WARN");
        }

        private void Log(string msg, string level)
        {
            try
            {
                var logFileName = $"{LogFilePrefix}{DateTime.Now:yyyy-MM-dd}.log";
                var logFilePath = Path.Combine(_appPaths.LogDirectoryPath, logFileName);
                var logMessage = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{level}] {msg}{Environment.NewLine}";

                // Write to dedicated plugin log file
                lock (_writeLock)
                {
                    File.AppendAllText(logFilePath, logMessage);
                }

                // Also forward to Jellyfin's main logger for visibility
                switch (level)
                {
                    case "DEBUG":
                        _jfLogger.LogDebug("{Message}", msg);
                        break;
                    case "ERROR":
                        _jfLogger.LogError("{Message}", msg);
                        break;
                    case "WARN":
                        _jfLogger.LogWarning("{Message}", msg);
                        break;
                    default:
                        _jfLogger.LogInformation("{Message}", msg);
                        break;
                }
            }
            catch (Exception ex)
            {
                // Fallback to console if file logging fails
                Console.WriteLine($"Failed to write to JellyfinEnhanced log file: {ex.Message}");
            }
        }

        private void RotateLogs()
        {
            try
            {
                var logDirectory = _appPaths.LogDirectoryPath;
                var cutoffDate = DateTime.Now.AddDays(-LogRetentionDays);

                var oldLogFiles = Directory.GetFiles(logDirectory, $"{LogFilePrefix}*.log")
                    .Select(f => new FileInfo(f))
                    .Where(f => f.CreationTime < cutoffDate);

                foreach (var file in oldLogFiles)
                {
                    file.Delete();
                    Console.WriteLine($"Deleted old log file: {file.Name}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error during log rotation: {ex.Message}");
            }
        }
    }
}