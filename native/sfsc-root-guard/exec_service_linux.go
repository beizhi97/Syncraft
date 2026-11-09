//go:build linux && (amd64 || arm64)

package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"
)

const (
	execServiceMode = "exec-service"

	execRequestMaxBytes  = 64 << 10
	execReadyMaxBytes    = 4 << 10
	execGoMaxBytes       = 512
	execFailureMaxBytes  = 4 << 10
	execRcloneMaxBytes   = 256 << 20
	execProcStatMaxBytes = 64 << 10

	execRequestTimeout     = 5 * time.Second
	execReadyWriteTimeout  = 2 * time.Second
	execGoTimeout          = 10 * time.Second
	execGoEOFTimeout       = time.Second
	execControlWriteTimout = 2 * time.Second

	execRcloneFD   = 3
	execHelperFD   = 4
	execProtocolFD = 10
	execControlFD  = 10

	linuxCapabilityVersion3 = 0x20080522
	prSetPDeathSig          = 0x1
	prGetPDeathSig          = 0x2
	prCapBSetRead           = 0x17
	prCapBSetDrop           = 0x18
	prSetNoNewPrivs         = 0x26
	prGetNoNewPrivs         = 0x27
	prCapAmbient            = 0x2f
	prCapAmbientIsSet       = 0x1
	prCapAmbientClearAll    = 0x4

	closeRangeUnshare = 0x2
	closeRangeCloexec = 0x4
	sysCloseRange     = 436

	pollOut   = 0x0004
	pollErr   = 0x0008
	pollHup   = 0x0010
	pollNVal  = 0x0020
	clockMono = 1

	execCodeRequestInvalid   = "request_invalid"
	execCodeRequestTimeout   = "request_timeout"
	execCodeControlFDFailed  = "control_fd_failed"
	execCodeFDInvalid        = "fd_invalid"
	execCodeRcloneNotRegular = "rclone_not_regular"
	execCodeRcloneIdentity   = "rclone_identity_mismatch"
	execCodeRcloneDigest     = "rclone_digest_mismatch"
	execCodeRcloneAttributes = "rclone_attributes_invalid"
	execCodeParentChanged    = "parent_changed"
	execCodePDeathSigFailed  = "pdeathsig_failed"
	execCodeCapabilityDrop   = "capability_drop_failed"
	execCodeCapabilityVerify = "capability_verify_failed"
	execCodeNoNewPrivs       = "no_new_privs_failed"
	execCodeReadyWrite       = "ready_write_failed"
	execCodeGoTimeout        = "go_timeout"
	execCodeGoInvalid        = "go_invalid"
	execCodeFDHygiene        = "fd_hygiene_failed"
	execCodeRedirection      = "redirection_failed"
	execCodeExec             = "exec_failed"
)

var execFailedFrame = []byte(
	`{"version":1,"helperVersion":"1","operation":"exec-service","ok":false,"error":{"code":"exec_failed"}}` + "\n",
)

var execFDHygieneFailedFrame = []byte(
	`{"version":1,"helperVersion":"1","operation":"exec-service","ok":false,"error":{"code":"fd_hygiene_failed"}}` + "\n",
)

var execRedirectionFailedFrame = []byte(
	`{"version":1,"helperVersion":"1","operation":"exec-service","ok":false,"error":{"code":"redirection_failed"}}` + "\n",
)

var serviceV2ExecFailedFrame = []byte(`{"version":2,"helperVersion":"1","operation":"exec-service-v2","ok":false,"error":{"code":"exec_failed"}}` + "\n")
var serviceV2FDHygieneFailedFrame = []byte(`{"version":2,"helperVersion":"1","operation":"exec-service-v2","ok":false,"error":{"code":"fd_hygiene_failed"}}` + "\n")
var serviceV2RedirectionFailedFrame = []byte(`{"version":2,"helperVersion":"1","operation":"exec-service-v2","ok":false,"error":{"code":"redirection_failed"}}` + "\n")

type execServiceFailureFrames struct {
	writeFailure func(*os.File, string) int
	redirection  []byte
	hygiene      []byte
	exec         []byte
}

func execServiceV1FailureFrames() execServiceFailureFrames {
	return execServiceFailureFrames{writeFailure: writeExecServiceFailure, redirection: execRedirectionFailedFrame, hygiene: execFDHygieneFailedFrame, exec: execFailedFrame}
}

func execServiceV2FailureFrames() execServiceFailureFrames {
	return execServiceFailureFrames{writeFailure: writeServiceV2Failure, redirection: serviceV2RedirectionFailedFrame, hygiene: serviceV2FDHygieneFailedFrame, exec: serviceV2ExecFailedFrame}
}

type execServiceParentInput struct {
	PID       string `json:"pid"`
	StartTime string `json:"starttime"`
}

type execServiceRcloneInput struct {
	Dev    string `json:"dev"`
	Ino    string `json:"ino"`
	Size   string `json:"size"`
	SHA256 string `json:"sha256"`
}

type execServiceListenerInput struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type execServiceRequest struct {
	Version   int                      `json:"version"`
	Operation string                   `json:"operation"`
	Token     string                   `json:"token"`
	Parent    execServiceParentInput   `json:"parent"`
	Rclone    execServiceRcloneInput   `json:"rclone"`
	Listener  execServiceListenerInput `json:"listener"`
	Argv      []string                 `json:"argv"`
	parent    execServiceParsedParent  `json:"-"`
	rclone    execServiceParsedRclone  `json:"-"`
}

type execServiceParsedParent struct {
	pid       uint64
	startTime uint64
}

type execServiceParsedRclone struct {
	dev    uint64
	ino    uint64
	size   uint64
	sha256 [sha256.Size]byte
}

type execServiceGoRequest struct {
	Version   int    `json:"version"`
	Operation string `json:"operation"`
	Token     string `json:"token"`
}

