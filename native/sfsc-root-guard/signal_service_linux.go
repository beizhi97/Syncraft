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
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	signalServiceMode = "signal-service"

	signalRequestMaxBytes      = 8192
	signalProcStatMaxBytes     = 64 << 10
	signalEnvironMaxBytes      = 1 << 20
	signalExecutableMaxBytes   = 256 << 20
	signalBootIDMaxBytes       = 128
	signalFailureMaxBytes      = 4 << 10
	signalTotalBudget          = 5 * time.Second
	signalInitialFrameLimit    = 5 * time.Second
	signalEOFLimit             = 1 * time.Second
	signalOutputLimit          = 2 * time.Second
	signalMaxPID               = uint64(1<<31 - 1)
	signalServiceSysPidfdOpen  = uintptr(434)
	signalServiceSysPidfdSend  = uintptr(424)
	signalServiceDeliveryValue = "pidfd-send-returned"

	signalCodeRequestInvalid         = "request_invalid"
	signalCodeRequestTimeout         = "request_timeout"
	signalCodeCallerIdentityMismatch = "caller_identity_mismatch"
	signalCodeNamespaceMismatch      = "namespace_mismatch"
	signalCodePidfdUnsupported       = "pidfd_unsupported"
	signalCodePidfdOpenFailed        = "pidfd_open_failed"
	signalCodeTargetUnavailable      = "target_unavailable"
	signalCodeTargetIdentityMismatch = "target_identity_mismatch"
	signalCodeExecutableMismatch     = "target_executable_mismatch"
	signalCodeTokenMismatch          = "target_token_mismatch"
	signalCodeSignalFailed           = "signal_failed"
	signalCodeResourceCloseFailed    = "resource_close_failed"
	signalCodeDeadlineExceeded       = "deadline_exceeded"
)

type signalServiceNamespaceInput struct {
	BootID         string `json:"bootId"`
	PIDNamespaceID string `json:"pidNamespaceId"`
}

type signalServiceManagerInput struct {
	PID       string `json:"pid"`
	StartTime string `json:"starttime"`
}

type signalServiceProcessInput struct {
	PID             string `json:"pid"`
	StartTime       string `json:"starttime"`
	ParentPID       string `json:"parentPid"`
	ParentStartTime string `json:"parentStarttime"`
}

type signalServiceExecutableInput struct {
	Dev    string `json:"dev"`
	Ino    string `json:"ino"`
	Size   string `json:"size"`
	SHA256 string `json:"sha256"`
}

type signalServiceExecutablesInput struct {
	Launcher signalServiceExecutableInput `json:"launcher"`
	Target   signalServiceExecutableInput `json:"target"`
}

type signalServiceRequest struct {
	Version    int                           `json:"version"`
	Operation  string                        `json:"operation"`
	Signal     string                        `json:"signal"`
	Namespace  signalServiceNamespaceInput   `json:"namespace"`
	Manager    signalServiceManagerInput     `json:"manager"`
	Process    signalServiceProcessInput     `json:"process"`
	Token      string                        `json:"token"`
	Executable signalServiceExecutablesInput `json:"executable"`
	parsed     signalServiceParsedRequest
}

type signalServiceParsedManager struct {
	pid       uint64
	startTime uint64
}

type signalServiceParsedProcess struct {
	pid             uint64
	startTime       uint64
	parentPID       uint64
	parentStartTime uint64
}

type signalServiceParsedExecutable struct {
	dev    uint64
	ino    uint64
	size   uint64
	sha256 [sha256.Size]byte
}

type signalServiceParsedRequest struct {
	signal            syscall.Signal
	namespace         signalServiceNamespaceInput
	manager           signalServiceParsedManager
	process           signalServiceParsedProcess
	token             string
	launcher          signalServiceParsedExecutable
	target            signalServiceParsedExecutable
	matchedExecutable string
}

type signalServiceSuccessTarget struct {
	PID         string `json:"pid"`
	StartTime   string `json:"starttime"`
	TokenSHA256 string `json:"tokenSha256"`
}

type signalServiceSuccessResponse struct {
	Version           int                        `json:"version"`
	HelperVersion     string                     `json:"helperVersion"`
	Operation         string                     `json:"operation"`
	OK                bool                       `json:"ok"`
	Signal            string                     `json:"signal"`
	Delivery          string                     `json:"delivery"`
	Target            signalServiceSuccessTarget `json:"target"`
	MatchedExecutable string                     `json:"matchedExecutable"`
}

type signalServiceFailureBody struct {
	Code string `json:"code"`
}

type signalServiceFailureResponse struct {
	Version       int                      `json:"version"`
	HelperVersion string                   `json:"helperVersion"`
	Operation     string                   `json:"operation"`
	OK            bool                     `json:"ok"`
	Error         signalServiceFailureBody `json:"error"`
}

type signalServiceError struct {
	code string
}

func (e *signalServiceError) Error() string {
	return e.code
}

type signalServiceDeadline struct {
	end time.Time
	now func() time.Time
}

type signalServiceHooks struct {
	now              func() time.Time
	getppid          func() int
	readlink         func(string) (string, error)
	open             func(string, int, uint32) (int, error)
	read             func(int, []byte) (int, error)
	close            func(int) error
	closeFile        func(*os.File) error
	fstat            func(int, *syscall.Stat_t) error
	pread            func(int, []byte, int64) (int, error)
	fcntl            func(int, int, int) (int, error)
	pidfdOpen        func(uint64, uintptr) (int, error)
	pidfdSendSignal  func(int, syscall.Signal, uintptr) error
	setReadDeadline  func(*os.File, time.Time) error
	setProtocolRead  func(*os.File, time.Time) error
	setProtocolWrite func(*os.File, time.Time) error
	writeFrame       func(*os.File, []byte, time.Duration) error
	totalBudget      time.Duration
	initialFrameWait time.Duration
	eofWait          time.Duration
	outputWait       time.Duration
}

