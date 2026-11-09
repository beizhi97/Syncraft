# sfsc-sftp-service (R75 isolated slice)

This is a standalone, small Go SSH/SFTP daemon prototype. It is not installed as, advertised as, or substituted for rclone. The module is isolated under `native/sfsc-sftp-service` so the existing native build path that uses `GO111MODULE=off` is unchanged.

## Run

Build into the project-local temporary directory:

```powershell
node scripts/build-sftp-service.mjs --goos linux --goarch arm64
```

The daemon requires the five explicit flags below and rejects non-loopback bind IPs:

```text
sfsc-sftp-service --root <directory> --addr <loopback-ip:port> --authorized-keys <file> --key <SSH-host-private-key> --user <exact-username>
```

It accepts only SSH public-key authentication for the exact username and keys in the authorized-keys file. Authorized-key options are rejected. It accepts `session` channels with the `sftp` subsystem and the limited hash `exec` commands; shell, PTY, direct TCP channels, remote forwarding, other global requests, and other subsystems are rejected. A hash command is parsed as arguments without invoking a shell. Only `md5sum`, `sha1sum`, and `sha256sum` are implemented; a no-argument command returns the corresponding empty-file digest, matching rclone's SFTP hash probe. Hash input is streamed.

Filesystem access is rooted in one `os.Root`. The daemon permits regular files and directories, denies symlink and hardlink creation, chown, non-regular file opens, and files with more than one hard link. File chmod/truncate/time updates use an opened file descriptor; directory chmod/time uses the opened directory where supported, with a rooted-path fallback on Windows because Go's Windows directory handle does not request write-attributes access. Root operations perform listing, stat, rename, remove, and mkdir. Paths with LF or CR fail closed. The minimal command parser handles the Unix SFTP backend's backslash escaping and single/double quotes so spaces, quote characters, and POSIX backslashes are one literal filename argument on POSIX; Windows backslashes remain path separators and are rejected. It does not evaluate shell syntax.

## Tests

Run in this module:

```powershell
go test ./...
```

Tests run the daemon's SSH and SFTP handlers on an in-process loopback listener; they do not start child processes. They exercise public-key and username rejection, normal read through EOF/write/list/stat/mtime/truncate/rename, empty and file hash commands on the same SSH transport as SFTP, unsupported exec, shell/PTY/forward rejection, root-external symlink escapes, external hardlink protection, and Linux FIFO rejection. The symlink/hardlink tests skip only if the local OS refuses creation. The Linux FIFO regression is Linux-only.

## Dependency provenance

Direct dependencies are pinned in `go.mod` and checksummed in `go.sum`:

- `github.com/pkg/sftp v1.13.12` — tag [`v1.13.12`](https://github.com/pkg/sftp/tree/v1.13.12); `go.sum` module checksum `h1:Myhzy/ZzLPnCtE2F2WtDHsgs8RfgMnH2gfbHuCJhkMU=`.
- `golang.org/x/crypto v0.58.0` — tag [`v0.58.0`](https://go.googlesource.com/crypto/+/refs/tags/v0.58.0); `go.sum` module checksum `h1:COkYLr4k7nDI4r6QtMML2AfzeIswWHAJthLS6K/M/54=`.
- `golang.org/x/sys v0.49.0` — module also imported by this module's OS-specific fd helpers; tag [`v0.49.0`](https://go.googlesource.com/sys/+/refs/tags/v0.49.0); `go.sum` module checksum `h1:XbzkgYJHdqh/8m2Uu0W/dQv8nktxx4BFHp1M0gROTXA=`.

The selected module directives require Go 1.26.0. The version pins above were resolved from the Go module proxy; `go.sum` provides the integrity values used by Go's module verifier.

## Boundary limits

`os.Root` prevents path traversal and symlinks escaping the selected root, but it does not contain bind mounts, `/proc`, device files, or external hardlinks that already exist under the root. This slice rejects special files and regular files whose link count is not exactly one, which protects tested external-hardlink cases; it does not prevent a privileged actor from changing mounts or hardlinks concurrently. Keep the service root on a dedicated, controlled filesystem and do not expose it to untrusted local writers. These limits are not claims of a complete filesystem sandbox.