type execServiceFileIdentity struct {
	Dev    string `json:"dev"`
	Ino    string `json:"ino"`
	Size   string `json:"size"`
	SHA256 string `json:"sha256"`
}

type execServiceListener struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type execServiceCapabilities struct {
	Effective      string `json:"effective"`
	Permitted      string `json:"permitted"`
	Inheritable    string `json:"inheritable"`
	Bounding       string `json:"bounding"`
	Ambient        string `json:"ambient"`
	NoNewPrivs     bool   `json:"noNewPrivs"`
	ParentDeathSig string `json:"parentDeathSignal"`
}

type execServiceReadyResponse struct {
	Version       int                     `json:"version"`
	HelperVersion string                  `json:"helperVersion"`
	Operation     string                  `json:"operation"`
	OK            bool                    `json:"ok"`
	State         string                  `json:"state"`
	Token         string                  `json:"token"`
	PID           string                  `json:"pid"`
	StartTime     string                  `json:"starttime"`
	ParentPID     string                  `json:"parentPid"`
	Rclone        execServiceFileIdentity `json:"rclone"`
	Listener      execServiceListener     `json:"listener"`
	Capabilities  execServiceCapabilities `json:"capabilities"`
}

type execServiceFailureResponse struct {
	Version       int                    `json:"version"`
	HelperVersion string                 `json:"helperVersion"`
	Operation     string                 `json:"operation"`
	OK            bool                   `json:"ok"`
	Error         execServiceFailureBody `json:"error"`
}

type execServiceFailureBody struct {
	Code string `json:"code"`
}

type execServiceError struct {
	code string
}

func (e *execServiceError) Error() string {
	return e.code
}

type execServiceProcStat struct {
	PID       uint64
	PPid      uint64
	StartTime uint64
}

type execServiceCapHeader struct {
	Version uint32
	PID     int32
}

type execServiceCapData struct {
	Effective   uint32
	Permitted   uint32
	Inheritable uint32
}

type execServicePollFD struct {
	FD      int32
	Events  int16
	Revents int16
}

type execvePayload struct {
	path     []byte
	argBlock []byte
	envBlock []byte
	argv     []uintptr
	envp     []uintptr
}

type execServiceHooks struct {
	lockOSThread func()
	getpid       func() int
	getppid      func() int
	getenv       func(string) string
	readFile     func(string) ([]byte, error)
	fstat        func(int, *syscall.Stat_t) error
	fgetxattr    func(int, string) (int, error)
	fcntl        func(int, int, int) (int, error)
	prctl        func(int, uintptr, uintptr, uintptr, uintptr) (int, error)
	getPDeathSig func() (int32, error)
	capget       func(*execServiceCapHeader, *[2]execServiceCapData) error
	capset       func(*execServiceCapHeader, *[2]execServiceCapData) error
	closeRange   func(uintptr, uintptr, uintptr) syscall.Errno
	open         func(string, int, uint32) (int, error)
	dup3         func(int, int, int) error
	close        func(int) error
	pread        func(int, []byte, int64) (int, error)
	rawFailure   func(int, []byte)
	rawTail      func(int, *execvePayload, []byte)
}

func runExecService(args []string, stdin, stdout, stderr *os.File) int {
	return runExecServiceWithHooks(args, stdin, stdout, stderr, linuxExecServiceHooks())
}

func runExecServiceWithHooks(args []string, stdin, stdout, stderr *os.File, hooks execServiceHooks) int {
	hooks.lockOSThread()
	_ = stderr

	if len(args) != 2 || args[1] != execServiceMode {
		return writeExecServiceFailure(stdout, execCodeRequestInvalid)
	}

	protocolStdin, protocolStdout, protocolErr := prepareExecServiceProtocolFiles(stdin, stdout, hooks)
	if protocolErr != nil {
		return writeExecServiceFailure(stdout, protocolErr.code)
	}
	defer protocolStdin.Close()
	defer protocolStdout.Close()

	fail := func(code string) int {
		return writeExecServiceFailure(protocolStdout, code)
	}

	reader := bufio.NewReaderSize(protocolStdin, execRequestMaxBytes+2)
	requestFrame, frameErr := readExecServiceFrame(protocolStdin, reader, execRequestMaxBytes, execRequestTimeout)
	if frameErr != nil {
		if frameErr.code == execCodeRequestTimeout {
			return fail(execCodeRequestTimeout)
		}
		return fail(execCodeRequestInvalid)
	}

	request, reqErr := decodeExecServiceRequest(requestFrame)
	if reqErr != nil {
		return fail(reqErr.code)
	}
	if hooks.getenv("SFSC_SERVICE_TOKEN") != request.Token {
		return fail(execCodeRequestInvalid)
	}

	if _, err := hooks.prctl(prSetPDeathSig, uintptr(syscall.SIGKILL), 0, 0, 0); err != nil {
		return fail(execCodePDeathSigFailed)
	}
	selfStat, guardErr := checkExecServiceParent(request.parent, hooks)
	if guardErr != nil {
		return fail(guardErr.code)
	}

	if _, guardErr = verifyExecServiceRclone(execRcloneFD, request.rclone, hooks); guardErr != nil {
		return fail(guardErr.code)
	}
	capLast, guardErr := readExecServiceCapLast(hooks)
	if guardErr != nil {
		return fail(guardErr.code)
	}
	if guardErr = dropExecServiceCapabilities(capLast, hooks); guardErr != nil {
		return fail(guardErr.code)
	}
	if guardErr = verifyExecServiceSecurity(capLast, hooks); guardErr != nil {
		return fail(guardErr.code)
	}
	if _, guardErr = checkExecServiceParent(request.parent, hooks); guardErr != nil {
		return fail(guardErr.code)
	}
	if _, guardErr = verifyExecServiceRclone(execRcloneFD, request.rclone, hooks); guardErr != nil {
		return fail(guardErr.code)
	}

	ready := execServiceReadyResponse{
		Version:       protocolVersion,
		HelperVersion: helperVersion,
		Operation:     execServiceMode,
		OK:            true,
		State:         "ready",
		Token:         request.Token,
		PID:           strconv.Itoa(hooks.getpid()),
		StartTime:     strconv.FormatUint(selfStat.StartTime, 10),
		ParentPID:     strconv.Itoa(hooks.getppid()),
		Rclone: execServiceFileIdentity{
			Dev:    request.Rclone.Dev,
			Ino:    request.Rclone.Ino,
			Size:   request.Rclone.Size,
			SHA256: request.Rclone.SHA256,
		},
		Listener: execServiceListener{
			Host: request.Listener.Host,
			Port: request.Listener.Port,
		},
		Capabilities: execServiceCapabilities{
			Effective:      "0",
			Permitted:      "0",
			Inheritable:    "0",
			Bounding:       "0",
			Ambient:        "0",
			NoNewPrivs:     true,
			ParentDeathSig: "SIGKILL",
		},
	}
	if err := writeExecServiceJSONFrame(protocolStdout, ready, execReadyMaxBytes, execReadyWriteTimeout); err != nil {
		return fail(execCodeReadyWrite)
	}

	goFrame, frameErr := readExecServiceFrame(protocolStdin, reader, execGoMaxBytes, execGoTimeout)
	if frameErr != nil {
		if frameErr.code == execCodeRequestTimeout {
			return fail(execCodeGoTimeout)
		}
		return fail(execCodeGoInvalid)
	}
	goRequest, goErr := decodeExecServiceGo(goFrame)
	if goErr != nil || goRequest.Token != request.Token {
		return fail(execCodeGoInvalid)
	}
	if err := requireExecServiceEOF(protocolStdin, reader, execGoEOFTimeout); err != nil {
		return fail(execCodeGoInvalid)
	}

	if guardErr = verifyExecServiceSecurity(capLast, hooks); guardErr != nil {
		return fail(guardErr.code)
	}
	if _, guardErr = checkExecServiceParent(request.parent, hooks); guardErr != nil {
		return fail(guardErr.code)
	}
	if _, guardErr = verifyExecServiceRclone(execRcloneFD, request.rclone, hooks); guardErr != nil {
		return fail(guardErr.code)
	}

	return executeExecService(protocolStdout, request, hooks)
}