type signalServiceProtocolFiles struct {
	stdin  *os.File
	stdout *os.File
}

func runSignalService(args []string, stdin, stdout, stderr *os.File) int {
	return runSignalServiceWithHooks(args, stdin, stdout, stderr, linuxSignalServiceHooks())
}

func runSignalServiceWithHooks(args []string, stdin, stdout, stderr *os.File, hooks signalServiceHooks) int {
	_ = stderr
	start := hooks.now()
	deadline := &signalServiceDeadline{
		end: start.Add(hooks.totalBudget),
		now: hooks.now,
	}
	if len(args) != 2 || args[1] != signalServiceMode {
		return writeSignalServiceFailure(stdout, signalCodeRequestInvalid, hooks)
	}

	protocol, protocolErr := prepareSignalServiceProtocolFiles(stdin, stdout, hooks)
	if protocolErr != nil {
		return 2
	}
	closeInput := func() error {
		return closeSignalServiceProtocolFile(&protocol.stdin, hooks)
	}
	closeOutput := func() error {
		return closeSignalServiceProtocolFile(&protocol.stdout, hooks)
	}
	fail := func(code string) int {
		if err := closeInput(); err != nil {
			code = signalCodeResourceCloseFailed
		}
		_ = writeSignalServiceFailure(protocol.stdout, code, hooks)
		if err := closeOutput(); err != nil {
			return 2
		}
		return 2
	}

	reader := bufio.NewReaderSize(protocol.stdin, signalRequestMaxBytes+2)
	frame, frameErr := readSignalServiceFrame(
		protocol.stdin,
		reader,
		signalRequestMaxBytes,
		hooks.initialFrameWait,
		deadline,
		hooks,
	)
	if frameErr != nil {
		return fail(frameErr.code)
	}
	if deadlineErr := deadline.check(); deadlineErr != nil {
		return fail(deadlineErr.code)
	}
	if eofErr := requireSignalServiceEOF(protocol.stdin, reader, hooks.eofWait, deadline, hooks); eofErr != nil {
		return fail(eofErr.code)
	}
	if err := closeInput(); err != nil {
		return fail(signalCodeResourceCloseFailed)
	}

	request, requestErr := decodeSignalServiceRequest(frame)
	if requestErr != nil {
		return fail(requestErr.code)
	}
	if deadlineErr := deadline.check(); deadlineErr != nil {
		return fail(deadlineErr.code)
	}
	if guardErr := checkSignalServiceCaller(request.parsed, deadline, hooks); guardErr != nil {
		return fail(guardErr.code)
	}

	pidfd, openErr := hooks.pidfdOpen(request.parsed.process.pid, 0)
	if openErr != nil {
		if errors.Is(openErr, syscall.ENOSYS) || errors.Is(openErr, syscall.EINVAL) {
			return fail(signalCodePidfdUnsupported)
		}
		return fail(signalCodePidfdOpenFailed)
	}
	if pidfd < 0 {
		return fail(signalCodePidfdOpenFailed)
	}

	failAfterPidfd := func(code string) int {
		if pidfd >= 0 {
			closeErr := hooks.close(pidfd)
			pidfd = -1
			if closeErr != nil {
				code = signalCodeResourceCloseFailed
			}
		}
		return fail(code)
	}

	if guardErr := ensureSignalServiceCLOEXEC(pidfd, deadline, hooks); guardErr != nil {
		return failAfterPidfd(guardErr.code)
	}
	if guardErr := verifySignalServiceTarget(pidfd, &request.parsed, deadline, hooks); guardErr != nil {
		return failAfterPidfd(guardErr.code)
	}

	if deadlineErr := deadline.check(); deadlineErr != nil {
		return failAfterPidfd(deadlineErr.code)
	}
	sendErr := hooks.pidfdSendSignal(pidfd, request.parsed.signal, 0)
	if sendErr != nil {
		return failAfterPidfd(signalCodeSignalFailed)
	}
	if closeErr := hooks.close(pidfd); closeErr != nil {
		pidfd = -1
		return fail(signalCodeResourceCloseFailed)
	}
	pidfd = -1

	tokenDigest := sha256.Sum256([]byte(request.parsed.token))
	response := signalServiceSuccessResponse{
		Version:       protocolVersion,
		HelperVersion: helperVersion,
		Operation:     signalServiceMode,
		OK:            true,
		Signal:        request.Signal,
		Delivery:      signalServiceDeliveryValue,
		Target: signalServiceSuccessTarget{
			PID:         request.Process.PID,
			StartTime:   request.Process.StartTime,
			TokenSHA256: hex.EncodeToString(tokenDigest[:]),
		},
		MatchedExecutable: request.parsed.matchedExecutable,
	}
	if err := writeSignalServiceJSONFrame(protocol.stdout, response, signalFailureMaxBytes, hooks.outputWait, hooks); err != nil {
		_ = closeOutput()
		return 2
	}
	if err := closeOutput(); err != nil {
		return 2
	}
	return 0
}

