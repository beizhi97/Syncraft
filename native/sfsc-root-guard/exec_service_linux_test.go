//go:build linux && (amd64 || arm64)

package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

const (
	fixtureModeEnv       = "SFSC_EXEC_FIXTURE_MODE"
	fixtureModeLauncher  = "launcher"
	fixtureModeParent    = "parent"
	fixtureModeTarget    = "target"
	fixtureModeLauncherD = "launcher-death"
	fixtureModeTargetD   = "target-death"
	fixtureModeHookChild = "hook-child"
	requireRealEnv       = "SFSC_LAUNCHER_REQUIRE_REAL"
	hookScenarioEnv      = "SFSC_EXEC_HOOK_SCENARIO"

	fixtureSuccessToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	fixtureDeathToken   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

	hookScenarioParentGetPPID      = "parent-getppid"
	hookScenarioParentSelfPPID     = "parent-self-ppid"
	hookScenarioParentStatMissing  = "parent-stat-missing"
	hookScenarioParentStartTime    = "parent-starttime"
	hookScenarioParentAfterGo      = "parent-after-go"
	hookScenarioEnvToken           = "env-token"
	hookScenarioRcloneFstat        = "rclone-fstat"
	hookScenarioRcloneNotRegular   = "rclone-not-regular"
	hookScenarioRcloneShortRead    = "rclone-short-read"
	hookScenarioRcloneExtraRead    = "rclone-extra-read"
	hookScenarioRcloneIdentityChg  = "rclone-identity-change"
	hookScenarioRcloneAfterGo      = "rclone-after-go"
	hookScenarioRcloneXattrPresent = "rclone-xattr-present"
	hookScenarioRcloneXattrError   = "rclone-xattr-error"
	hookScenarioRcloneXattrNoData  = "rclone-xattr-enodata"
	hookScenarioRcloneXattrNotSup  = "rclone-xattr-enotsup"
	hookScenarioCapLastMissing     = "cap-last-missing"
	hookScenarioCapLastOutOfRange  = "cap-last-out-of-range"
	hookScenarioCapBoundingDrop    = "cap-bounding-drop"
	hookScenarioCapAmbientClear    = "cap-ambient-clear"
	hookScenarioCapset             = "capset"
	hookScenarioCapgetNonempty     = "capget-nonempty"
	hookScenarioCapBoundingVerify  = "cap-bounding-verify"
	hookScenarioCapAmbientVerify   = "cap-ambient-verify"
	hookScenarioNoNewPrivsSet      = "no-new-privs-set"
	hookScenarioNoNewPrivsReadback = "no-new-privs-readback"
	hookScenarioPDeathSet          = "pdeathsig-set"
	hookScenarioPDeathReadback     = "pdeathsig-readback"
	hookScenarioSecurityAfterGo    = "security-after-go"
	hookScenarioControlDup         = "control-dup"
	hookScenarioControlNonblock    = "control-nonblock"
	hookScenarioOpenDevNull        = "open-dev-null"
	hookScenarioRedirectFD0        = "redirect-fd0"
	hookScenarioRedirectFD1        = "redirect-fd1"
	hookScenarioCloseRange         = "close-range"
)

type postExecReport struct {
	PID        int               `json:"pid"`
	FDs        map[string]string `json:"fds"`
	NoNewPrivs string            `json:"noNewPrivs"`
	CapEff     string            `json:"capEff"`
	CapPrm     string            `json:"capPrm"`
	CapInh     string            `json:"capInh"`
	CapBnd     string            `json:"capBnd"`
	CapAmb     string            `json:"capAmb"`
}

type parentDeathInfo struct {
	PID       int    `json:"pid"`
	StartTime string `json:"starttime"`
}

type launcherFixturePaths struct {
	Target         string
	Helper         string
	Sentinel       string
	Root           string
	AuthorizedKeys string
	HostKey        string
	Token          string
}

func TestMain(m *testing.M) {
	switch os.Getenv(fixtureModeEnv) {
	case fixtureModeLauncher:
		os.Exit(runExecService(os.Args, os.Stdin, os.Stdout, os.Stderr))
	case fixtureModeParent:
		os.Exit(runParentDeathFixture())
	case fixtureModeHookChild:
		os.Exit(runExecServiceHookChild())
	}

	token := os.Getenv("SFSC_SERVICE_TOKEN")
	if len(os.Args) >= 3 && os.Args[1] == "serve" && os.Args[2] == "sftp" {
		switch token {
		case fixtureSuccessToken:
			os.Exit(runPostExecReport())
		case fixtureDeathToken:
			runPostExecDeath()
		}
	}
	os.Exit(m.Run())
}

func TestExecServiceDecodeRequestStrict(t *testing.T) {
	request := validExecServiceTestRequest(t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir())
	valid, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	decoded, guardErr := decodeExecServiceRequest(valid)
	if guardErr != nil {
		t.Fatalf("valid request rejected: %v", guardErr)
	}
	if decoded.Token != request.Token || len(decoded.Argv) != 15 {
		t.Fatalf("unexpected decoded request: %#v", decoded)
	}

	tests := []struct {
		name string
		data []byte
	}{
		{name: "empty", data: nil},
		{name: "not object", data: []byte(`[]`)},
		{name: "nul", data: append(append([]byte(nil), valid...), 0)},
		{name: "unknown field", data: []byte(strings.TrimSuffix(string(valid), "}") + `,"extra":true}`)},
		{name: "duplicate field", data: []byte(strings.TrimSuffix(string(valid), "}") + `,"version":1}`)},
		{name: "wrong token", data: []byte(strings.Replace(string(valid), fixtureSuccessToken, strings.ToUpper(fixtureSuccessToken), 1))},
		{name: "trailing value", data: append(append([]byte(nil), valid...), []byte(` {}`)...)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeExecServiceRequest(test.data); err == nil || err.code != execCodeRequestInvalid {
				t.Fatalf("got %v, want %s", err, execCodeRequestInvalid)
			}
		})
	}
}

func TestExecServiceArgvAllowlist(t *testing.T) {
	argv := validExecServiceTestArgv("/approved/root", "/approved/authorized_keys", "/approved/host_key", 41001)
	if !validExecServiceArgv(argv, 41001) {
		t.Fatal("valid argv rejected")
	}

	tests := []struct {
		name string
		argv []string
	}{
		{name: "short", argv: argv[:14]},
		{name: "extra positional", argv: append(append([]string(nil), argv...), "extra")},
		{name: "extra flag", argv: replaceExecServiceTestArg(argv, 14, "--exclude")},
		{name: "reordered", argv: swapExecServiceTestArgs(argv, 3, 5)},
		{name: "non loopback", argv: replaceExecServiceTestArg(argv, 4, "0.0.0.0:41001")},
		{name: "dirty root", argv: replaceExecServiceTestArg(argv, 2, ":local:/approved/../root")},
		{name: "root trailing slash", argv: replaceExecServiceTestArg(argv, 2, ":local:/approved/root/")},
		{name: "relative root", argv: replaceExecServiceTestArg(argv, 2, ":local:approved/root")},
		{name: "root slash", argv: replaceExecServiceTestArg(argv, 2, ":local:/")},
		{name: "duplicate flag", argv: replaceExecServiceTestArg(argv, 5, "--addr")},
		{name: "dirty authorized keys", argv: replaceExecServiceTestArg(argv, 6, "/approved/../authorized_keys")},
		{name: "dirty host key", argv: replaceExecServiceTestArg(argv, 8, "/approved/../host_key")},
		{name: "nul path", argv: replaceExecServiceTestArg(argv, 6, "/approved/\x00keys")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if validExecServiceArgv(test.argv, 41001) {
				t.Fatalf("invalid argv accepted: %#v", test.argv)
			}
		})
	}
}

func TestExecServiceParseProcStatUsesField22(t *testing.T) {
	data := []byte("1234 (name with ) and spaces) S 99 1 1 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 0 0\n")
	stat, err := parseExecServiceProcStat(data)
	if err != nil {
		t.Fatal(err)
	}
	if stat.PID != 1234 || stat.PPid != 99 || stat.StartTime != 987654 {
		t.Fatalf("unexpected stat: %#v", stat)
	}
}

func TestExecServiceParentCheckReadsParentProc(t *testing.T) {
	var readPaths []string
	hooks := linuxExecServiceHooks()
	hooks.getppid = func() int { return 1234 }
	hooks.readFile = func(path string) ([]byte, error) {
		readPaths = append(readPaths, path)
		switch path {
		case "/proc/self/stat":
			return []byte("1250 (launcher) S 1234 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 20 0 1 111 0 0 0\n"), nil
		case "/proc/1234/stat":
			return []byte("1234 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 20 0 1 987654 0 0 0\n"), nil
		default:
			return nil, os.ErrNotExist
		}
	}
	if _, err := checkExecServiceParent(execServiceParsedParent{pid: 1234, startTime: 987654}, hooks); err != nil {
		t.Fatal(err)
	}
	if !containsString(readPaths, "/proc/1234/stat") {
		t.Fatalf("parent starttime path not read: %#v", readPaths)
	}
}