func prepareExecServiceProtocolFiles(stdin, stdout *os.File, hooks execServiceHooks) (*os.File, *os.File, *execServiceError) {
	inputFD, err := hooks.fcntl(int(stdin.Fd()), syscall.F_DUPFD_CLOEXEC, execProtocolFD)
	if err != nil {
		return nil, nil, execServiceFail(execCodeFDInvalid)
	}
	if err := setExecServiceNonblocking(inputFD, hooks); err != nil {
		_ = hooks.close(inputFD)
		return nil, nil, execServiceFail(execCodeFDInvalid)
	}

	outputFD, err := hooks.fcntl(int(stdout.Fd()), syscall.F_DUPFD_CLOEXEC, execProtocolFD)
	if err != nil {
		_ = hooks.close(inputFD)
		return nil, nil, execServiceFail(execCodeControlFDFailed)
	}
	if err := setExecServiceNonblocking(outputFD, hooks); err != nil {
		_ = hooks.close(inputFD)
		_ = hooks.close(outputFD)
		return nil, nil, execServiceFail(execCodeControlFDFailed)
	}

	input := os.NewFile(uintptr(inputFD), "sfsc-exec-stdin")
	output := os.NewFile(uintptr(outputFD), "sfsc-exec-stdout")
	if input == nil {
		_ = hooks.close(inputFD)
		_ = hooks.close(outputFD)
		return nil, nil, execServiceFail(execCodeControlFDFailed)
	}
	if output == nil {
		_ = input.Close()
		return nil, nil, execServiceFail(execCodeControlFDFailed)
	}
	if err := input.SetReadDeadline(time.Time{}); err != nil {
		_ = input.Close()
		_ = output.Close()
		return nil, nil, execServiceFail(execCodeFDInvalid)
	}
	if err := output.SetWriteDeadline(time.Time{}); err != nil {
		_ = input.Close()
		_ = output.Close()
		return nil, nil, execServiceFail(execCodeControlFDFailed)
	}
	return input, output, nil
}

func setExecServiceNonblocking(fd int, hooks execServiceHooks) error {
	flags, err := hooks.fcntl(fd, syscall.F_GETFL, 0)
	if err != nil || flags < 0 {
		return errors.New("read file status flags")
	}
	if _, err := hooks.fcntl(fd, syscall.F_SETFL, flags|syscall.O_NONBLOCK); err != nil {
		return err
	}
	return nil
}

func decodeExecServiceRequest(data []byte) (execServiceRequest, *execServiceError) {
	var request execServiceRequest
	if len(data) == 0 || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return request, execServiceFail(execCodeRequestInvalid)
	}
	if err := json.Unmarshal(data, &request); err != nil {
		return execServiceRequest{}, execServiceFail(execCodeRequestInvalid)
	}
	if request.Version != protocolVersion || request.Operation != "launch" || !validExecServiceToken(request.Token) {
		return execServiceRequest{}, execServiceFail(execCodeRequestInvalid)
	}

	parent, ok := parseExecServiceParent(request.Parent)
	if !ok {
		return execServiceRequest{}, execServiceFail(execCodeRequestInvalid)
	}
	rclone, ok := parseExecServiceRclone(request.Rclone)
	if !ok {
		return execServiceRequest{}, execServiceFail(execCodeRequestInvalid)
	}
	if request.Listener.Host != "127.0.0.1" || request.Listener.Port < 1 || request.Listener.Port > 65535 {
		return execServiceRequest{}, execServiceFail(execCodeRequestInvalid)
	}
	if !validExecServiceArgv(request.Argv, request.Listener.Port) {
		return execServiceRequest{}, execServiceFail(execCodeRequestInvalid)
	}

	request.parent = parent
	request.rclone = rclone
	return request, nil
}

