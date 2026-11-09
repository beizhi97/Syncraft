//go:build linux && (amd64 || arm64)

package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// V2 is a distinct child protocol and identity. It deliberately does not
// accept the V1 rclone request or its argv contract.
const execServiceV2Mode = "exec-service-v2"

type serviceV2Request struct {
	Version   int                      `json:"version"`
	Operation string                   `json:"operation"`
	Token     string                   `json:"token"`
	Parent    execServiceParentInput   `json:"parent"`
	Service   execServiceRcloneInput   `json:"service"`
	Listener  execServiceListenerInput `json:"listener"`
	Argv      []string                 `json:"argv"`
}
type serviceV2Ready struct {
	Version       int                     `json:"version"`
	HelperVersion string                  `json:"helperVersion"`
	Operation     string                  `json:"operation"`
	OK            bool                    `json:"ok"`
	State         string                  `json:"state"`
	Token         string                  `json:"token"`
	PID           string                  `json:"pid"`
	StartTime     string                  `json:"starttime"`
	ParentPID     string                  `json:"parentPid"`
	Service       execServiceFileIdentity `json:"service"`
	Listener      execServiceListener     `json:"listener"`
	Capabilities  execServiceCapabilities `json:"capabilities"`
}

type serviceV2Failure struct {
	Version       int                    `json:"version"`
	HelperVersion string                 `json:"helperVersion"`
	Operation     string                 `json:"operation"`
	OK            bool                   `json:"ok"`
	Error         execServiceFailureBody `json:"error"`
}

func writeServiceV2Failure(out *os.File, code string) int {
	data, err := json.Marshal(serviceV2Failure{Version: 2, HelperVersion: helperVersion, Operation: execServiceV2Mode, OK: false, Error: execServiceFailureBody{Code: code}})
	if err == nil {
		data = append(data, '\n')
		_ = writeExecServiceBytes(out, data, execReadyWriteTimeout)
	}
	return 2
}

func decodeServiceV2Request(frame []byte) (serviceV2Request, execServiceParsedParent, execServiceParsedRclone, *execServiceError) {
	var req serviceV2Request
	err := decodeExecServiceObject(frame, []string{"version", "operation", "token", "parent", "service", "listener", "argv"}, map[string]func(json.RawMessage) error{
		"version": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Version) }, "operation": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Operation) }, "token": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Token) }, "parent": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Parent) }, "service": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Service) }, "listener": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Listener) }, "argv": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Argv) },
	})
	if err != nil || req.Version != 2 || req.Operation != "launch" || !validExecServiceToken(req.Token) {
		return serviceV2Request{}, execServiceParsedParent{}, execServiceParsedRclone{}, execServiceFail(execCodeRequestInvalid)
	}
	parent, ok := parseExecServiceParent(req.Parent)
	if !ok {
		return serviceV2Request{}, execServiceParsedParent{}, execServiceParsedRclone{}, execServiceFail(execCodeRequestInvalid)
	}
	identity, ok := parseExecServiceRclone(req.Service)
	if !ok || req.Listener.Host != "127.0.0.1" || req.Listener.Port < 1 || req.Listener.Port > 65535 || !validServiceV2Argv(req.Argv, req.Listener) {
		return serviceV2Request{}, execServiceParsedParent{}, execServiceParsedRclone{}, execServiceFail(execCodeRequestInvalid)
	}
	return req, parent, identity, nil
}

func decodeServiceV2Go(frame []byte, token string) *execServiceError {
	var req execServiceGoRequest
	err := decodeExecServiceObject(frame, []string{"version", "operation", "token"}, map[string]func(json.RawMessage) error{"version": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Version) }, "operation": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Operation) }, "token": func(r json.RawMessage) error { return json.Unmarshal(r, &req.Token) }})
	if err != nil || req.Version != 2 || req.Operation != "go" || req.Token != token || !validExecServiceToken(req.Token) {
		return execServiceFail(execCodeGoInvalid)
	}
	return nil
}

func validateServiceV2AfterGo(parent execServiceParsedParent, identity execServiceParsedRclone, capLast uint64, hooks execServiceHooks) *execServiceError {
	if err := verifyExecServiceSecurity(capLast, hooks); err != nil {
		return err
	}
	if _, err := checkExecServiceParent(parent, hooks); err != nil {
		return err
	}
	if _, err := verifyExecServiceRclone(execRcloneFD, identity, hooks); err != nil {
		return err
	}
	return nil
}

