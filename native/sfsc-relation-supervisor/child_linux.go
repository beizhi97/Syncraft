//go:build linux && (amd64 || arm64)

package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"syscall"
	"time"
)

const execServiceV2Mode = "exec-service-v2"

const (
	sysPidfdOpen       = 434
	sysPidfdSendSignal = 424
)

type helperProcess struct {
	PID             uint64
	Start           procStat
	ProtocolVersion int
	Stdin           *os.File
	Stdout          *os.File
	Stderr          *os.File
}

type signalServiceManager struct {
	PID       string `json:"pid"`
	StartTime string `json:"starttime"`
}

type signalServiceProcess struct {
	PID             string `json:"pid"`
	StartTime       string `json:"starttime"`
	ParentPID       string `json:"parentPid"`
	ParentStartTime string `json:"parentStarttime"`
}

type signalServiceExecutables struct {
	Launcher fileIdentity `json:"launcher"`
	Target   fileIdentity `json:"target"`
}

type signalServiceRequest struct {
	Version    int                      `json:"version"`
	Operation  string                   `json:"operation"`
	Signal     string                   `json:"signal"`
	Namespace  namespaceIdentity        `json:"namespace"`
	Manager    signalServiceManager     `json:"manager"`
	Process    signalServiceProcess     `json:"process"`
	Token      string                   `json:"token"`
	Executable signalServiceExecutables `json:"executable"`
}

type signalServiceResponse struct {
	Version   int    `json:"version"`
	Operation string `json:"operation"`
	OK        bool   `json:"ok"`
	Delivery  string `json:"delivery"`
}

type waitResult struct {
	PID    uint64
	Status syscall.WaitStatus
}

func startHelper(
	execServicePath string,
	rclonePath string,
	rootPath string,
	authorizedKeysPath string,
	hostKeyPath string,
	listener listenerIdentity,
	token string,
	parent processIdentity,
) (*helperProcess, error) {
	return startHelperContract(execServicePath, rclonePath, rootPath, authorizedKeysPath, hostKeyPath, "", listener, token, parent)
}

func startHelperV2(execServicePath, servicePath, rootPath, authorizedKeysPath, hostKeyPath, user string, listener listenerIdentity, token string, parent processIdentity) (*helperProcess, error) {
	if !validServiceV2Username(user) {
		return nil, errors.New("service_user_invalid")
	}
	return startHelperContract(execServicePath, servicePath, rootPath, authorizedKeysPath, hostKeyPath, user, listener, token, parent)
}