func decodeExecServiceGo(data []byte) (execServiceGoRequest, *execServiceError) {
	var request execServiceGoRequest
	if len(data) == 0 || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return request, execServiceFail(execCodeGoInvalid)
	}
	if err := json.Unmarshal(data, &request); err != nil {
		return execServiceGoRequest{}, execServiceFail(execCodeGoInvalid)
	}
	if request.Version != protocolVersion || request.Operation != "go" || !validExecServiceToken(request.Token) {
		return execServiceGoRequest{}, execServiceFail(execCodeGoInvalid)
	}
	return request, nil
}

func (r *execServiceRequest) UnmarshalJSON(data []byte) error {
	return decodeExecServiceObject(data, []string{"version", "operation", "token", "parent", "rclone", "listener", "argv"}, map[string]func(json.RawMessage) error{
		"version":   func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Version) },
		"operation": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Operation) },
		"token":     func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Token) },
		"parent":    func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Parent) },
		"rclone":    func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Rclone) },
		"listener":  func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Listener) },
		"argv":      func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Argv) },
	})
}

func (r *execServiceGoRequest) UnmarshalJSON(data []byte) error {
	return decodeExecServiceObject(data, []string{"version", "operation", "token"}, map[string]func(json.RawMessage) error{
		"version":   func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Version) },
		"operation": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Operation) },
		"token":     func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Token) },
	})
}

func (r *execServiceParentInput) UnmarshalJSON(data []byte) error {
	return decodeExecServiceObject(data, []string{"pid", "starttime"}, map[string]func(json.RawMessage) error{
		"pid":       func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.PID) },
		"starttime": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.StartTime) },
	})
}

func (r *execServiceRcloneInput) UnmarshalJSON(data []byte) error {
	return decodeExecServiceObject(data, []string{"dev", "ino", "size", "sha256"}, map[string]func(json.RawMessage) error{
		"dev":    func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Dev) },
		"ino":    func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Ino) },
		"size":   func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Size) },
		"sha256": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.SHA256) },
	})
}

func (r *execServiceListenerInput) UnmarshalJSON(data []byte) error {
	return decodeExecServiceObject(data, []string{"host", "port"}, map[string]func(json.RawMessage) error{
		"host": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Host) },
		"port": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Port) },
	})
}

func decodeExecServiceObject(data []byte, required []string, fields map[string]func(json.RawMessage) error) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("object required")
	}
	seen := make(map[string]bool)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := keyToken.(string)
		if !ok || seen[key] {
			return errors.New("invalid or duplicate field")
		}
		seen[key] = true
		handler, ok := fields[key]
		if !ok {
			return errors.New("unknown field")
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return err
		}
		if err := handler(raw); err != nil {
			return err
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return errors.New("object close required")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("trailing JSON")
	}
	for _, key := range required {
		if !seen[key] {
			return errors.New("missing field")
		}
	}
	return nil
}

func parseExecServiceParent(input execServiceParentInput) (execServiceParsedParent, bool) {
	pid, ok := parseCanonicalDecimal(input.PID)
	if !ok || pid == 0 {
		return execServiceParsedParent{}, false
	}
	startTime, ok := parseCanonicalDecimal(input.StartTime)
	if !ok || startTime == 0 {
		return execServiceParsedParent{}, false
	}
	return execServiceParsedParent{pid: pid, startTime: startTime}, true
}

func parseExecServiceRclone(input execServiceRcloneInput) (execServiceParsedRclone, bool) {
	dev, ok := parseCanonicalDecimal(input.Dev)
	if !ok {
		return execServiceParsedRclone{}, false
	}
	ino, ok := parseCanonicalDecimal(input.Ino)
	if !ok {
		return execServiceParsedRclone{}, false
	}
	size, ok := parseCanonicalDecimal(input.Size)
	if !ok || size == 0 || size > execRcloneMaxBytes {
		return execServiceParsedRclone{}, false
	}
	if len(input.SHA256) != sha256.Size*2 || strings.ToLower(input.SHA256) != input.SHA256 {
		return execServiceParsedRclone{}, false
	}
	digest, err := hex.DecodeString(input.SHA256)
	if err != nil || len(digest) != sha256.Size {
		return execServiceParsedRclone{}, false
	}
	var expected [sha256.Size]byte
	copy(expected[:], digest)
	return execServiceParsedRclone{dev: dev, ino: ino, size: size, sha256: expected}, true
}

func validExecServiceToken(token string) bool {
	if len(token) != 32 || strings.ToLower(token) != token {
		return false
	}
	_, err := hex.DecodeString(token)
	return err == nil
}

func validExecServiceArgv(argv []string, port int) bool {
	if len(argv) != 15 {
		return false
	}
	total := 0
	for _, value := range argv {
		if strings.IndexByte(value, 0) >= 0 {
			return false
		}
		total += len(value)
	}
	if total > 16<<10 {
		return false
	}
	if argv[0] != "serve" || argv[1] != "sftp" ||
		argv[3] != "--addr" || argv[4] != "127.0.0.1:"+strconv.Itoa(port) ||
		argv[5] != "--authorized-keys" ||
		argv[7] != "--key" ||
		argv[9] != "--dir-cache-time" || argv[10] != "0" ||
		argv[11] != "--poll-interval" || argv[12] != "0" ||
		argv[13] != "--vfs-cache-mode" || argv[14] != "off" {
		return false
	}
	if !strings.HasPrefix(argv[2], ":local:") || !validCleanAbsolutePath(strings.TrimPrefix(argv[2], ":local:")) {
		return false
	}
	return validCleanAbsolutePath(argv[6]) && validCleanAbsolutePath(argv[8])
}

