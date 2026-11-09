//go:build linux && (amd64 || arm64)

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func TestDecodeRequestStrictProtocol(t *testing.T) {
	digest := sha256.Sum256([]byte("marker"))
	valid := `{"version":1,"operation":"inspect","expected":{"dev":"8","ino":"12345","size":"6","sha256":"` +
		hex.EncodeToString(digest[:]) + `"}}`

	req, err := decodeRequest(strings.NewReader(valid))
	if err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	if req.Operation != operationInspect || req.expected.dev != 8 || req.expected.ino != 12345 || req.expected.size != 6 {
		t.Fatalf("valid request decoded incorrectly: %#v", req)
	}

	tests := []struct {
		name  string
		input string
	}{
		{name: "empty", input: ""},
		{name: "non-object", input: "[]"},
		{name: "unknown top-level field", input: `{"version":1,"operation":"inspect","expected":{"dev":"8","ino":"1","size":"0","sha256":"` + hex.EncodeToString(digest[:]) + `"},"path":"/tmp/x"}`},
		{name: "duplicate top-level field", input: `{"version":1,"version":1,"operation":"inspect","expected":{"dev":"8","ino":"1","size":"0","sha256":"` + hex.EncodeToString(digest[:]) + `"}}`},
		{name: "duplicate expected field", input: `{"version":1,"operation":"inspect","expected":{"dev":"8","dev":"8","ino":"1","size":"0","sha256":"` + hex.EncodeToString(digest[:]) + `"}}`},
		{name: "unknown expected field", input: `{"version":1,"operation":"inspect","expected":{"dev":"8","ino":"1","size":"0","sha256":"` + hex.EncodeToString(digest[:]) + `","path":"x"}}`},
		{name: "trailing JSON", input: valid + ` {}`},
		{name: "wrong version", input: strings.Replace(valid, `"version":1`, `"version":2`, 1)},
		{name: "unknown operation", input: strings.Replace(valid, `"inspect"`, `"clear_immutable"`, 1)},
		{name: "signed decimal", input: strings.Replace(valid, `"dev":"8"`, `"dev":"+8"`, 1)},
		{name: "leading zero", input: strings.Replace(valid, `"ino":"12345"`, `"ino":"012345"`, 1)},
		{name: "negative decimal", input: strings.Replace(valid, `"dev":"8"`, `"dev":"-8"`, 1)},
		{name: "oversized content", input: strings.Replace(valid, `"size":"6"`, `"size":"4097"`, 1)},
		{name: "uppercase digest", input: strings.Replace(valid, hex.EncodeToString(digest[:]), strings.ToUpper(hex.EncodeToString(digest[:])), 1)},
		{name: "short digest", input: strings.Replace(valid, hex.EncodeToString(digest[:]), "abcd", 1)},
		{name: "missing expected", input: `{"version":1,"operation":"inspect"}`},
		{name: "oversized request", input: strings.Repeat(" ", maxRequestBytes+1)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := decodeRequest(strings.NewReader(test.input))
			if err == nil || err.code != codeRequestInvalid {
				t.Fatalf("got %v, want %s", err, codeRequestInvalid)
			}
		})
	}
}

func TestVerifyFileIdentityAndContent(t *testing.T) {
	content := []byte("exact marker")
	marker, expected := createMarkerFile(t, content)

	identity, digest, err := verifyFile(marker, expected)
	if err != nil {
		t.Fatalf("valid file rejected: %v", err)
	}
	if identity.Dev != strconv.FormatUint(expected.dev, 10) ||
		identity.Ino != strconv.FormatUint(expected.ino, 10) ||
		identity.Size != strconv.FormatUint(expected.size, 10) {
		t.Fatalf("unexpected identity: %#v", identity)
	}
	if digest != hex.EncodeToString(expected.sha256[:]) {
		t.Fatalf("unexpected digest: %s", digest)
	}

	tests := []struct {
		name   string
		mutate func(*expectedIdentity)
		code   string
	}{
		{name: "wrong dev", mutate: func(value *expectedIdentity) { value.dev++ }, code: codeIdentityMismatch},
		{name: "wrong ino", mutate: func(value *expectedIdentity) { value.ino++ }, code: codeIdentityMismatch},
		{name: "wrong size", mutate: func(value *expectedIdentity) { value.size++ }, code: codeIdentityMismatch},
		{name: "wrong hash", mutate: func(value *expectedIdentity) { value.sha256[0] ^= 0xff }, code: codeContentMismatch},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := expected
			test.mutate(&candidate)
			_, _, err := verifyFile(marker, candidate)
			if err == nil || err.code != test.code {
				t.Fatalf("got %v, want %s", err, test.code)
			}
		})
	}
}

func TestVerifyFileRejectsNonRegular(t *testing.T) {
	directory, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()

	_, _, guardErr := verifyFile(directory, expectedIdentity{})
	if guardErr == nil || guardErr.code != codeNotRegularFile {
		t.Fatalf("got %v, want %s", guardErr, codeNotRegularFile)
	}
}

