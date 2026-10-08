# Poster test harnesses

```sh
python3 tests/run.py poster
```

- `rendering/`: native asset decoding, text shaping and renderer diagnostics against supported Skia lines.
- `pipeline/`: native image-tag, token, client-policy and cache contracts.
- `parity/`: actual JavaScript/C# resolver comparison with deterministic offline profiles. Generated inputs/results stay in its ignored `data/` directory.

These are test-only projects outside the plugin's production directory. Routine backend poster tests live in `../backend/PosterTags/`. Keep captured images and reports in root `artifacts/`; do not embed test fixtures into the plugin. See [suite setup](../docs/README.md) for runtime and ICU requirements and [parity details](parity/README.md) for focused commands.
