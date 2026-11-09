//go:build linux && (amd64 || arm64)

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	helperVersion         = "1"
	protocolVersion       = 1
	maxContentBytes       = 4096
	maxRequestBytes       = 8192
	maxProcStatusBytes    = 1 << 20
	inheritedMarkerFD     = 3
	immutableFlag         = uint32(0x00000010)
	capLinuxImmutable     = uint32(9)
	fsIOCGetFlags         = uintptr(0x80086601)
	fsIOCSetFlags         = uintptr(0x40086602)
	protectFDMode         = "protect-fd"
	operationInspect      = "inspect"
	operationSetImmutable = "set_immutable"
)

const (
	codeRequestInvalid         = "request_invalid"
	codeFDInvalid              = "fd_invalid"
	codeNotRegularFile         = "not_regular_file"
	codeIdentityMismatch       = "identity_mismatch"
	codeContentMismatch        = "content_mismatch"
	codeFlagsReadFailed        = "flags_read_failed"
	codeSetFlagsFailed         = "set_flags_failed"
	codeFlagsVerifyFailed      = "flags_verify_failed"
	codeCapabilitiesReadFailed = "capabilities_read_failed"
	codeUnsupported            = "unsupported"
)

type request struct {
	Version   int           `json:"version"`
	Operation string        `json:"operation"`
	Expected  expectedInput `json:"expected"`
	expected  expectedIdentity
}

type expectedInput struct {
	Dev    string `json:"dev"`
	Ino    string `json:"ino"`
	Size   string `json:"size"`
	SHA256 string `json:"sha256"`
}

type expectedIdentity struct {
	dev    uint64
	ino    uint64
	size   uint64
	sha256 [sha256.Size]byte
}

type fileIdentity struct {
	Dev  string `json:"dev"`
	Ino  string `json:"ino"`
	Size string `json:"size"`
}

type flagState struct {
	Raw       string `json:"raw"`
	Immutable bool   `json:"immutable"`
}

type capabilities struct {
	EffectiveHasLinuxImmutable bool `json:"effectiveHasLinuxImmutable"`
	PermittedHasLinuxImmutable bool `json:"permittedHasLinuxImmutable"`
	BoundingHasLinuxImmutable  bool `json:"boundingHasLinuxImmutable"`
	NoNewPrivs                 bool `json:"noNewPrivs"`
}

type successResponse struct {
	Version       int          `json:"version"`
	HelperVersion string       `json:"helperVersion"`
	Operation     string       `json:"operation"`
	OK            bool         `json:"ok"`
	Identity      fileIdentity `json:"identity"`
	ContentSHA256 string       `json:"contentSha256"`
	FlagsBefore   flagState    `json:"flagsBefore"`
	FlagsAfter    flagState    `json:"flagsAfter"`
	Capabilities  capabilities `json:"capabilities"`
}

// Failure responses intentionally use a separate fixed schema. Error code
// values are stable protocol values; messages and raw errno text are omitted.
type failureResponse struct {
	Version       int         `json:"version"`
	HelperVersion string      `json:"helperVersion"`
	Operation     string      `json:"operation"`
	OK            bool        `json:"ok"`
	Error         failureBody `json:"error"`
}

type failureBody struct {
	Code string `json:"code"`
}

type guardError struct {
	code string
}

func (e *guardError) Error() string {
	return e.code
}

type flagOperations interface {
	Get(fd uintptr) (uint32, error)
	Set(fd uintptr, flags uint32) error
}

type linuxFlagOperations struct{}