func TestProtectFilePreservesFlagsAndReadsBack(t *testing.T) {
	marker, expected := createMarkerFile(t, []byte("marker"))
	initial := uint32(0x00200000)
	operations := &fakeFlagOperations{flags: initial}
	caps := capabilities{EffectiveHasLinuxImmutable: true}
	req := request{
		Version:   protocolVersion,
		Operation: operationSetImmutable,
		Expected: expectedInput{
			Dev:    strconv.FormatUint(expected.dev, 10),
			Ino:    strconv.FormatUint(expected.ino, 10),
			Size:   strconv.FormatUint(expected.size, 10),
			SHA256: hex.EncodeToString(expected.sha256[:]),
		},
		expected: expected,
	}

	response, guardErr := protectFile(marker, req, caps, operations)
	if guardErr != nil {
		t.Fatalf("set immutable failed: %v", guardErr)
	}
	if operations.setValue != initial|immutableFlag {
		t.Fatalf("set flags = %#x, want %#x", operations.setValue, initial|immutableFlag)
	}
	if response.FlagsBefore.Raw != strconv.FormatUint(uint64(initial), 10) {
		t.Fatalf("before raw = %s", response.FlagsBefore.Raw)
	}
	if response.FlagsAfter.Raw != strconv.FormatUint(uint64(initial|immutableFlag), 10) || !response.FlagsAfter.Immutable {
		t.Fatalf("after flags = %#v", response.FlagsAfter)
	}
}

func TestProtectFileInspectAllowsUnprotectedMarker(t *testing.T) {
	marker, expected := createMarkerFile(t, []byte("marker"))
	operations := &fakeFlagOperations{}
	req := request{
		Version:   protocolVersion,
		Operation: operationInspect,
		expected:  expected,
	}

	response, guardErr := protectFile(marker, req, capabilities{}, operations)
	if guardErr != nil {
		t.Fatalf("inspect of unprotected marker failed: %v", guardErr)
	}
	if response.FlagsBefore.Immutable || response.FlagsAfter.Immutable {
		t.Fatalf("unprotected marker reported immutable flags: %#v / %#v", response.FlagsBefore, response.FlagsAfter)
	}
	if operations.setCalled {
		t.Fatal("inspect called the SET ioctl")
	}
	object := assertJSONKeys(t, response,
		"version",
		"helperVersion",
		"operation",
		"ok",
		"identity",
		"contentSha256",
		"flagsBefore",
		"flagsAfter",
		"capabilities",
	)
	assertRawJSONKeys(t, object["identity"], "dev", "ino", "size")
	assertRawJSONKeys(t, object["flagsBefore"], "raw", "immutable")
	assertRawJSONKeys(t, object["flagsAfter"], "raw", "immutable")
	assertRawJSONKeys(t, object["capabilities"],
		"effectiveHasLinuxImmutable",
		"permittedHasLinuxImmutable",
		"boundingHasLinuxImmutable",
		"noNewPrivs",
	)
}

func TestProtectFilePermissionAndReadbackFailures(t *testing.T) {
	marker, expected := createMarkerFile(t, []byte("marker"))
	request := request{
		Version:   protocolVersion,
		Operation: operationSetImmutable,
		expected:  expected,
	}

	t.Run("get permission denied", func(t *testing.T) {
		operations := &fakeFlagOperations{getError: syscall.EPERM}
		_, err := protectFile(marker, request, capabilities{EffectiveHasLinuxImmutable: true}, operations)
		if err == nil || err.code != codeFlagsReadFailed {
			t.Fatalf("got %v, want %s", err, codeFlagsReadFailed)
		}
	})

	t.Run("set permission denied", func(t *testing.T) {
		operations := &fakeFlagOperations{setError: syscall.EPERM}
		_, err := protectFile(marker, request, capabilities{EffectiveHasLinuxImmutable: true}, operations)
		if err == nil || err.code != codeSetFlagsFailed {
			t.Fatalf("got %v, want %s", err, codeSetFlagsFailed)
		}
	})

	t.Run("missing capability", func(t *testing.T) {
		operations := &fakeFlagOperations{}
		_, err := protectFile(marker, request, capabilities{}, operations)
		if err == nil || err.code != codeSetFlagsFailed {
			t.Fatalf("got %v, want %s", err, codeSetFlagsFailed)
		}
		if operations.setCalled {
			t.Fatal("SET ioctl was called without effective CAP_LINUX_IMMUTABLE")
		}
	})

	t.Run("readback mismatch", func(t *testing.T) {
		operations := &fakeFlagOperations{ignoreSet: true}
		_, err := protectFile(marker, request, capabilities{EffectiveHasLinuxImmutable: true}, operations)
		if err == nil || err.code != codeFlagsVerifyFailed {
			t.Fatalf("got %v, want %s", err, codeFlagsVerifyFailed)
		}
	})
}

