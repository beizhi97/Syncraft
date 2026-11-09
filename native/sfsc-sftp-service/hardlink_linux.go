//go:build linux

package main

import (
	"errors"
	"os"
	"syscall"
)

func requireSingleLink(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("file link count is unavailable")
	}
	if stat.Nlink != 1 {
		return errors.New("files with multiple hard links are not supported")
	}
	return nil
}
