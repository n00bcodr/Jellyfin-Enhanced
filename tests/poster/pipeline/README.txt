Native Poster Tags pipeline checks (not part of the plugin build).

  dotnet run --project tests/poster/pipeline -c Release

The default builds the production project directly. To test a separately built
plugin DLL, pass -p:PluginDir=/absolute/path/to/plugin-output.

(If the installed ASP.NET Core runtime doesn't match the installed .NET runtime,
add "-r linux-x64 --self-contained true" to the run command.)

Covers: image tag decoration parse/compose with every sb-/-jet/-jeu
permutation (and Spoiler Guard's own readers on those shapes), variant token
mint/verify/tamper (incl. the pixel version) and secret persistence, native client policy, the
per-user on/off preference (null/missing = on, false = off, master switch wins), composite
cache eviction/coalescing/limits/disk tier (passthrough memory-only and
bounded, per-file disk charge, legacy zero-length files), base image
completeness check, bounded file-settle wait (future mtimes, churn, abort).
Exit code 0 when every check passes.