func prepareSignalServiceProtocolFiles(
	stdin, stdout *os.File,
	hooks signalServiceHooks,
) (signalServiceProtocolFiles, *signalServiceError) {
	inputFD, err := hooks.fcntl(int(stdin.Fd()), syscall.F_DUPFD_CLOEXEC, 10)
	if err != nil || inputFD < 0 {
		return signalServiceProtocolFiles{}, signalServiceFail(signalCodeRequestInvalid)
	}
	if err := setSignalServiceNonblocking(inputFD, hooks); err != nil {
		if closeErr := hooks.close(inputFD); closeErr != nil {
			return signalServiceProtocolFiles{}, signalServiceFail(signalCodeResourceCloseFailed)
		}
		return signalServiceProtocolFiles{}, signalServiceFail(signalCodeRequestInvalid)
	}
	outputFD, err := hooks.fcntl(int(stdout.Fd()), syscall.F_DUPFD_CLOEXEC, 10)
	if err != nil || outputFD < 0 {
		_ = hooks.close(inputFD)
		return signalServiceProtocolFiles{}, signalServiceFail(signalCodeResourceCloseFailed)
	}
	if err := setSignalServiceNonblocking(outputFD, hooks); err != nil {
		_ = closeSignalServiceRawFDs(hooks, inputFD, outputFD)
		return signalServiceProtocolFiles{}, signalServiceFail(signalCodeResourceCloseFailed)
	}

	input := os.NewFile(uintptr(inputFD), "sfsc-signal-stdin")
	if input == nil {
		_ = closeSignalServiceRawFDs(hooks, inputFD, outputFD)
		return signalServiceProtocolFiles{}, signalServiceFail(signalCodeResourceCloseFailed)
	}
	output := os.NewFile(uintptr(outputFD), "sfsc-signal-stdout")
	if output == nil {
		_ = hooks.closeFile(input)
		_ = hooks.close(outputFD)
		return signalServiceProtocolFiles{}, signalServiceFail(signalCodeResourceCloseFailed)
	}
	protocol := signalServiceProtocolFiles{stdin: input, stdout: output}
	if err := hooks.setProtocolRead(input, time.Time{}); err != nil {
		code := signalCodeRequestInvalid
		if closeErr := closeSignalServiceProtocolFiles(&protocol, hooks); closeErr != nil {
			code = signalCodeResourceCloseFailed
		}
		return signalServiceProtocolFiles{}, signalServiceFail(code)
	}
	if err := hooks.setProtocolWrite(output, time.Time{}); err != nil {
		_ = closeSignalServiceProtocolFiles(&protocol, hooks)
		return signalServiceProtocolFiles{}, signalServiceFail(signalCodeResourceCloseFailed)
	}
	return protocol, nil
}

func closeSignalServiceProtocolFile(file **os.File, hooks signalServiceHooks) error {
	if file == nil || *file == nil {
		return nil
	}
	current := *file
	*file = nil
	return hooks.closeFile(current)
}

func closeSignalServiceProtocolFiles(files *signalServiceProtocolFiles, hooks signalServiceHooks) error {
	inputErr := closeSignalServiceProtocolFile(&files.stdin, hooks)
	outputErr := closeSignalServiceProtocolFile(&files.stdout, hooks)
	if inputErr != nil {
		return inputErr
	}
	return outputErr
}

func closeSignalServiceRawFDs(hooks signalServiceHooks, fds ...int) error {
	var firstErr error
	for _, fd := range fds {
		if err := hooks.close(fd); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func setSignalServiceNonblocking(fd int, hooks signalServiceHooks) error {
	flags, err := hooks.fcntl(fd, syscall.F_GETFL, 0)
	if err != nil || flags < 0 {
		return errors.New("read file status flags")
	}
	if _, err := hooks.fcntl(fd, syscall.F_SETFL, flags|syscall.O_NONBLOCK); err != nil {
		return err
	}
	return nil
}

func decodeSignalServiceRequest(data []byte) (signalServiceRequest, *signalServiceError) {
	var request signalServiceRequest
	if len(data) == 0 || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return request, signalServiceFail(signalCodeRequestInvalid)
	}
	if data[0] != '{' || data[len(data)-1] != '}' {
		return signalServiceRequest{}, signalServiceFail(signalCodeRequestInvalid)
	}
	if err := json.Unmarshal(data, &request); err != nil {
		return signalServiceRequest{}, signalServiceFail(signalCodeRequestInvalid)
	}
	if request.Version != protocolVersion || request.Operation != "signal" ||
		!validSignalServiceToken(request.Token) {
		return signalServiceRequest{}, signalServiceFail(signalCodeRequestInvalid)
	}
	signal, ok := parseSignalServiceSignal(request.Signal)
	if !ok {
		return signalServiceRequest{}, signalServiceFail(signalCodeRequestInvalid)
	}
	if !validSignalServiceNamespace(request.Namespace) {
		return signalServiceRequest{}, signalServiceFail(signalCodeRequestInvalid)
	}
	manager, ok := parseSignalServiceManager(request.Manager)
	if !ok {
		return signalServiceRequest{}, signalServiceFail(signalCodeRequestInvalid)
	}
	process, ok := parseSignalServiceProcess(request.Process)
	if !ok || process.pid == manager.pid ||
		process.parentPID != manager.pid ||
		process.parentStartTime != manager.startTime {
		return signalServiceRequest{}, signalServiceFail(signalCodeRequestInvalid)
	}
	launcher, ok := parseSignalServiceExecutable(request.Executable.Launcher)
	if !ok {
		return signalServiceRequest{}, signalServiceFail(signalCodeRequestInvalid)
	}
	target, ok := parseSignalServiceExecutable(request.Executable.Target)
	if !ok {
		return signalServiceRequest{}, signalServiceFail(signalCodeRequestInvalid)
	}
	request.parsed = signalServiceParsedRequest{
		signal:    signal,
		namespace: request.Namespace,
		manager: signalServiceParsedManager{
			pid:       manager.pid,
			startTime: manager.startTime,
		},
		process:  process,
		token:    request.Token,
		launcher: launcher,
		target:   target,
	}
	return request, nil
}

func (r *signalServiceRequest) UnmarshalJSON(data []byte) error {
	return decodeSignalServiceObject(data, []string{
		"version", "operation", "signal", "namespace", "manager", "process", "token", "executable",
	}, map[string]func(json.RawMessage) error{
		"version":    func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Version) },
		"operation":  func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Operation) },
		"signal":     func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Signal) },
		"namespace":  func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Namespace) },
		"manager":    func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Manager) },
		"process":    func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Process) },
		"token":      func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Token) },
		"executable": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Executable) },
	})
}