func main() {
	if len(os.Args) == 2 && os.Args[1] == execServiceV2Mode {
		os.Exit(runExecServiceV2(os.Args, os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) == 2 && os.Args[1] == execServiceMode {
		os.Exit(runExecService(os.Args, os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) == 2 && os.Args[1] == signalServiceMode {
		os.Exit(runSignalService(os.Args, os.Stdin, os.Stdout, os.Stderr))
	}
	os.Exit(run(os.Args, os.Stdin, os.Stdout, os.Stderr, inheritedMarkerFD))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer, markerFD uintptr) int {
	operation := ""
	fail := func(code string) int {
		if err := writeFailure(stdout, operation, code); err != nil {
			return 2
		}
		_, _ = fmt.Fprintln(stderr, code)
		return 2
	}

	if len(args) != 2 || args[1] != protectFDMode {
		if len(args) == 2 && args[1] == "exec-service" {
			return fail(codeUnsupported)
		}
		return fail(codeRequestInvalid)
	}

	req, err := decodeRequest(stdin)
	if err != nil {
		return fail(err.code)
	}
	operation = req.Operation

	caps, err := readCapabilities("/proc/self/status")
	if err != nil {
		return fail(err.code)
	}

	marker := os.NewFile(markerFD, "sfsc-inherited-marker")
	if marker == nil {
		return fail(codeFDInvalid)
	}
	defer runtime.KeepAlive(marker)
	// The inherited descriptor is owned by this short-lived helper process.
	// It is deliberately not closed here; process exit closes it without any
	// path lookup or descriptor-number reuse.

	resp, guardErr := protectFile(marker, req, caps, linuxFlagOperations{})
	if guardErr != nil {
		return fail(guardErr.code)
	}
	if err := writeJSON(stdout, resp); err != nil {
		return 2
	}
	return 0
}

func decodeRequest(r io.Reader) (request, *guardError) {
	var req request
	limited := &io.LimitedReader{R: r, N: maxRequestBytes + 1}
	data, err := io.ReadAll(limited)
	if err != nil || len(data) > maxRequestBytes {
		return req, fail(codeRequestInvalid)
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&req); err != nil {
		return request{}, fail(codeRequestInvalid)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return request{}, fail(codeRequestInvalid)
	}
	if req.Version != protocolVersion {
		return request{}, fail(codeRequestInvalid)
	}
	if req.Operation != operationInspect && req.Operation != operationSetImmutable {
		return request{}, fail(codeRequestInvalid)
	}

	expected, guardErr := parseExpectedIdentity(req.Expected)
	if guardErr != nil {
		return request{}, guardErr
	}
	req.expected = expected
	return req, nil
}

func (r *request) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("request must be an object")
	}

	seen := make(map[string]bool)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := keyToken.(string)
		if !ok {
			return errors.New("request key must be a string")
		}
		if seen[key] {
			return errors.New("duplicate request field")
		}
		seen[key] = true

		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return err
		}
		switch key {
		case "version":
			if err := json.Unmarshal(raw, &r.Version); err != nil {
				return err
			}
		case "operation":
			if err := json.Unmarshal(raw, &r.Operation); err != nil {
				return err
			}
		case "expected":
			if err := json.Unmarshal(raw, &r.Expected); err != nil {
				return err
			}
		default:
			return errors.New("unknown request field")
		}
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	if err := ensureDecoderEOF(decoder); err != nil {
		return err
	}
	for _, key := range []string{"version", "operation", "expected"} {
		if !seen[key] {
			return errors.New("missing request field")
		}
	}
	return nil
}

func (e *expectedInput) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("expected must be an object")
	}

	seen := make(map[string]bool)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := keyToken.(string)
		if !ok {
			return errors.New("expected key must be a string")
		}
		if seen[key] {
			return errors.New("duplicate expected field")
		}
		seen[key] = true

		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return err
		}
		switch key {
		case "dev":
			if err := json.Unmarshal(raw, &e.Dev); err != nil {
				return err
			}
		case "ino":
			if err := json.Unmarshal(raw, &e.Ino); err != nil {
				return err
			}
		case "size":
			if err := json.Unmarshal(raw, &e.Size); err != nil {
				return err
			}
		case "sha256":
			if err := json.Unmarshal(raw, &e.SHA256); err != nil {
				return err
			}
		default:
			return errors.New("unknown expected field")
		}
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	if err := ensureDecoderEOF(decoder); err != nil {
		return err
	}
	for _, key := range []string{"dev", "ino", "size", "sha256"} {
		if !seen[key] {
			return errors.New("missing expected field")
		}
	}
	return nil
}

func ensureDecoderEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func parseExpectedIdentity(input expectedInput) (expectedIdentity, *guardError) {
	dev, ok := parseCanonicalDecimal(input.Dev)
	if !ok {
		return expectedIdentity{}, fail(codeRequestInvalid)
	}
	ino, ok := parseCanonicalDecimal(input.Ino)
	if !ok {
		return expectedIdentity{}, fail(codeRequestInvalid)
	}
	size, ok := parseCanonicalDecimal(input.Size)
	if !ok || size > maxContentBytes {
		return expectedIdentity{}, fail(codeRequestInvalid)
	}
	if len(input.SHA256) != sha256.Size*2 || strings.ToLower(input.SHA256) != input.SHA256 {
		return expectedIdentity{}, fail(codeRequestInvalid)
	}
	shaBytes, err := hex.DecodeString(input.SHA256)
	if err != nil || len(shaBytes) != sha256.Size {
		return expectedIdentity{}, fail(codeRequestInvalid)
	}

	var digest [sha256.Size]byte
	copy(digest[:], shaBytes)
	return expectedIdentity{
		dev:    dev,
		ino:    ino,
		size:   size,
		sha256: digest,
	}, nil
}