func TestParseCapabilitiesFailsClosed(t *testing.T) {
	status := []byte(
		"Name:\troot\n" +
			"CapEff:\t0000000000000200\n" +
			"CapPrm:\t0000000000000200\n" +
			"CapBnd:\t0000000000000200\n" +
			"NoNewPrivs:\t1\n",
	)
	caps, err := parseCapabilities(status)
	if err != nil {
		t.Fatalf("valid capabilities rejected: %v", err)
	}
	if !caps.EffectiveHasLinuxImmutable || !caps.PermittedHasLinuxImmutable ||
		!caps.BoundingHasLinuxImmutable || !caps.NoNewPrivs {
		t.Fatalf("unexpected capabilities: %#v", caps)
	}

	invalid := []string{
		"CapEff:\t0000000000000200\nCapPrm:\t0000000000000200\nCapBnd:\t0000000000000200\n",
		"CapEff:\tnot-hex\nCapPrm:\t0\nCapBnd:\t0\nNoNewPrivs:\t0\n",
		"CapEff:\t1\nCapEff:\t1\nCapPrm:\t1\nCapBnd:\t1\nNoNewPrivs:\t0\n",
		"CapEff:\t1\nCapPrm:\t1\nCapBnd:\t1\nNoNewPrivs:\t2\n",
	}
	for index, input := range invalid {
		if _, err := parseCapabilities([]byte(input)); err == nil || err.code != codeCapabilitiesReadFailed {
			t.Fatalf("case %d got %v, want %s", index, err, codeCapabilitiesReadFailed)
		}
	}
}

func TestRunWritesOneStableFailureJSONDocument(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run([]string{"sfsc-root-guard", "exec-service"}, strings.NewReader(""), &stdout, &stderr, inheritedMarkerFD)
	if exitCode == 0 {
		t.Fatal("unsupported mode returned success")
	}

	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("stdout has %d lines: %q", len(lines), stdout.String())
	}
	var response failureResponse
	if err := json.Unmarshal([]byte(lines[0]), &response); err != nil {
		t.Fatalf("invalid failure JSON: %v", err)
	}
	if response.Version != protocolVersion || response.HelperVersion != helperVersion ||
		response.OK || response.Error.Code != codeUnsupported {
		t.Fatalf("unexpected failure response: %#v", response)
	}
	if stderr.String() != codeUnsupported+"\n" {
		t.Fatalf("unexpected stderr: %q", stderr.String())
	}
	object := assertJSONKeys(t, response,
		"version",
		"helperVersion",
		"operation",
		"ok",
		"error",
	)
	assertRawJSONKeys(t, object["error"], "code")
}

func createMarkerFile(t *testing.T, content []byte) (*os.File, expectedIdentity) {
	t.Helper()
	path := t.TempDir() + "/marker"
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	marker, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = marker.Close() })

	var stat syscall.Stat_t
	if err := syscall.Fstat(int(marker.Fd()), &stat); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	return marker, expectedIdentity{
		dev:    uint64(stat.Dev),
		ino:    uint64(stat.Ino),
		size:   uint64(len(content)),
		sha256: digest,
	}
}

type fakeFlagOperations struct {
	flags      uint32
	getError   error
	setError   error
	ignoreSet  bool
	setCalled  bool
	setValue   uint32
	getCounter int
}

func (f *fakeFlagOperations) Get(_ uintptr) (uint32, error) {
	f.getCounter++
	if f.getError != nil {
		return 0, f.getError
	}
	return f.flags, nil
}

func (f *fakeFlagOperations) Set(_ uintptr, flags uint32) error {
	f.setCalled = true
	f.setValue = flags
	if f.setError != nil {
		return f.setError
	}
	if !f.ignoreSet {
		f.flags = flags
	}
	return nil
}

func TestGuardErrorNeverIncludesErrnoText(t *testing.T) {
	err := fail(codeFlagsReadFailed)
	if errors.Is(err, syscall.EPERM) || strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("error leaked errno text: %v", err)
	}
}

func assertJSONKeys(t *testing.T, value any, expected ...string) map[string]json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &object); err != nil {
		t.Fatal(err)
	}
	if len(object) != len(expected) {
		t.Fatalf("JSON has %d keys, want %d: %s", len(object), len(expected), encoded)
	}
	for _, key := range expected {
		if _, ok := object[key]; !ok {
			t.Fatalf("JSON missing key %q: %s", key, encoded)
		}
	}
	return object
}

func assertRawJSONKeys(t *testing.T, raw json.RawMessage, expected ...string) {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatalf("invalid nested JSON object: %v", err)
	}
	if len(object) != len(expected) {
		t.Fatalf("nested JSON has %d keys, want %d: %s", len(object), len(expected), raw)
	}
	for _, key := range expected {
		if _, ok := object[key]; !ok {
			t.Fatalf("nested JSON missing key %q: %s", key, raw)
		}
	}
}