func runExecServiceV2(args []string, stdin, stdout, stderr *os.File) int {
	h := linuxExecServiceHooks()
	h.lockOSThread()
	_ = stderr
	if len(args) != 2 || args[1] != execServiceV2Mode {
		return writeServiceV2Failure(stdout, execCodeRequestInvalid)
	}
	in, out, pe := prepareExecServiceProtocolFiles(stdin, stdout, h)
	if pe != nil {
		return writeServiceV2Failure(stdout, pe.code)
	}
	defer in.Close()
	defer out.Close()
	fail := func(code string) int { return writeServiceV2Failure(out, code) }
	reader := bufio.NewReaderSize(in, execRequestMaxBytes+2)
	frame, fe := readExecServiceFrame(in, reader, execRequestMaxBytes, execRequestTimeout)
	if fe != nil {
		return fail(fe.code)
	}
	req, parent, identity, reqErr := decodeServiceV2Request(frame)
	if reqErr != nil || h.getenv("SFSC_SERVICE_TOKEN") != req.Token {
		return fail(execCodeRequestInvalid)
	}
	if _, err := h.prctl(prSetPDeathSig, uintptr(syscall.SIGKILL), 0, 0, 0); err != nil {
		return fail(execCodePDeathSigFailed)
	}
	self, ge := checkExecServiceParent(parent, h)
	if ge != nil {
		return fail(ge.code)
	}
	if _, ge = verifyExecServiceRclone(execRcloneFD, identity, h); ge != nil {
		return fail(ge.code)
	}
	capLast, ge := readExecServiceCapLast(h)
	if ge != nil {
		return fail(ge.code)
	}
	if ge = dropExecServiceCapabilities(capLast, h); ge != nil {
		return fail(ge.code)
	}
	if ge = verifyExecServiceSecurity(capLast, h); ge != nil {
		return fail(ge.code)
	}
	if _, ge = checkExecServiceParent(parent, h); ge != nil {
		return fail(ge.code)
	}
	if _, ge = verifyExecServiceRclone(execRcloneFD, identity, h); ge != nil {
		return fail(ge.code)
	}
	ready := serviceV2Ready{Version: 2, HelperVersion: helperVersion, Operation: execServiceV2Mode, OK: true, State: "ready", Token: req.Token, PID: strconv.Itoa(h.getpid()), StartTime: strconv.FormatUint(self.StartTime, 10), ParentPID: strconv.Itoa(h.getppid()), Service: execServiceFileIdentity{Dev: req.Service.Dev, Ino: req.Service.Ino, Size: req.Service.Size, SHA256: req.Service.SHA256}, Listener: execServiceListener{Host: req.Listener.Host, Port: req.Listener.Port}, Capabilities: execServiceCapabilities{Effective: "0", Permitted: "0", Inheritable: "0", Bounding: "0", Ambient: "0", NoNewPrivs: true, ParentDeathSig: "SIGKILL"}}
	if err := writeExecServiceJSONFrame(out, ready, execReadyMaxBytes, execReadyWriteTimeout); err != nil {
		return fail(execCodeReadyWrite)
	}
	goFrame, ge2 := readExecServiceFrame(in, reader, execGoMaxBytes, execGoTimeout)
	if ge2 != nil {
		return fail(execCodeGoTimeout)
	}
	if decodeServiceV2Go(goFrame, req.Token) != nil || requireExecServiceEOF(in, reader, execGoEOFTimeout) != nil {
		return fail(execCodeGoInvalid)
	}
	if ge = validateServiceV2AfterGo(parent, identity, capLast, h); ge != nil {
		return fail(ge.code)
	}
	payload, err := buildServiceV2ExecvePayload(req.Argv, req.Token)
	if err != nil {
		return fail(execCodeRequestInvalid)
	}
	return executeExecServicePayload(out, payload, h, execServiceV2FailureFrames())
}

func validServiceV2Argv(argv []string, listener execServiceListenerInput) bool {
	if len(argv) != 11 {
		return false
	}
	total := 0
	for _, v := range argv {
		if v == "" || strings.IndexByte(v, 0) >= 0 {
			return false
		}
		total += len(v)
	}
	if total > 16<<10 {
		return false
	}
	if argv[0] != "sfsc-sftp-service" || argv[1] != "--root" || !validCleanAbsolutePath(argv[2]) || argv[3] != "--addr" || argv[4] != "127.0.0.1:"+strconv.Itoa(listener.Port) || argv[5] != "--authorized-keys" || !validCleanAbsolutePath(argv[6]) || argv[7] != "--key" || !validCleanAbsolutePath(argv[8]) || argv[9] != "--user" {
		return false
	}
	return validServiceV2Username(argv[10])
}

func validServiceV2Username(value string) bool {
	if len(value) < 1 || len(value) > 32 {
		return false
	}
	for i, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || i > 0 && (c == '_' || c == '-' || c == '.')) {
			return false
		}
	}
	return true
}

func buildServiceV2ExecvePayload(argv []string, token string) (*execvePayload, error) {
	values := append([]string(nil), argv...)
	values[0] = "sfsc-sftp-service"
	env := []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/nonexistent", "LC_ALL=C", "SFSC_SERVICE_TOKEN=" + token}
	ab, ap, err := packExecServiceCStrings(values)
	if err != nil {
		return nil, err
	}
	eb, ep, err := packExecServiceCStrings(env)
	if err != nil {
		return nil, err
	}
	return &execvePayload{path: []byte("/proc/self/fd/3\x00"), argBlock: ab, envBlock: eb, argv: ap, envp: ep}, nil
}
