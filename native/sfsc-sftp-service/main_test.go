package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type testServer struct {
	client *ssh.Client
	sftp   *sftp.Client
	root   string
	user   string
	signer ssh.Signer
}

func startTestServer(t *testing.T) *testServer {
	t.Helper()
	root := t.TempDir()
	materialDir := t.TempDir()
	hostSigner, hostPrivate := testSigner(t)
	clientSigner, _ := testSigner(t)
	hostPEM, err := ssh.MarshalPrivateKey(hostPrivate, "test-host")
	if err != nil {
		t.Fatal(err)
	}
	hostPath := filepath.Join(materialDir, "host-key")
	if err := os.WriteFile(hostPath, pem.EncodeToMemory(hostPEM), 0600); err != nil {
		t.Fatal(err)
	}
	pubPath := filepath.Join(materialDir, "authorized_keys")
	if err := os.WriteFile(pubPath, ssh.MarshalAuthorizedKey(clientSigner.PublicKey()), 0600); err != nil {
		t.Fatal(err)
	}
	service, err := newService(options{root: root, addr: "127.0.0.1:0", authorizedKeys: pubPath, hostKey: hostPath, user: "sync-user"})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- service.serve(listener) }()
	config := &ssh.ClientConfig{
		User:            "sync-user",
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(clientSigner)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         3 * time.Second,
	}
	client, err := ssh.Dial("tcp", listener.Addr().String(), config)
	if err != nil {
		_ = listener.Close()
		_ = service.root.Close()
		t.Fatal(err)
	}
	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		_ = client.Close()
		_ = listener.Close()
		_ = service.root.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = sftpClient.Close()
		_ = client.Close()
		_ = listener.Close()
		<-serveDone
		_ = service.root.Close()
	})
	_ = hostSigner // keeps signer generation explicit in this test setup
	return &testServer{client: client, sftp: sftpClient, root: root, user: "sync-user", signer: clientSigner}
}

func testSigner(t *testing.T) (ssh.Signer, ed25519.PrivateKey) {
	t.Helper()
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	_ = pub
	return signer, private
}

