//go:build linux && (amd64 || arm64)

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"syscall"
	"testing"
)

func TestServiceV2ArgvIsExactAndUsernameIsValidated(t *testing.T) {
	listener := execServiceListenerInput{Host: "127.0.0.1", Port: 41001}
	good := []string{"sfsc-sftp-service", "--root", "/srv/root", "--addr", "127.0.0.1:41001", "--authorized-keys", "/etc/sfsc/authorized_keys", "--key", "/etc/sfsc/host.key", "--user", "sfsc"}
	if !validServiceV2Argv(good, listener) {
		t.Fatal("valid V2 argv rejected")
	}
	tests := [][]string{
		append(append([]string(nil), good...), "--extra"),
		append(append([]string(nil), good[:10]...), "bad user"),
		func() []string { v := append([]string(nil), good...); v[0] = "rclone"; return v }(),
		func() []string { v := append([]string(nil), good...); v[4] = "0.0.0.0:41001"; return v }(),
		func() []string { v := append([]string(nil), good...); v[2] = "/srv/root/../outside"; return v }(),
	}
	for i, argv := range tests {
		if validServiceV2Argv(argv, listener) {
			t.Errorf("case %d accepted", i)
		}
	}
}

func TestServiceV2UsernameGrammar(t *testing.T) {
	for _, v := range []string{"sfsc", "sync_user", "a-1", "a.b"} {
		if !validServiceV2Username(v) {
			t.Errorf("valid username %q rejected", v)
		}
	}
	for _, v := range []string{"", "_a", "-a", "a/b", "UPPER", "a b", "a\n"} {
		if validServiceV2Username(v) {
			t.Errorf("invalid username %q accepted", v)
		}
	}
}

func TestServiceV2RequestDecoderRejectsVersionExtraAndDuplicateFields(t *testing.T) {
	marker := []byte("sftp-service candidate")
	digest := sha256.Sum256(marker)
	valid := serviceV2Request{Version: 2, Operation: "launch", Token: fixtureSuccessToken, Parent: execServiceParentInput{PID: "123", StartTime: "456"}, Service: execServiceRcloneInput{Dev: "8", Ino: "99", Size: strconv.Itoa(len(marker)), SHA256: hex.EncodeToString(digest[:])}, Listener: execServiceListenerInput{Host: "127.0.0.1", Port: 41001}, Argv: []string{"sfsc-sftp-service", "--root", "/srv/root", "--addr", "127.0.0.1:41001", "--authorized-keys", "/etc/sfsc/authorized_keys", "--key", "/etc/sfsc/host.key", "--user", "sfsc"}}
	data, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, guardErr := decodeServiceV2Request(data); guardErr != nil {
		t.Fatalf("valid V2 request rejected: %s", guardErr)
	}
	badVersion := append([]byte(nil), data...)
	badVersion = replaceExecServiceJSONField(t, badVersion, "version", []byte("1"))
	withExtra := append([]byte(nil), data...)
	withExtra = replaceExecServiceJSONField(t, withExtra, "extra", []byte(`true`))
	duplicate := append(append([]byte(nil), data[:len(data)-1]...), []byte(`,"version":2}`)...)
	for name, frame := range map[string][]byte{"wrong-version": badVersion, "extra-field": withExtra, "duplicate-field": duplicate} {
		if _, _, _, guardErr := decodeServiceV2Request(frame); guardErr == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestServiceV2GoRejectsWrongVersionAndToken(t *testing.T) {
	good := []byte(`{"version":2,"operation":"go","token":"` + fixtureSuccessToken + `"}`)
	if err := decodeServiceV2Go(good, fixtureSuccessToken); err != nil {
		t.Fatalf("valid V2 go rejected: %s", err)
	}
	for _, frame := range [][]byte{[]byte(`{"version":1,"operation":"go","token":"` + fixtureSuccessToken + `"}`), []byte(`{"version":2,"operation":"go","token":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`), []byte(`{"version":2,"operation":"go","token":"` + fixtureSuccessToken + `","extra":true}`)} {
		if err := decodeServiceV2Go(frame, fixtureSuccessToken); err == nil {
			t.Errorf("invalid V2 go accepted: %s", frame)
		}
	}
}

func TestServiceV2FDValidationBindsIdentityAndDigest(t *testing.T) {
	path := createExecutableFixture(t, []byte("service-binary"))
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	expected := readExecServiceRcloneInputFile(path)
	parsed, ok := parseExecServiceRclone(expected)
	if !ok {
		t.Fatal("fixture identity invalid")
	}
	hooks := linuxExecServiceHooks()
	if _, guardErr := verifyExecServiceRclone(int(file.Fd()), parsed, hooks); guardErr != nil {
		t.Fatalf("correct FD rejected: %s", guardErr)
	}
	wrongInode := parsed
	wrongInode.ino++
	if _, guardErr := verifyExecServiceRclone(int(file.Fd()), wrongInode, hooks); guardErr == nil {
		t.Fatal("wrong FD identity accepted")
	}
	wrongDigest := parsed
	wrongDigest.sha256[0] ^= 0xff
	if _, guardErr := verifyExecServiceRclone(int(file.Fd()), wrongDigest, hooks); guardErr == nil {
		t.Fatal("wrong FD digest accepted")
	}
}

func TestServiceV2PostGoRevalidationFailureStopsBeforeExecPayload(t *testing.T) {
	hooks := linuxExecServiceHooks()
	hooks.capget = func(*execServiceCapHeader, *[2]execServiceCapData) error { return syscall.EPERM }
	if guardErr := validateServiceV2AfterGo(execServiceParsedParent{pid: 1, startTime: 1}, execServiceParsedRclone{}, 0, hooks); guardErr == nil {
		t.Fatal("post-go security revalidation failure accepted")
	}
}

func TestServiceV2PreExecFailureKeepsV2FrameIdentity(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	hooks := linuxExecServiceHooks()
	hooks.fcntl = func(int, int, int) (int, error) { return -1, syscall.EPERM }
	if code := executeExecServicePayload(writer, &execvePayload{}, hooks, execServiceV2FailureFrames()); code != 2 {
		t.Fatalf("exit code=%d", code)
	}
	_ = writer.Close()
	frame, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	var response serviceV2Failure
	if err := json.Unmarshal(bytes.TrimSpace(frame), &response); err != nil {
		t.Fatalf("invalid failure frame %q: %v", frame, err)
	}
	if response.Version != 2 || response.Operation != execServiceV2Mode || response.OK || response.Error.Code != execCodeControlFDFailed {
		t.Fatalf("wrong V2 failure identity: %#v", response)
	}
}