func validCleanAbsolutePath(value string) bool {
	return value != "" && value != "/" && strings.HasPrefix(value, "/") &&
		path.Clean(value) == value && strings.IndexByte(value, 0) < 0
}

func readExecServiceFrame(file *os.File, reader *bufio.Reader, maxBytes int, timeout time.Duration) ([]byte, *execServiceError) {
	if err := file.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return nil, execServiceFail(execCodeRequestTimeout)
	}
	line := make([]byte, 0, maxBytes+1)
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > maxBytes+1 {
			return nil, execServiceFail(execCodeRequestInvalid)
		}
		line = append(line, fragment...)
		if err == nil {
			break
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return nil, execServiceFail(execCodeRequestTimeout)
		}
		return nil, execServiceFail(execCodeRequestInvalid)
	}
	if len(line) == 0 || line[len(line)-1] != '\n' || len(line)-1 > maxBytes {
		return nil, execServiceFail(execCodeRequestInvalid)
	}
	return line[:len(line)-1], nil
}

func requireExecServiceEOF(file *os.File, reader *bufio.Reader, timeout time.Duration) error {
	if err := file.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	if reader.Buffered() > 0 {
		return errors.New("extra frame data")
	}
	_, err := reader.ReadByte()
	if err == io.EOF {
		return nil
	}
	if err != nil {
		return err
	}
	return errors.New("extra frame data")
}

func writeExecServiceJSONFrame(file *os.File, value any, maxBytes int, timeout time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > maxBytes+1 {
		return errors.New("frame too large")
	}
	return writeExecServiceBytes(file, data, timeout)
}

func writeExecServiceBytes(file *os.File, data []byte, timeout time.Duration) error {
	if err := file.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	for len(data) > 0 {
		written, err := file.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrNoProgress
		}
		data = data[written:]
	}
	return nil
}

func writeExecServiceFailure(stdout *os.File, code string) int {
	response := execServiceFailureResponse{
		Version:       protocolVersion,
		HelperVersion: helperVersion,
		Operation:     execServiceMode,
		OK:            false,
		Error:         execServiceFailureBody{Code: code},
	}
	data, err := json.Marshal(response)
	if err == nil {
		data = append(data, '\n')
		fd := int(stdout.Fd())
		flags, flagErr := linuxExecServiceFcntl(fd, syscall.F_GETFL, 0)
		if flagErr == nil && flags >= 0 {
			_, _ = linuxExecServiceFcntl(fd, syscall.F_SETFL, flags|syscall.O_NONBLOCK)
		}
		if len(data) <= execFailureMaxBytes+1 {
			linuxExecServiceRawWriteNoSplit(fd, data, execControlWriteTimout)
		}
	}
	return 2
}

func checkExecServiceParent(expected execServiceParsedParent, hooks execServiceHooks) (execServiceProcStat, *execServiceError) {
	parentPID := hooks.getppid()
	if parentPID <= 0 || uint64(parentPID) != expected.pid {
		return execServiceProcStat{}, execServiceFail(execCodeParentChanged)
	}
	self, err := readExecServiceProcStat("/proc/self/stat", hooks)
	if err != nil || self.PPid != uint64(parentPID) {
		return execServiceProcStat{}, execServiceFail(execCodeParentChanged)
	}
	parent, err := readExecServiceProcStat("/proc/"+strconv.FormatUint(expected.pid, 10)+"/stat", hooks)
	if err != nil || parent.PID != expected.pid || parent.StartTime != expected.startTime {
		return execServiceProcStat{}, execServiceFail(execCodeParentChanged)
	}
	return self, nil
}

func readExecServiceProcStat(path string, hooks execServiceHooks) (execServiceProcStat, error) {
	data, err := hooks.readFile(path)
	if err != nil || len(data) == 0 || len(data) > execProcStatMaxBytes {
		return execServiceProcStat{}, errors.New("proc stat unavailable")
	}
	return parseExecServiceProcStat(data)
}

func parseExecServiceProcStat(data []byte) (execServiceProcStat, error) {
	open := bytes.LastIndexByte(data, ')')
	if open < 0 || open+2 >= len(data) {
		return execServiceProcStat{}, errors.New("invalid proc stat")
	}
	fields := strings.Fields(string(data[open+2:]))
	if len(fields) < 20 {
		return execServiceProcStat{}, errors.New("short proc stat")
	}
	prefix := strings.Fields(string(data[:open+1]))
	if len(prefix) < 1 {
		return execServiceProcStat{}, errors.New("missing pid")
	}
	pid, err := strconv.ParseUint(prefix[0], 10, 64)
	if err != nil {
		return execServiceProcStat{}, err
	}
	ppid, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return execServiceProcStat{}, err
	}
	startTime, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return execServiceProcStat{}, err
	}
	return execServiceProcStat{PID: pid, PPid: ppid, StartTime: startTime}, nil
}

func verifyExecServiceRclone(fd int, expected execServiceParsedRclone, hooks execServiceHooks) (execServiceFileIdentity, *execServiceError) {
	before, err := statExecServiceFile(fd, expected, hooks)
	if err != nil {
		return execServiceFileIdentity{}, err
	}
	digest, err := hashExecServiceFile(fd, expected.size, hooks)
	if err != nil {
		return execServiceFileIdentity{}, err
	}
	after, err := statExecServiceFile(fd, expected, hooks)
	if err != nil {
		return execServiceFileIdentity{}, err
	}
	if !sameExecServiceFileIdentity(before, after) {
		return execServiceFileIdentity{}, execServiceFail(execCodeRcloneIdentity)
	}
	if digest != expected.sha256 {
		return execServiceFileIdentity{}, execServiceFail(execCodeRcloneDigest)
	}
	return execServiceFileIdentity{
		Dev:    strconv.FormatUint(expected.dev, 10),
		Ino:    strconv.FormatUint(expected.ino, 10),
		Size:   strconv.FormatUint(expected.size, 10),
		SHA256: hex.EncodeToString(digest[:]),
	}, nil
}