func TestSSHAuthAndRequestPolicy(t *testing.T) {
	srv := startTestServer(t)
	address := srv.client.RemoteAddr().String()
	wrongUser := &ssh.ClientConfig{User: "other", Auth: []ssh.AuthMethod{ssh.PublicKeys(srv.signer)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 2 * time.Second}
	if client, err := ssh.Dial("tcp", address, wrongUser); err == nil {
		_ = client.Close()
		t.Fatal("wrong username authenticated")
	}
	wrongSigner, _ := testSigner(t)
	wrongKey := &ssh.ClientConfig{User: srv.user, Auth: []ssh.AuthMethod{ssh.PublicKeys(wrongSigner)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 2 * time.Second}
	if client, err := ssh.Dial("tcp", address, wrongKey); err == nil {
		_ = client.Close()
		t.Fatal("unlisted key authenticated")
	}

	session, err := srv.client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Shell(); err == nil {
		t.Fatal("shell request was accepted")
	}
	_ = session.Close()
	session, err = srv.client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := session.RequestPty("xterm", 24, 80, ssh.TerminalModes{}); err == nil {
		t.Fatal("pty request was accepted")
	}
	_ = session.Close()

	if forwarded, err := srv.client.Dial("tcp", "127.0.0.1:9"); err == nil {
		_ = forwarded.Close()
		t.Fatal("direct-tcpip forwarding was accepted")
	}
	if listener, err := srv.client.Listen("tcp", "127.0.0.1:0"); err == nil {
		_ = listener.Close()
		t.Fatal("remote TCP forwarding was accepted")
	}
	if err := requireLoopbackAddr("0.0.0.0:0"); err == nil {
		t.Fatal("non-loopback bind address was accepted")
	}
}

func TestSFTPRoundTripMtimeRenameAndHashCompatibility(t *testing.T) {
	srv := startTestServer(t)
	name := "ordinary file.txt"
	body := []byte("normal SFTP DATA through EOF\n")
	remote, err := srv.sftp.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remote.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := remote.Close(); err != nil {
		t.Fatal(err)
	}
	remote, err = srv.sftp.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	readback, err := io.ReadAll(remote)
	_ = remote.Close()
	if err != nil {
		t.Fatalf("SFTP read through normal EOF: %v", err)
	}
	if !bytes.Equal(readback, body) {
		t.Fatalf("readback = %q, want %q", readback, body)
	}

	mtime := time.Date(2024, 6, 7, 8, 9, 10, 0, time.UTC)
	if err := srv.sftp.Chtimes(name, mtime, mtime); err != nil {
		t.Fatalf("set mtime: %v", err)
	}
	localInfo, err := os.Stat(filepath.Join(srv.root, name))
	if err != nil {
		t.Fatal(err)
	}
	if delta := localInfo.ModTime().Sub(mtime); delta < -time.Second || delta > time.Second {
		t.Fatalf("mtime = %s, want near %s", localInfo.ModTime(), mtime)
	}
	if err := srv.sftp.Truncate(name, 7); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if err := srv.sftp.Rename(name, "renamed.txt"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := srv.sftp.Stat("renamed.txt"); err != nil {
		t.Fatalf("stat after rename: %v", err)
	}
	if err := srv.sftp.Mkdir("subdir"); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dirMtime := time.Date(2023, 2, 3, 4, 5, 6, 0, time.UTC)
	if err := srv.sftp.Chtimes("subdir", dirMtime, dirMtime); err != nil {
		t.Fatalf("set directory mtime: %v", err)
	}
	localDirInfo, err := os.Stat(filepath.Join(srv.root, "subdir"))
	if err != nil {
		t.Fatal(err)
	}
	if delta := localDirInfo.ModTime().Sub(dirMtime); delta < -time.Second || delta > time.Second {
		t.Fatalf("directory mtime = %s, want near %s", localDirInfo.ModTime(), dirMtime)
	}
	entries, err := srv.sftp.ReadDir(".")
	if err != nil {
		t.Fatalf("list root: %v", err)
	}
	if len(entries) < 2 {
		t.Fatalf("list root returned %d entries", len(entries))
	}

	oddName := "space and 'quote' ;$(id)"
	if runtime.GOOS != "windows" {
		oddName += ` and \ slash`
	}
	oddBody := []byte("hash this content")
	oddFile, err := srv.sftp.Create(oddName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := oddFile.Write(oddBody); err != nil {
		t.Fatal(err)
	}
	_ = oddFile.Close()
	for _, testCase := range []struct {
		command string
		empty   string
		hash    func([]byte) []byte
	}{
		{"md5sum", "d41d8cd98f00b204e9800998ecf8427e", func(b []byte) []byte { h := md5.Sum(b); return h[:] }},
		{"sha1sum", "da39a3ee5e6b4b0d3255bfef95601890afd80709", func(b []byte) []byte { h := sha1.Sum(b); return h[:] }},
		{"sha256sum", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", func(b []byte) []byte { h := sha256.Sum256(b); return h[:] }},
	} {
		emptySession, err := srv.client.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		emptyOut, err := emptySession.Output(testCase.command)
		_ = emptySession.Close()
		if err != nil || string(emptyOut) != testCase.empty+"  -\n" {
			t.Fatalf("empty %s output = (%q, %v)", testCase.command, emptyOut, err)
		}
		hashSession, err := srv.client.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		hashOut, err := hashSession.Output(testCase.command + " " + quoteUnixArg(oddName))
		_ = hashSession.Close()
		if err != nil {
			t.Fatalf("%s on SFTP transport did not complete: %v", testCase.command, err)
		}
		wantHash := hex.EncodeToString(testCase.hash(oddBody))
		if !strings.HasPrefix(string(hashOut), wantHash+"  ") {
			t.Fatalf("%s output = %q, want prefix %q", testCase.command, hashOut, wantHash+"  ")
		}
	}

	badSession, err := srv.client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	badOut, err := badSession.CombinedOutput("id")
	_ = badSession.Close()
	if err == nil || !strings.Contains(string(badOut), `"id" not implemented`) {
		t.Fatalf("unsupported exec result = (%q, %v), want application-level rejection", badOut, err)
	}
}

func TestSFTPRejectsLinkCreation(t *testing.T) {
	srv := startTestServer(t)
	if err := srv.sftp.Symlink("target", "link"); err == nil {
		t.Fatal("symlink creation was accepted")
	}
	if err := srv.sftp.Link("source", "hardlink"); err == nil {
		t.Fatal("hardlink creation was accepted")
	}
}

func TestSFTPRejectsRootExternalSymlinkAccess(t *testing.T) {
	srv := startTestServer(t)
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("outside secret"), 0600); err != nil {
		t.Fatal(err)
	}
	linkPath := filepath.Join(srv.root, "escape")
	if err := os.Symlink(outside, linkPath); err != nil {
		t.Skipf("host does not permit test symlink creation: %v", err)
	}
	if _, err := srv.sftp.Open("escape/secret.txt"); err == nil {
		t.Fatal("read through external symlink succeeded")
	}
	if file, err := srv.sftp.Create("escape/new.txt"); err == nil {
		_ = file.Close()
		t.Fatal("write through external symlink succeeded")
	}
	if _, err := srv.sftp.Stat("escape/secret.txt"); err == nil {
		t.Fatal("stat through external symlink succeeded")
	}
	if err := srv.sftp.Rename("escape/secret.txt", "moved.txt"); err == nil {
		t.Fatal("rename through external symlink succeeded")
	}
	source, err := srv.sftp.Create("rename-source.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(source, "move me"); err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	if err := srv.sftp.Rename("rename-source.txt", "escape/replaced.txt"); err == nil {
		t.Fatal("rename into external symlink succeeded")
	}
	if _, err := srv.sftp.Stat("rename-source.txt"); err != nil {
		t.Fatalf("failed external rename changed the source: %v", err)
	}
	hashSession, err := srv.client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	hashOut, err := hashSession.CombinedOutput(`sha1sum escape/secret.txt`)
	_ = hashSession.Close()
	if err == nil {
		t.Fatalf("hash through external symlink succeeded: %q", hashOut)
	}
	if got, err := os.ReadFile(secret); err != nil || string(got) != "outside secret" {
		t.Fatalf("outside file changed: %q, %v", got, err)
	}
}

func TestSFTPRejectsDirectExternalFileSymlinkWithoutChangingCanary(t *testing.T) {
	srv := startTestServer(t)
	outside := t.TempDir()
	canary := filepath.Join(outside, "secret.txt")
	body := []byte("direct symlink canary")
	if err := os.WriteFile(canary, body, 0600); err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(canary)
	if err != nil {
		t.Fatal(err)
	}
	beforeHash := sha1.Sum(body)
	link := filepath.Join(srv.root, "external-link")
	if err := os.Symlink(canary, link); err != nil {
		t.Skipf("host does not permit test symlink creation: %v", err)
	}
	if _, err := srv.sftp.Open("external-link"); err == nil {
		t.Fatal("read through direct external symlink succeeded")
	}
	if file, err := srv.sftp.OpenFile("external-link", os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err == nil {
		_ = file.Close()
		t.Fatal("open-truncate through direct external symlink succeeded")
	}
	session, err := srv.client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	_, err = session.CombinedOutput("sha1sum external-link")
	_ = session.Close()
	if err == nil {
		t.Fatal("hash through direct external symlink succeeded")
	}
	got, err := os.ReadFile(canary)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("external symlink canary changed: %q, %v", got, err)
	}
	afterHash := sha1.Sum(got)
	afterInfo, err := os.Stat(canary)
	if err != nil || !os.SameFile(beforeInfo, afterInfo) || afterInfo.Size() != beforeInfo.Size() || afterHash != beforeHash {
		t.Fatalf("external symlink canary identity/size/hash changed: info=%v err=%v hash=%x", afterInfo, err, afterHash)
	}
}

func TestSFTPRejectsExternalHardlinkReadWriteHashAndSetstat(t *testing.T) {
	srv := startTestServer(t)
	outside := t.TempDir()
	canary := filepath.Join(outside, "marker")
	body := []byte("outside hardlink canary")
	if err := os.WriteFile(canary, body, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(srv.root, "marker")
	if err := os.Link(canary, link); err != nil {
		t.Skipf("host does not permit test hardlink creation: %v", err)
	}
	beforeInfo, err := os.Stat(canary)
	if err != nil {
		t.Fatal(err)
	}
	beforeHash := sha1.Sum(body)
	if file, err := srv.sftp.Open("marker"); err == nil {
		_ = file.Close()
		t.Fatal("read of externally shared hardlink succeeded")
	}
	if file, err := srv.sftp.OpenFile("marker", os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err == nil {
		_ = file.Close()
		t.Fatal("open-truncate of externally shared hardlink succeeded")
	}
	if _, err := srv.sftp.Stat("marker"); err == nil {
		t.Fatal("stat of externally shared hardlink succeeded")
	}
	if err := srv.sftp.Chtimes("marker", time.Now(), time.Now()); err == nil {
		t.Fatal("mtime update on externally shared hardlink succeeded")
	}
	if err := srv.sftp.Chmod("marker", 0644); err == nil {
		t.Fatal("chmod on externally shared hardlink succeeded")
	}
	if err := srv.sftp.Truncate("marker", 0); err == nil {
		t.Fatal("truncate on externally shared hardlink succeeded")
	}
	if err := srv.sftp.Rename("marker", "moved-marker"); err == nil {
		t.Fatal("rename of externally shared hardlink succeeded")
	}
	if err := srv.sftp.Remove("marker"); err == nil {
		t.Fatal("remove of externally shared hardlink succeeded")
	}
	session, err := srv.client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	_, err = session.CombinedOutput("sha1sum marker")
	_ = session.Close()
	if err == nil {
		t.Fatal("hash of externally shared hardlink succeeded")
	}
	got, err := os.ReadFile(canary)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("external hardlink canary changed: %q, %v", got, err)
	}
	gotHash := sha1.Sum(got)
	if gotHash != beforeHash {
		t.Fatalf("external canary hash changed: %x != %x", gotHash, beforeHash)
	}
	if gotInfo, err := os.Stat(canary); err != nil || gotInfo.Size() != int64(len(body)) || !os.SameFile(beforeInfo, gotInfo) {
		t.Fatalf("external canary identity/size changed: info=%v err=%v", gotInfo, err)
	}
}

func quoteUnixArg(value string) string {
	var out strings.Builder
	for _, r := range value {
		safe := r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("_.,:/@-", r) || r >= 0x80
		if !safe {
			out.WriteRune('\\')
		}
		out.WriteRune(r)
	}
	return out.String()
}

func TestCommandLexerTreatsMetacharactersAsLiteralPath(t *testing.T) {
	argv, err := splitCommand(`sha1sum a\;$(id)\ file`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"sha1sum", "a;$(id) file"}
	if fmt.Sprint(argv) != fmt.Sprint(want) {
		t.Fatalf("argv = %#v, want %#v", argv, want)
	}
	if _, err := splitCommand(`sha1sum 'unterminated`); err == nil {
		t.Fatal("unterminated quote accepted")
	}
}
