//go:build windows

package main

import (
	"os"
	"time"

	"golang.org/x/sys/windows"
)

func setFileTimes(file *os.File, atime, mtime time.Time) error {
	access := windows.NsecToFiletime(atime.UnixNano())
	write := windows.NsecToFiletime(mtime.UnixNano())
	return windows.SetFileTime(windows.Handle(file.Fd()), nil, &access, &write)
}

func setDirectoryTimes(root *os.Root, name string, _ *os.File, atime, mtime time.Time) error {
	// Go's os.File.Open on Windows does not request FILE_WRITE_ATTRIBUTES for
	// directories, so use the rooted path operation as a platform fallback.
	return root.Chtimes(name, atime, mtime)
}

func setFileMode(root *os.Root, name string, file *os.File, mode os.FileMode, isDir bool) error {
	if isDir {
		return root.Chmod(name, mode)
	}
	return file.Chmod(mode)
}

func nonblockingFlag() int { return 0 }