func parseCanonicalDecimal(value string) (uint64, bool) {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return 0, false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, false
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	return parsed, err == nil
}

func protectFile(marker *os.File, req request, caps capabilities, operations flagOperations) (successResponse, *guardError) {
	identity, contentSHA, err := verifyFile(marker, req.expected)
	if err != nil {
		return successResponse{}, err
	}

	fd := marker.Fd()
	before, ioctlErr := operations.Get(fd)
	if ioctlErr != nil {
		return successResponse{}, fail(codeFlagsReadFailed)
	}

	var after uint32
	switch req.Operation {
	case operationInspect:
		_, _, err = verifyFile(marker, req.expected)
		if err != nil {
			return successResponse{}, err
		}
		after, ioctlErr = operations.Get(fd)
		if ioctlErr != nil {
			return successResponse{}, fail(codeFlagsReadFailed)
		}
		if after != before {
			return successResponse{}, fail(codeFlagsVerifyFailed)
		}
	case operationSetImmutable:
		if !caps.EffectiveHasLinuxImmutable {
			return successResponse{}, fail(codeSetFlagsFailed)
		}
		desired := before | immutableFlag
		if ioctlErr := operations.Set(fd, desired); ioctlErr != nil {
			return successResponse{}, fail(codeSetFlagsFailed)
		}
		_, _, err = verifyFile(marker, req.expected)
		if err != nil {
			return successResponse{}, err
		}
		after, ioctlErr = operations.Get(fd)
		if ioctlErr != nil {
			return successResponse{}, fail(codeFlagsReadFailed)
		}
		if after != desired {
			return successResponse{}, fail(codeFlagsVerifyFailed)
		}
	default:
		return successResponse{}, fail(codeRequestInvalid)
	}

	identity, contentSHA, err = verifyFile(marker, req.expected)
	if err != nil {
		return successResponse{}, err
	}
	if req.Operation == operationSetImmutable && !flagEnabled(after, immutableFlag) {
		return successResponse{}, fail(codeFlagsVerifyFailed)
	}

	return successResponse{
		Version:       protocolVersion,
		HelperVersion: helperVersion,
		Operation:     req.Operation,
		OK:            true,
		Identity:      identity,
		ContentSHA256: contentSHA,
		FlagsBefore:   flagStateFromRaw(before),
		FlagsAfter:    flagStateFromRaw(after),
		Capabilities:  caps,
	}, nil
}

func verifyFile(marker *os.File, expected expectedIdentity) (fileIdentity, string, *guardError) {
	before, err := statExpectedFile(marker, expected)
	if err != nil {
		return fileIdentity{}, "", err
	}

	content, readErr := readExactContent(marker, expected.size)
	if readErr != nil {
		return fileIdentity{}, "", fail(codeContentMismatch)
	}
	after, err := statExpectedFile(marker, expected)
	if err != nil {
		return fileIdentity{}, "", err
	}
	if before != after {
		return fileIdentity{}, "", fail(codeIdentityMismatch)
	}

	digest := sha256.Sum256(content)
	if digest != expected.sha256 {
		return fileIdentity{}, "", fail(codeContentMismatch)
	}
	return after, hex.EncodeToString(digest[:]), nil
}

func statExpectedFile(marker *os.File, expected expectedIdentity) (fileIdentity, *guardError) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(marker.Fd()), &stat); err != nil {
		return fileIdentity{}, fail(codeFDInvalid)
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return fileIdentity{}, fail(codeNotRegularFile)
	}
	if stat.Size < 0 ||
		uint64(stat.Dev) != expected.dev ||
		uint64(stat.Ino) != expected.ino ||
		uint64(stat.Size) != expected.size {
		return fileIdentity{}, fail(codeIdentityMismatch)
	}
	return fileIdentity{
		Dev:  strconv.FormatUint(uint64(stat.Dev), 10),
		Ino:  strconv.FormatUint(uint64(stat.Ino), 10),
		Size: strconv.FormatUint(uint64(stat.Size), 10),
	}, nil
}