func startHelperContract(
	execServicePath, targetPath, rootPath, authorizedKeysPath, hostKeyPath, user string,
	listener listenerIdentity, token string, parent processIdentity,
) (*helperProcess, error) {
	isV2 := user != ""
	targetFile, err := os.Open(targetPath)
	if err != nil {
		return nil, err
	}
	defer targetFile.Close()
	helperFile, err := os.Open(execServicePath)
	if err != nil {
		return nil, err
	}
	defer helperFile.Close()
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		closeFiles(stdinRead, stdinWrite)
		return nil, err
	}
	stderrRead, stderrWrite, err := os.Pipe()
	if err != nil {
		closeFiles(stdinRead, stdinWrite, stdoutRead, stdoutWrite)
		return nil, err
	}
	devNull, err := os.OpenFile("/dev/null", os.O_RDWR, 0)
	if err != nil {
		closeFiles(stdinRead, stdinWrite, stdoutRead, stdoutWrite, stderrRead, stderrWrite)
		return nil, err
	}
	defer devNull.Close()

	mode := "exec-service"
	if isV2 {
		mode = execServiceV2Mode
	}
	childEnv := []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/nonexistent", "LC_ALL=C", "SFSC_SERVICE_TOKEN=" + token}
	if !isV2 {
		childEnv = append(childEnv, "XDG_CONFIG_HOME=/nonexistent", "RCLONE_CONFIG=/dev/null")
	}
	pid, err := syscall.ForkExec(
		execServicePath,
		[]string{execServicePath, mode},
		&syscall.ProcAttr{
			Dir: "/",
			Env: childEnv,
			Files: []uintptr{
				stdinRead.Fd(),
				stdoutWrite.Fd(),
				stderrWrite.Fd(),
				targetFile.Fd(),
				helperFile.Fd(),
			},
		},
	)
	closeFiles(stdinRead, stdoutWrite, stderrWrite)
	if err != nil {
		closeFiles(stdinWrite, stdoutRead, stderrRead)
		return nil, err
	}
	childStat, err := readProcStat(uint64(pid))
	if err != nil {
		_ = signalDirectChild(uint64(pid), 0, syscall.SIGKILL)
		_ = waitForSpecificChild(uint64(pid), 5*time.Second)
		closeFiles(stdinWrite, stdoutRead, stderrRead)
		return nil, err
	}
	launcher, err := readFileIdentity(execServicePath)
	if err != nil {
		_ = signalDirectChild(uint64(pid), childStat.StartTime, syscall.SIGKILL)
		_ = waitForSpecificChild(uint64(pid), 5*time.Second)
		closeFiles(stdinWrite, stdoutRead, stderrRead)
		return nil, err
	}
	target, err := readFileIdentity(targetPath)
	if err != nil {
		_ = signalDirectChild(uint64(pid), childStat.StartTime, syscall.SIGKILL)
		_ = waitForSpecificChild(uint64(pid), 5*time.Second)
		closeFiles(stdinWrite, stdoutRead, stderrRead)
		return nil, err
	}
	launch := map[string]any{
		"version":   1,
		"operation": "launch",
		"token":     token,
		"parent": map[string]string{
			"pid":       parent.PID,
			"starttime": parent.StartTime,
		},
		"rclone": map[string]string{
			"dev":    target.Dev,
			"ino":    target.Ino,
			"size":   target.Size,
			"sha256": target.Sha256,
		},
		"listener": map[string]any{
			"host": listener.Host,
			"port": listener.Port,
		},
		"argv": []string{
			"serve",
			"sftp",
			":local:" + rootPath,
			"--addr",
			fmt.Sprintf("%s:%d", listener.Host, listener.Port),
			"--authorized-keys",
			authorizedKeysPath,
			"--key",
			hostKeyPath,
			"--dir-cache-time",
			"0",
			"--poll-interval",
			"0",
			"--vfs-cache-mode",
			"off",
		},
	}
	if isV2 {
		delete(launch, "rclone")
		launch["version"] = 2
		launch["service"] = map[string]string{"dev": target.Dev, "ino": target.Ino, "size": target.Size, "sha256": fileSHA256(targetPath)}
		launch["argv"] = []string{"sfsc-sftp-service", "--root", rootPath, "--addr", fmt.Sprintf("%s:%d", listener.Host, listener.Port), "--authorized-keys", authorizedKeysPath, "--key", hostKeyPath, "--user", user}
	}
	if err := writeJSONLine(stdinWrite, launch); err != nil {
		_ = signalDirectChild(uint64(pid), childStat.StartTime, syscall.SIGKILL)
		_ = waitForSpecificChild(uint64(pid), 5*time.Second)
		closeFiles(stdinWrite, stdoutRead, stderrRead)
		return nil, err
	}
	_ = launcher
	version := 1
	if isV2 {
		version = 2
	}
	return &helperProcess{
		PID:             uint64(pid),
		Start:           childStat,
		ProtocolVersion: version,
		Stdin:           stdinWrite,
		Stdout:          stdoutRead,
		Stderr:          stderrRead,
	}, nil
}

func fileSHA256(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return ""
	}
	return hex.EncodeToString(hash.Sum(nil))
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

func terminateHelper(helper *helperProcess) error {
	if helper == nil {
		return nil
	}
	var waitErr error
	var signalErr error
	if helper.PID != 0 {
		signalErr = signalDirectChild(helper.PID, helper.Start.StartTime, syscall.SIGKILL)
		waitErr = waitForSpecificChild(helper.PID, 5*time.Second)
	}
	closeFiles(helper.Stdin, helper.Stdout, helper.Stderr)
	helper.Stdin = nil
	helper.Stdout = nil
	helper.Stderr = nil
	if signalErr != nil {
		return signalErr
	}
	return waitErr
}

func readHelperReady(helper *helperProcess, timeout time.Duration) (map[string]any, error) {
	return readJSONLineWithTimeout(helper.Stdout, timeout)
}

