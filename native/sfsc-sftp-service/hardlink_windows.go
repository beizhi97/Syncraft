//go:build windows

package main

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func requireSingleLink(file *os.File) error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return err
	}
	if info.NumberOfLinks != 1 {
		return errors.New("files with multiple hard links are not supported")
	}
	return nil
}