func (r *signalServiceNamespaceInput) UnmarshalJSON(data []byte) error {
	return decodeSignalServiceObject(data, []string{"bootId", "pidNamespaceId"}, map[string]func(json.RawMessage) error{
		"bootId":         func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.BootID) },
		"pidNamespaceId": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.PIDNamespaceID) },
	})
}

func (r *signalServiceManagerInput) UnmarshalJSON(data []byte) error {
	return decodeSignalServiceObject(data, []string{"pid", "starttime"}, map[string]func(json.RawMessage) error{
		"pid":       func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.PID) },
		"starttime": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.StartTime) },
	})
}

func (r *signalServiceProcessInput) UnmarshalJSON(data []byte) error {
	return decodeSignalServiceObject(data, []string{"pid", "starttime", "parentPid", "parentStarttime"}, map[string]func(json.RawMessage) error{
		"pid":             func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.PID) },
		"starttime":       func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.StartTime) },
		"parentPid":       func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.ParentPID) },
		"parentStarttime": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.ParentStartTime) },
	})
}

func (r *signalServiceExecutableInput) UnmarshalJSON(data []byte) error {
	return decodeSignalServiceObject(data, []string{"dev", "ino", "size", "sha256"}, map[string]func(json.RawMessage) error{
		"dev":    func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Dev) },
		"ino":    func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Ino) },
		"size":   func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Size) },
		"sha256": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.SHA256) },
	})
}

func (r *signalServiceExecutablesInput) UnmarshalJSON(data []byte) error {
	return decodeSignalServiceObject(data, []string{"launcher", "target"}, map[string]func(json.RawMessage) error{
		"launcher": func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Launcher) },
		"target":   func(raw json.RawMessage) error { return json.Unmarshal(raw, &r.Target) },
	})
}

func decodeSignalServiceObject(data []byte, required []string, fields map[string]func(json.RawMessage) error) error {
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
	if int(decoder.InputOffset()) != len(data) {
		return errors.New("trailing JSON bytes")
	}
	for _, key := range required {
		if !seen[key] {
			return errors.New("missing field")
		}
	}
	return nil
}

func parseSignalServiceSignal(value string) (syscall.Signal, bool) {
	switch value {
	case "SIGTERM":
		return syscall.SIGTERM, true
	case "SIGKILL":
		return syscall.SIGKILL, true
	default:
		return 0, false
	}
}

func validSignalServiceNamespace(namespace signalServiceNamespaceInput) bool {
	return validSignalServiceUUID(namespace.BootID) &&
		strings.HasPrefix(namespace.PIDNamespaceID, "pid:[") &&
		strings.HasSuffix(namespace.PIDNamespaceID, "]") &&
		validSignalServiceDigits(namespace.PIDNamespaceID[5:len(namespace.PIDNamespaceID)-1])
}

func validSignalServiceUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index := 0; index < len(value); index++ {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if value[index] != '-' {
				return false
			}
			continue
		}
		if !signalServiceLowerHex(value[index]) {
			return false
		}
	}
	return true
}

func validSignalServiceDigits(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}

func validSignalServiceToken(value string) bool {
	if len(value) != 32 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func signalServiceLowerHex(value byte) bool {
	return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f')
}

func parseSignalServiceManager(input signalServiceManagerInput) (signalServiceParsedManager, bool) {
	pid, ok := parseCanonicalDecimal(input.PID)
	if !ok || pid < 2 || pid > signalMaxPID {
		return signalServiceParsedManager{}, false
	}
	startTime, ok := parseCanonicalDecimal(input.StartTime)
	if !ok || startTime == 0 {
		return signalServiceParsedManager{}, false
	}
	return signalServiceParsedManager{pid: pid, startTime: startTime}, true
}

func parseSignalServiceProcess(input signalServiceProcessInput) (signalServiceParsedProcess, bool) {
	pid, ok := parseCanonicalDecimal(input.PID)
	if !ok || pid < 2 || pid > signalMaxPID {
		return signalServiceParsedProcess{}, false
	}
	startTime, ok := parseCanonicalDecimal(input.StartTime)
	if !ok || startTime == 0 {
		return signalServiceParsedProcess{}, false
	}
	parentPID, ok := parseCanonicalDecimal(input.ParentPID)
	if !ok || parentPID < 2 || parentPID > signalMaxPID {
		return signalServiceParsedProcess{}, false
	}
	parentStartTime, ok := parseCanonicalDecimal(input.ParentStartTime)
	if !ok || parentStartTime == 0 {
		return signalServiceParsedProcess{}, false
	}
	return signalServiceParsedProcess{
		pid:             pid,
		startTime:       startTime,
		parentPID:       parentPID,
		parentStartTime: parentStartTime,
	}, true
}

func parseSignalServiceExecutable(input signalServiceExecutableInput) (signalServiceParsedExecutable, bool) {
	dev, ok := parseCanonicalDecimal(input.Dev)
	if !ok || dev == 0 {
		return signalServiceParsedExecutable{}, false
	}
	ino, ok := parseCanonicalDecimal(input.Ino)
	if !ok || ino == 0 {
		return signalServiceParsedExecutable{}, false
	}
	size, ok := parseCanonicalDecimal(input.Size)
	if !ok || size == 0 || size > signalExecutableMaxBytes {
		return signalServiceParsedExecutable{}, false
	}
	if len(input.SHA256) != sha256.Size*2 || strings.ToLower(input.SHA256) != input.SHA256 {
		return signalServiceParsedExecutable{}, false
	}
	digest, err := hex.DecodeString(input.SHA256)
	if err != nil || len(digest) != sha256.Size {
		return signalServiceParsedExecutable{}, false
	}
	var expected [sha256.Size]byte
	copy(expected[:], digest)
	return signalServiceParsedExecutable{
		dev:    dev,
		ino:    ino,
		size:   size,
		sha256: expected,
	}, true
}

func readSignalServiceFrame(
	file *os.File,
	reader *bufio.Reader,
	maxBytes int,
	limit time.Duration,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) ([]byte, *signalServiceError) {
	localDeadline, deadlineErr := deadline.local(limit)
	if deadlineErr != nil {
		return nil, deadlineErr
	}
	if err := hooks.setReadDeadline(file, localDeadline); err != nil {
		return nil, signalServiceFail(signalCodeRequestTimeout)
	}
	line := make([]byte, 0, maxBytes+1)
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > maxBytes+1 {
			return nil, signalServiceFail(signalCodeRequestInvalid)
		}
		line = append(line, fragment...)
		if err == nil {
			break
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, os.ErrDeadlineExceeded) {
			if deadlineErr := deadline.check(); deadlineErr != nil {
				return nil, deadlineErr
			}
			return nil, signalServiceFail(signalCodeRequestTimeout)
		}
		if deadlineErr := deadline.check(); deadlineErr != nil {
			return nil, deadlineErr
		}
		return nil, signalServiceFail(signalCodeRequestInvalid)
	}
	if len(line) == 0 || line[len(line)-1] != '\n' || len(line)-1 > maxBytes {
		return nil, signalServiceFail(signalCodeRequestInvalid)
	}
	if deadlineErr := deadline.check(); deadlineErr != nil {
		return nil, deadlineErr
	}
	return line[:len(line)-1], nil
}