func TestExecServiceFrameBounds(t *testing.T) {
	readerFile, writerFile, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readerFile.Close()
	defer writerFile.Close()
	go func() {
		_, _ = writerFile.Write(bytes.Repeat([]byte("x"), execRequestMaxBytes+2))
		_, _ = writerFile.Write([]byte("\n"))
		_ = writerFile.Close()
	}()
	_, frameErr := readExecServiceFrame(readerFile, bufio.NewReaderSize(readerFile, execRequestMaxBytes+2), execRequestMaxBytes, time.Second)
	if frameErr == nil || frameErr.code != execCodeRequestInvalid {
		t.Fatalf("got %v, want %s", frameErr, execCodeRequestInvalid)
	}
}

func TestExecServiceDecodeRequestValidationMatrix(t *testing.T) {
	request := validExecServiceTestRequest(t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir())
	valid := marshalExecServiceTestRequest(t, request)

	invalidUTF8 := append([]byte(nil), valid...)
	tokenOffset := bytes.Index(invalidUTF8, []byte(fixtureSuccessToken))
	if tokenOffset < 0 {
		t.Fatal("valid request token not found")
	}
	invalidUTF8[tokenOffset] = 0xff

	tests := []struct {
		name string
		data []byte
	}{
		{name: "missing version", data: deleteExecServiceJSONField(t, valid, "version")},
		{name: "missing operation", data: deleteExecServiceJSONField(t, valid, "operation")},
		{name: "missing token", data: deleteExecServiceJSONField(t, valid, "token")},
		{name: "missing parent", data: deleteExecServiceJSONField(t, valid, "parent")},
		{name: "missing rclone", data: deleteExecServiceJSONField(t, valid, "rclone")},
		{name: "missing listener", data: deleteExecServiceJSONField(t, valid, "listener")},
		{name: "missing argv", data: deleteExecServiceJSONField(t, valid, "argv")},
		{name: "wrong version type", data: replaceExecServiceJSONField(t, valid, "version", []byte(`"1"`))},
		{name: "wrong operation type", data: replaceExecServiceJSONField(t, valid, "operation", []byte(`false`))},
		{name: "wrong parent type", data: replaceExecServiceJSONField(t, valid, "parent", []byte(`[]`))},
		{name: "wrong argv type", data: replaceExecServiceJSONField(t, valid, "argv", []byte(`{}`))},
		{name: "missing parent pid", data: mutateExecServiceJSONField(t, valid, "parent", func(value map[string]json.RawMessage) {
			delete(value, "pid")
		})},
		{name: "wrong parent starttime type", data: mutateExecServiceJSONField(t, valid, "parent", func(value map[string]json.RawMessage) {
			value["starttime"] = []byte(`987654`)
		})},
		{name: "missing rclone digest", data: mutateExecServiceJSONField(t, valid, "rclone", func(value map[string]json.RawMessage) {
			delete(value, "sha256")
		})},
		{name: "wrong rclone size type", data: mutateExecServiceJSONField(t, valid, "rclone", func(value map[string]json.RawMessage) {
			value["size"] = []byte(`60000000`)
		})},
		{name: "missing listener port", data: mutateExecServiceJSONField(t, valid, "listener", func(value map[string]json.RawMessage) {
			delete(value, "port")
		})},
		{name: "wrong listener host type", data: mutateExecServiceJSONField(t, valid, "listener", func(value map[string]json.RawMessage) {
			value["host"] = []byte(`false`)
		})},
		{name: "invalid UTF-8", data: invalidUTF8},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeExecServiceRequest(test.data); err == nil || err.code != execCodeRequestInvalid {
				t.Fatalf("got %v, want %s", err, execCodeRequestInvalid)
			}
		})
	}
}

func TestExecServiceCanonicalInputMatrix(t *testing.T) {
	base := validExecServiceTestRequest(t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir())
	tests := []struct {
		name   string
		mutate func(*execServiceRequest)
	}{
		{name: "parent pid empty", mutate: func(request *execServiceRequest) { request.Parent.PID = "" }},
		{name: "parent pid zero", mutate: func(request *execServiceRequest) { request.Parent.PID = "0" }},
		{name: "parent pid leading zero", mutate: func(request *execServiceRequest) { request.Parent.PID = "01234" }},
		{name: "parent pid negative", mutate: func(request *execServiceRequest) { request.Parent.PID = "-1" }},
		{name: "parent starttime zero", mutate: func(request *execServiceRequest) { request.Parent.StartTime = "0" }},
		{name: "parent starttime leading zero", mutate: func(request *execServiceRequest) { request.Parent.StartTime = "0987654" }},
		{name: "parent starttime negative", mutate: func(request *execServiceRequest) { request.Parent.StartTime = "-1" }},
		{name: "dev empty", mutate: func(request *execServiceRequest) { request.Rclone.Dev = "" }},
		{name: "dev leading zero", mutate: func(request *execServiceRequest) { request.Rclone.Dev = "02049" }},
		{name: "ino leading zero", mutate: func(request *execServiceRequest) { request.Rclone.Ino = "0123456" }},
		{name: "size zero", mutate: func(request *execServiceRequest) { request.Rclone.Size = "0" }},
		{name: "size leading zero", mutate: func(request *execServiceRequest) { request.Rclone.Size = "060000000" }},
		{name: "size above maximum", mutate: func(request *execServiceRequest) {
			request.Rclone.Size = strconv.FormatUint(execRcloneMaxBytes+1, 10)
		}},
		{name: "digest uppercase", mutate: func(request *execServiceRequest) { request.Rclone.SHA256 = strings.Repeat("A", 64) }},
		{name: "digest short", mutate: func(request *execServiceRequest) { request.Rclone.SHA256 = strings.Repeat("a", 63) }},
		{name: "digest nonhex", mutate: func(request *execServiceRequest) { request.Rclone.SHA256 = strings.Repeat("g", 64) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := base
			test.mutate(&request)
			if _, err := decodeExecServiceRequest(marshalExecServiceTestRequest(t, request)); err == nil || err.code != execCodeRequestInvalid {
				t.Fatalf("got %v, want %s", err, execCodeRequestInvalid)
			}
		})
	}
}