func readExactContent(marker *os.File, size uint64) ([]byte, error) {
	content := make([]byte, int(size))
	offset := 0
	for offset < len(content) {
		read, err := marker.ReadAt(content[offset:], int64(offset))
		offset += read
		if err != nil {
			return nil, err
		}
		if read == 0 {
			return nil, io.ErrNoProgress
		}
	}

	var extra [1]byte
	read, err := marker.ReadAt(extra[:], int64(size))
	if read != 0 {
		return nil, errors.New("file exceeds expected size")
	}
	if err != nil && err != io.EOF {
		return nil, err
	}
	return content, nil
}

func (linuxFlagOperations) Get(fd uintptr) (uint32, error) {
	var flags uint32
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, fsIOCGetFlags, uintptr(unsafe.Pointer(&flags)))
	runtime.KeepAlive(&flags)
	if errno != 0 {
		return 0, errno
	}
	return flags, nil
}

func (linuxFlagOperations) Set(fd uintptr, flags uint32) error {
	value := flags
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, fsIOCSetFlags, uintptr(unsafe.Pointer(&value)))
	runtime.KeepAlive(&value)
	if errno != 0 {
		return errno
	}
	return nil
}

func readCapabilities(path string) (capabilities, *guardError) {
	file, err := os.Open(path)
	if err != nil {
		return capabilities{}, fail(codeCapabilitiesReadFailed)
	}
	defer file.Close()

	status, err := io.ReadAll(io.LimitReader(file, maxProcStatusBytes+1))
	if err != nil || len(status) > maxProcStatusBytes {
		return capabilities{}, fail(codeCapabilitiesReadFailed)
	}
	return parseCapabilities(status)
}

func parseCapabilities(status []byte) (capabilities, *guardError) {
	values := make(map[string]string)
	for _, line := range strings.Split(string(status), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch key {
		case "CapEff", "CapPrm", "CapBnd", "NoNewPrivs":
			if _, duplicate := values[key]; duplicate {
				return capabilities{}, fail(codeCapabilitiesReadFailed)
			}
			values[key] = strings.TrimSpace(value)
		}
	}
	for _, key := range []string{"CapEff", "CapPrm", "CapBnd", "NoNewPrivs"} {
		if values[key] == "" {
			return capabilities{}, fail(codeCapabilitiesReadFailed)
		}
	}

	effective, ok := parseCapabilityMask(values["CapEff"])
	if !ok {
		return capabilities{}, fail(codeCapabilitiesReadFailed)
	}
	permitted, ok := parseCapabilityMask(values["CapPrm"])
	if !ok {
		return capabilities{}, fail(codeCapabilitiesReadFailed)
	}
	bounding, ok := parseCapabilityMask(values["CapBnd"])
	if !ok {
		return capabilities{}, fail(codeCapabilitiesReadFailed)
	}
	noNewPrivs, ok := parseBooleanFlag(values["NoNewPrivs"])
	if !ok {
		return capabilities{}, fail(codeCapabilitiesReadFailed)
	}

	bit := uint64(1) << capLinuxImmutable
	return capabilities{
		EffectiveHasLinuxImmutable: effective&bit != 0,
		PermittedHasLinuxImmutable: permitted&bit != 0,
		BoundingHasLinuxImmutable:  bounding&bit != 0,
		NoNewPrivs:                 noNewPrivs,
	}, nil
}

func parseCapabilityMask(value string) (uint64, bool) {
	if value == "" {
		return 0, false
	}
	for _, char := range value {
		if (char < '0' || char > '9') &&
			(char < 'a' || char > 'f') &&
			(char < 'A' || char > 'F') {
			return 0, false
		}
	}
	parsed, err := strconv.ParseUint(value, 16, 64)
	return parsed, err == nil
}

func parseBooleanFlag(value string) (bool, bool) {
	switch value {
	case "0":
		return false, true
	case "1":
		return true, true
	default:
		return false, false
	}
}

func flagStateFromRaw(raw uint32) flagState {
	return flagState{
		Raw:       strconv.FormatUint(uint64(raw), 10),
		Immutable: flagEnabled(raw, immutableFlag),
	}
}

func flagEnabled(flags, flag uint32) bool {
	return flags&flag != 0
}

func writeFailure(stdout io.Writer, operation, code string) error {
	return writeJSON(stdout, failureResponse{
		Version:       protocolVersion,
		HelperVersion: helperVersion,
		Operation:     operation,
		OK:            false,
		Error:         failureBody{Code: code},
	})
}

func writeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func fail(code string) *guardError {
	return &guardError{code: code}
}