func requireSignalServiceEOF(
	file *os.File,
	reader *bufio.Reader,
	limit time.Duration,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) *signalServiceError {
	localDeadline, deadlineErr := deadline.local(limit)
	if deadlineErr != nil {
		return deadlineErr
	}
	if err := hooks.setReadDeadline(file, localDeadline); err != nil {
		return signalServiceFail(signalCodeRequestTimeout)
	}
	if reader.Buffered() > 0 {
		return signalServiceFail(signalCodeRequestInvalid)
	}
	_, err := reader.ReadByte()
	if err == io.EOF {
		if deadlineErr := deadline.check(); deadlineErr != nil {
			return deadlineErr
		}
		return nil
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		if deadlineErr := deadline.check(); deadlineErr != nil {
			return deadlineErr
		}
		return signalServiceFail(signalCodeRequestTimeout)
	}
	if err != nil {
		if deadlineErr := deadline.check(); deadlineErr != nil {
			return deadlineErr
		}
		return signalServiceFail(signalCodeRequestInvalid)
	}
	if deadlineErr := deadline.check(); deadlineErr != nil {
		return deadlineErr
	}
	return signalServiceFail(signalCodeRequestInvalid)
}

func (d *signalServiceDeadline) check() *signalServiceError {
	if !d.now().Before(d.end) {
		return signalServiceFail(signalCodeDeadlineExceeded)
	}
	return nil
}

func (d *signalServiceDeadline) local(limit time.Duration) (time.Time, *signalServiceError) {
	now := d.now()
	remaining := d.end.Sub(now)
	if remaining <= 0 {
		return time.Time{}, signalServiceFail(signalCodeDeadlineExceeded)
	}
	if limit < remaining {
		remaining = limit
	}
	return now.Add(remaining), nil
}

func checkSignalServiceCaller(request signalServiceParsedRequest, deadline *signalServiceDeadline, hooks signalServiceHooks) *signalServiceError {
	parentPID := hooks.getppid()
	if parentPID <= 0 || uint64(parentPID) != request.manager.pid {
		return signalServiceFail(signalCodeCallerIdentityMismatch)
	}
	self, err := readSignalServiceProcStat(
		"/proc/self/stat",
		signalProcStatMaxBytes,
		signalCodeCallerIdentityMismatch,
		deadline,
		hooks,
	)
	if err != nil {
		return err
	}
	if self.PPid != uint64(parentPID) {
		return signalServiceFail(signalCodeCallerIdentityMismatch)
	}
	manager, err := readSignalServiceProcStat(
		"/proc/"+strconv.FormatUint(request.manager.pid, 10)+"/stat",
		signalProcStatMaxBytes,
		signalCodeCallerIdentityMismatch,
		deadline,
		hooks,
	)
	if err != nil {
		return err
	}
	if manager.PID != request.manager.pid || manager.StartTime != request.manager.startTime {
		return signalServiceFail(signalCodeCallerIdentityMismatch)
	}
	return checkSignalServiceNamespace(request.namespace, false, request.process.pid, deadline, hooks)
}

func verifySignalServiceTarget(
	pidfd int,
	request *signalServiceParsedRequest,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) *signalServiceError {
	if pidfd < 0 {
		return signalServiceFail(signalCodePidfdOpenFailed)
	}
	if guardErr := checkSignalServiceTargetStat(*request, deadline, hooks); guardErr != nil {
		return guardErr
	}
	if guardErr := checkSignalServiceNamespace(request.namespace, true, request.process.pid, deadline, hooks); guardErr != nil {
		return guardErr
	}
	if guardErr := checkSignalServiceTargetToken(request.process.pid, request.token, deadline, hooks); guardErr != nil {
		return guardErr
	}

	matched, firstMetadata, guardErr := verifySignalServiceExecutable(request.process.pid, *request, deadline, hooks)
	if guardErr != nil {
		return guardErr
	}
	request.matchedExecutable = matched

	if guardErr := checkSignalServiceTargetStat(*request, deadline, hooks); guardErr != nil {
		return guardErr
	}
	if guardErr := checkSignalServiceTargetToken(request.process.pid, request.token, deadline, hooks); guardErr != nil {
		return guardErr
	}
	if guardErr := checkSignalServiceCaller(*request, deadline, hooks); guardErr != nil {
		return guardErr
	}
	if guardErr := checkSignalServiceNamespace(request.namespace, true, request.process.pid, deadline, hooks); guardErr != nil {
		return guardErr
	}
	return verifySignalServiceExecutableMetadata(request.process.pid, matched, firstMetadata, *request, deadline, hooks)
}