func TestExecServiceDecodeGoStrict(t *testing.T) {
	valid, err := json.Marshal(execServiceGoRequest{
		Version:   protocolVersion,
		Operation: "go",
		Token:     fixtureSuccessToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, guardErr := decodeExecServiceGo(valid); guardErr != nil {
		t.Fatalf("valid go rejected: %v", guardErr)
	}

	invalidUTF8 := append([]byte(nil), valid...)
	tokenOffset := bytes.Index(invalidUTF8, []byte(fixtureSuccessToken))
	if tokenOffset < 0 {
		t.Fatal("valid go token not found")
	}
	invalidUTF8[tokenOffset] = 0xff

	tests := []struct {
		name string
		data []byte
	}{
		{name: "empty", data: nil},
		{name: "missing version", data: deleteExecServiceJSONField(t, valid, "version")},
		{name: "missing operation", data: deleteExecServiceJSONField(t, valid, "operation")},
		{name: "missing token", data: deleteExecServiceJSONField(t, valid, "token")},
		{name: "wrong version type", data: replaceExecServiceJSONField(t, valid, "version", []byte(`"1"`))},
		{name: "wrong operation", data: replaceExecServiceJSONField(t, valid, "operation", []byte(`"launch"`))},
		{name: "uppercase token", data: replaceExecServiceJSONField(t, valid, "token", []byte(`"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"`))},
		{name: "invalid UTF-8", data: invalidUTF8},
		{name: "unknown field", data: []byte(`{"version":1,"operation":"go","token":"` + fixtureSuccessToken + `","extra":true}`)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeExecServiceGo(test.data); err == nil || err.code != execCodeGoInvalid {
				t.Fatalf("got %v, want %s", err, execCodeGoInvalid)
			}
		})
	}
}

func TestExecServiceFrameReaderBoundsAndTimeouts(t *testing.T) {
	t.Run("missing newline", func(t *testing.T) {
		readerFile, writerFile, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer readerFile.Close()
		if _, err := writerFile.Write([]byte(`{}`)); err != nil {
			t.Fatal(err)
		}
		_ = writerFile.Close()
		if _, frameErr := readExecServiceFrame(readerFile, bufio.NewReader(readerFile), 64, time.Second); frameErr == nil ||
			frameErr.code != execCodeRequestInvalid {
			t.Fatalf("got %v, want %s", frameErr, execCodeRequestInvalid)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		readerFile, writerFile, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer readerFile.Close()
		defer writerFile.Close()
		if _, frameErr := readExecServiceFrame(readerFile, bufio.NewReader(readerFile), 64, 25*time.Millisecond); frameErr == nil ||
			frameErr.code != execCodeRequestTimeout {
			t.Fatalf("got %v, want %s", frameErr, execCodeRequestTimeout)
		}
	})

	t.Run("oversized", func(t *testing.T) {
		readerFile, writerFile, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer readerFile.Close()
		if _, err := writerFile.Write([]byte(strings.Repeat("x", 9) + "\n")); err != nil {
			t.Fatal(err)
		}
		_ = writerFile.Close()
		if _, frameErr := readExecServiceFrame(readerFile, bufio.NewReader(readerFile), 8, time.Second); frameErr == nil ||
			frameErr.code != execCodeRequestInvalid {
			t.Fatalf("got %v, want %s", frameErr, execCodeRequestInvalid)
		}
	})
}

func TestExecServiceEOFReaderRejectsExtraBytesAndTimeouts(t *testing.T) {
	t.Run("extra bytes", func(t *testing.T) {
		readerFile, writerFile, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer readerFile.Close()
		if _, err := writerFile.Write([]byte("x")); err != nil {
			t.Fatal(err)
		}
		_ = writerFile.Close()
		if err := requireExecServiceEOF(readerFile, bufio.NewReader(readerFile), time.Second); err == nil {
			t.Fatal("extra byte accepted")
		}
	})

	t.Run("timeout", func(t *testing.T) {
		readerFile, writerFile, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer readerFile.Close()
		defer writerFile.Close()
		if err := requireExecServiceEOF(readerFile, bufio.NewReader(readerFile), 25*time.Millisecond); err == nil {
			t.Fatal("EOF timeout accepted")
		}
	})
}

func TestExecServiceReadyWriterEnforcesBound(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "ready-frame")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := writeExecServiceJSONFrame(file, map[string]string{"value": strings.Repeat("x", 16)}, 8, time.Second); err == nil {
		t.Fatal("oversized ready frame accepted")
	}
}

func TestExecServiceParseProcStatRejectsMalformed(t *testing.T) {
	tests := [][]byte{
		nil,
		[]byte("1234 no closing parenthesis"),
		[]byte("1234 (short) S 1"),
		[]byte("not-a-pid (process) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 20 0 1 987654 0 0 0\n"),
		[]byte("1234 (bad ppid) S nope 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 20 0 1 987654 0 0 0\n"),
		[]byte("1234 (bad start) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 20 0 1 nope 0 0 0\n"),
	}
	for index, data := range tests {
		if _, err := parseExecServiceProcStat(data); err == nil {
			t.Fatalf("case %d accepted malformed proc stat", index)
		}
	}
}

func TestExecServiceRcloneVerification(t *testing.T) {
	target := createExecutableFixture(t, []byte("test executable fixture"))
	expected := readExecServiceRcloneInput(t, target)
	parsed, ok := parseExecServiceRclone(expected)
	if !ok {
		t.Fatal("fixture identity rejected")
	}
	file, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, guardErr := verifyExecServiceRclone(int(file.Fd()), parsed, linuxExecServiceHooks()); guardErr != nil {
		t.Fatalf("valid executable rejected: %v", guardErr)
	}

	setIDMode := os.FileMode(0o755) | os.ModeSetuid | os.ModeSetgid
	if err := os.Chmod(target, setIDMode); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSetuid == 0 || info.Mode()&os.ModeSetgid == 0 {
		t.Fatalf("fixture setid bits not applied: mode=%v", info.Mode())
	}
	if _, guardErr := verifyExecServiceRclone(int(file.Fd()), parsed, linuxExecServiceHooks()); guardErr == nil || guardErr.code != execCodeRcloneAttributes {
		t.Fatalf("setuid/setgid got %v, want %s", guardErr, execCodeRcloneAttributes)
	}
}

func TestExecServiceFileIdentityStability(t *testing.T) {
	before := syscall.Stat_t{
		Dev:  8,
		Ino:  12345,
		Size: 678,
		Mode: 0o100755,
		Atim: syscall.Timespec{Sec: 1, Nsec: 2},
	}
	atimeChanged := before
	atimeChanged.Atim = syscall.Timespec{Sec: 3, Nsec: 4}
	if !sameExecServiceFileIdentity(before, atimeChanged) {
		t.Fatal("atime-only change was treated as an identity change")
	}

	tests := []struct {
		name   string
		mutate func(*syscall.Stat_t)
	}{
		{name: "dev", mutate: func(stat *syscall.Stat_t) { stat.Dev++ }},
		{name: "ino", mutate: func(stat *syscall.Stat_t) { stat.Ino++ }},
		{name: "size", mutate: func(stat *syscall.Stat_t) { stat.Size++ }},
		{name: "mode", mutate: func(stat *syscall.Stat_t) { stat.Mode ^= 0o100 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			after := before
			test.mutate(&after)
			if sameExecServiceFileIdentity(before, after) {
				t.Fatalf("%s change was ignored", test.name)
			}
		})
	}
}

func TestExecServiceHashFileAcceptsPreadEOFWithoutError(t *testing.T) {
	content := []byte("bounded executable content")
	hooks := linuxExecServiceHooks()
	hooks.pread = func(_ int, buffer []byte, offset int64) (int, error) {
		if offset >= int64(len(content)) {
			return 0, nil
		}
		return copy(buffer, content[offset:]), nil
	}
	digest, err := hashExecServiceFile(0, uint64(len(content)), hooks)
	if err != nil {
		t.Fatalf("EOF without an error was rejected: %v", err)
	}
	if expected := sha256.Sum256(content); digest != expected {
		t.Fatalf("digest mismatch: got %x want %x", digest, expected)
	}
}

func TestExecServiceRcloneVerificationAllowsAtimeChange(t *testing.T) {
	target := createExecutableFixture(t, []byte("atime regression fixture"))
	expected := readExecServiceRcloneInput(t, target)
	parsed, ok := parseExecServiceRclone(expected)
	if !ok {
		t.Fatal("fixture identity rejected")
	}
	file, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	statCalls := 0
	hooks := linuxExecServiceHooks()
	hooks.fstat = func(fd int, stat *syscall.Stat_t) error {
		if err := syscall.Fstat(fd, stat); err != nil {
			return err
		}
		statCalls++
		if statCalls == 2 {
			stat.Atim.Sec++
		}
		return nil
	}
	if _, err := verifyExecServiceRclone(int(file.Fd()), parsed, hooks); err != nil {
		t.Fatalf("atime-only stat change rejected: %v", err)
	}
	if statCalls != 2 {
		t.Fatalf("fstat calls = %d, want 2", statCalls)
	}
}

func TestExecServiceCapabilityFailureMatrixUsesMocks(t *testing.T) {
	t.Run("bounding drop", func(t *testing.T) {
		hooks := linuxExecServiceHooks()
		hooks.prctl = func(option int, arg2, _, _, _ uintptr) (int, error) {
			if option == prCapBSetDrop && arg2 == 9 {
				return 0, syscall.EPERM
			}
			return 0, nil
		}
		err := dropExecServiceCapabilities(10, hooks)
		if err == nil || err.code != execCodeCapabilityDrop {
			t.Fatalf("got %v, want %s", err, execCodeCapabilityDrop)
		}
	})

	t.Run("ambient clear", func(t *testing.T) {
		hooks := linuxExecServiceHooks()
		hooks.prctl = func(option int, arg2, _, _, _ uintptr) (int, error) {
			if option == prCapAmbient && arg2 == prCapAmbientClearAll {
				return 0, syscall.EPERM
			}
			return 0, nil
		}
		err := dropExecServiceCapabilities(2, hooks)
		if err == nil || err.code != execCodeCapabilityDrop {
			t.Fatalf("got %v, want %s", err, execCodeCapabilityDrop)
		}
	})

	t.Run("capset", func(t *testing.T) {
		hooks := linuxExecServiceHooks()
		hooks.capset = func(*execServiceCapHeader, *[2]execServiceCapData) error {
			return syscall.EPERM
		}
		err := dropExecServiceCapabilities(2, hooks)
		if err == nil || err.code != execCodeCapabilityDrop {
			t.Fatalf("got %v, want %s", err, execCodeCapabilityDrop)
		}
	})

	t.Run("verify nonempty", func(t *testing.T) {
		hooks := linuxExecServiceHooks()
		hooks.capget = func(_ *execServiceCapHeader, data *[2]execServiceCapData) error {
			data[0].Effective = 1
			return nil
		}
		err := verifyExecServiceSecurity(2, hooks)
		if err == nil || err.code != execCodeCapabilityVerify {
			t.Fatalf("got %v, want %s", err, execCodeCapabilityVerify)
		}
	})
}

func TestExecServiceSecurityReadsParentDeathSignalPointer(t *testing.T) {
	hooks := linuxExecServiceHooks()
	hooks.capget = func(_ *execServiceCapHeader, data *[2]execServiceCapData) error {
		*data = [2]execServiceCapData{}
		return nil
	}
	hooks.getPDeathSig = func() (int32, error) {
		return int32(syscall.SIGKILL), nil
	}
	hooks.prctl = func(option int, arg2, _, _, _ uintptr) (int, error) {
		if option == prGetNoNewPrivs {
			return 1, nil
		}
		return 0, nil
	}
	if err := verifyExecServiceSecurity(2, hooks); err != nil {
		t.Fatalf("valid parent-death signal rejected: %v", err)
	}
}

func TestExecServiceBuildPayloadFixedEnvironment(t *testing.T) {
	argv := validExecServiceTestArgv("/approved/root", "/approved/authorized_keys", "/approved/host_key", 41001)
	payload, err := buildExecvePayload(argv, fixtureSuccessToken)
	if err != nil {
		t.Fatal(err)
	}
	if got := cStringBlock(payload.argBlock); len(got) != 16 || got[0] != "rclone" || got[15] != "off" {
		t.Fatalf("unexpected argv block: %#v", got)
	}
	env := cStringBlock(payload.envBlock)
	if !containsString(env, "RCLONE_CONFIG=/dev/null") ||
		!containsString(env, "SFSC_SERVICE_TOKEN="+fixtureSuccessToken) {
		t.Fatalf("unexpected env block: %#v", env)
	}
}

func TestExecServiceCStringPointersTargetFinalBlock(t *testing.T) {
	block, pointers, err := packExecServiceCStrings([]string{"alpha", "beta", "gamma"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pointers) != 4 || pointers[3] != 0 {
		t.Fatalf("unexpected pointer table: %#v", pointers)
	}
	start := uintptr(unsafe.Pointer(unsafe.SliceData(block)))
	end := start + uintptr(len(block))
	for index, pointer := range pointers[:3] {
		if pointer < start || pointer >= end {
			t.Fatalf("pointer %d outside final block: %#x not in [%#x,%#x)", index, pointer, start, end)
		}
	}
}

func TestRealExecServiceGate(t *testing.T) {
	requireReal := os.Getenv(requireRealEnv) == "1"
	if err := realLauncherPreflight(); err != nil {
		if requireReal {
			t.Fatalf("%s=1 requires a capable Linux gate: %v", requireRealEnv, err)
		}
		t.Skipf("real launcher fixture skipped: %v", err)
	}

	t.Run("gated exec success", func(t *testing.T) {
		paths := createLauncherFixturePaths(t, fixtureSuccessToken)
		cmd, stdin, stdout, stderr := startLauncherFixture(t, paths)
		readReadyFrame(t, stdout)
		controlTarget, err := os.Readlink("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/fd/1")
		if err != nil || !strings.HasPrefix(controlTarget, "pipe:[") {
			t.Fatalf("capture stdout control target: target=%q err=%v", controlTarget, err)
		}
		writeGoFrame(t, stdin, paths.Token)
		stderrData := readAllWithTimeout(t, stderr, 8*time.Second)
		waitCommand(t, cmd, 8*time.Second)
		if cmd.ProcessState.ExitCode() != 0 {
			t.Fatalf("launcher exit=%d stderr=%s", cmd.ProcessState.ExitCode(), stderrData)
		}
		var report postExecReport
		if err := json.Unmarshal(bytes.TrimSpace(stderrData), &report); err != nil {
			t.Fatalf("invalid post-exec report: %v: %s", err, stderrData)
		}
		assertPostExecFDReport(t, report, paths, controlTarget)
		if report.NoNewPrivs != "1" || report.CapEff != "0000000000000000" ||
			report.CapPrm != "0000000000000000" || report.CapInh != "0000000000000000" ||
			report.CapBnd != "0000000000000000" || report.CapAmb != "0000000000000000" {
			t.Fatalf("post-exec capability report mismatch: %#v", report)
		}
	})

	t.Run("execve failure control JSON", func(t *testing.T) {
		paths := createLauncherFixturePaths(t, fixtureSuccessToken)
		paths.Target = createExecutableFixtureInDirectory(t, filepath.Dir(paths.Target), []byte("not an executable format"))
		cmd, stdin, stdout, _ := startLauncherFixture(t, paths)
		readReadyFrame(t, stdout)
		writeGoFrame(t, stdin, paths.Token)
		failure := readFailureFrame(t, stdout)
		waitCommand(t, cmd, 8*time.Second)
		if failure.Error.Code != execCodeExec {
			t.Fatalf("got failure %s, want %s", failure.Error.Code, execCodeExec)
		}
		if cmd.ProcessState.ExitCode() != 2 {
			t.Fatalf("exec failure exit=%d", cmd.ProcessState.ExitCode())
		}
	})

	t.Run("no go does not exec", func(t *testing.T) {
		paths := createLauncherFixturePaths(t, fixtureSuccessToken)
		cmd, stdin, stdout, stderr := startLauncherFixture(t, paths)
		readReadyFrame(t, stdout)
		_ = stdin.Close()
		failure := readFailureFrame(t, stdout)
		stderrData := readAllWithTimeout(t, stderr, 3*time.Second)
		waitCommand(t, cmd, 3*time.Second)
		if failure.Error.Code != execCodeGoInvalid {
			t.Fatalf("got failure %s, want %s", failure.Error.Code, execCodeGoInvalid)
		}
		if len(bytes.TrimSpace(stderrData)) != 0 {
			t.Fatalf("target appears to have executed: %s", stderrData)
		}
	})

	t.Run("parent death kills launcher", func(t *testing.T) {
		runParentDeathFixtureTest(t, fixtureModeLauncherD)
	})

	t.Run("parent death kills exec target", func(t *testing.T) {
		runParentDeathFixtureTest(t, fixtureModeTargetD)
	})
}

func TestExecServiceHookChildPreReadyFailures(t *testing.T) {
	tests := []struct {
		name     string
		scenario string
		tokenEnv string
		mutate   func(*execServiceRequest)
		wantCode string
	}{
		{
			name:     "environment token mismatch",
			scenario: hookScenarioEnvToken,
			tokenEnv: strings.ToUpper(fixtureSuccessToken),
			wantCode: execCodeRequestInvalid,
		},
		{
			name:     "getppid mismatch",
			scenario: hookScenarioParentGetPPID,
			wantCode: execCodeParentChanged,
		},
		{
			name:     "self PPid mismatch",
			scenario: hookScenarioParentSelfPPID,
			wantCode: execCodeParentChanged,
		},
		{
			name:     "parent stat missing",
			scenario: hookScenarioParentStatMissing,
			wantCode: execCodeParentChanged,
		},
		{
			name:     "parent starttime mismatch",
			scenario: hookScenarioParentStartTime,
			wantCode: execCodeParentChanged,
		},
		{
			name:     "rclone fstat failure",
			scenario: hookScenarioRcloneFstat,
			wantCode: execCodeFDInvalid,
		},
		{
			name:     "rclone not regular",
			scenario: hookScenarioRcloneNotRegular,
			wantCode: execCodeRcloneNotRegular,
		},
		{
			name: "rclone identity mismatch",
			mutate: func(request *execServiceRequest) {
				request.Rclone.Dev = incrementCanonicalDecimal(request.Rclone.Dev)
			},
			wantCode: execCodeRcloneIdentity,
		},
		{
			name: "rclone digest mismatch",
			mutate: func(request *execServiceRequest) {
				request.Rclone.SHA256 = strings.Repeat("0", 64)
			},
			wantCode: execCodeRcloneDigest,
		},
		{
			name:     "rclone short read",
			scenario: hookScenarioRcloneShortRead,
			wantCode: execCodeRcloneDigest,
		},
		{
			name:     "rclone extra read",
			scenario: hookScenarioRcloneExtraRead,
			wantCode: execCodeRcloneIdentity,
		},
		{
			name:     "rclone mode changes while hashing",
			scenario: hookScenarioRcloneIdentityChg,
			wantCode: execCodeRcloneIdentity,
		},
		{
			name:     "rclone security capability present",
			scenario: hookScenarioRcloneXattrPresent,
			wantCode: execCodeRcloneAttributes,
		},
		{
			name:     "rclone xattr other error",
			scenario: hookScenarioRcloneXattrError,
			wantCode: execCodeRcloneAttributes,
		},
		{
			name:     "cap last missing",
			scenario: hookScenarioCapLastMissing,
			wantCode: execCodeCapabilityDrop,
		},
		{
			name:     "cap last out of range",
			scenario: hookScenarioCapLastOutOfRange,
			wantCode: execCodeCapabilityDrop,
		},
		{
			name:     "bounding drop failure",
			scenario: hookScenarioCapBoundingDrop,
			wantCode: execCodeCapabilityDrop,
		},
		{
			name:     "ambient clear failure",
			scenario: hookScenarioCapAmbientClear,
			wantCode: execCodeCapabilityDrop,
		},
		{
			name:     "capset failure",
			scenario: hookScenarioCapset,
			wantCode: execCodeCapabilityDrop,
		},
		{
			name:     "capget nonempty",
			scenario: hookScenarioCapgetNonempty,
			wantCode: execCodeCapabilityVerify,
		},
		{
			name:     "bounding verification failure",
			scenario: hookScenarioCapBoundingVerify,
			wantCode: execCodeCapabilityVerify,
		},
		{
			name:     "ambient verification failure",
			scenario: hookScenarioCapAmbientVerify,
			wantCode: execCodeCapabilityVerify,
		},
		{
			name:     "no new privileges set failure",
			scenario: hookScenarioNoNewPrivsSet,
			wantCode: execCodeNoNewPrivs,
		},
		{
			name:     "no new privileges readback failure",
			scenario: hookScenarioNoNewPrivsReadback,
			wantCode: execCodeNoNewPrivs,
		},
		{
			name:     "parent death signal set failure",
			scenario: hookScenarioPDeathSet,
			wantCode: execCodePDeathSigFailed,
		},
		{
			name:     "parent death signal readback failure",
			scenario: hookScenarioPDeathReadback,
			wantCode: execCodePDeathSigFailed,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			paths := createHookFixturePaths(t, fixtureSuccessToken)
			assertHookChildPreReadyFailure(t, paths, test.scenario, test.tokenEnv, test.mutate, test.wantCode)
		})
	}
}

func TestExecServiceHookChildAcceptsAbsentCapabilityXattr(t *testing.T) {
	tests := []struct {
		name     string
		scenario string
	}{
		{name: "ENODATA", scenario: hookScenarioRcloneXattrNoData},
		{name: "ENOTSUP", scenario: hookScenarioRcloneXattrNotSup},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			paths := createHookFixturePaths(t, fixtureSuccessToken)
			assertHookChildReadyThenNoGoFailure(t, paths, test.scenario, execCodeGoInvalid)
		})
	}
}