func sendHelperGo(helper *helperProcess, token string) error {
	if helper == nil || helper.Stdin == nil {
		return errors.New("helper_stdin_missing")
	}
	version := helper.ProtocolVersion
	if version == 0 {
		version = 1
	}
	err := writeJSONLine(helper.Stdin, map[string]any{
		"version":   version,
		"operation": "go",
		"token":     token,
	})
	closeErr := helper.Stdin.Close()
	helper.Stdin = nil
	if err != nil {
		return err
	}
	return closeErr
}

func sendExactSignal(
	signalServicePath string,
	signal string,
	namespace namespaceIdentity,
	manager processIdentity,
	process processParentIdentity,
	token string,
	launcher fileIdentity,
	target fileIdentity,
	timeout time.Duration,
) error {
	presence, err := observeProcessPresence(process)
	if err != nil {
		return err
	}
	if presence == processGone {
		return nil
	}
	if presence != processExact {
		return errors.New("process_not_exact")
	}
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		closeFiles(stdinRead, stdinWrite)
		return err
	}
	devNull, err := os.OpenFile("/dev/null", os.O_RDWR, 0)
	if err != nil {
		closeFiles(stdinRead, stdinWrite, stdoutRead, stdoutWrite)
		return err
	}
	defer devNull.Close()
	pid, err := syscall.ForkExec(
		signalServicePath,
		[]string{signalServicePath, "signal-service"},
		&syscall.ProcAttr{
			Dir: "/",
			Env: []string{
				"PATH=/usr/local/bin:/usr/bin:/bin",
				"HOME=/nonexistent",
				"LC_ALL=C",
			},
			Files: []uintptr{
				stdinRead.Fd(),
				stdoutWrite.Fd(),
				devNull.Fd(),
			},
		},
	)
	closeFiles(stdinRead, stdoutWrite)
	if err != nil {
		closeFiles(stdinWrite, stdoutRead)
		return err
	}
	request := signalServiceRequest{
		Version:   1,
		Operation: "signal",
		Signal:    signal,
		Namespace: namespace,
		Manager: signalServiceManager{
			PID:       manager.PID,
			StartTime: manager.StartTime,
		},
		Process: signalServiceProcess{
			PID:             process.PID,
			StartTime:       process.StartTime,
			ParentPID:       process.ParentPID,
			ParentStartTime: process.ParentStartTime,
		},
		Token: token,
		Executable: signalServiceExecutables{
			Launcher: launcher,
			Target:   target,
		},
	}
	if err := writeJSONLine(stdinWrite, request); err != nil {
		_ = signalDirectChild(uint64(pid), 0, syscall.SIGKILL)
		_ = waitForSpecificChild(uint64(pid), timeout)
		closeFiles(stdinWrite, stdoutRead)
		return err
	}
	if err := stdinWrite.Close(); err != nil {
		_ = signalDirectChild(uint64(pid), 0, syscall.SIGKILL)
		_ = waitForSpecificChild(uint64(pid), timeout)
		closeFiles(stdoutRead)
		return err
	}
	response, readErr := readJSONLineWithTimeout(stdoutRead, timeout)
	_ = stdoutRead.Close()
	if readErr != nil {
		_ = signalDirectChild(uint64(pid), 0, syscall.SIGKILL)
		_ = waitForSpecificChild(uint64(pid), timeout)
		return readErr
	}
	waitErr := waitForSpecificChild(uint64(pid), timeout)
	if waitErr != nil {
		_ = signalDirectChild(uint64(pid), 0, syscall.SIGKILL)
		_ = waitForSpecificChild(uint64(pid), timeout)
		return waitErr
	}
	if response["ok"] != true || response["delivery"] != "pidfd-send-returned" {
		return errors.New("signal_service_failed")
	}
	return nil
}

