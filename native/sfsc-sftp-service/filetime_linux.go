//go:build linux

package main

import (
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func setFileTimes(file *os.File, atime, mtime time.Time) error {
	times := []unix.Timeval{
		{Sec: atime.Unix(), Usec: int64(atime.Nanosecond() / 1000)},
		{Sec: mtime.Unix(), Usec: int64(mtime.Nanosecond() / 1000)},
	}
	return unix.Futimes(int(file.Fd()), times)
}

func setDirectoryTimes(_ *os.Root, _ string, file *os.File, atime, mtime time.Time) error {
	return setFileTimes(file, atime, mtime)
}

func setFileMode(_ *os.Root, _ string, file *os.File, mode os.FileMode, _ bool) error {
	return file.Chmod(mode)
}

func nonblockingFlag() int { return unix.O_NONBLOCK }