func TestExecServiceHookChildGoRevalidationFailures(t *testing.T) {
	tests := []struct {
		name     string
		scenario string
		wantCode string
	}{
		{name: "security", scenario: hookScenarioSecurityAfterGo, wantCode: execCodeCapabilityVerify},
		{name: "parent", scenario: hookScenarioParentAfterGo, wantCode: execCodeParentChanged},
		{name: "rclone", scenario: hookScenarioRcloneAfterGo, wantCode: execCodeFDInvalid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			paths := createHookFixturePaths(t, fixtureSuccessToken)
			assertHookChildReadyThenGoFailure(t, paths, test.scenario, test.wantCode)
		})
	}
}

func TestExecServiceHookChildExecuteFailures(t *testing.T) {
	tests := []struct {
		name     string
		scenario string
		wantCode string
	}{
		{name: "control duplicate", scenario: hookScenarioControlDup, wantCode: execCodeControlFDFailed},
		{name: "control nonblocking", scenario: hookScenarioControlNonblock, wantCode: execCodeControlFDFailed},
		{name: "dev null open", scenario: hookScenarioOpenDevNull, wantCode: execCodeRedirection},
		{name: "stdin redirect", scenario: hookScenarioRedirectFD0, wantCode: execCodeRedirection},
		{name: "stdout redirect", scenario: hookScenarioRedirectFD1, wantCode: execCodeRedirection},
		{name: "close range", scenario: hookScenarioCloseRange, wantCode: execCodeFDHygiene},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			paths := createHookFixturePaths(t, fixtureSuccessToken)
			assertHookChildReadyThenGoFailure(t, paths, test.scenario, test.wantCode)
		})
	}
}