func checkSignalServiceTargetStat(
	request signalServiceParsedRequest,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) *signalServiceError {
	stat, err := readSignalServiceProcStat(
		"/proc/"+strconv.FormatUint(request.process.pid, 10)+"/stat",
		signalProcStatMaxBytes,
		signalCodeTargetUnavailable,
		deadline,
		hooks,
	)
	if err != nil {
		return err
	}
	if stat.PID != request.process.pid ||
		stat.StartTime != request.process.startTime ||
		stat.PPid != request.process.parentPID {
		return signalServiceFail(signalCodeTargetIdentityMismatch)
	}
	return nil
}

func checkSignalServiceNamespace(
	expected signalServiceNamespaceInput,
	includeTarget bool,
	targetPID uint64,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) *signalServiceError {
	bootIDData, err := readSignalServiceFile(
		"/proc/sys/kernel/random/boot_id",
		signalBootIDMaxBytes,
		signalCodeNamespaceMismatch,
		deadline,
		hooks,
	)
	if err != nil {
		return err
	}
	bootID := string(bytes.TrimSuffix(bootIDData, []byte{'\n'}))
	if bootID != expected.BootID {
		return signalServiceFail(signalCodeNamespaceMismatch)
	}
	selfNamespace, err := readSignalServiceLink("/proc/self/ns/pid", deadline, hooks)
	if err != nil || selfNamespace != expected.PIDNamespaceID {
		return signalServiceFail(signalCodeNamespaceMismatch)
	}
	if includeTarget {
		targetNamespace, err := readSignalServiceLink(
			"/proc/"+strconv.FormatUint(targetPID, 10)+"/ns/pid",
			deadline,
			hooks,
		)
		if err != nil || targetNamespace != expected.PIDNamespaceID {
			return signalServiceFail(signalCodeNamespaceMismatch)
		}
	}
	return nil
}

func checkSignalServiceTargetToken(
	targetPID uint64,
	token string,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) *signalServiceError {
	data, err := readSignalServiceFile(
		"/proc/"+strconv.FormatUint(targetPID, 10)+"/environ",
		signalEnvironMaxBytes,
		signalCodeTargetUnavailable,
		deadline,
		hooks,
	)
	if err != nil {
		return err
	}
	if len(data) == 0 || data[len(data)-1] != 0 {
		return signalServiceFail(signalCodeTokenMismatch)
	}
	prefix := []byte("SFSC_SERVICE_TOKEN=")
	count := 0
	for _, entry := range bytes.Split(data[:len(data)-1], []byte{0}) {
		if !bytes.HasPrefix(entry, prefix) {
			continue
		}
		count++
		if string(entry[len(prefix):]) != token {
			return signalServiceFail(signalCodeTokenMismatch)
		}
	}
	if count != 1 {
		return signalServiceFail(signalCodeTokenMismatch)
	}
	return nil
}

func readSignalServiceProcStat(
	path string,
	maxBytes int64,
	unavailableCode string,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) (execServiceProcStat, *signalServiceError) {
	data, guardErr := readSignalServiceFile(path, maxBytes, unavailableCode, deadline, hooks)
	if guardErr != nil {
		return execServiceProcStat{}, guardErr
	}
	stat, err := parseExecServiceProcStat(data)
	if err != nil {
		return execServiceProcStat{}, signalServiceFail(unavailableCode)
	}
	return stat, nil
}

func readSignalServiceLink(path string, deadline *signalServiceDeadline, hooks signalServiceHooks) (string, *signalServiceError) {
	if err := deadline.check(); err != nil {
		return "", err
	}
	value, err := hooks.readlink(path)
	if err := deadline.check(); err != nil {
		return "", err
	}
	if err != nil {
		return "", signalServiceFail(signalCodeNamespaceMismatch)
	}
	return value, nil
}