func signalDirectChild(pid uint64, expectedStartTime uint64, signal syscall.Signal) error {
	if pid == 0 {
		return errors.New("child_pid_invalid")
	}
	fd, _, errno := syscall.RawSyscall(
		sysPidfdOpen,
		uintptr(pid),
		0,
		0,
	)
	if errno != 0 {
		if errors.Is(errno, syscall.ESRCH) || errors.Is(errno, syscall.ENOENT) {
			return nil
		}
		return fmt.Errorf("pidfd_open_failed: %w", errno)
	}
	defer syscall.Close(int(fd))
	stat, err := readProcStat(pid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if stat.PPID != uint64(os.Getpid()) {
		return errors.New("child_parent_mismatch")
	}
	if expectedStartTime != 0 && stat.StartTime != expectedStartTime {
		return errors.New("child_identity_changed")
	}
	for {
		_, _, errno = syscall.RawSyscall6(
			sysPidfdSendSignal,
			fd,
			uintptr(signal),
			0,
			0,
			0,
			0,
		)
		if errno == syscall.EINTR {
			continue
		}
		if errno == 0 || errors.Is(errno, syscall.ESRCH) {
			return nil
		}
		return fmt.Errorf("pidfd_send_signal_failed: %w", errno)
	}
}

func waitForSpecificChild(pid uint64, timeout time.Duration) error {
	if pid == 0 {
		return errors.New("child_pid_invalid")
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var status syscall.WaitStatus
		reaped, err := syscall.Wait4(int(pid), &status, syscall.WNOHANG, nil)
		if err != nil {
			if errors.Is(err, syscall.ECHILD) {
				return errors.New("child_already_reaped")
			}
			return err
		}
		if reaped > 0 {
			_ = status
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("child_wait_timeout")
}

func drainAdoptedChildren(timeout time.Duration) (bool, error) {
	deadline := time.Now().Add(timeout)
	firstSeen := map[uint64]time.Time{}
	for {
		for {
			var status syscall.WaitStatus
			pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
			if err != nil {
				if errors.Is(err, syscall.ECHILD) {
					break
				}
				return false, err
			}
			if pid <= 0 {
				break
			}
			_ = status
			delete(firstSeen, uint64(pid))
		}
		children, err := directChildren()
		if err != nil {
			return false, err
		}
		if len(children) == 0 {
			var status syscall.WaitStatus
			_, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
			if errors.Is(err, syscall.ECHILD) {
				return true, nil
			}
		}
		if !time.Now().Before(deadline) {
			return false, nil
		}
		for _, child := range children {
			stat, err := readProcStat(child)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				return false, err
			}
			if stat.PPID != uint64(os.Getpid()) {
				return false, errors.New("adopted_child_parent_mismatch")
			}
			seenAt, seen := firstSeen[child]
			if !seen {
				firstSeen[child] = time.Now()
				if err := signalDirectChild(child, stat.StartTime, syscall.SIGTERM); err != nil {
					return false, err
				}
				continue
			}
			if time.Since(seenAt) >= 250*time.Millisecond {
				if err := signalDirectChild(child, stat.StartTime, syscall.SIGKILL); err != nil {
					return false, err
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func waitForHelperExit(pid uint64, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var status syscall.WaitStatus
		reaped, err := syscall.Wait4(int(pid), &status, syscall.WNOHANG, nil)
		if err != nil {
			if errors.Is(err, syscall.ECHILD) {
				return nil
			}
			return err
		}
		if reaped > 0 {
			_ = status
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("helper_wait_timeout")
}

func writeJSONLine(file *os.File, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	data = append(data, '\n')
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

func readJSONLineWithTimeout(file *os.File, timeout time.Duration) (map[string]any, error) {
	type result struct {
		value map[string]any
		err   error
	}
	channel := make(chan result, 1)
	go func() {
		reader := bufio.NewReaderSize(file, 64*1024)
		line, err := reader.ReadBytes('\n')
		if err != nil {
			channel <- result{err: err}
			return
		}
		if len(line) > 64*1024 {
			channel <- result{err: errors.New("child_frame_too_large")}
			return
		}
		var value map[string]any
		if err := json.Unmarshal(line, &value); err != nil {
			channel <- result{err: err}
			return
		}
		channel <- result{value: value}
	}()
	select {
	case outcome := <-channel:
		return outcome.value, outcome.err
	case <-time.After(timeout):
		return nil, errors.New("child_response_timeout")
	}
}

func closeFiles(files ...*os.File) {
	for _, file := range files {
		if file != nil {
			_ = file.Close()
		}
	}
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

func validToken(value string) bool {
	if len(value) != 32 || value != lowerASCII(value) {
		return false
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}

func lowerASCII(value string) string {
	result := []byte(value)
	for index, char := range result {
		if char >= 'A' && char <= 'Z' {
			result[index] = char + ('a' - 'A')
		}
	}
	return string(result)
}