func TestExecServiceHookChildRequestTimeout(t *testing.T) {
	paths := createHookFixturePaths(t, fixtureSuccessToken)
	cmd, stdin, stdout, stderr := startHookChild(t, paths, "", "")
	failure := readFailureFrameWithTimeout(t, stdout, 7*time.Second)
	_ = stdin.Close()
	assertHookChildCompletedWithFailure(t, cmd, stdout, stderr, failure, execCodeRequestTimeout, 7*time.Second)
}

func TestExecServiceHookChildGoTimeout(t *testing.T) {
	paths := createHookFixturePaths(t, fixtureSuccessToken)
	cmd, stdin, stdout, stderr := startHookChild(t, paths, "", "")
	request, err := launcherRequestForCurrentParent(paths)
	if err != nil {
		_ = cmd.Process.Kill()
		t.Fatal(err)
	}
	data, err := json.Marshal(request)
	if err != nil {
		_ = cmd.Process.Kill()
		t.Fatal(err)
	}
	if _, err := stdin.Write(append(data, '\n')); err != nil {
		_ = cmd.Process.Kill()
		t.Fatal(err)
	}
	readReadyFrame(t, stdout)
	failure := readFailureFrameWithTimeout(t, stdout, 13*time.Second)
	_ = stdin.Close()
	assertHookChildCompletedWithFailure(t, cmd, stdout, stderr, failure, execCodeGoTimeout, 13*time.Second)
}

func TestExecServiceHookChildGoFrameFailures(t *testing.T) {
	goFrame, err := json.Marshal(execServiceGoRequest{
		Version:   protocolVersion,
		Operation: "go",
		Token:     fixtureSuccessToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		payload []byte
		close   bool
	}{
		{name: "oversized go", payload: []byte(strings.Repeat("x", execGoMaxBytes+1) + "\n"), close: true},
		{name: "extra bytes after go", payload: append(append(append([]byte(nil), goFrame...), '\n'), 'x', '\n'), close: true},
		{name: "EOF timeout after go", payload: append(append([]byte(nil), goFrame...), '\n'), close: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			paths := createHookFixturePaths(t, fixtureSuccessToken)
			cmd, stdin, stdout, stderr := startHookChild(t, paths, "", "")
			request, err := launcherRequestForCurrentParent(paths)
			if err != nil {
				_ = cmd.Process.Kill()
				t.Fatal(err)
			}
			requestData, err := json.Marshal(request)
			if err != nil {
				_ = cmd.Process.Kill()
				t.Fatal(err)
			}
			if _, err := stdin.Write(append(requestData, '\n')); err != nil {
				_ = cmd.Process.Kill()
				t.Fatal(err)
			}
			readReadyFrame(t, stdout)
			if _, err := stdin.Write(test.payload); err != nil {
				_ = cmd.Process.Kill()
				t.Fatal(err)
			}
			if test.close {
				_ = stdin.Close()
			}
			failure := readFailureFrameWithTimeout(t, stdout, 5*time.Second)
			_ = stdin.Close()
			assertHookChildCompletedWithFailure(t, cmd, stdout, stderr, failure, execCodeGoInvalid, 5*time.Second)
		})
	}
}

func runPostExecReport() int {
	report := postExecReport{
		PID: os.Getpid(),
		FDs: readSelfFDs(),
	}
	status, err := os.ReadFile("/proc/self/status")
	if err == nil {
		values := parseProcStatusValues(status)
		report.NoNewPrivs = values["NoNewPrivs"]
		report.CapEff = values["CapEff"]
		report.CapPrm = values["CapPrm"]
		report.CapInh = values["CapInh"]
		report.CapBnd = values["CapBnd"]
		report.CapAmb = values["CapAmb"]
	}
	data, _ := json.Marshal(report)
	_, _ = os.NewFile(2, "stderr-report").Write(append(data, '\n'))
	return 0
}

func runPostExecDeath() {
	_, _ = os.NewFile(2, "stderr-live").Write([]byte("exec-live\n"))
	for {
		time.Sleep(time.Hour)
	}
}

func runParentDeathFixture() int {
	runtime.LockOSThread()
	paths := launcherFixturePaths{
		Target:         os.Getenv("SFSC_EXEC_FIXTURE_TARGET"),
		Helper:         os.Getenv("SFSC_EXEC_FIXTURE_HELPER"),
		Sentinel:       os.Getenv("SFSC_EXEC_FIXTURE_SENTINEL"),
		Root:           os.Getenv("SFSC_EXEC_FIXTURE_ROOT"),
		AuthorizedKeys: os.Getenv("SFSC_EXEC_FIXTURE_AUTHORIZED_KEYS"),
		HostKey:        os.Getenv("SFSC_EXEC_FIXTURE_HOST_KEY"),
		Token:          os.Getenv("SFSC_SERVICE_TOKEN"),
	}
	cmd, stdin, stdout, stderr := startLauncherFixtureProcess(paths)
	if err := writeLauncherRequest(stdin, paths); err != nil {
		return 2
	}
	if _, err := readReadyFrameRaw(stdout); err != nil {
		return 3
	}
	stage := os.Getenv("SFSC_EXEC_FIXTURE_STAGE")
	if stage == fixtureModeTargetD {
		if err := writeGoFrameRaw(stdin, paths.Token); err != nil {
			return 3
		}
		if _, err := readLineWithTimeout(bufio.NewReaderSize(stderr, 4096), 5*time.Second); err != nil {
			return 4
		}
	}
	stat, err := readExecServiceProcStat("/proc/"+strconv.Itoa(cmd.Process.Pid)+"/stat", linuxExecServiceHooks())
	if err != nil {
		return 5
	}
	info := parentDeathInfo{PID: cmd.Process.Pid, StartTime: strconv.FormatUint(stat.StartTime, 10)}
	data, _ := json.Marshal(info)
	_, _ = os.Stdout.Write(append(data, '\n'))
	for {
		time.Sleep(time.Hour)
	}
}

func runExecServiceHookChild() int {
	return runExecServiceWithHooks(
		[]string{os.Args[0], execServiceMode},
		os.Stdin,
		os.Stdout,
		os.Stderr,
		hookExecServiceHooks(os.Getenv(hookScenarioEnv)),
	)
}