func readSignalServiceFile(
	path string,
	maxBytes int64,
	unavailableCode string,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) ([]byte, *signalServiceError) {
	if err := deadline.check(); err != nil {
		return nil, err
	}
	fd, err := hooks.open(path, syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
	if err != nil || fd < 0 {
		return nil, signalServiceFail(unavailableCode)
	}

	data := make([]byte, 0, maxBytes+1)
	buffer := make([]byte, 64<<10)
	var readErr *signalServiceError
	for {
		if guardErr := deadline.check(); guardErr != nil {
			readErr = guardErr
			break
		}
		read, err := hooks.read(fd, buffer)
		if guardErr := deadline.check(); guardErr != nil {
			readErr = guardErr
			break
		}
		if read < 0 || read > len(buffer) {
			readErr = signalServiceFail(unavailableCode)
			break
		}
		if read > 0 {
			if int64(len(data))+int64(read) > maxBytes {
				readErr = signalServiceFail(unavailableCode)
				break
			}
			data = append(data, buffer[:read]...)
		}
		if err == nil {
			if read == 0 {
				// Raw syscall reads report EOF as (0, nil), unlike io.Reader.
				break
			}
			continue
		}
		if errors.Is(err, io.EOF) {
			break
		}
		readErr = signalServiceFail(unavailableCode)
		break
	}

	if deadlineErr := deadline.check(); deadlineErr != nil {
		readErr = deadlineErr
	}
	if closeErr := hooks.close(fd); closeErr != nil {
		return nil, signalServiceFail(signalCodeResourceCloseFailed)
	}
	if readErr != nil {
		return nil, readErr
	}
	return data, nil
}

func ensureSignalServiceCLOEXEC(fd int, deadline *signalServiceDeadline, hooks signalServiceHooks) *signalServiceError {
	if err := deadline.check(); err != nil {
		return err
	}
	flags, err := hooks.fcntl(fd, syscall.F_GETFD, 0)
	if err != nil || flags < 0 {
		return signalServiceFail(signalCodePidfdOpenFailed)
	}
	if flags&syscall.FD_CLOEXEC == 0 {
		if _, err := hooks.fcntl(fd, syscall.F_SETFD, flags|syscall.FD_CLOEXEC); err != nil {
			return signalServiceFail(signalCodePidfdOpenFailed)
		}
		flags, err = hooks.fcntl(fd, syscall.F_GETFD, 0)
		if err != nil || flags&syscall.FD_CLOEXEC == 0 {
			return signalServiceFail(signalCodePidfdOpenFailed)
		}
	}
	return deadline.check()
}

func verifySignalServiceExecutable(
	targetPID uint64,
	request signalServiceParsedRequest,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) (string, syscall.Stat_t, *signalServiceError) {
	if err := deadline.check(); err != nil {
		return "", syscall.Stat_t{}, err
	}
	fd, err := hooks.open(
		"/proc/"+strconv.FormatUint(targetPID, 10)+"/exe",
		syscall.O_RDONLY|syscall.O_CLOEXEC,
		0,
	)
	if err != nil || fd < 0 {
		return "", syscall.Stat_t{}, signalServiceFail(signalCodeTargetUnavailable)
	}

	var before syscall.Stat_t
	var after syscall.Stat_t
	var matched string
	var selected signalServiceParsedExecutable
	var guardErr *signalServiceError
	if guardErr = deadline.check(); guardErr == nil {
		if err := hooks.fstat(fd, &before); err != nil {
			guardErr = signalServiceFail(signalCodeTargetUnavailable)
		}
	}
	if guardErr == nil {
		if guardErr = deadline.check(); guardErr == nil {
			matched, selected, guardErr = matchSignalServiceExecutable(before, request)
		}
	}
	if guardErr == nil {
		var digest [sha256.Size]byte
		digest, guardErr = hashSignalServiceExecutable(fd, selected.size, deadline, hooks)
		if guardErr == nil && digest != selected.sha256 {
			guardErr = signalServiceFail(signalCodeExecutableMismatch)
		}
	}
	if guardErr == nil {
		if guardErr = deadline.check(); guardErr == nil {
			if err := hooks.fstat(fd, &after); err != nil {
				guardErr = signalServiceFail(signalCodeTargetUnavailable)
			}
		}
	}
	if guardErr == nil {
		if !sameSignalServiceExecutableMetadata(before, after) {
			guardErr = signalServiceFail(signalCodeExecutableMismatch)
		} else if matched == "target" && !signalServiceStatMatchesExecutable(after, request.target) {
			guardErr = signalServiceFail(signalCodeExecutableMismatch)
		} else if matched == "launcher" && !signalServiceStatMatchesExecutable(after, request.launcher) {
			guardErr = signalServiceFail(signalCodeExecutableMismatch)
		}
	}
	if deadlineErr := deadline.check(); deadlineErr != nil {
		guardErr = deadlineErr
	}
	if closeErr := hooks.close(fd); closeErr != nil {
		return "", syscall.Stat_t{}, signalServiceFail(signalCodeResourceCloseFailed)
	}
	if guardErr != nil {
		return "", syscall.Stat_t{}, guardErr
	}
	return matched, before, nil
}

func matchSignalServiceExecutable(
	stat syscall.Stat_t,
	request signalServiceParsedRequest,
) (string, signalServiceParsedExecutable, *signalServiceError) {
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG ||
		stat.Mode&0111 == 0 ||
		stat.Mode&(syscall.S_ISUID|syscall.S_ISGID) != 0 ||
		stat.Uid != 0 ||
		stat.Size <= 0 ||
		uint64(stat.Size) > signalExecutableMaxBytes {
		return "", signalServiceParsedExecutable{}, signalServiceFail(signalCodeExecutableMismatch)
	}
	if signalServiceStatMatchesExecutable(stat, request.launcher) {
		return "launcher", request.launcher, nil
	}
	if signalServiceStatMatchesExecutable(stat, request.target) {
		return "target", request.target, nil
	}
	return "", signalServiceParsedExecutable{}, signalServiceFail(signalCodeExecutableMismatch)
}

func signalServiceStatMatchesExecutable(stat syscall.Stat_t, expected signalServiceParsedExecutable) bool {
	return stat.Size > 0 &&
		uint64(stat.Dev) == expected.dev &&
		uint64(stat.Ino) == expected.ino &&
		uint64(stat.Size) == expected.size
}

func sameSignalServiceExecutableMetadata(left, right syscall.Stat_t) bool {
	return left.Dev == right.Dev &&
		left.Ino == right.Ino &&
		left.Size == right.Size &&
		left.Mode == right.Mode &&
		left.Uid == right.Uid
}

func hashSignalServiceExecutable(
	fd int,
	size uint64,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) ([sha256.Size]byte, *signalServiceError) {
	hasher := sha256.New()
	buffer := make([]byte, 64<<10)
	var offset int64
	remaining := int64(size)
	for remaining > 0 {
		if guardErr := deadline.check(); guardErr != nil {
			return [sha256.Size]byte{}, guardErr
		}
		chunk := int64(len(buffer))
		if remaining < chunk {
			chunk = remaining
		}
		read, err := hooks.pread(fd, buffer[:chunk], offset)
		if guardErr := deadline.check(); guardErr != nil {
			return [sha256.Size]byte{}, guardErr
		}
		if err != nil || read <= 0 || int64(read) > chunk {
			return [sha256.Size]byte{}, signalServiceFail(signalCodeExecutableMismatch)
		}
		_, _ = hasher.Write(buffer[:read])
		offset += int64(read)
		remaining -= int64(read)
	}

	if guardErr := deadline.check(); guardErr != nil {
		return [sha256.Size]byte{}, guardErr
	}
	var extra [1]byte
	read, err := hooks.pread(fd, extra[:], offset)
	if guardErr := deadline.check(); guardErr != nil {
		return [sha256.Size]byte{}, guardErr
	}
	if read != 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return [sha256.Size]byte{}, signalServiceFail(signalCodeExecutableMismatch)
	}
	var digest [sha256.Size]byte
	copy(digest[:], hasher.Sum(nil))
	return digest, nil
}

