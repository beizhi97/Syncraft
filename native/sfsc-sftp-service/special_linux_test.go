//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestSFTPRejectsSpecialFiles(t *testing.T) {
	srv := startTestServer(t)
	fifo := filepath.Join(srv.root, "pipe")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.sftp.Open("pipe"); err == nil {
		t.Fatal("opening FIFO was accepted")
	}
	if _, err := srv.sftp.Stat("pipe"); err == nil {
		t.Fatal("stat of FIFO was accepted")
	}
	entries, err := srv.sftp.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() == "pipe" {
			t.Fatal("FIFO appeared in supported directory listing")
		}
	}
	if err := srv.sftp.Remove("pipe"); err == nil {
		t.Fatal("removal of FIFO was accepted")
	}
	if info, err := os.Lstat(fifo); err != nil || info.Mode()&os.ModeNamedPipe == 0 {
		t.Fatalf("FIFO changed: info=%v err=%v", info, err)
	}
}