func sameExecServiceFileIdentity(before, after syscall.Stat_t) bool {
	return before.Dev == after.Dev &&
		before.Ino == after.Ino &&
		before.Size == after.Size &&
		before.Mode == after.Mode
}

func statExecServiceFile(fd int, expected execServiceParsedRclone, hooks execServiceHooks) (syscall.Stat_t, *execServiceError) {
	var stat syscall.Stat_t
	if err := hooks.fstat(fd, &stat); err != nil {
		return stat, execServiceFail(execCodeFDInvalid)
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Mode&0111 == 0 {
		return stat, execServiceFail(execCodeRcloneNotRegular)
	}
	if stat.Size < 0 || uint64(stat.Dev) != expected.dev ||
		uint64(stat.Ino) != expected.ino || uint64(stat.Size) != expected.size {
		return stat, execServiceFail(execCodeRcloneIdentity)
	}
	if stat.Mode&(syscall.S_ISUID|syscall.S_ISGID) != 0 {
		return stat, execServiceFail(execCodeRcloneAttributes)
	}
	size, err := hooks.fgetxattr(fd, "security.capability")
	if err != nil {
		if errors.Is(err, syscall.ENODATA) || errors.Is(err, syscall.ENOTSUP) {
			return stat, nil
		}
		return stat, execServiceFail(execCodeRcloneAttributes)
	}
	if size != 0 {
		return stat, execServiceFail(execCodeRcloneAttributes)
	}
	return stat, nil
}

func hashExecServiceFile(fd int, size uint64, hooks execServiceHooks) ([sha256.Size]byte, *execServiceError) {
	hasher := sha256.New()
	buffer := make([]byte, 64<<10)
	var offset int64
	remaining := int64(size)
	for remaining > 0 {
		chunk := int64(len(buffer))
		if remaining < chunk {
			chunk = remaining
		}
		read, err := hooks.pread(fd, buffer[:chunk], offset)
		if err != nil || read <= 0 {
			return [sha256.Size]byte{}, execServiceFail(execCodeRcloneDigest)
		}
		_, _ = hasher.Write(buffer[:read])
		offset += int64(read)
		remaining -= int64(read)
	}
	var extra [1]byte
	read, err := hooks.pread(fd, extra[:], offset)
	if read != 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return [sha256.Size]byte{}, execServiceFail(execCodeRcloneIdentity)
	}
	var digest [sha256.Size]byte
	copy(digest[:], hasher.Sum(nil))
	return digest, nil
}

func readExecServiceCapLast(hooks execServiceHooks) (uint64, *execServiceError) {
	data, err := hooks.readFile("/proc/sys/kernel/cap_last_cap")
	if err != nil {
		return 0, execServiceFail(execCodeCapabilityDrop)
	}
	value := strings.TrimSpace(string(data))
	last, ok := parseCanonicalDecimal(value)
	if !ok || last > 63 {
		return 0, execServiceFail(execCodeCapabilityDrop)
	}
	return last, nil
}

func dropExecServiceCapabilities(capLast uint64, hooks execServiceHooks) *execServiceError {
	for capability := uint64(0); capability <= capLast; capability++ {
		if _, err := hooks.prctl(prCapBSetDrop, uintptr(capability), 0, 0, 0); err != nil {
			return execServiceFail(execCodeCapabilityDrop)
		}
	}
	if _, err := hooks.prctl(prCapAmbient, prCapAmbientClearAll, 0, 0, 0); err != nil {
		return execServiceFail(execCodeCapabilityDrop)
	}
	header := execServiceCapHeader{Version: linuxCapabilityVersion3, PID: 0}
	var data [2]execServiceCapData
	if err := hooks.capset(&header, &data); err != nil {
		return execServiceFail(execCodeCapabilityDrop)
	}
	if _, err := hooks.prctl(prSetNoNewPrivs, 1, 0, 0, 0); err != nil {
		return execServiceFail(execCodeNoNewPrivs)
	}
	return nil
}

func verifyExecServiceSecurity(capLast uint64, hooks execServiceHooks) *execServiceError {
	header := execServiceCapHeader{Version: linuxCapabilityVersion3, PID: 0}
	var data [2]execServiceCapData
	if err := hooks.capget(&header, &data); err != nil {
		return execServiceFail(execCodeCapabilityVerify)
	}
	for _, entry := range data {
		if entry.Effective != 0 || entry.Permitted != 0 || entry.Inheritable != 0 {
			return execServiceFail(execCodeCapabilityVerify)
		}
	}
	for capability := uint64(0); capability <= capLast; capability++ {
		value, err := hooks.prctl(prCapBSetRead, uintptr(capability), 0, 0, 0)
		if err != nil || value != 0 {
			return execServiceFail(execCodeCapabilityVerify)
		}
		value, err = hooks.prctl(prCapAmbient, prCapAmbientIsSet, uintptr(capability), 0, 0)
		if err != nil || value != 0 {
			return execServiceFail(execCodeCapabilityVerify)
		}
	}
	value, err := hooks.prctl(prGetNoNewPrivs, 0, 0, 0, 0)
	if err != nil || value != 1 {
		return execServiceFail(execCodeNoNewPrivs)
	}
	parentDeathSignal, err := hooks.getPDeathSig()
	if err != nil || parentDeathSignal != int32(syscall.SIGKILL) {
		return execServiceFail(execCodePDeathSigFailed)
	}
	return nil
}