func hookExecServiceHooks(scenario string) execServiceHooks {
	hooks := linuxExecServiceHooks()
	capgetCalls := 0
	fstatCalls := 0
	dupOutputCalls := 0
	setFlagCalls := 0
	getppidCalls := 0
	dup3Calls := 0

	hooks.getppid = func() int {
		getppidCalls++
		actual := os.Getppid()
		if scenario == hookScenarioParentGetPPID {
			return actual + 1
		}
		if scenario == hookScenarioParentAfterGo && getppidCalls >= 4 {
			return actual + 1
		}
		return actual
	}
	hooks.readFile = func(path string) ([]byte, error) {
		if path == "/proc/sys/kernel/cap_last_cap" {
			switch scenario {
			case hookScenarioCapLastMissing:
				return nil, os.ErrNotExist
			case hookScenarioCapLastOutOfRange:
				return []byte("64\n"), nil
			default:
				return []byte("40\n"), nil
			}
		}
		switch scenario {
		case hookScenarioParentStatMissing:
			if path == "/proc/"+strconv.Itoa(os.Getppid())+"/stat" {
				return nil, os.ErrNotExist
			}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if scenario == hookScenarioParentSelfPPID && path == "/proc/self/stat" {
			return mutateExecServiceProcStat(data, func(fields []string) {
				fields[1] = incrementCanonicalDecimal(fields[1])
			}), nil
		}
		if scenario == hookScenarioParentStartTime && path == "/proc/"+strconv.Itoa(os.Getppid())+"/stat" {
			return mutateExecServiceProcStat(data, func(fields []string) {
				fields[19] = incrementCanonicalDecimal(fields[19])
			}), nil
		}
		return data, nil
	}
	hooks.fstat = func(fd int, stat *syscall.Stat_t) error {
		if err := syscall.Fstat(fd, stat); err != nil {
			return err
		}
		fstatCalls++
		switch scenario {
		case hookScenarioRcloneFstat:
			return syscall.EIO
		case hookScenarioRcloneNotRegular:
			stat.Mode = stat.Mode&^syscall.S_IFMT | syscall.S_IFDIR
		case hookScenarioRcloneAfterGo:
			if fstatCalls == 5 {
				return syscall.EIO
			}
		case hookScenarioRcloneIdentityChg:
			if fstatCalls == 2 {
				stat.Mode ^= 0o020
			}
		}
		return nil
	}
	hooks.fgetxattr = func(int, string) (int, error) {
		switch scenario {
		case hookScenarioRcloneXattrPresent:
			return 24, nil
		case hookScenarioRcloneXattrError:
			return 0, syscall.EIO
		case hookScenarioRcloneXattrNotSup:
			return 0, syscall.ENOTSUP
		default:
			return 0, syscall.ENODATA
		}
	}
	hooks.pread = func(fd int, buffer []byte, offset int64) (int, error) {
		switch scenario {
		case hookScenarioRcloneShortRead:
			if offset == 0 {
				return 0, nil
			}
		case hookScenarioRcloneExtraRead:
			var stat syscall.Stat_t
			if err := syscall.Fstat(fd, &stat); err == nil && offset >= stat.Size {
				buffer[0] = 'x'
				return 1, nil
			}
		}
		return syscall.Pread(fd, buffer, offset)
	}
	hooks.fcntl = func(fd, command, argument int) (int, error) {
		if scenario == hookScenarioControlDup && fd == 1 && command == syscall.F_DUPFD_CLOEXEC {
			dupOutputCalls++
			if dupOutputCalls == 2 {
				return 0, syscall.EPERM
			}
		}
		if scenario == hookScenarioControlNonblock && command == syscall.F_SETFL {
			setFlagCalls++
			if setFlagCalls == 3 {
				return 0, syscall.EPERM
			}
		}
		return linuxExecServiceFcntl(fd, command, argument)
	}
	hooks.prctl = func(option int, arg2, arg3, arg4, arg5 uintptr) (int, error) {
		switch option {
		case prSetPDeathSig:
			if scenario == hookScenarioPDeathSet {
				return 0, syscall.EPERM
			}
		case prCapBSetDrop:
			if scenario == hookScenarioCapBoundingDrop {
				return 0, syscall.EPERM
			}
		case prCapBSetRead:
			if scenario == hookScenarioCapBoundingVerify {
				return 1, nil
			}
		case prCapAmbient:
			if arg2 == prCapAmbientClearAll && scenario == hookScenarioCapAmbientClear {
				return 0, syscall.EPERM
			}
			if arg2 == prCapAmbientIsSet && scenario == hookScenarioCapAmbientVerify {
				return 1, nil
			}
		case prSetNoNewPrivs:
			if scenario == hookScenarioNoNewPrivsSet {
				return 0, syscall.EPERM
			}
		case prGetNoNewPrivs:
			if scenario == hookScenarioNoNewPrivsReadback {
				return 0, nil
			}
			return 1, nil
		}
		return 0, nil
	}
	hooks.getPDeathSig = func() (int32, error) {
		if scenario == hookScenarioPDeathReadback {
			return int32(syscall.SIGTERM), nil
		}
		return int32(syscall.SIGKILL), nil
	}
	hooks.capget = func(_ *execServiceCapHeader, data *[2]execServiceCapData) error {
		capgetCalls++
		*data = [2]execServiceCapData{}
		if scenario == hookScenarioCapgetNonempty ||
			(scenario == hookScenarioSecurityAfterGo && capgetCalls == 2) {
			data[0].Effective = 1
		}
		return nil
	}
	hooks.capset = func(*execServiceCapHeader, *[2]execServiceCapData) error {
		if scenario == hookScenarioCapset {
			return syscall.EPERM
		}
		return nil
	}
	hooks.closeRange = func(uintptr, uintptr, uintptr) syscall.Errno {
		if scenario == hookScenarioCloseRange {
			return syscall.EINVAL
		}
		return 0
	}
	hooks.open = func(path string, flags int, mode uint32) (int, error) {
		if scenario == hookScenarioOpenDevNull && path == "/dev/null" {
			return -1, syscall.EIO
		}
		return syscall.Open(path, flags, mode)
	}
	hooks.dup3 = func(oldFD, newFD, flags int) error {
		dup3Calls++
		if scenario == hookScenarioRedirectFD0 {
			return syscall.EIO
		}
		if scenario == hookScenarioRedirectFD1 && dup3Calls == 2 {
			return syscall.EIO
		}
		return syscall.Dup3(oldFD, newFD, flags)
	}
	return hooks
}

func createHookFixturePaths(t *testing.T, token string) launcherFixturePaths {
	t.Helper()
	temp := t.TempDir()
	target := filepath.Join(temp, "hook-target")
	if err := os.WriteFile(target, []byte("hook scenario executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o700); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(temp, "hook-helper")
	if err := os.WriteFile(helper, []byte("hook helper"), 0o700); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(temp, "hook-sentinel")
	if err := os.WriteFile(sentinel, []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(temp, "root")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	authorizedKeys := filepath.Join(temp, "authorized_keys")
	hostKey := filepath.Join(temp, "host_key")
	if err := os.WriteFile(authorizedKeys, []byte("authorized"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hostKey, []byte("host key"), 0o600); err != nil {
		t.Fatal(err)
	}
	return launcherFixturePaths{
		Target:         target,
		Helper:         helper,
		Sentinel:       sentinel,
		Root:           root,
		AuthorizedKeys: authorizedKeys,
		HostKey:        hostKey,
		Token:          token,
	}
}

func startHookChild(t *testing.T, paths launcherFixturePaths, scenario, tokenEnv string) (*exec.Cmd, io.WriteCloser, *bufio.Reader, io.ReadCloser) {
	t.Helper()
	target, err := os.Open(paths.Target)
	if err != nil {
		t.Fatal(err)
	}
	helper, err := os.Open(paths.Helper)
	if err != nil {
		_ = target.Close()
		t.Fatal(err)
	}
	sentinel, err := os.Open(paths.Sentinel)
	if err != nil {
		_ = target.Close()
		_ = helper.Close()
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		_ = target.Close()
		_ = helper.Close()
		_ = sentinel.Close()
		t.Fatal(err)
	}
	if tokenEnv == "" {
		tokenEnv = paths.Token
	}
	cmd := exec.Command(executable, "-test.run=^$")
	cmd.Env = fixtureEnvironment(map[string]string{
		fixtureModeEnv:       fixtureModeHookChild,
		hookScenarioEnv:      scenario,
		"SFSC_SERVICE_TOKEN": tokenEnv,
	})
	cmd.ExtraFiles = []*os.File{target, helper, sentinel}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = target.Close()
	_ = helper.Close()
	_ = sentinel.Close()
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
	})
	return cmd, stdin, bufio.NewReaderSize(stdoutPipe, execReadyMaxBytes+2), stderrPipe
}

func assertHookChildPreReadyFailure(
	t *testing.T,
	paths launcherFixturePaths,
	scenario, tokenEnv string,
	mutate func(*execServiceRequest),
	wantCode string,
) {
	t.Helper()
	runHookChildScenario(t, paths, scenario, tokenEnv, mutate, hookChildPhasePreReady, wantCode)
}

func assertHookChildReadyThenNoGoFailure(t *testing.T, paths launcherFixturePaths, scenario, wantCode string) {
	t.Helper()
	runHookChildScenario(t, paths, scenario, "", nil, hookChildPhaseReadyNoGo, wantCode)
}

func assertHookChildReadyThenGoFailure(t *testing.T, paths launcherFixturePaths, scenario, wantCode string) {
	t.Helper()
	runHookChildScenario(t, paths, scenario, "", nil, hookChildPhaseReadyGo, wantCode)
}

type hookChildPhase int

const (
	hookChildPhasePreReady hookChildPhase = iota
	hookChildPhaseReadyNoGo
	hookChildPhaseReadyGo
)

func runHookChildScenario(
	t *testing.T,
	paths launcherFixturePaths,
	scenario, tokenEnv string,
	mutate func(*execServiceRequest),
	phase hookChildPhase,
	wantCode string,
) {
	t.Helper()
	cmd, stdin, stdout, stderr := startHookChild(t, paths, scenario, tokenEnv)
	request, err := launcherRequestForCurrentParent(paths)
	if err != nil {
		_ = cmd.Process.Kill()
		t.Fatal(err)
	}
	if mutate != nil {
		mutate(&request)
	}
	data, err := json.Marshal(request)
	if err != nil {
		_ = cmd.Process.Kill()
		t.Fatal(err)
	}
	_, _ = stdin.Write(append(data, '\n'))

	switch phase {
	case hookChildPhasePreReady:
		_ = stdin.Close()
	case hookChildPhaseReadyNoGo:
		readReadyFrame(t, stdout)
		_ = stdin.Close()
	case hookChildPhaseReadyGo:
		readReadyFrame(t, stdout)
		writeGoFrame(t, stdin, paths.Token)
	default:
		_ = cmd.Process.Kill()
		t.Fatalf("unknown hook child phase %d", phase)
	}

	failure := readFailureFrame(t, stdout)
	assertHookChildCompletedWithFailure(t, cmd, stdout, stderr, failure, wantCode, 3*time.Second)
}

func assertHookChildCompletedWithFailure(
	t *testing.T,
	cmd *exec.Cmd,
	stdout *bufio.Reader,
	stderr io.Reader,
	failure execServiceFailureResponse,
	wantCode string,
	timeout time.Duration,
) {
	t.Helper()
	if failure.Error.Code != wantCode {
		_ = cmd.Process.Kill()
		t.Fatalf("got failure %s, want %s", failure.Error.Code, wantCode)
	}
	trailingStdout := readAllWithTimeout(t, stdout, timeout)
	stderrData := readAllWithTimeout(t, stderr, timeout)
	waitCommand(t, cmd, timeout)
	if cmd.ProcessState.ExitCode() != 2 {
		t.Fatalf("hook child exit=%d, want 2", cmd.ProcessState.ExitCode())
	}
	if len(bytes.TrimSpace(trailingStdout)) != 0 {
		t.Fatalf("unexpected trailing stdout: %s", trailingStdout)
	}
	if len(bytes.TrimSpace(stderrData)) != 0 {
		t.Fatalf("target appears to have executed: %s", stderrData)
	}
}

func mutateExecServiceProcStat(data []byte, mutate func([]string)) []byte {
	closeParen := bytes.LastIndexByte(data, ')')
	if closeParen < 0 {
		return data
	}
	fields := strings.Fields(string(data[closeParen+2:]))
	if len(fields) < 20 {
		return data
	}
	mutate(fields)
	result := append([]byte(nil), data[:closeParen+1]...)
	result = append(result, ' ')
	result = append(result, []byte(strings.Join(fields, " "))...)
	result = append(result, '\n')
	return result
}

func createLauncherFixturePaths(t *testing.T, token string) launcherFixturePaths {
	t.Helper()
	temp := t.TempDir()
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(temp, "sfsc-test-exec")
	copyFile(t, testBinary, target, 0o755)
	helper := filepath.Join(temp, "sfsc-test-helper")
	copyFile(t, testBinary, helper, 0o755)
	sentinel := filepath.Join(temp, "sentinel")
	if err := os.WriteFile(sentinel, []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(temp, "root")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	authorizedKeys := filepath.Join(temp, "authorized_keys")
	hostKey := filepath.Join(temp, "host_key")
	if err := os.WriteFile(authorizedKeys, []byte("authorized"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hostKey, []byte("host key"), 0o600); err != nil {
		t.Fatal(err)
	}
	return launcherFixturePaths{
		Target:         target,
		Helper:         helper,
		Sentinel:       sentinel,
		Root:           root,
		AuthorizedKeys: authorizedKeys,
		HostKey:        hostKey,
		Token:          token,
	}
}

func startLauncherFixture(t *testing.T, paths launcherFixturePaths) (*exec.Cmd, io.WriteCloser, *bufio.Reader, io.ReadCloser) {
	t.Helper()
	cmd, stdin, stdout, stderr := startLauncherFixtureProcess(paths)
	if err := writeLauncherRequest(stdin, paths); err != nil {
		_ = cmd.Process.Kill()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
	})
	return cmd, stdin, stdout, stderr
}

func writeLauncherRequest(writer io.Writer, paths launcherFixturePaths) error {
	request, err := launcherRequestForCurrentParent(paths)
	if err != nil {
		return err
	}
	data, err := json.Marshal(request)
	if err != nil {
		return err
	}
	_, err = writer.Write(append(data, '\n'))
	return err
}

func startLauncherFixtureProcess(paths launcherFixturePaths) (*exec.Cmd, io.WriteCloser, *bufio.Reader, io.ReadCloser) {
	target, err := os.Open(paths.Target)
	if err != nil {
		panic(err)
	}
	helper, err := os.Open(paths.Helper)
	if err != nil {
		panic(err)
	}
	sentinel, err := os.Open(paths.Sentinel)
	if err != nil {
		panic(err)
	}
	executable, err := os.Executable()
	if err != nil {
		panic(err)
	}
	cmd := exec.Command(executable, execServiceMode)
	cmd.Env = fixtureEnvironment(map[string]string{
		fixtureModeEnv:       fixtureModeLauncher,
		"SFSC_SERVICE_TOKEN": paths.Token,
	})
	cmd.ExtraFiles = []*os.File{target, helper, sentinel}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		panic(err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		panic(err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		panic(err)
	}
	if err := cmd.Start(); err != nil {
		panic(err)
	}
	_ = target.Close()
	_ = helper.Close()
	_ = sentinel.Close()
	return cmd, stdin, bufio.NewReaderSize(stdoutPipe, execReadyMaxBytes+2), stderrPipe
}

func launcherRequestForCurrentParent(paths launcherFixturePaths) (execServiceRequest, error) {
	stat, err := readExecServiceProcStat("/proc/self/stat", linuxExecServiceHooks())
	if err != nil {
		return execServiceRequest{}, err
	}
	rclone := readExecServiceRcloneInputFile(paths.Target)
	return execServiceRequest{
		Version:   protocolVersion,
		Operation: "launch",
		Token:     paths.Token,
		Parent: execServiceParentInput{
			PID:       strconv.FormatUint(stat.PID, 10),
			StartTime: strconv.FormatUint(stat.StartTime, 10),
		},
		Rclone: rclone,
		Listener: execServiceListenerInput{
			Host: "127.0.0.1",
			Port: 41001,
		},
		Argv: validExecServiceTestArgv(paths.Root, paths.AuthorizedKeys, paths.HostKey, 41001),
	}, nil
}

func readExecServiceRcloneInput(t *testing.T, filename string) execServiceRcloneInput {
	t.Helper()
	return readExecServiceRcloneInputFile(filename)
}

func readExecServiceRcloneInputFile(filename string) execServiceRcloneInput {
	file, err := os.Open(filename)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(file.Fd()), &stat); err != nil {
		panic(err)
	}
	digest, guardErr := hashExecServiceFile(int(file.Fd()), uint64(stat.Size), linuxExecServiceHooks())
	if guardErr != nil {
		panic(guardErr)
	}
	return execServiceRcloneInput{
		Dev:    strconv.FormatUint(uint64(stat.Dev), 10),
		Ino:    strconv.FormatUint(uint64(stat.Ino), 10),
		Size:   strconv.FormatUint(uint64(stat.Size), 10),
		SHA256: hex.EncodeToString(digest[:]),
	}
}

func readReadyFrame(t *testing.T, reader *bufio.Reader) {
	t.Helper()
	line, err := readLineWithTimeout(reader, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var ready execServiceReadyResponse
	if err := json.Unmarshal(line, &ready); err != nil {
		t.Fatalf("invalid ready frame: %v: %s", err, line)
	}
	if !ready.OK || ready.State != "ready" {
		t.Fatalf("unexpected ready: %s", line)
	}
}

func readReadyFrameRaw(reader *bufio.Reader) ([]byte, error) {
	line, err := readLineWithTimeout(reader, 5*time.Second)
	if err != nil {
		return nil, err
	}
	var ready execServiceReadyResponse
	if err := json.Unmarshal(line, &ready); err != nil || !ready.OK {
		return nil, errors.New("ready frame invalid")
	}
	return line, nil
}

func writeGoFrame(t *testing.T, writer io.WriteCloser, token string) {
	t.Helper()
	if err := writeGoFrameRaw(writer, token); err != nil {
		t.Fatal(err)
	}
}

func writeGoFrameRaw(writer io.WriteCloser, token string) error {
	data, _ := json.Marshal(execServiceGoRequest{Version: protocolVersion, Operation: "go", Token: token})
	if _, err := writer.Write(append(data, '\n')); err != nil {
		return err
	}
	return writer.Close()
}

func readFailureFrame(t *testing.T, reader *bufio.Reader) execServiceFailureResponse {
	t.Helper()
	return readFailureFrameWithTimeout(t, reader, 5*time.Second)
}

func readFailureFrameWithTimeout(t *testing.T, reader *bufio.Reader, timeout time.Duration) execServiceFailureResponse {
	t.Helper()
	line, err := readLineWithTimeout(reader, timeout)
	if err != nil {
		t.Fatal(err)
	}
	var failure execServiceFailureResponse
	if err := json.Unmarshal(line, &failure); err != nil {
		t.Fatalf("invalid failure frame: %v: %s", err, line)
	}
	if failure.OK || failure.Error.Code == "" {
		t.Fatalf("unexpected failure frame: %s", line)
	}
	return failure
}

func readLineWithTimeout(reader *bufio.Reader, timeout time.Duration) ([]byte, error) {
	type result struct {
		line []byte
		err  error
	}
	channel := make(chan result, 1)
	go func() {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			line = line[:len(line)-1]
		}
		channel <- result{line: line, err: err}
	}()
	select {
	case result := <-channel:
		return result.line, result.err
	case <-time.After(timeout):
		return nil, errors.New("frame read timeout")
	}
}

func readAllWithTimeout(t *testing.T, reader io.Reader, timeout time.Duration) []byte {
	t.Helper()
	channel := make(chan []byte, 1)
	go func() {
		data, _ := io.ReadAll(reader)
		channel <- data
	}()
	select {
	case data := <-channel:
		return data
	case <-time.After(timeout):
		t.Fatal("stream read timeout")
		return nil
	}
}

func waitCommand(t *testing.T, cmd *exec.Cmd, timeout time.Duration) {
	t.Helper()
	channel := make(chan error, 1)
	go func() { channel <- cmd.Wait() }()
	select {
	case <-channel:
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		t.Fatal("command wait timeout")
	}
}

func runParentDeathFixtureTest(t *testing.T, stage string) {
	t.Helper()
	token := fixtureDeathToken
	paths := createLauncherFixturePaths(t, token)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^$")
	cmd.Env = fixtureEnvironment(map[string]string{
		fixtureModeEnv:                      fixtureModeParent,
		"SFSC_EXEC_FIXTURE_STAGE":           stage,
		"SFSC_SERVICE_TOKEN":                token,
		"SFSC_EXEC_FIXTURE_TARGET":          paths.Target,
		"SFSC_EXEC_FIXTURE_HELPER":          paths.Helper,
		"SFSC_EXEC_FIXTURE_SENTINEL":        paths.Sentinel,
		"SFSC_EXEC_FIXTURE_ROOT":            paths.Root,
		"SFSC_EXEC_FIXTURE_AUTHORIZED_KEYS": paths.AuthorizedKeys,
		"SFSC_EXEC_FIXTURE_HOST_KEY":        paths.HostKey,
	})
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(stdout)
	line, err := readLineWithTimeout(reader, 8*time.Second)
	if err != nil {
		_ = cmd.Process.Kill()
		t.Fatal(err)
	}
	var info parentDeathInfo
	if err := json.Unmarshal(line, &info); err != nil {
		_ = cmd.Process.Kill()
		t.Fatalf("invalid parent fixture info: %v: %s", err, line)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	if !waitForPIDGone(info.PID, info.StartTime, 8*time.Second) {
		killIfSameProcess(info.PID, info.StartTime)
		t.Fatalf("child PID %d did not exit after parent death", info.PID)
	}
}

func realLauncherPreflight() error {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return err
	}
	values := parseProcStatusValues(status)
	capEff, ok := parseCapabilityMask(values["CapEff"])
	if !ok || capEff&(1<<8) == 0 {
		return errors.New("effective CAP_SETPCAP is required")
	}
	_, _, errno := syscall.RawSyscall(sysCloseRange, ^uintptr(0), ^uintptr(0), 0)
	if errno != 0 {
		return fmt.Errorf("close_range unavailable: %v", errno)
	}
	return nil
}

func assertPostExecFDReport(t *testing.T, report postExecReport, paths launcherFixturePaths, controlTarget string) {
	t.Helper()
	if report.FDs["0"] != "/dev/null" || report.FDs["1"] != "/dev/null" {
		t.Fatalf("fd 0/1 not /dev/null: %#v", report.FDs)
	}
	if !strings.HasPrefix(report.FDs["2"], "pipe:[") {
		t.Fatalf("fd 2 not preserved: %#v", report.FDs)
	}
	stderrTarget := report.FDs["2"]
	for fd, target := range report.FDs {
		number, err := strconv.Atoi(fd)
		if err != nil || number <= 2 {
			continue
		}
		if target == controlTarget || target == stderrTarget {
			t.Fatalf("control fd %s escaped exec: %s", fd, target)
		}
		for _, inherited := range []string{paths.Target, paths.Helper, paths.Sentinel} {
			if target == inherited || strings.HasPrefix(target, inherited+" ") {
				t.Fatalf("inherited fixture fd %s escaped exec: %s", fd, target)
			}
		}
		if strings.HasPrefix(target, "pipe:[") || strings.HasPrefix(target, "socket:[") ||
			strings.HasPrefix(target, "anon_inode:") || strings.HasPrefix(target, "/proc/") {
			t.Logf("permitted runtime-created fd %s: %s", fd, target)
		}
	}
}

func readSelfFDs() map[string]string {
	result := make(map[string]string)
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return result
	}
	for _, entry := range entries {
		target, err := os.Readlink("/proc/self/fd/" + entry.Name())
		if err == nil {
			result[entry.Name()] = target
		}
	}
	return result
}

func parseProcStatusValues(data []byte) map[string]string {
	result := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			result[key] = strings.TrimSpace(value)
		}
	}
	return result
}

func waitForPIDGone(pid int, startTime string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		stat, err := readExecServiceProcStat("/proc/"+strconv.Itoa(pid)+"/stat", linuxExecServiceHooks())
		if err != nil || strconv.FormatUint(stat.StartTime, 10) != startTime {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return false
}

func killIfSameProcess(pid int, startTime string) {
	stat, err := readExecServiceProcStat("/proc/"+strconv.Itoa(pid)+"/stat", linuxExecServiceHooks())
	if err == nil && strconv.FormatUint(stat.StartTime, 10) == startTime {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}

func marshalExecServiceTestRequest(t *testing.T, request execServiceRequest) []byte {
	t.Helper()
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func decodeExecServiceJSONObject(t *testing.T, data []byte) map[string]json.RawMessage {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	return object
}

func deleteExecServiceJSONField(t *testing.T, data []byte, field string) []byte {
	t.Helper()
	object := decodeExecServiceJSONObject(t, data)
	delete(object, field)
	result, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func replaceExecServiceJSONField(t *testing.T, data []byte, field string, value []byte) []byte {
	t.Helper()
	object := decodeExecServiceJSONObject(t, data)
	object[field] = append(json.RawMessage(nil), value...)
	result, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func mutateExecServiceJSONField(
	t *testing.T,
	data []byte,
	field string,
	mutate func(map[string]json.RawMessage),
) []byte {
	t.Helper()
	object := decodeExecServiceJSONObject(t, data)
	raw, ok := object[field]
	if !ok {
		t.Fatalf("field %q not found", field)
	}
	var nested map[string]json.RawMessage
	if err := json.Unmarshal(raw, &nested); err != nil {
		t.Fatal(err)
	}
	mutate(nested)
	updated, err := json.Marshal(nested)
	if err != nil {
		t.Fatal(err)
	}
	object[field] = updated
	result, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func incrementCanonicalDecimal(value string) string {
	number, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return "invalid"
	}
	return strconv.FormatUint(number+1, 10)
}

func validExecServiceTestRequest(root, authorizedKeys, hostKey, tokenSource string) execServiceRequest {
	_ = tokenSource
	return execServiceRequest{
		Version:   protocolVersion,
		Operation: "launch",
		Token:     fixtureSuccessToken,
		Parent: execServiceParentInput{
			PID:       "1234",
			StartTime: "987654",
		},
		Rclone: execServiceRcloneInput{
			Dev:    "2049",
			Ino:    "123456",
			Size:   "60000000",
			SHA256: strings.Repeat("a", 64),
		},
		Listener: execServiceListenerInput{
			Host: "127.0.0.1",
			Port: 41001,
		},
		Argv: validExecServiceTestArgv(root, authorizedKeys, hostKey, 41001),
	}
}

func validExecServiceTestArgv(root, authorizedKeys, hostKey string, port int) []string {
	return []string{
		"serve",
		"sftp",
		":local:" + root,
		"--addr",
		"127.0.0.1:" + strconv.Itoa(port),
		"--authorized-keys",
		authorizedKeys,
		"--key",
		hostKey,
		"--dir-cache-time",
		"0",
		"--poll-interval",
		"0",
		"--vfs-cache-mode",
		"off",
	}
}

func replaceExecServiceTestArg(argv []string, index int, value string) []string {
	result := append([]string(nil), argv...)
	result[index] = value
	return result
}

func swapExecServiceTestArgs(argv []string, left, right int) []string {
	result := append([]string(nil), argv...)
	result[left], result[right] = result[right], result[left]
	return result
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func cStringBlock(data []byte) []string {
	parts := bytes.Split(data, []byte{0})
	if len(parts) > 0 && len(parts[len(parts)-1]) == 0 {
		parts = parts[:len(parts)-1]
	}
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		result = append(result, string(part))
	}
	return result
}

func createExecutableFixture(t *testing.T, data []byte) string {
	t.Helper()
	return createExecutableFixtureInDirectory(t, t.TempDir(), data)
}

func createExecutableFixtureInDirectory(t *testing.T, directory string, data []byte) string {
	t.Helper()
	filename := filepath.Join(directory, "exec-fixture-"+strconv.FormatInt(time.Now().UnixNano(), 10))
	if err := os.WriteFile(filename, data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filename, 0o700); err != nil {
		t.Fatal(err)
	}
	return filename
}

func copyFile(t *testing.T, source, destination string, mode os.FileMode) {
	t.Helper()
	input, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		t.Fatal(err)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(destination, mode); err != nil {
		t.Fatal(err)
	}
}

func fixtureEnvironment(overrides map[string]string) []string {
	blocked := make(map[string]bool)
	for key := range overrides {
		blocked[key] = true
	}
	result := make([]string, 0, len(os.Environ())+len(overrides))
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if !blocked[key] {
			result = append(result, value)
		}
	}
	for key, value := range overrides {
		result = append(result, key+"="+value)
	}
	return result
}