func verifySignalServiceExecutableMetadata(
	targetPID uint64,
	matched string,
	first syscall.Stat_t,
	request signalServiceParsedRequest,
	deadline *signalServiceDeadline,
	hooks signalServiceHooks,
) *signalServiceError {
	if err := deadline.check(); err != nil {
		return err
	}
	fd, err := hooks.open(
		"/proc/"+strconv.FormatUint(targetPID, 10)+"/exe",
		syscall.O_RDONLY|syscall.O_CLOEXEC,
		0,
	)
	if err != nil || fd < 0 {
		return signalServiceFail(signalCodeTargetUnavailable)
	}
	var current syscall.Stat_t
	var guardErr *signalServiceError
	if guardErr = deadline.check(); guardErr == nil {
		if err := hooks.fstat(fd, &current); err != nil {
			guardErr = signalServiceFail(signalCodeTargetUnavailable)
		}
	}
	if guardErr == nil {
		if guardErr = deadline.check(); guardErr == nil {
			if !sameSignalServiceExecutableMetadata(first, current) {
				guardErr = signalServiceFail(signalCodeExecutableMismatch)
			} else if matched == "launcher" {
				if !signalServiceStatMatchesExecutable(current, request.launcher) {
					guardErr = signalServiceFail(signalCodeExecutableMismatch)
				}
			} else if matched == "target" {
				if !signalServiceStatMatchesExecutable(current, request.target) {
					guardErr = signalServiceFail(signalCodeExecutableMismatch)
				}
			} else {
				guardErr = signalServiceFail(signalCodeExecutableMismatch)
			}
		}
	}
	if deadlineErr := deadline.check(); deadlineErr != nil {
		guardErr = deadlineErr
	}
	if closeErr := hooks.close(fd); closeErr != nil {
		return signalServiceFail(signalCodeResourceCloseFailed)
	}
	return guardErr
}

func writeSignalServiceFailure(stdout *os.File, code string, hooks signalServiceHooks) int {
	response := signalServiceFailureResponse{
		Version:       protocolVersion,
		HelperVersion: helperVersion,
		Operation:     signalServiceMode,
		OK:            false,
		Error:         signalServiceFailureBody{Code: code},
	}
	if err := writeSignalServiceJSONFrame(stdout, response, signalFailureMaxBytes, hooks.outputWait, hooks); err != nil {
		return 2
	}
	return 2
}

func writeSignalServiceJSONFrame(
	stdout *os.File,
	value any,
	maxBytes int,
	timeout time.Duration,
	hooks signalServiceHooks,
) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > maxBytes+1 {
		return errors.New("frame too large")
	}
	return hooks.writeFrame(stdout, data, timeout)
}

func writeSignalServiceBytes(file *os.File, data []byte, timeout time.Duration) error {
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

func linuxSignalServiceHooks() signalServiceHooks {
	return signalServiceHooks{
		now:             time.Now,
		getppid:         os.Getppid,
		readlink:        os.Readlink,
		open:            syscall.Open,
		read:            syscall.Read,
		close:           syscall.Close,
		closeFile:       func(file *os.File) error { return file.Close() },
		fstat:           syscall.Fstat,
		pread:           syscall.Pread,
		fcntl:           linuxExecServiceFcntl,
		pidfdOpen:       linuxSignalServicePidfdOpen,
		pidfdSendSignal: linuxSignalServicePidfdSendSignal,
		setReadDeadline: func(file *os.File, deadline time.Time) error {
			return file.SetReadDeadline(deadline)
		},
		setProtocolRead:  func(file *os.File, deadline time.Time) error { return file.SetReadDeadline(deadline) },
		setProtocolWrite: func(file *os.File, deadline time.Time) error { return file.SetWriteDeadline(deadline) },
		writeFrame:       writeSignalServiceBytes,
		totalBudget:      signalTotalBudget,
		initialFrameWait: signalInitialFrameLimit,
		eofWait:          signalEOFLimit,
		outputWait:       signalOutputLimit,
	}
}

func linuxSignalServicePidfdOpen(pid uint64, flags uintptr) (int, error) {
	value, _, errno := syscall.RawSyscall(signalServiceSysPidfdOpen, uintptr(pid), flags, 0)
	if errno != 0 {
		return -1, errno
	}
	return int(value), nil
}

func linuxSignalServicePidfdSendSignal(fd int, signal syscall.Signal, flags uintptr) error {
	_, _, errno := syscall.RawSyscall6(
		signalServiceSysPidfdSend,
		uintptr(fd),
		uintptr(signal),
		0,
		flags,
		0,
		0,
	)
	if errno != 0 {
		return errno
	}
	return nil
}

func signalServiceFail(code string) *signalServiceError {
	return &signalServiceError{code: code}
}