func executeExecService(stdout *os.File, request execServiceRequest, hooks execServiceHooks) int {
	payload, err := buildExecvePayload(request.Argv, request.Token)
	if err != nil {
		return writeExecServiceFailure(stdout, execCodeRequestInvalid)
	}
	return executeExecServicePayload(stdout, payload, hooks, execServiceV1FailureFrames())
}

func executeExecServicePayload(stdout *os.File, payload *execvePayload, hooks execServiceHooks, frames execServiceFailureFrames) int {
	controlFD, err := hooks.fcntl(1, syscall.F_DUPFD_CLOEXEC, execControlFD)
	if err != nil {
		return frames.writeFailure(stdout, execCodeControlFDFailed)
	}
	flags, err := hooks.fcntl(controlFD, syscall.F_GETFL, 0)
	if err != nil || flags < 0 {
		_ = hooks.close(controlFD)
		return frames.writeFailure(stdout, execCodeControlFDFailed)
	}
	if _, err = hooks.fcntl(controlFD, syscall.F_SETFL, flags|syscall.O_NONBLOCK); err != nil {
		_ = hooks.close(controlFD)
		return frames.writeFailure(stdout, execCodeControlFDFailed)
	}

	devNull, err := hooks.open("/dev/null", syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		_ = hooks.close(controlFD)
		return frames.writeFailure(stdout, execCodeRedirection)
	}
	if err := hooks.dup3(devNull, 0, 0); err != nil {
		_ = hooks.close(devNull)
		hooks.rawFailure(controlFD, frames.redirection)
	}
	if err := hooks.dup3(devNull, 1, 0); err != nil {
		_ = hooks.close(devNull)
		hooks.rawFailure(controlFD, frames.redirection)
	}
	_ = hooks.close(devNull)

	if errno := hooks.closeRange(execRcloneFD, ^uintptr(0), closeRangeUnshare|closeRangeCloexec); errno != 0 {
		hooks.rawTail(controlFD, nil, frames.hygiene)
	}

	hooks.rawTail(controlFD, payload, frames.exec)
	return 2
}

func buildExecvePayload(argv []string, token string) (*execvePayload, error) {
	argValues := make([]string, 1, len(argv)+1)
	argValues[0] = "rclone"
	argValues = append(argValues, argv...)
	envValues := []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=/nonexistent",
		"XDG_CONFIG_HOME=/nonexistent",
		"RCLONE_CONFIG=/dev/null",
		"LC_ALL=C",
		"SFSC_SERVICE_TOKEN=" + token,
	}
	argBlock, argvPointers, err := packExecServiceCStrings(argValues)
	if err != nil {
		return nil, err
	}
	envBlock, envPointers, err := packExecServiceCStrings(envValues)
	if err != nil {
		return nil, err
	}
	pathBlock := append([]byte("/proc/self/fd/3"), 0)
	return &execvePayload{
		path:     pathBlock,
		argBlock: argBlock,
		envBlock: envBlock,
		argv:     argvPointers,
		envp:     envPointers,
	}, nil
}

func packExecServiceCStrings(values []string) ([]byte, []uintptr, error) {
	total := 0
	for _, value := range values {
		if strings.IndexByte(value, 0) >= 0 {
			return nil, nil, errors.New("NUL in exec string")
		}
		total += len(value) + 1
	}
	block := make([]byte, 0, total)
	pointers := make([]uintptr, 0, len(values)+1)
	for _, value := range values {
		offset := len(block)
		block = append(block, value...)
		block = append(block, 0)
		pointers = append(pointers, uintptr(unsafe.Pointer(&block[offset])))
	}
	pointers = append(pointers, 0)
	return block, pointers, nil
}

func linuxExecServiceHooks() execServiceHooks {
	return execServiceHooks{
		lockOSThread: runtime.LockOSThread,
		getpid:       os.Getpid,
		getppid:      os.Getppid,
		getenv:       os.Getenv,
		readFile:     os.ReadFile,
		fstat:        syscall.Fstat,
		fgetxattr:    linuxExecServiceFgetxattr,
		fcntl:        linuxExecServiceFcntl,
		prctl:        linuxExecServicePrctl,
		getPDeathSig: linuxExecServiceGetPDeathSig,
		capget:       linuxExecServiceCapget,
		capset:       linuxExecServiceCapset,
		closeRange:   linuxExecServiceCloseRange,
		open:         syscall.Open,
		dup3:         syscall.Dup3,
		close:        syscall.Close,
		pread:        syscall.Pread,
		rawFailure:   linuxExecServiceRawFailure,
		rawTail:      linuxExecServiceRawTail,
	}
}

func linuxExecServiceFgetxattr(fd int, name string) (int, error) {
	nameBytes, err := syscall.BytePtrFromString(name)
	if err != nil {
		return 0, err
	}
	value, _, errno := syscall.RawSyscall6(syscall.SYS_FGETXATTR, uintptr(fd), uintptr(unsafe.Pointer(nameBytes)), 0, 0, 0, 0)
	runtime.KeepAlive(nameBytes)
	if errno != 0 {
		return 0, errno
	}
	return int(value), nil
}

func linuxExecServiceFcntl(fd, command, argument int) (int, error) {
	value, _, errno := syscall.RawSyscall(syscall.SYS_FCNTL, uintptr(fd), uintptr(command), uintptr(argument))
	if errno != 0 {
		return 0, errno
	}
	return int(value), nil
}

func linuxExecServicePrctl(option int, arg2, arg3, arg4, arg5 uintptr) (int, error) {
	value, _, errno := syscall.RawSyscall6(syscall.SYS_PRCTL, uintptr(option), arg2, arg3, arg4, arg5, 0)
	if errno != 0 {
		return 0, errno
	}
	return int(value), nil
}

func linuxExecServiceGetPDeathSig() (int32, error) {
	var signal int32
	_, _, errno := syscall.RawSyscall6(
		syscall.SYS_PRCTL,
		prGetPDeathSig,
		uintptr(unsafe.Pointer(&signal)),
		0,
		0,
		0,
		0,
	)
	runtime.KeepAlive(&signal)
	if errno != 0 {
		return 0, errno
	}
	return signal, nil
}

