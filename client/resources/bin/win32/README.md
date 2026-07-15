# Bundled Windows Binaries

The packaged Windows client expects these files here:

```text
sing-box.exe
rclone.exe
binaries.lock.json
```

Use:

```powershell
.\client\scripts\download-binaries.ps1
```

By default the script uses `binaries.lock.json` and verifies SHA256 before skipping an existing binary. To intentionally upgrade a component, update the lock file and run with `-Force`; ad-hoc version overrides are available through `-SingBoxVersion` and `-RcloneVersion`, but those builds are not reproducible unless the lock file is updated afterwards.

The app never calls system-installed `sing-box` or `rclone`.