func linuxExecServiceCapget(header *execServiceCapHeader, data *[2]execServiceCapData) error {
	_, _, errno := syscall.RawSyscall(
		syscall.SYS_CAPGET,
		uintptr(unsafe.Pointer(header)),
		uintptr(unsafe.Pointer(data)),
		0,
	)
	runtime.KeepAlive(header)
	runtime.KeepAlive(data)
	if errno != 0 {
		return errno
	}
	return nil
}

func linuxExecServiceCapset(header *execServiceCapHeader, data *[2]execServiceCapData) error {
	_, _, errno := syscall.RawSyscall(
		syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(header)),
		uintptr(unsafe.Pointer(data)),
		0,
	)
	runtime.KeepAlive(header)
	runtime.KeepAlive(data)
	if errno != 0 {
		return errno
	}
	return nil
}

func linuxExecServiceCloseRange(first, last, flags uintptr) syscall.Errno {
	_, _, errno := syscall.RawSyscall(sysCloseRange, first, last, flags)
	return errno
}

//go:nosplit
func linuxExecServiceRawFailure(fd int, frame []byte) {
	linuxExecServiceRawWriteNoSplit(fd, frame, execControlWriteTimout)
	linuxExecServiceExitGroupNoSplit(2)
}

//go:nosplit
func linuxExecServiceRawTail(fd int, payload *execvePayload, failureFrame []byte) {
	if payload != nil {
		_ = linuxExecServiceExecveNoSplit(payload)
	}
	linuxExecServiceRawWriteNoSplit(fd, failureFrame, execControlWriteTimout)
	linuxExecServiceExitGroupNoSplit(2)
}

//go:nosplit
func linuxExecServiceExecveNoSplit(payload *execvePayload) syscall.Errno {
	_, _, errno := syscall.RawSyscall(
		syscall.SYS_EXECVE,
		uintptr(unsafe.Pointer(unsafe.SliceData(payload.path))),
		uintptr(unsafe.Pointer(unsafe.SliceData(payload.argv))),
		uintptr(unsafe.Pointer(unsafe.SliceData(payload.envp))),
	)
	runtime.KeepAlive(payload.path)
	runtime.KeepAlive(payload.argBlock)
	runtime.KeepAlive(payload.envBlock)
	runtime.KeepAlive(payload.argv)
	runtime.KeepAlive(payload.envp)
	return errno
}

//go:nosplit
func linuxExecServiceRawWriteNoSplit(fd int, data []byte, timeout time.Duration) bool {
	if fd < 0 || len(data) == 0 {
		return false
	}
	deadline, ok := linuxExecServiceMonotonicDeadlineNoSplit(timeout)
	if !ok {
		return false
	}
	for len(data) > 0 {
		remaining, ok := linuxExecServiceRemainingNoSplit(deadline)
		if !ok {
			return false
		}
		pollFD := execServicePollFD{FD: int32(fd), Events: pollOut}
		_, _, errno := syscall.RawSyscall6(
			syscall.SYS_PPOLL,
			uintptr(unsafe.Pointer(&pollFD)),
			1,
			uintptr(unsafe.Pointer(&remaining)),
			0,
			0,
			0,
		)
		runtime.KeepAlive(&pollFD)
		runtime.KeepAlive(&remaining)
		if errno == syscall.EINTR {
			continue
		}
		if errno != 0 {
			return false
		}
		if pollFD.Revents&(pollErr|pollHup|pollNVal) != 0 {
			return false
		}
		if pollFD.Revents&pollOut == 0 {
			return false
		}
		written, _, writeErr := syscall.RawSyscall(
			syscall.SYS_WRITE,
			uintptr(fd),
			uintptr(unsafe.Pointer(unsafe.SliceData(data))),
			uintptr(len(data)),
		)
		runtime.KeepAlive(data)
		if writeErr == syscall.EINTR || writeErr == syscall.EAGAIN {
			continue
		}
		if writeErr != 0 || written == 0 {
			return false
		}
		data = data[written:]
	}
	return true
}

//go:nosplit
func linuxExecServiceMonotonicDeadlineNoSplit(timeout time.Duration) (syscall.Timespec, bool) {
	now, ok := linuxExecServiceMonotonicNowNoSplit()
	if !ok {
		return syscall.Timespec{}, false
	}
	deadline := syscall.NsecToTimespec(now.Nano() + int64(timeout))
	return deadline, true
}

//go:nosplit
func linuxExecServiceMonotonicNowNoSplit() (syscall.Timespec, bool) {
	var now syscall.Timespec
	_, _, errno := syscall.RawSyscall(
		syscall.SYS_CLOCK_GETTIME,
		clockMono,
		uintptr(unsafe.Pointer(&now)),
		0,
	)
	runtime.KeepAlive(&now)
	return now, errno == 0
}

//go:nosplit
func linuxExecServiceRemainingNoSplit(deadline syscall.Timespec) (syscall.Timespec, bool) {
	now, ok := linuxExecServiceMonotonicNowNoSplit()
	if !ok {
		return syscall.Timespec{}, false
	}
	remaining := syscall.NsecToTimespec(deadline.Nano() - now.Nano())
	if remaining.Sec < 0 || (remaining.Sec == 0 && remaining.Nsec <= 0) {
		return syscall.Timespec{}, false
	}
	return remaining, true
}

//go:nosplit
func linuxExecServiceExitGroupNoSplit(code int) {
	for {
		_, _, _ = syscall.RawSyscall(syscall.SYS_EXIT_GROUP, uintptr(code), 0, 0)
	}
}

func execServiceFail(code string) *execServiceError {
	return &execServiceError{code: code}
}
