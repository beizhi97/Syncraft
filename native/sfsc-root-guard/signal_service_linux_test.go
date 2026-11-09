//go:build linux && (amd64 || arm64)

package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	signalRequireRealEnv = "SFSC_SIGNAL_REQUIRE_REAL"
	signalHelperPathEnv  = "SFSC_SIGNAL_HELPER_PATH"
	signalHelperSHAEnv   = "SFSC_SIGNAL_HELPER_SHA256"
	signalFixtureTarget  = "SFSC_SIGNAL_FIXTURE_TARGET"

	signalTestToken      = "0123456789abcdef0123456789abcdef"
	signalTestBootID     = "abcdef01-2345-4678-9abc-def012345678"
	signalTestNamespace  = "pid:[4026532000]"
	signalTestManagerPID = "101"
	signalTestTargetPID  = "102"
	signalTestStartTime  = "900"
	signalTestTargetTime = "901"
)

type signalServiceTestEnvironment struct {
	now       time.Time
	ppid      int
	files     map[string][]byte
	links     map[string]string
	openErrs  map[string]error
	readErrs  map[string]error
	closeErrs map[int]error

	exeData  []byte
	exeStat  syscall.Stat_t
	fstatFn  func(int, *syscall.Stat_t, string) error
	preadFn  func(int, []byte, int64, string) (int, error)
	readFn   func(int, []byte, string) (int, error)
	closeFn  func(int, string) error
	writeErr error

	nextFD             int
	pidfd              int
	fdPath             map[int]string
	fdOffset           map[int]int
	openedPaths        []string
	closedFDs          []int
	closedPaths        []string
	rawCloseFDs        []int
	protocolCloseFDs   []int
	protocolCloseNames []string
	closeFileFn        func(*os.File) error
	events             []string
	readDeadlines      []time.Time
	pidfdOpenCall      int
	sentSignals        []syscall.Signal
	sendCallCount      int
	pidfdOpenErr       error
	sendErr            error
}

func TestSignalFixtureTargetProcess(t *testing.T) {
	if os.Getenv(signalFixtureTarget) != "1" {
		return
	}
	for {
		time.Sleep(time.Hour)
	}
}

func TestSignalServiceDecodeRequestStrict(t *testing.T) {
	request := validSignalServiceTestRequest()
	valid := marshalSignalServiceTestRequest(t, request)
	if _, err := decodeSignalServiceRequest(valid); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}

	tests := []struct {
		name string
		data []byte
	}{
		{name: "empty", data: nil},
		{name: "null", data: []byte("null")},
		{name: "array", data: []byte("[]")},
		{name: "trailing whitespace", data: append(append([]byte(nil), valid...), ' ')},
		{name: "trailing value", data: append(append([]byte(nil), valid...), []byte(" {}")...)},
		{name: "nul", data: append(append([]byte(nil), valid...), 0)},
		{name: "invalid utf8", data: append(append([]byte(nil), valid...), 0xff)},
		{name: "duplicate top-level", data: []byte(`{"version":1,` + string(valid[1:]))},
		{name: "unknown top-level", data: signalServiceJSONWithTopLevelField(t, valid, "extra", true)},
		{name: "duplicate namespace", data: signalServiceJSONWithDuplicateNestedField(t, valid, "namespace", "bootId")},
		{name: "unknown namespace", data: signalServiceJSONWithNestedField(t, valid, "namespace", "extra", true)},
		{name: "duplicate manager", data: signalServiceJSONWithDuplicateNestedField(t, valid, "manager", "pid")},
		{name: "unknown process", data: signalServiceJSONWithNestedField(t, valid, "process", "extra", true)},
		{name: "duplicate process", data: signalServiceJSONWithDuplicateNestedField(t, valid, "process", "pid")},
		{name: "duplicate executable", data: signalServiceJSONWithDuplicateNestedField(t, valid, "executable", "target")},
		{name: "duplicate launcher field", data: signalServiceJSONWithDuplicateExecutableField(t, valid, "launcher", "dev")},
		{name: "null namespace", data: signalServiceJSONWithTopLevelField(t, valid, "namespace", nil)},
		{name: "null manager", data: signalServiceJSONWithTopLevelField(t, valid, "manager", nil)},
		{name: "null process", data: signalServiceJSONWithTopLevelField(t, valid, "process", nil)},
		{name: "null executable", data: signalServiceJSONWithTopLevelField(t, valid, "executable", nil)},
	}
	for _, key := range []string{"version", "operation", "signal", "namespace", "manager", "process", "token", "executable"} {
		object := signalServiceJSONObject(t, valid)
		delete(object, key)
		tests = append(tests, struct {
			name string
			data []byte
		}{name: "missing " + key, data: signalServiceMarshalJSON(t, object)})
	}
	for _, key := range []string{"version", "operation", "signal", "token"} {
		tests = append(tests,
			struct {
				name string
				data []byte
			}{name: "wrong type " + key, data: signalServiceJSONWithTopLevelField(t, valid, key, []string{"wrong"})},
			struct {
				name string
				data []byte
			}{name: "null " + key, data: signalServiceJSONWithTopLevelField(t, valid, key, nil)},
		)
	}
	for _, nested := range []struct {
		object string
		fields []string
	}{
		{object: "namespace", fields: []string{"bootId", "pidNamespaceId"}},
		{object: "manager", fields: []string{"pid", "starttime"}},
		{object: "process", fields: []string{"pid", "starttime", "parentPid", "parentStarttime"}},
		{object: "executable", fields: []string{"launcher", "target"}},
	} {
		for _, field := range nested.fields {
			tests = append(tests,
				struct {
					name string
					data []byte
				}{name: "missing " + nested.object + "." + field, data: signalServiceJSONWithoutNestedField(t, valid, nested.object, field)},
				struct {
					name string
					data []byte
				}{name: "wrong type " + nested.object + "." + field, data: signalServiceJSONWithNestedField(t, valid, nested.object, field, []int{1})},
				struct {
					name string
					data []byte
				}{name: "null " + nested.object + "." + field, data: signalServiceJSONWithNestedField(t, valid, nested.object, field, nil)},
			)
		}
	}
	for _, executable := range []string{"launcher", "target"} {
		for _, field := range []string{"dev", "ino", "size", "sha256"} {
			tests = append(tests,
				struct {
					name string
					data []byte
				}{name: "missing executable." + executable + "." + field, data: signalServiceJSONWithoutExecutableField(t, valid, executable, field)},
				struct {
					name string
					data []byte
				}{name: "wrong type executable." + executable + "." + field, data: signalServiceJSONWithExecutableField(t, valid, executable, field, []int{1})},
				struct {
					name string
					data []byte
				}{name: "null executable." + executable + "." + field, data: signalServiceJSONWithExecutableField(t, valid, executable, field, nil)},
			)
		}
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeSignalServiceRequest(test.data); err == nil || err.code != signalCodeRequestInvalid {
				t.Fatalf("got %v, want %s", err, signalCodeRequestInvalid)
			}
		})
	}
}

func TestSignalServiceValueValidation(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*signalServiceRequest)
	}{
		{name: "version", mutate: func(r *signalServiceRequest) { r.Version = 2 }},
		{name: "operation", mutate: func(r *signalServiceRequest) { r.Operation = "launch" }},
		{name: "signal zero", mutate: func(r *signalServiceRequest) { r.Signal = "0" }},
		{name: "signal numeric", mutate: func(r *signalServiceRequest) { r.Signal = "15" }},
		{name: "signal empty", mutate: func(r *signalServiceRequest) { r.Signal = "" }},
		{name: "signal name only", mutate: func(r *signalServiceRequest) { r.Signal = "TERM" }},
		{name: "signal trailing space", mutate: func(r *signalServiceRequest) { r.Signal = "SIGTERM " }},
		{name: "signal int", mutate: func(r *signalServiceRequest) { r.Signal = "SIGINT" }},
		{name: "signal stop", mutate: func(r *signalServiceRequest) { r.Signal = "SIGSTOP" }},
		{name: "signal user", mutate: func(r *signalServiceRequest) { r.Signal = "SIGUSR1" }},
		{name: "signal group", mutate: func(r *signalServiceRequest) { r.Signal = "-SIGTERM" }},
		{name: "uppercase boot", mutate: func(r *signalServiceRequest) { r.Namespace.BootID = strings.ToUpper(r.Namespace.BootID) }},
		{name: "bad boot", mutate: func(r *signalServiceRequest) { r.Namespace.BootID = "not-a-uuid" }},
		{name: "bad namespace prefix", mutate: func(r *signalServiceRequest) { r.Namespace.PIDNamespaceID = "net:[1]" }},
		{name: "empty namespace id", mutate: func(r *signalServiceRequest) { r.Namespace.PIDNamespaceID = "pid:[]" }},
		{name: "nondecimal namespace id", mutate: func(r *signalServiceRequest) { r.Namespace.PIDNamespaceID = "pid:[x]" }},
		{name: "manager pid one", mutate: func(r *signalServiceRequest) { r.Manager.PID = "1" }},
		{name: "manager pid overflow", mutate: func(r *signalServiceRequest) { r.Manager.PID = "2147483648" }},
		{name: "manager leading zero", mutate: func(r *signalServiceRequest) { r.Manager.PID = "0101" }},
		{name: "manager start zero", mutate: func(r *signalServiceRequest) { r.Manager.StartTime = "0" }},
		{name: "process same pid", mutate: func(r *signalServiceRequest) { r.Process.PID = r.Manager.PID }},
		{name: "process parent pid", mutate: func(r *signalServiceRequest) { r.Process.ParentPID = "999" }},
		{name: "process parent start", mutate: func(r *signalServiceRequest) { r.Process.ParentStartTime = "999" }},
		{name: "process start zero", mutate: func(r *signalServiceRequest) { r.Process.StartTime = "0" }},
		{name: "token uppercase", mutate: func(r *signalServiceRequest) { r.Token = strings.ToUpper(r.Token) }},
		{name: "token short", mutate: func(r *signalServiceRequest) { r.Token = "abcd" }},
		{name: "launcher dev zero", mutate: func(r *signalServiceRequest) { r.Executable.Launcher.Dev = "0" }},
		{name: "target ino zero", mutate: func(r *signalServiceRequest) { r.Executable.Target.Ino = "0" }},
		{name: "target size zero", mutate: func(r *signalServiceRequest) { r.Executable.Target.Size = "0" }},
		{name: "target size too large", mutate: func(r *signalServiceRequest) {
			r.Executable.Target.Size = strconv.FormatUint(signalExecutableMaxBytes+1, 10)
		}},
		{name: "target uppercase digest", mutate: func(r *signalServiceRequest) {
			r.Executable.Target.SHA256 = strings.ToUpper(r.Executable.Target.SHA256)
		}},
		{name: "target short digest", mutate: func(r *signalServiceRequest) { r.Executable.Target.SHA256 = "abcd" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validSignalServiceTestRequest()
			test.mutate(&request)
			data := marshalSignalServiceTestRequest(t, request)
			if _, err := decodeSignalServiceRequest(data); err == nil || err.code != signalCodeRequestInvalid {
				t.Fatalf("got %v, want %s", err, signalCodeRequestInvalid)
			}
		})
	}
}

func TestSignalServiceOldRunCompatibility(t *testing.T) {
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	exit := run(
		[]string{"helper", signalServiceMode},
		bytes.NewReader(nil),
		stdout,
		stderr,
		inheritedMarkerFD,
	)
	if exit != 2 {
		t.Fatalf("exit=%d", exit)
	}
	if stderr.String() != signalCodeRequestInvalid+"\n" {
		t.Fatalf("stderr=%q", stderr.String())
	}
	var response failureResponse
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &response); err != nil {
		t.Fatal(err)
	}
	if response.Version != protocolVersion ||
		response.HelperVersion != helperVersion ||
		response.Operation != "" ||
		response.OK ||
		response.Error.Code != signalCodeRequestInvalid {
		t.Fatalf("unexpected old run response: %#v", response)
	}
}

func TestSignalServiceSuccessTERMAndKILL(t *testing.T) {
	for _, test := range []struct {
		name   string
		signal string
		want   syscall.Signal
	}{
		{name: "TERM", signal: "SIGTERM", want: syscall.SIGTERM},
		{name: "KILL", signal: "SIGKILL", want: syscall.SIGKILL},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := validSignalServiceTestRequest()
			request.Signal = test.signal
			fake := newSignalServiceTestEnvironment()
			exit, output := runSignalServiceForTest(t, request, fake, nil)
			if exit != 0 {
				t.Fatalf("exit=%d output=%s", exit, output)
			}
			if bytes.Contains(output, []byte(signalTestToken)) {
				t.Fatalf("response leaked token: %s", output)
			}
			var response signalServiceSuccessResponse
			if err := json.Unmarshal(bytes.TrimSpace(output), &response); err != nil {
				t.Fatalf("invalid response: %v: %s", err, output)
			}
			if !response.OK || response.Signal != test.signal ||
				response.Delivery != signalServiceDeliveryValue ||
				response.Target.PID != signalTestTargetPID ||
				response.Target.StartTime != signalTestTargetTime ||
				response.Target.TokenSHA256 != signalServiceTokenDigest(signalTestToken) ||
				response.MatchedExecutable != "target" {
				t.Fatalf("unexpected response: %#v", response)
			}
			if fake.pidfdOpenCall != 1 || fake.sendCallCount != 1 ||
				len(fake.sentSignals) != 1 || fake.sentSignals[0] != test.want {
				t.Fatalf("unexpected pidfd calls: open=%d send=%d signals=%v", fake.pidfdOpenCall, fake.sendCallCount, fake.sentSignals)
			}
			assertSignalServiceFDCleanup(t, fake)
			assertSignalServiceProtocolCleanup(t, fake)
			if !signalServiceEventBefore(fake.events, "close:/proc/"+signalTestTargetPID+"/exe", "open:/proc/"+signalTestTargetPID+"/exe#2") {
				t.Fatalf("first executable was not closed before final reopen: %v", fake.events)
			}
			if !signalServiceEventBefore(
				fake.events,
				"pidfd-open:"+signalTestTargetPID,
				"open:/proc/"+signalTestTargetPID+"/stat#1",
			) {
				t.Fatalf("target proc reads preceded pidfd open: %v", fake.events)
			}
		})
	}
}

func TestSignalServiceRequestFailuresDoNotOpenOrSend(t *testing.T) {
	valid := marshalSignalServiceTestRequest(t, validSignalServiceTestRequest())
	tests := []struct {
		name string
		data []byte
	}{
		{name: "oversized", data: append(bytes.Repeat([]byte("x"), signalRequestMaxBytes+1), '\n')},
		{name: "missing newline", data: valid},
		{name: "extra newline", data: append(append([]byte(nil), valid...), '\n', '\n')},
		{name: "trailing whitespace", data: append(append(append([]byte(nil), valid...), ' '), '\n')},
		{name: "nul", data: append(append(append([]byte(nil), valid...), 0), '\n')},
		{name: "invalid utf8", data: append(append(append([]byte(nil), valid...), 0xff), '\n')},
		{name: "bad signal", data: appendSignalServiceLine(signalServiceJSONWithTopLevelField(t, valid, "signal", "SIGINT"))},
		{name: "bad schema", data: appendSignalServiceLine(signalServiceJSONWithTopLevelField(t, valid, "extra", true))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fake := newSignalServiceTestEnvironment()
			hooks := fake.hooks()
			exit, output := runSignalServiceRawForTest(t, test.data, hooks)
			if exit != 2 || signalServiceFailureCode(t, output) != signalCodeRequestInvalid {
				t.Fatalf("exit=%d output=%s", exit, output)
			}
			if fake.pidfdOpenCall != 0 || fake.sendCallCount != 0 {
				t.Fatalf("request failure opened/sent: open=%d send=%d", fake.pidfdOpenCall, fake.sendCallCount)
			}
		})
	}
}

func TestSignalServiceIdentityAndMetadataFailures(t *testing.T) {
	tests := []struct {
		name     string
		wantCode string
		mutate   func(*signalServiceRequest, *signalServiceTestEnvironment, *signalServiceHooks)
	}{
		{
			name:     "caller getppid",
			wantCode: signalCodeCallerIdentityMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.ppid = 999
			},
		},
		{
			name:     "caller self ppid",
			wantCode: signalCodeCallerIdentityMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/self/stat"] = signalServiceProcStatFixture(101, 999, 899)
			},
		},
		{
			name:     "manager unavailable",
			wantCode: signalCodeCallerIdentityMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.openErrs["/proc/101/stat"] = os.ErrNotExist
			},
		},
		{
			name:     "manager starttime",
			wantCode: signalCodeCallerIdentityMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/101/stat"] = signalServiceProcStatFixture(101, 1, 999)
			},
		},
		{
			name:     "boot id",
			wantCode: signalCodeNamespaceMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/sys/kernel/random/boot_id"] = []byte("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n")
			},
		},
		{
			name:     "helper namespace",
			wantCode: signalCodeNamespaceMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.links["/proc/self/ns/pid"] = "pid:[1]"
			},
		},
		{
			name:     "target namespace",
			wantCode: signalCodeNamespaceMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.links["/proc/102/ns/pid"] = "pid:[1]"
			},
		},
		{
			name:     "pidfd ENOSYS",
			wantCode: signalCodePidfdUnsupported,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.pidfdOpenErr = syscall.ENOSYS
			},
		},
		{
			name:     "pidfd EINVAL",
			wantCode: signalCodePidfdUnsupported,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.pidfdOpenErr = syscall.EINVAL
			},
		},
		{
			name:     "pidfd EACCES",
			wantCode: signalCodePidfdOpenFailed,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.pidfdOpenErr = syscall.EACCES
			},
		},
		{
			name:     "pidfd cloexec setup",
			wantCode: signalCodePidfdOpenFailed,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, hooks *signalServiceHooks) {
				baseFcntl := hooks.fcntl
				hooks.fcntl = func(fd int, command, argument int) (int, error) {
					if fd == fake.pidfd {
						if command == syscall.F_GETFD {
							return 0, nil
						}
						return 0, syscall.EIO
					}
					return baseFcntl(fd, command, argument)
				}
			},
		},
		{
			name:     "target stat unavailable",
			wantCode: signalCodeTargetUnavailable,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.openErrs["/proc/102/stat"] = os.ErrNotExist
			},
		},
		{
			name:     "target stat read error",
			wantCode: signalCodeTargetUnavailable,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.readErrs["/proc/102/stat"] = syscall.EIO
			},
		},
		{
			name:     "proc close error",
			wantCode: signalCodeResourceCloseFailed,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.closeFn = func(_ int, path string) error {
					if path == "/proc/102/stat" {
						return syscall.EIO
					}
					return nil
				}
			},
		},
		{
			name:     "target starttime",
			wantCode: signalCodeTargetIdentityMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/102/stat"] = signalServiceProcStatFixture(102, 101, 999)
			},
		},
		{
			name:     "target parent",
			wantCode: signalCodeTargetIdentityMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/102/stat"] = signalServiceProcStatFixture(102, 999, 901)
			},
		},
		{
			name:     "target token absent",
			wantCode: signalCodeTokenMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/102/environ"] = []byte("PATH=/usr/bin\x00")
			},
		},
		{
			name:     "target token wrong",
			wantCode: signalCodeTokenMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/102/environ"] = []byte("SFSC_SERVICE_TOKEN=22222222222222222222222222222222\x00")
			},
		},
		{
			name:     "target token duplicate",
			wantCode: signalCodeTokenMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/102/environ"] = []byte(
					"SFSC_SERVICE_TOKEN=" + signalTestToken + "\x00SFSC_SERVICE_TOKEN=" + signalTestToken + "\x00",
				)
			},
		},
		{
			name:     "target environ unterminated",
			wantCode: signalCodeTokenMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/102/environ"] = []byte("SFSC_SERVICE_TOKEN=" + signalTestToken)
			},
		},
		{
			name:     "target environ too large",
			wantCode: signalCodeTargetUnavailable,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.files["/proc/102/environ"] = bytes.Repeat([]byte("x"), signalEnvironMaxBytes+1)
			},
		},
		{
			name:     "executable open",
			wantCode: signalCodeTargetUnavailable,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.openErrs["/proc/102/exe"] = os.ErrNotExist
			},
		},
		{
			name:     "executable fstat error",
			wantCode: signalCodeTargetUnavailable,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.fstatFn = func(_ int, _ *syscall.Stat_t, path string) error {
					if strings.HasSuffix(path, "/exe") {
						return syscall.EIO
					}
					return nil
				}
			},
		},
		{
			name:     "executable pread error",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.preadFn = func(_ int, _ []byte, _ int64, _ string) (int, error) {
					return 0, syscall.EIO
				}
			},
		},
		{
			name:     "executable not regular",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.exeStat.Mode = syscall.S_IFIFO | 0o755
			},
		},
		{
			name:     "executable uid",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.exeStat.Uid = 1
			},
		},
		{
			name:     "executable setuid",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.exeStat.Mode |= syscall.S_ISUID
			},
		},
		{
			name:     "executable no execute bit",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.exeStat.Mode = syscall.S_IFREG | 0o600
			},
		},
		{
			name:     "executable identity",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.exeStat.Ino = 999
			},
		},
		{
			name:     "executable digest",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(request *signalServiceRequest, _ *signalServiceTestEnvironment, _ *signalServiceHooks) {
				request.Executable.Target.SHA256 = strings.Repeat("0", 64)
			},
		},
		{
			name:     "executable extra byte",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.exeData = []byte("targetX")
			},
		},
		{
			name:     "executable fstat changes",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				count := 0
				fake.fstatFn = func(_ int, stat *syscall.Stat_t, path string) error {
					*stat = fake.exeStat
					if strings.HasSuffix(path, "/exe") {
						count++
						if count == 2 {
							stat.Ino++
						}
					}
					return nil
				}
			},
		},
		{
			name:     "executable close",
			wantCode: signalCodeResourceCloseFailed,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				count := 0
				fake.closeFn = func(_ int, path string) error {
					if strings.HasSuffix(path, "/exe") {
						count++
						if count == 1 {
							return syscall.EIO
						}
					}
					return nil
				}
			},
		},
		{
			name:     "target identity changes after pidfd",
			wantCode: signalCodeTargetIdentityMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, hooks *signalServiceHooks) {
				count := 0
				fake.readFn = func(fd int, buffer []byte, path string) (int, error) {
					data := fake.files[path]
					offset := fake.fdOffset[fd]
					if offset == 0 && path == "/proc/102/stat" {
						count++
						if count == 2 {
							data = signalServiceProcStatFixture(102, 101, 999)
						}
					}
					if offset >= len(data) {
						return 0, io.EOF
					}
					read := copy(buffer, data[offset:])
					fake.fdOffset[fd] = offset + read
					return read, nil
				}
			},
		},
		{
			name:     "target disappears after pidfd",
			wantCode: signalCodeTargetUnavailable,
			mutate: func(_ *signalServiceRequest, _ *signalServiceTestEnvironment, hooks *signalServiceHooks) {
				baseOpen := hooks.open
				count := 0
				hooks.open = func(path string, flags int, mode uint32) (int, error) {
					if path == "/proc/102/stat" {
						count++
						if count == 2 {
							return -1, os.ErrNotExist
						}
					}
					return baseOpen(path, flags, mode)
				}
			},
		},
		{
			name:     "token changes after pidfd",
			wantCode: signalCodeTokenMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, hooks *signalServiceHooks) {
				count := 0
				fake.readFn = func(fd int, buffer []byte, path string) (int, error) {
					data := fake.files[path]
					offset := fake.fdOffset[fd]
					if offset == 0 && path == "/proc/102/environ" {
						count++
						if count == 2 {
							data = []byte("SFSC_SERVICE_TOKEN=22222222222222222222222222222222\x00")
						}
					}
					if offset >= len(data) {
						return 0, io.EOF
					}
					read := copy(buffer, data[offset:])
					fake.fdOffset[fd] = offset + read
					return read, nil
				}
			},
		},
		{
			name:     "manager changes after pidfd",
			wantCode: signalCodeCallerIdentityMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, hooks *signalServiceHooks) {
				count := 0
				fake.readFn = func(fd int, buffer []byte, path string) (int, error) {
					data := fake.files[path]
					offset := fake.fdOffset[fd]
					if offset == 0 && path == "/proc/101/stat" {
						count++
						if count == 2 {
							data = signalServiceProcStatFixture(101, 1, 999)
						}
					}
					if offset >= len(data) {
						return 0, io.EOF
					}
					read := copy(buffer, data[offset:])
					fake.fdOffset[fd] = offset + read
					return read, nil
				}
			},
		},
		{
			name:     "namespace changes after pidfd",
			wantCode: signalCodeNamespaceMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, hooks *signalServiceHooks) {
				count := 0
				hooks.readlink = func(path string) (string, error) {
					if path == "/proc/102/ns/pid" {
						count++
						if count == 2 {
							return "pid:[1]", nil
						}
					}
					return fake.links[path], nil
				}
			},
		},
		{
			name:     "final executable metadata changes",
			wantCode: signalCodeExecutableMismatch,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				count := 0
				fake.fstatFn = func(_ int, stat *syscall.Stat_t, path string) error {
					*stat = fake.exeStat
					if strings.HasSuffix(path, "/exe") {
						count++
						if count == 3 {
							stat.Ino++
						}
					}
					return nil
				}
			},
		},
		{
			name:     "final executable reopen",
			wantCode: signalCodeTargetUnavailable,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, hooks *signalServiceHooks) {
				count := 0
				hooks.open = func(path string, flags int, mode uint32) (int, error) {
					if path == "/proc/102/exe" {
						count++
						if count == 2 {
							return -1, os.ErrNotExist
						}
					}
					fd := fake.nextFD
					fake.nextFD++
					fake.fdPath[fd] = path
					fake.fdOffset[fd] = 0
					fake.openedPaths = append(fake.openedPaths, path)
					fake.events = append(fake.events, "open:"+path)
					return fd, nil
				}
			},
		},
		{
			name:     "final executable close",
			wantCode: signalCodeResourceCloseFailed,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				count := 0
				fake.closeFn = func(_ int, path string) error {
					if strings.HasSuffix(path, "/exe") {
						count++
						if count == 2 {
							return syscall.EIO
						}
					}
					return nil
				}
			},
		},
		{
			name:     "send error",
			wantCode: signalCodeSignalFailed,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.sendErr = syscall.ESRCH
			},
		},
		{
			name:     "pidfd close after send",
			wantCode: signalCodeResourceCloseFailed,
			mutate: func(_ *signalServiceRequest, fake *signalServiceTestEnvironment, _ *signalServiceHooks) {
				fake.closeErrs[fake.pidfd] = syscall.EIO
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validSignalServiceTestRequest()
			fake := newSignalServiceTestEnvironment()
			exit, output := runSignalServicePreparedForTest(t, request, fake, test.mutate)
			if exit != 2 || signalServiceFailureCode(t, output) != test.wantCode {
				t.Fatalf("exit=%d output=%s want=%s", exit, output, test.wantCode)
			}
			if test.wantCode == signalCodePidfdUnsupported ||
				test.wantCode == signalCodePidfdOpenFailed ||
				test.wantCode == signalCodeCallerIdentityMismatch ||
				test.wantCode == signalCodeNamespaceMismatch {
				if fake.sendCallCount != 0 {
					t.Fatalf("failure sent signal: %v", fake.sentSignals)
				}
			}
			if test.name != "send error" && test.name != "pidfd close after send" &&
				fake.sendCallCount != 0 {
				t.Fatalf("pre-send failure sent signal: %v", fake.sentSignals)
			}
			assertSignalServiceFDCleanup(t, fake)
		})
	}
}

func TestSignalServiceReadSignalServiceFileEOFSemantics(t *testing.T) {
	t.Run("non-empty fake raw EOF succeeds", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		path := "/proc/read-success"
		content := []byte("non-empty proc data")
		fake.files[path] = content
		deadline := &signalServiceDeadline{
			end: fake.now.Add(signalTotalBudget),
			now: func() time.Time { return fake.now },
		}
		data, guardErr := readSignalServiceFile(
			path,
			int64(len(content)),
			signalCodeTargetUnavailable,
			deadline,
			fake.hooks(),
		)
		if guardErr != nil {
			t.Fatalf("read failed: %v", guardErr)
		}
		if !bytes.Equal(data, content) {
			t.Fatalf("data=%q, want=%q", data, content)
		}
	})

	t.Run("empty file is rejected by caller parser", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		path := "/proc/empty"
		fake.files[path] = nil
		deadline := &signalServiceDeadline{
			end: fake.now.Add(signalTotalBudget),
			now: func() time.Time { return fake.now },
		}
		data, readErr := readSignalServiceFile(
			path,
			4096,
			signalCodeTargetUnavailable,
			deadline,
			fake.hooks(),
		)
		if readErr != nil || len(data) != 0 {
			t.Fatalf("empty read data=%q err=%v", data, readErr)
		}
		_, parseErr := readSignalServiceProcStat(
			path,
			4096,
			signalCodeTargetUnavailable,
			deadline,
			fake.hooks(),
		)
		if parseErr == nil || parseErr.code != signalCodeTargetUnavailable {
			t.Fatalf("empty proc stat error=%v, want %s", parseErr, signalCodeTargetUnavailable)
		}
	})

	t.Run("production raw Read EOF succeeds", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "raw-read")
		content := []byte("real syscall.Read data")
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
		deadline := &signalServiceDeadline{
			end: time.Now().Add(signalTotalBudget),
			now: time.Now,
		}
		data, guardErr := readSignalServiceFile(
			path,
			int64(len(content)),
			signalCodeTargetUnavailable,
			deadline,
			linuxSignalServiceHooks(),
		)
		if guardErr != nil {
			t.Fatalf("raw read failed: %v", guardErr)
		}
		if !bytes.Equal(data, content) {
			t.Fatalf("raw data=%q, want=%q", data, content)
		}
	})
}

func TestSignalServiceProcStatAliveState(t *testing.T) {
	const (
		pid       = uint64(102)
		startTime = uint64(901)
	)
	tests := []struct {
		name  string
		state string
		want  bool
	}{
		{name: "running", state: "R", want: true},
		{name: "sleeping", state: "S", want: true},
		{name: "disk sleep", state: "D", want: true},
		{name: "zombie", state: "Z", want: false},
		{name: "dead uppercase", state: "X", want: false},
		{name: "dead lowercase", state: "x", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stat := signalServiceProcStatFixtureState(pid, 101, startTime, test.state)
			if got := signalServiceProcStatAlive(stat, pid, startTime); got != test.want {
				t.Fatalf("state %s alive=%t, want %t", test.state, got, test.want)
			}
		})
	}
	stat := signalServiceProcStatFixtureState(pid, 101, startTime, "S")
	if signalServiceProcStatAlive(stat, pid+1, startTime) {
		t.Fatal("wrong PID was treated as alive")
	}
	if signalServiceProcStatAlive(stat, pid, startTime+1) {
		t.Fatal("wrong starttime was treated as alive")
	}
	if signalServiceProcStatAlive([]byte("102 (truncated) S"), pid, startTime) {
		t.Fatal("malformed stat was treated as alive")
	}
}

func TestSignalServiceDeadlineAndOutputSemantics(t *testing.T) {
	t.Run("local deadline capped by remaining budget", func(t *testing.T) {
		start := time.Unix(1_800_000_000, 0)
		now := start.Add(4*time.Second + 250*time.Millisecond)
		deadline := &signalServiceDeadline{
			end: start.Add(signalTotalBudget),
			now: func() time.Time { return now },
		}
		local, err := deadline.local(2 * time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if got := local.Sub(now); got != 750*time.Millisecond {
			t.Fatalf("local deadline=%s, want 750ms", got)
		}
		now = deadline.end
		if _, err := deadline.local(time.Second); err == nil || err.code != signalCodeDeadlineExceeded {
			t.Fatalf("expired budget got %v", err)
		}
	})

	t.Run("input expiry", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		start := fake.now
		_, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, func(hooks *signalServiceHooks) {
			hooks.setReadDeadline = func(*os.File, time.Time) error {
				fake.now = start.Add(signalTotalBudget)
				return nil
			}
		})
		if signalServiceFailureCode(t, output) != signalCodeDeadlineExceeded ||
			fake.pidfdOpenCall != 0 || fake.sendCallCount != 0 {
			t.Fatalf("output=%s open=%d send=%d", output, fake.pidfdOpenCall, fake.sendCallCount)
		}
	})

	t.Run("EOF expiry", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		start := fake.now
		calls := 0
		_, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, func(hooks *signalServiceHooks) {
			hooks.setReadDeadline = func(*os.File, time.Time) error {
				calls++
				if calls == 2 {
					fake.now = start.Add(signalTotalBudget)
				}
				return nil
			}
		})
		if signalServiceFailureCode(t, output) != signalCodeDeadlineExceeded ||
			fake.pidfdOpenCall != 0 || fake.sendCallCount != 0 {
			t.Fatalf("output=%s open=%d send=%d", output, fake.pidfdOpenCall, fake.sendCallCount)
		}
	})

	t.Run("proc read expiry", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		start := fake.now
		advanced := false
		_, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, func(hooks *signalServiceHooks) {
			fake.readFn = func(fd int, buffer []byte, path string) (int, error) {
				data := fake.files[path]
				offset := fake.fdOffset[fd]
				if offset >= len(data) {
					return 0, io.EOF
				}
				read := copy(buffer, data[offset:])
				fake.fdOffset[fd] = offset + read
				if path == "/proc/102/stat" && !advanced {
					advanced = true
					fake.now = start.Add(signalTotalBudget)
				}
				return read, nil
			}
		})
		if signalServiceFailureCode(t, output) != signalCodeDeadlineExceeded ||
			fake.pidfdOpenCall != 1 || fake.sendCallCount != 0 {
			t.Fatalf("output=%s open=%d send=%d", output, fake.pidfdOpenCall, fake.sendCallCount)
		}
		assertSignalServiceFDCleanup(t, fake)
	})

	t.Run("hash chunk expiry", func(t *testing.T) {
		request := validSignalServiceTestRequest()
		data := bytes.Repeat([]byte("x"), 64<<10+1)
		digest := sha256.Sum256(data)
		request.Executable.Target.Size = strconv.Itoa(len(data))
		request.Executable.Target.SHA256 = hex.EncodeToString(digest[:])
		fake := newSignalServiceTestEnvironment()
		fake.exeData = data
		fake.exeStat.Size = int64(len(data))
		start := fake.now
		preadCalls := 0
		_, output := runSignalServiceForTest(t, request, fake, func(hooks *signalServiceHooks) {
			hooks.pread = func(fd int, buffer []byte, offset int64) (int, error) {
				if offset >= int64(len(fake.exeData)) {
					return 0, nil
				}
				read := copy(buffer, fake.exeData[offset:])
				preadCalls++
				if preadCalls == 1 {
					fake.now = start.Add(signalTotalBudget)
				}
				return read, nil
			}
		})
		if signalServiceFailureCode(t, output) != signalCodeDeadlineExceeded ||
			fake.sendCallCount != 0 {
			t.Fatalf("output=%s send=%d", output, fake.sendCallCount)
		}
		assertSignalServiceFDCleanup(t, fake)
	})

	t.Run("final executable reopen expiry", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		start := fake.now
		fstatCalls := 0
		_, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, func(hooks *signalServiceHooks) {
			fake.fstatFn = func(_ int, stat *syscall.Stat_t, path string) error {
				*stat = fake.exeStat
				if strings.HasSuffix(path, "/exe") {
					fstatCalls++
					if fstatCalls == 3 {
						fake.now = start.Add(signalTotalBudget)
					}
				}
				return nil
			}
		})
		if signalServiceFailureCode(t, output) != signalCodeDeadlineExceeded ||
			fake.sendCallCount != 0 {
			t.Fatalf("output=%s send=%d", output, fake.sendCallCount)
		}
		assertSignalServiceFDCleanup(t, fake)
	})

	t.Run("final close advances to global expiry", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		start := fake.now
		exeCloses := 0
		_, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, func(hooks *signalServiceHooks) {
			fake.closeFn = func(_ int, path string) error {
				if strings.HasSuffix(path, "/exe") {
					exeCloses++
					if exeCloses == 2 {
						fake.now = start.Add(signalTotalBudget)
					}
				}
				return nil
			}
		})
		if signalServiceFailureCode(t, output) != signalCodeDeadlineExceeded ||
			fake.sendCallCount != 0 {
			t.Fatalf("output=%s send=%d", output, fake.sendCallCount)
		}
		assertSignalServiceFDCleanup(t, fake)
	})

	t.Run("post-send output failure is result unknown", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		fake.writeErr = syscall.EPIPE
		exit, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, nil)
		if exit != 2 || len(output) != 0 {
			t.Fatalf("exit=%d output=%s", exit, output)
		}
		if fake.sendCallCount != 1 || fake.pidfdOpenCall != 1 {
			t.Fatalf("send=%d open=%d", fake.sendCallCount, fake.pidfdOpenCall)
		}
		assertSignalServiceFDCleanup(t, fake)
	})
}

func TestSignalServiceFrameTimeoutAndOutputLimit(t *testing.T) {
	t.Run("initial frame timeout", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		hooks := fake.hooks()
		hooks.initialFrameWait = 30 * time.Millisecond
		hooks.setReadDeadline = func(file *os.File, deadline time.Time) error {
			return file.SetReadDeadline(deadline)
		}
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		defer writer.Close()
		outputFile := signalServiceTestOutputFile(t)
		exit := runSignalServiceWithHooks(
			[]string{"helper", signalServiceMode},
			reader,
			outputFile,
			signalServiceTestErrorFile(t),
			hooks,
		)
		output := signalServiceReadTestOutput(t, outputFile)
		if exit != 2 || signalServiceFailureCode(t, output) != signalCodeRequestTimeout ||
			fake.pidfdOpenCall != 0 || fake.sendCallCount != 0 {
			t.Fatalf("exit=%d output=%s", exit, output)
		}
	})

	t.Run("EOF timeout", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		hooks := fake.hooks()
		hooks.eofWait = 30 * time.Millisecond
		hooks.setReadDeadline = func(file *os.File, deadline time.Time) error {
			return file.SetReadDeadline(deadline)
		}
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		defer writer.Close()
		valid := marshalSignalServiceTestRequest(t, validSignalServiceTestRequest())
		if _, err := writer.Write(appendSignalServiceLine(valid)); err != nil {
			t.Fatal(err)
		}
		outputFile := signalServiceTestOutputFile(t)
		exit := runSignalServiceWithHooks(
			[]string{"helper", signalServiceMode},
			reader,
			outputFile,
			signalServiceTestErrorFile(t),
			hooks,
		)
		output := signalServiceReadTestOutput(t, outputFile)
		if exit != 2 || signalServiceFailureCode(t, output) != signalCodeRequestTimeout ||
			fake.pidfdOpenCall != 0 || fake.sendCallCount != 0 {
			t.Fatalf("exit=%d output=%s", exit, output)
		}
	})

	t.Run("independent output timeout", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		var got time.Duration
		exit, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, func(hooks *signalServiceHooks) {
			hooks.writeFrame = func(file *os.File, data []byte, timeout time.Duration) error {
				got = timeout
				_, err := file.Write(data)
				return err
			}
		})
		if exit != 0 || got != signalOutputLimit {
			t.Fatalf("exit=%d timeout=%s output=%s", exit, got, output)
		}
	})
}

func TestSignalServiceProtocolFileOwnership(t *testing.T) {
	t.Run("input nonblocking failure closes raw duplicate", func(t *testing.T) {
		stdinReader, _ := signalServiceTestPipe(t)
		_, stdoutWriter := signalServiceTestPipe(t)
		hooks := linuxSignalServiceHooks()
		var duplicated []int
		var rawClosed []int
		hooks.fcntl = func(fd, command, argument int) (int, error) {
			if command == syscall.F_DUPFD_CLOEXEC {
				duplicate, err := linuxExecServiceFcntl(fd, command, argument)
				if err == nil {
					duplicated = append(duplicated, duplicate)
				}
				return duplicate, err
			}
			if command == syscall.F_GETFL && len(duplicated) == 1 {
				return -1, syscall.EIO
			}
			return linuxExecServiceFcntl(fd, command, argument)
		}
		hooks.close = func(fd int) error {
			rawClosed = append(rawClosed, fd)
			return syscall.Close(fd)
		}

		_, protocolErr := prepareSignalServiceProtocolFiles(stdinReader, stdoutWriter, hooks)
		if protocolErr == nil || protocolErr.code != signalCodeRequestInvalid {
			t.Fatalf("prepare error=%v", protocolErr)
		}
		if len(duplicated) != 1 || len(rawClosed) != 1 || rawClosed[0] != duplicated[0] {
			t.Fatalf("duplicated=%v rawClosed=%v", duplicated, rawClosed)
		}
		assertSignalServiceTestFDClosed(t, duplicated[0])
	})

	t.Run("output nonblocking failure closes both raw duplicates", func(t *testing.T) {
		stdinReader, _ := signalServiceTestPipe(t)
		_, stdoutWriter := signalServiceTestPipe(t)
		hooks := linuxSignalServiceHooks()
		var duplicated []int
		var rawClosed []int
		hooks.fcntl = func(fd, command, argument int) (int, error) {
			if command == syscall.F_DUPFD_CLOEXEC {
				duplicate, err := linuxExecServiceFcntl(fd, command, argument)
				if err == nil {
					duplicated = append(duplicated, duplicate)
				}
				return duplicate, err
			}
			if command == syscall.F_GETFL && len(duplicated) == 2 {
				return -1, syscall.EIO
			}
			return linuxExecServiceFcntl(fd, command, argument)
		}
		hooks.close = func(fd int) error {
			rawClosed = append(rawClosed, fd)
			return syscall.Close(fd)
		}

		_, protocolErr := prepareSignalServiceProtocolFiles(stdinReader, stdoutWriter, hooks)
		if protocolErr == nil || protocolErr.code != signalCodeResourceCloseFailed {
			t.Fatalf("prepare error=%v", protocolErr)
		}
		if len(duplicated) != 2 || len(rawClosed) != 2 ||
			rawClosed[0] != duplicated[0] || rawClosed[1] != duplicated[1] {
			t.Fatalf("duplicated=%v rawClosed=%v", duplicated, rawClosed)
		}
		assertSignalServiceTestFDClosed(t, duplicated[0])
		assertSignalServiceTestFDClosed(t, duplicated[1])
	})

	t.Run("raw close failure overrides input nonblocking error", func(t *testing.T) {
		stdinReader, _ := signalServiceTestPipe(t)
		_, stdoutWriter := signalServiceTestPipe(t)
		hooks := linuxSignalServiceHooks()
		var duplicated int
		hooks.fcntl = func(fd, command, argument int) (int, error) {
			if command == syscall.F_DUPFD_CLOEXEC {
				var err error
				duplicated, err = linuxExecServiceFcntl(fd, command, argument)
				return duplicated, err
			}
			if command == syscall.F_GETFL && duplicated >= 0 {
				return -1, syscall.EIO
			}
			return linuxExecServiceFcntl(fd, command, argument)
		}
		hooks.close = func(fd int) error {
			if err := syscall.Close(fd); err != nil {
				return err
			}
			return syscall.EIO
		}

		_, protocolErr := prepareSignalServiceProtocolFiles(stdinReader, stdoutWriter, hooks)
		if protocolErr == nil || protocolErr.code != signalCodeResourceCloseFailed {
			t.Fatalf("prepare error=%v", protocolErr)
		}
		assertSignalServiceTestFDClosed(t, duplicated)
	})

	for _, test := range []struct {
		name     string
		wantCode string
		failRead bool
	}{
		{name: "read initialization failure closes both owned files", wantCode: signalCodeRequestInvalid, failRead: true},
		{name: "write initialization failure closes both owned files", wantCode: signalCodeResourceCloseFailed},
	} {
		t.Run(test.name, func(t *testing.T) {
			stdinReader, _ := signalServiceTestPipe(t)
			_, stdoutWriter := signalServiceTestPipe(t)
			hooks := linuxSignalServiceHooks()
			var fileClosed []int
			var rawClosed []int
			hooks.closeFile = func(file *os.File) error {
				fileClosed = append(fileClosed, int(file.Fd()))
				return file.Close()
			}
			hooks.close = func(fd int) error {
				rawClosed = append(rawClosed, fd)
				return syscall.Close(fd)
			}
			if test.failRead {
				hooks.setProtocolRead = func(*os.File, time.Time) error { return syscall.EIO }
			} else {
				hooks.setProtocolWrite = func(*os.File, time.Time) error { return syscall.EIO }
			}

			_, protocolErr := prepareSignalServiceProtocolFiles(stdinReader, stdoutWriter, hooks)
			if protocolErr == nil || protocolErr.code != test.wantCode {
				t.Fatalf("prepare error=%v, want %s", protocolErr, test.wantCode)
			}
			if len(fileClosed) != 2 || len(rawClosed) != 0 || fileClosed[0] == fileClosed[1] {
				t.Fatalf("fileClosed=%v rawClosed=%v", fileClosed, rawClosed)
			}
			assertSignalServiceTestFDClosed(t, fileClosed[0])
			assertSignalServiceTestFDClosed(t, fileClosed[1])
		})
	}

	t.Run("owned file close failure overrides read initialization error", func(t *testing.T) {
		stdinReader, _ := signalServiceTestPipe(t)
		_, stdoutWriter := signalServiceTestPipe(t)
		hooks := linuxSignalServiceHooks()
		hooks.setProtocolRead = func(*os.File, time.Time) error { return syscall.EIO }
		hooks.closeFile = func(file *os.File) error {
			err := file.Close()
			if file.Name() == "sfsc-signal-stdin" {
				if err != nil {
					return err
				}
				return syscall.EIO
			}
			return err
		}

		_, protocolErr := prepareSignalServiceProtocolFiles(stdinReader, stdoutWriter, hooks)
		if protocolErr == nil || protocolErr.code != signalCodeResourceCloseFailed {
			t.Fatalf("prepare error=%v", protocolErr)
		}
	})
}

func TestSignalServiceProtocolRunClosesFilesNotRawFDs(t *testing.T) {
	fake := newSignalServiceTestEnvironment()
	exit, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, nil)
	if exit != 0 {
		t.Fatalf("exit=%d output=%s", exit, output)
	}
	assertSignalServiceProtocolCleanup(t, fake)
	for _, fd := range fake.protocolCloseFDs {
		assertSignalServiceTestFDClosed(t, fd)
	}
}

func TestSignalServiceProtocolFileCloseFailures(t *testing.T) {
	t.Run("input close failure prevents pidfd open", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		fake.closeFileFn = func(file *os.File) error {
			err := file.Close()
			if file.Name() == "sfsc-signal-stdin" {
				if err != nil {
					return err
				}
				return syscall.EIO
			}
			return err
		}
		exit, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, nil)
		if exit != 2 || signalServiceFailureCode(t, output) != signalCodeResourceCloseFailed {
			t.Fatalf("exit=%d output=%s", exit, output)
		}
		if fake.pidfdOpenCall != 0 || fake.sendCallCount != 0 {
			t.Fatalf("open=%d send=%d", fake.pidfdOpenCall, fake.sendCallCount)
		}
		assertSignalServiceProtocolCleanup(t, fake)
		for _, fd := range fake.protocolCloseFDs {
			assertSignalServiceTestFDClosed(t, fd)
		}
	})

	t.Run("output close failure after send is result unknown", func(t *testing.T) {
		fake := newSignalServiceTestEnvironment()
		fake.closeFileFn = func(file *os.File) error {
			err := file.Close()
			if file.Name() == "sfsc-signal-stdout" {
				if err != nil {
					return err
				}
				return syscall.EIO
			}
			return err
		}
		exit, output := runSignalServiceForTest(t, validSignalServiceTestRequest(), fake, nil)
		if exit != 2 {
			t.Fatalf("exit=%d output=%s", exit, output)
		}
		var response signalServiceSuccessResponse
		if err := json.Unmarshal(bytes.TrimSpace(output), &response); err != nil {
			t.Fatalf("success response was not preserved: %v: %s", err, output)
		}
		if !response.OK || fake.pidfdOpenCall != 1 || fake.sendCallCount != 1 {
			t.Fatalf("response=%#v open=%d send=%d", response, fake.pidfdOpenCall, fake.sendCallCount)
		}
		assertSignalServiceProtocolCleanup(t, fake)
		for _, fd := range fake.protocolCloseFDs {
			assertSignalServiceTestFDClosed(t, fd)
		}
	})
}

func TestSignalServiceProtocolFileCloseMarksAndProtectsReusedFD(t *testing.T) {
	stdinReader, _ := signalServiceTestPipe(t)
	_, stdoutWriter := signalServiceTestPipe(t)
	hooks := linuxSignalServiceHooks()
	protocol, protocolErr := prepareSignalServiceProtocolFiles(stdinReader, stdoutWriter, hooks)
	if protocolErr != nil {
		t.Fatal(protocolErr)
	}
	inputFile := protocol.stdin
	inputFD := int(inputFile.Fd())
	if err := closeSignalServiceProtocolFile(&protocol.stdin, hooks); err != nil {
		t.Fatal(err)
	}
	assertSignalServiceTestFDClosed(t, inputFD)

	source, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err := syscall.Dup3(int(source.Fd()), inputFD, syscall.O_CLOEXEC); err != nil {
		t.Fatal(err)
	}
	reused := os.NewFile(uintptr(inputFD), "reused-protocol-fd")
	if reused == nil {
		t.Fatal("os.NewFile returned nil for reused fd")
	}
	defer reused.Close()
	if err := inputFile.Close(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed protocol file Close error=%v", err)
	}
	if err := closeSignalServiceProtocolFile(&protocol.stdin, hooks); err != nil {
		t.Fatalf("idempotent protocol close error=%v", err)
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(inputFD, &stat); err != nil {
		t.Fatalf("reused fd was closed: %v", err)
	}
	if err := closeSignalServiceProtocolFile(&protocol.stdout, hooks); err != nil {
		t.Fatal(err)
	}
}

func TestSignalServicePrepareBlockingInheritedPipes(t *testing.T) {
	inputFDs := make([]int, 2)
	if err := syscall.Pipe2(inputFDs, syscall.O_CLOEXEC); err != nil {
		t.Fatal(err)
	}
	outputFDs := make([]int, 2)
	if err := syscall.Pipe2(outputFDs, syscall.O_CLOEXEC); err != nil {
		_ = syscall.Close(inputFDs[0])
		_ = syscall.Close(inputFDs[1])
		t.Fatal(err)
	}
	stdin := os.NewFile(uintptr(inputFDs[0]), "blocking-inherited-stdin")
	stdout := os.NewFile(uintptr(outputFDs[1]), "blocking-inherited-stdout")
	stdinWriter := os.NewFile(uintptr(inputFDs[1]), "blocking-input-writer")
	stdoutReader := os.NewFile(uintptr(outputFDs[0]), "blocking-output-reader")
	defer stdin.Close()
	defer stdout.Close()
	defer stdinWriter.Close()
	defer stdoutReader.Close()

	initialInputFlags, err := linuxExecServiceFcntl(int(stdin.Fd()), syscall.F_GETFL, 0)
	if err != nil || initialInputFlags&syscall.O_NONBLOCK != 0 {
		t.Fatalf("input pipe was not initially blocking: flags=%#x err=%v", initialInputFlags, err)
	}
	initialOutputFlags, err := linuxExecServiceFcntl(int(stdout.Fd()), syscall.F_GETFL, 0)
	if err != nil || initialOutputFlags&syscall.O_NONBLOCK != 0 {
		t.Fatalf("output pipe was not initially blocking: flags=%#x err=%v", initialOutputFlags, err)
	}

	protocol, protocolErr := prepareSignalServiceProtocolFiles(stdin, stdout, linuxSignalServiceHooks())
	if protocolErr != nil {
		t.Fatal(protocolErr)
	}
	defer protocol.stdin.Close()
	defer protocol.stdout.Close()
	inputFlags, err := linuxExecServiceFcntl(int(protocol.stdin.Fd()), syscall.F_GETFL, 0)
	if err != nil || inputFlags&syscall.O_NONBLOCK == 0 {
		t.Fatalf("protocol stdin is not nonblocking: flags=%#x err=%v", inputFlags, err)
	}
	outputFlags, err := linuxExecServiceFcntl(int(protocol.stdout.Fd()), syscall.F_GETFL, 0)
	if err != nil || outputFlags&syscall.O_NONBLOCK == 0 {
		t.Fatalf("protocol stdout is not nonblocking: flags=%#x err=%v", outputFlags, err)
	}

	if err := protocol.stdin.SetReadDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	var one [1]byte
	if _, err := protocol.stdin.Read(one[:]); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("blocking input deadline error=%v", err)
	}

	if _, err := linuxExecServiceFcntl(int(stdout.Fd()), syscall.F_SETFL, initialOutputFlags|syscall.O_NONBLOCK); err != nil {
		t.Fatal(err)
	}
	fill := bytes.Repeat([]byte("x"), 64<<10)
	filled := false
	for attempts := 0; attempts < 1024; attempts++ {
		_, err := stdout.Write(fill)
		if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
			filled = true
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !filled {
		t.Fatal("output pipe could not be filled")
	}
	if err := protocol.stdout.SetWriteDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := protocol.stdout.Write(one[:]); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("blocking output deadline error=%v", err)
	}
}

func TestSignalServiceRealTERM(t *testing.T) {
	runSignalServiceRealSuccess(t, "SIGTERM", syscall.SIGTERM)
}

func TestSignalServiceRealKILL(t *testing.T) {
	runSignalServiceRealSuccess(t, "SIGKILL", syscall.SIGKILL)
}

func TestSignalServiceRealWrongToken(t *testing.T) {
	runSignalServiceRealRejection(t, signalCodeTokenMismatch, func(request *signalServiceRequest) {
		request.Token = strings.Repeat("2", 32)
	})
}

func TestSignalServiceRealWrongStarttime(t *testing.T) {
	runSignalServiceRealRejection(t, signalCodeTargetIdentityMismatch, func(request *signalServiceRequest) {
		startTime, _ := strconv.ParseUint(request.Process.StartTime, 10, 64)
		request.Process.StartTime = strconv.FormatUint(startTime+1, 10)
	})
}

func TestSignalServiceRealWrongParent(t *testing.T) {
	runSignalServiceRealRejection(t, signalCodeCallerIdentityMismatch, func(request *signalServiceRequest) {
		targetPID, _ := strconv.ParseUint(request.Process.PID, 10, 64)
		wrongParent := uint64(os.Getpid() + 1)
		if wrongParent == targetPID {
			wrongParent++
		}
		wrongParentText := strconv.FormatUint(wrongParent, 10)
		request.Manager.PID = wrongParentText
		request.Process.ParentPID = wrongParentText
	})
}

func TestSignalServiceRealWrongExecutable(t *testing.T) {
	runSignalServiceRealRejection(t, signalCodeExecutableMismatch, func(request *signalServiceRequest) {
		request.Executable.Target.SHA256 = strings.Repeat("0", 64)
	})
}

func runSignalServiceRealSuccess(t *testing.T, signalName string, expected syscall.Signal) {
	t.Helper()
	helperPath, helperSHA := requireSignalServiceReal(t)
	token := randomSignalServiceToken(t)
	target, targetOut, targetErr, targetStartTime := startSignalServiceRealTarget(t, token)
	request := signalServiceRealRequest(t, helperPath, helperSHA, target.Process.Pid, targetStartTime, token)
	request.Signal = signalName

	exit, output := runSignalServiceRealHelper(t, helperPath, request)
	if exit != 0 {
		t.Fatalf("helper exit=%d output=%s", exit, output)
	}
	if bytes.Contains(output, []byte(token)) {
		t.Fatalf("helper response leaked token")
	}
	t.Logf("signal real helper raw response: %s", strings.TrimSpace(string(output)))
	var response signalServiceSuccessResponse
	if err := json.Unmarshal(bytes.TrimSpace(output), &response); err != nil {
		t.Fatalf("invalid helper response: %v: %s", err, output)
	}
	if !response.OK || response.Signal != signalName ||
		response.Delivery != signalServiceDeliveryValue ||
		response.Target.PID != strconv.Itoa(target.Process.Pid) ||
		response.Target.StartTime != strconv.FormatUint(targetStartTime, 10) ||
		response.Target.TokenSHA256 != signalServiceTokenDigest(token) ||
		response.MatchedExecutable != "target" {
		t.Fatalf("unexpected helper response: %#v", response)
	}

	waitCommand(t, target, 8*time.Second)
	status, ok := target.ProcessState.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != expected {
		t.Fatalf("target wait status=%v, want signal %s", target.ProcessState, expected)
	}
	t.Logf(
		"signal real success evidence: helperExit=%d targetPid=%d targetStarttime=%d waitSignaled=true waitSignal=%s",
		exit,
		target.Process.Pid,
		targetStartTime,
		expected,
	)
	if bytes.Contains(targetOut.Bytes(), []byte(token)) || bytes.Contains(targetErr.Bytes(), []byte(token)) {
		t.Fatalf("target output leaked token")
	}
}

func runSignalServiceRealRejection(
	t *testing.T,
	wantCode string,
	mutate func(*signalServiceRequest),
) {
	t.Helper()
	helperPath, helperSHA := requireSignalServiceReal(t)
	token := randomSignalServiceToken(t)
	target, targetOut, targetErr, targetStartTime := startSignalServiceRealTarget(t, token)
	request := signalServiceRealRequest(t, helperPath, helperSHA, target.Process.Pid, targetStartTime, token)
	mutate(&request)

	exit, output := runSignalServiceRealHelper(t, helperPath, request)
	if exit != 2 {
		t.Fatalf("helper exit=%d output=%s", exit, output)
	}
	if bytes.Contains(output, []byte(token)) {
		t.Fatalf("helper response leaked token")
	}
	code := signalServiceFailureCode(t, output)
	if code != wantCode {
		t.Fatalf("failure code=%s, want=%s output=%s", code, wantCode, output)
	}
	t.Logf("signal real rejection raw response: %s", strings.TrimSpace(string(output)))
	if !signalServiceProcessAlive(target.Process.Pid, targetStartTime) {
		t.Fatalf("rejected target exited or changed identity")
	}
	t.Logf(
		"signal real rejection evidence: helperExit=%d targetPid=%d targetStarttime=%d targetAlive=true identityMatched=true",
		exit,
		target.Process.Pid,
		targetStartTime,
	)
	if bytes.Contains(targetOut.Bytes(), []byte(token)) || bytes.Contains(targetErr.Bytes(), []byte(token)) {
		t.Fatalf("target output leaked token")
	}
	cleanupSignal := cleanupSignalServiceRealTarget(t, target, targetStartTime)
	t.Logf("signal real rejection cleanup: waitSignaled=true waitSignal=%s", cleanupSignal)
}

func requireSignalServiceReal(t *testing.T) (string, string) {
	t.Helper()
	if os.Getenv(signalRequireRealEnv) != "1" {
		t.Skipf("%s=1 is required for the real signal fixture", signalRequireRealEnv)
	}
	helperPath := os.Getenv(signalHelperPathEnv)
	expectedSHA := os.Getenv(signalHelperSHAEnv)
	if helperPath == "" || !filepath.IsAbs(helperPath) {
		t.Fatalf("%s must be an absolute path", signalHelperPathEnv)
	}
	if len(expectedSHA) != sha256.Size*2 || strings.ToLower(expectedSHA) != expectedSHA {
		t.Fatalf("%s must be a lowercase SHA-256", signalHelperSHAEnv)
	}
	actualSHA := signalServiceFileSHA(t, helperPath)
	if actualSHA != expectedSHA {
		t.Fatalf("helper SHA-256 mismatch")
	}
	return helperPath, expectedSHA
}

func startSignalServiceRealTarget(
	t *testing.T,
	token string,
) (*exec.Cmd, *bytes.Buffer, *bytes.Buffer, uint64) {
	t.Helper()
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	target := exec.Command(testBinary, "-test.run=^TestSignalFixtureTargetProcess$")
	target.Env = fixtureEnvironment(map[string]string{
		signalFixtureTarget:  "1",
		"SFSC_SERVICE_TOKEN": token,
	})
	targetOut := &bytes.Buffer{}
	targetErr := &bytes.Buffer{}
	target.Stdout = targetOut
	target.Stderr = targetErr
	if err := target.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupStartedSignalFixture(t, target, "target") })
	startTime := waitSignalServiceTargetReady(t, target.Process.Pid, token)
	return target, targetOut, targetErr, startTime
}

func waitSignalServiceTargetReady(t *testing.T, pid int, token string) uint64 {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		environ, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
		if err == nil && signalServiceEnvironHasExactlyToken(environ, token) {
			stat, err := readExecServiceProcStat(
				"/proc/"+strconv.Itoa(pid)+"/stat",
				linuxExecServiceHooks(),
			)
			if err == nil && stat.PID == uint64(pid) && stat.PPid == uint64(os.Getpid()) {
				return stat.StartTime
			}
			lastErr = err
		} else {
			lastErr = err
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("signal target fixture did not become ready: %v", lastErr)
	return 0
}

func signalServiceRealRequest(
	t *testing.T,
	helperPath string,
	helperSHA string,
	targetPID int,
	targetStartTime uint64,
	token string,
) signalServiceRequest {
	t.Helper()
	manager, err := readExecServiceProcStat("/proc/self/stat", linuxExecServiceHooks())
	if err != nil {
		t.Fatal(err)
	}
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bootIDData, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		t.Fatal(err)
	}
	bootID := string(bytes.TrimSuffix(bootIDData, []byte{'\n'}))
	pidNamespace, err := os.Readlink("/proc/self/ns/pid")
	if err != nil {
		t.Fatal(err)
	}
	launcher := signalServiceFileIdentity(t, helperPath)
	if launcher.SHA256 != helperSHA {
		t.Fatalf("helper identity SHA mismatch")
	}
	target := signalServiceFileIdentity(t, testBinary)
	return signalServiceRequest{
		Version:   protocolVersion,
		Operation: "signal",
		Signal:    "SIGTERM",
		Namespace: signalServiceNamespaceInput{
			BootID:         bootID,
			PIDNamespaceID: pidNamespace,
		},
		Manager: signalServiceManagerInput{
			PID:       strconv.FormatUint(manager.PID, 10),
			StartTime: strconv.FormatUint(manager.StartTime, 10),
		},
		Process: signalServiceProcessInput{
			PID:             strconv.Itoa(targetPID),
			StartTime:       strconv.FormatUint(targetStartTime, 10),
			ParentPID:       strconv.FormatUint(manager.PID, 10),
			ParentStartTime: strconv.FormatUint(manager.StartTime, 10),
		},
		Token:      token,
		Executable: signalServiceExecutablesInput{Launcher: launcher, Target: target},
	}
}

func runSignalServiceRealHelper(
	t *testing.T,
	helperPath string,
	request signalServiceRequest,
) (int, []byte) {
	t.Helper()
	helper, err := os.Open(helperPath)
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer devNull.Close()

	command := exec.Command("/proc/self/fd/4", signalServiceMode)
	command.Env = signalServiceHelperEnvironment()
	command.ExtraFiles = []*os.File{devNull, helper}
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupStartedSignalFixture(t, command, "helper") })
	helperInfo, err := helper.Stat()
	if err != nil {
		_ = command.Process.Kill()
		t.Fatal(err)
	}
	fdInfo, err := os.Stat("/proc/" + strconv.Itoa(command.Process.Pid) + "/fd/4")
	if err != nil || !os.SameFile(helperInfo, fdInfo) {
		_ = command.Process.Kill()
		t.Fatalf("helper production fd4 does not match the frozen helper: %v", err)
	}

	data := appendSignalServiceLine(marshalSignalServiceTestRequest(t, request))
	if _, err := stdin.Write(data); err != nil {
		_ = command.Process.Kill()
		t.Fatal(err)
	}
	if err := stdin.Close(); err != nil {
		_ = command.Process.Kill()
		t.Fatal(err)
	}
	waitCommand(t, command, 8*time.Second)
	if stderr.Len() != 0 {
		t.Fatalf("helper stderr was not empty")
	}
	return command.ProcessState.ExitCode(), append([]byte(nil), stdout.Bytes()...)
}

func signalServiceHelperEnvironment() []string {
	result := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "SFSC_SERVICE_TOKEN=") {
			continue
		}
		result = append(result, entry)
	}
	return result
}

func signalServiceFileIdentity(t *testing.T, path string) signalServiceExecutableInput {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(file.Fd()), &stat); err != nil {
		t.Fatal(err)
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		t.Fatal(err)
	}
	return signalServiceExecutableInput{
		Dev:    strconv.FormatUint(uint64(stat.Dev), 10),
		Ino:    strconv.FormatUint(uint64(stat.Ino), 10),
		Size:   strconv.FormatUint(uint64(stat.Size), 10),
		SHA256: hex.EncodeToString(hasher.Sum(nil)),
	}
}

func signalServiceFileSHA(t *testing.T, path string) string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func randomSignalServiceToken(t *testing.T) string {
	t.Helper()
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(value[:])
}

func signalServiceEnvironHasExactlyToken(environ []byte, token string) bool {
	if len(environ) == 0 || environ[len(environ)-1] != 0 {
		return false
	}
	prefix := []byte("SFSC_SERVICE_TOKEN=")
	count := 0
	for _, entry := range bytes.Split(environ[:len(environ)-1], []byte{0}) {
		if bytes.HasPrefix(entry, prefix) {
			count++
			if string(entry[len(prefix):]) != token {
				return false
			}
		}
	}
	return count == 1
}

func signalServiceProcessAlive(pid int, startTime uint64) bool {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	return err == nil && signalServiceProcStatAlive(data, uint64(pid), startTime)
}

func signalServiceProcStatAlive(data []byte, pid, startTime uint64) bool {
	open := bytes.LastIndexByte(data, ')')
	if open < 0 || open+2 >= len(data) {
		return false
	}
	fields := strings.Fields(string(data[open+2:]))
	if len(fields) < 20 ||
		fields[0] == "Z" || fields[0] == "X" || fields[0] == "x" {
		return false
	}
	prefix := strings.Fields(string(data[:open+1]))
	if len(prefix) < 1 {
		return false
	}
	actualPID, err := strconv.ParseUint(prefix[0], 10, 64)
	if err != nil || actualPID != pid {
		return false
	}
	actualStartTime, err := strconv.ParseUint(fields[19], 10, 64)
	return err == nil && actualStartTime == startTime
}

func cleanupSignalServiceRealTarget(t *testing.T, target *exec.Cmd, startTime uint64) syscall.Signal {
	t.Helper()
	if !signalServiceProcessAlive(target.Process.Pid, startTime) {
		t.Fatalf("refusing cleanup because target identity changed")
	}
	if err := target.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitCommand(t, target, 8*time.Second)
	status, ok := target.ProcessState.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
		t.Fatalf("target cleanup status=%v", target.ProcessState)
	}
	if signalServiceProcessAlive(target.Process.Pid, startTime) {
		t.Fatalf("target remained alive after cleanup")
	}
	return status.Signal()
}

func cleanupStartedSignalFixture(t *testing.T, command *exec.Cmd, label string) {
	t.Helper()
	if command.ProcessState != nil {
		return
	}
	killErr := command.Process.Kill()
	waitErr := command.Wait()
	if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
		t.Errorf("%s fixture cleanup kill failed: %v", label, killErr)
	}
	if command.ProcessState == nil {
		t.Errorf("%s fixture cleanup produced no process state: %v", label, waitErr)
		return
	}
	status, ok := command.ProcessState.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
		if waitErr != nil {
			t.Errorf("%s fixture cleanup wait failed: %v status=%v", label, waitErr, command.ProcessState)
		} else {
			t.Errorf("%s fixture cleanup did not confirm SIGKILL: status=%v", label, command.ProcessState)
		}
	}
}

func validSignalServiceTestRequest() signalServiceRequest {
	targetSHA := sha256.Sum256([]byte("target"))
	launcherSHA := sha256.Sum256([]byte("launcher"))
	return signalServiceRequest{
		Version:   protocolVersion,
		Operation: "signal",
		Signal:    "SIGTERM",
		Namespace: signalServiceNamespaceInput{
			BootID:         signalTestBootID,
			PIDNamespaceID: signalTestNamespace,
		},
		Manager: signalServiceManagerInput{
			PID:       signalTestManagerPID,
			StartTime: signalTestStartTime,
		},
		Process: signalServiceProcessInput{
			PID:             signalTestTargetPID,
			StartTime:       signalTestTargetTime,
			ParentPID:       signalTestManagerPID,
			ParentStartTime: signalTestStartTime,
		},
		Token: signalTestToken,
		Executable: signalServiceExecutablesInput{
			Launcher: signalServiceExecutableInput{
				Dev:    "2049",
				Ino:    "123",
				Size:   strconv.Itoa(len("launcher")),
				SHA256: hex.EncodeToString(launcherSHA[:]),
			},
			Target: signalServiceExecutableInput{
				Dev:    "2049",
				Ino:    "124",
				Size:   strconv.Itoa(len("target")),
				SHA256: hex.EncodeToString(targetSHA[:]),
			},
		},
	}
}

func newSignalServiceTestEnvironment() *signalServiceTestEnvironment {
	now := time.Now()
	fake := &signalServiceTestEnvironment{
		now:      now,
		ppid:     101,
		nextFD:   21,
		pidfd:    20,
		fdPath:   make(map[int]string),
		fdOffset: make(map[int]int),
		exeData:  []byte("target"),
		exeStat: syscall.Stat_t{
			Dev:  2049,
			Ino:  124,
			Size: int64(len("target")),
			Mode: syscall.S_IFREG | 0o755,
			Uid:  0,
		},
		files: map[string][]byte{
			"/proc/self/stat":                 signalServiceProcStatFixture(101, 101, 899),
			"/proc/101/stat":                  signalServiceProcStatFixture(101, 1, 900),
			"/proc/102/stat":                  signalServiceProcStatFixture(102, 101, 901),
			"/proc/sys/kernel/random/boot_id": []byte(signalTestBootID + "\n"),
			"/proc/102/environ":               []byte("PATH=/usr/bin\x00SFSC_SERVICE_TOKEN=" + signalTestToken + "\x00"),
		},
		links: map[string]string{
			"/proc/self/ns/pid": signalTestNamespace,
			"/proc/102/ns/pid":  signalTestNamespace,
		},
		openErrs:  make(map[string]error),
		readErrs:  make(map[string]error),
		closeErrs: make(map[int]error),
	}
	return fake
}

func (fake *signalServiceTestEnvironment) hooks() signalServiceHooks {
	hooks := signalServiceHooks{
		now:              func() time.Time { return fake.now },
		getppid:          func() int { return fake.ppid },
		readlink:         func(path string) (string, error) { return fake.links[path], nil },
		setReadDeadline:  func(*os.File, time.Time) error { return nil },
		setProtocolRead:  func(*os.File, time.Time) error { return nil },
		setProtocolWrite: func(*os.File, time.Time) error { return nil },
		closeFile: func(file *os.File) error {
			fake.protocolCloseFDs = append(fake.protocolCloseFDs, int(file.Fd()))
			fake.protocolCloseNames = append(fake.protocolCloseNames, file.Name())
			if fake.closeFileFn != nil {
				return fake.closeFileFn(file)
			}
			return file.Close()
		},
		writeFrame: func(file *os.File, data []byte, _ time.Duration) error {
			if fake.writeErr != nil {
				return fake.writeErr
			}
			_, err := file.Write(data)
			return err
		},
		totalBudget:      signalTotalBudget,
		initialFrameWait: signalInitialFrameLimit,
		eofWait:          signalEOFLimit,
		outputWait:       signalOutputLimit,
	}
	hooks.open = func(path string, flags int, mode uint32) (int, error) {
		if err := fake.openErrs[path]; err != nil {
			return -1, err
		}
		if !strings.HasSuffix(path, "/exe") {
			if _, ok := fake.files[path]; !ok {
				return -1, os.ErrNotExist
			}
		}
		fd := fake.nextFD
		fake.nextFD++
		fake.fdPath[fd] = path
		fake.fdOffset[fd] = 0
		occurrence := 0
		for _, openedPath := range fake.openedPaths {
			if openedPath == path {
				occurrence++
			}
		}
		fake.openedPaths = append(fake.openedPaths, path)
		fake.events = append(fake.events, fmt.Sprintf("open:%s#%d", path, occurrence+1))
		return fd, nil
	}
	hooks.read = func(fd int, buffer []byte) (int, error) {
		path := fake.fdPath[fd]
		if fake.readFn != nil {
			return fake.readFn(fd, buffer, path)
		}
		if err := fake.readErrs[path]; err != nil {
			return 0, err
		}
		data := fake.files[path]
		offset := fake.fdOffset[fd]
		if offset >= len(data) {
			return 0, nil
		}
		read := copy(buffer, data[offset:])
		fake.fdOffset[fd] = offset + read
		return read, nil
	}
	hooks.close = func(fd int) error {
		path, known := fake.fdPath[fd]
		if !known {
			fake.rawCloseFDs = append(fake.rawCloseFDs, fd)
			return syscall.Close(fd)
		}
		fake.closedFDs = append(fake.closedFDs, fd)
		fake.closedPaths = append(fake.closedPaths, path)
		fake.events = append(fake.events, "close:"+path)
		if fake.closeFn != nil {
			return fake.closeFn(fd, path)
		}
		return fake.closeErrs[fd]
	}
	hooks.fstat = func(fd int, stat *syscall.Stat_t) error {
		path := fake.fdPath[fd]
		if fake.fstatFn != nil {
			return fake.fstatFn(fd, stat, path)
		}
		*stat = fake.exeStat
		return nil
	}
	hooks.pread = func(fd int, buffer []byte, offset int64) (int, error) {
		path := fake.fdPath[fd]
		if fake.preadFn != nil {
			return fake.preadFn(fd, buffer, offset, path)
		}
		if offset >= int64(len(fake.exeData)) {
			return 0, nil
		}
		read := copy(buffer, fake.exeData[offset:])
		return read, nil
	}
	hooks.fcntl = func(fd, command, argument int) (int, error) {
		if fd != fake.pidfd || fake.fdPath[fd] != "pidfd" {
			return linuxExecServiceFcntl(fd, command, argument)
		}
		switch command {
		case syscall.F_GETFD:
			return syscall.FD_CLOEXEC, nil
		case syscall.F_SETFD:
			return 0, nil
		default:
			return argument, nil
		}
	}
	hooks.pidfdOpen = func(pid uint64, flags uintptr) (int, error) {
		fake.pidfdOpenCall++
		fake.events = append(fake.events, "pidfd-open:"+strconv.FormatUint(pid, 10))
		if fake.pidfdOpenErr != nil {
			return -1, fake.pidfdOpenErr
		}
		fake.fdPath[fake.pidfd] = "pidfd"
		return fake.pidfd, nil
	}
	hooks.pidfdSendSignal = func(fd int, signal syscall.Signal, flags uintptr) error {
		fake.sendCallCount++
		fake.sentSignals = append(fake.sentSignals, signal)
		fake.events = append(fake.events, "pidfd-send:"+strconv.Itoa(int(signal)))
		return fake.sendErr
	}
	return hooks
}

func runSignalServiceForTest(
	t *testing.T,
	request signalServiceRequest,
	fake *signalServiceTestEnvironment,
	mutate func(*signalServiceHooks),
) (int, []byte) {
	t.Helper()
	data := appendSignalServiceLine(marshalSignalServiceTestRequest(t, request))
	hooks := fake.hooks()
	if mutate != nil {
		mutate(&hooks)
	}
	return runSignalServiceRawForTest(t, data, hooks)
}

func runSignalServicePreparedForTest(
	t *testing.T,
	request signalServiceRequest,
	fake *signalServiceTestEnvironment,
	prepare func(*signalServiceRequest, *signalServiceTestEnvironment, *signalServiceHooks),
) (int, []byte) {
	t.Helper()
	hooks := fake.hooks()
	prepare(&request, fake, &hooks)
	data := appendSignalServiceLine(marshalSignalServiceTestRequest(t, request))
	return runSignalServiceRawForTest(t, data, hooks)
}

func runSignalServiceRawForTest(t *testing.T, data []byte, hooks signalServiceHooks) (int, []byte) {
	t.Helper()
	directory := t.TempDir()
	inputReader, inputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer inputReader.Close()
	if _, err := inputWriter.Write(data); err != nil {
		_ = inputWriter.Close()
		t.Fatal(err)
	}
	if err := inputWriter.Close(); err != nil {
		t.Fatal(err)
	}
	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer outputReader.Close()
	stderr, err := os.OpenFile(filepath.Join(directory, "stderr"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer stderr.Close()
	exit := runSignalServiceWithHooks([]string{"helper", signalServiceMode}, inputReader, outputWriter, stderr, hooks)
	if err := outputWriter.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := io.ReadAll(outputReader)
	if err != nil {
		t.Fatal(err)
	}
	stderrData, err := io.ReadAll(stderr)
	if err != nil {
		t.Fatal(err)
	}
	if len(stderrData) != 0 {
		t.Fatalf("signal-service wrote stderr: %q", stderrData)
	}
	return exit, result
}

func marshalSignalServiceTestRequest(t *testing.T, request signalServiceRequest) []byte {
	t.Helper()
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func appendSignalServiceLine(data []byte) []byte {
	return append(append([]byte(nil), data...), '\n')
}

func signalServiceFailureCode(t *testing.T, output []byte) string {
	t.Helper()
	var response signalServiceFailureResponse
	if err := json.Unmarshal(bytes.TrimSpace(output), &response); err != nil {
		t.Fatalf("invalid failure response: %v: %s", err, output)
	}
	if response.OK || response.Version != protocolVersion ||
		response.HelperVersion != helperVersion ||
		response.Operation != signalServiceMode {
		t.Fatalf("unexpected failure response: %#v", response)
	}
	return response.Error.Code
}

func signalServiceTokenDigest(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func signalServiceProcStatFixture(pid, ppid, startTime uint64) []byte {
	return []byte(fmt.Sprintf(
		"%d (name with ) and spaces) S %d 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 20 0 1 %d 0 0 0\n",
		pid,
		ppid,
		startTime,
	))
}

func signalServiceProcStatFixtureState(
	pid, ppid, startTime uint64,
	state string,
) []byte {
	return bytes.Replace(
		signalServiceProcStatFixture(pid, ppid, startTime),
		[]byte(") S "),
		[]byte(") "+state+" "),
		1,
	)
}

func signalServiceJSONObject(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	return object
}

func signalServiceMarshalJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func signalServiceJSONWithTopLevelField(t *testing.T, data []byte, key string, value any) []byte {
	t.Helper()
	object := signalServiceJSONObject(t, data)
	object[key] = value
	return signalServiceMarshalJSON(t, object)
}

func signalServiceJSONWithNestedField(t *testing.T, data []byte, objectKey, field string, value any) []byte {
	t.Helper()
	object := signalServiceJSONObject(t, data)
	nested, ok := object[objectKey].(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object", objectKey)
	}
	nested[field] = value
	return signalServiceMarshalJSON(t, object)
}

func signalServiceJSONWithDuplicateNestedField(t *testing.T, data []byte, objectKey, field string) []byte {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	var nested map[string]json.RawMessage
	if err := json.Unmarshal(object[objectKey], &nested); err != nil {
		t.Fatal(err)
	}
	fieldValue, ok := nested[field]
	if !ok {
		t.Fatalf("%s.%s not found", objectKey, field)
	}
	nestedJSON := strings.TrimSuffix(string(object[objectKey]), "}")
	nestedJSON += `,"` + field + `":` + string(fieldValue) + "}"
	object[objectKey] = json.RawMessage(nestedJSON)
	return signalServiceMarshalJSON(t, object)
}

func signalServiceJSONWithDuplicateExecutableField(t *testing.T, data []byte, executable, field string) []byte {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	var executables map[string]json.RawMessage
	if err := json.Unmarshal(object["executable"], &executables); err != nil {
		t.Fatal(err)
	}
	var identity map[string]json.RawMessage
	if err := json.Unmarshal(executables[executable], &identity); err != nil {
		t.Fatal(err)
	}
	fieldValue, ok := identity[field]
	if !ok {
		t.Fatalf("executable.%s.%s not found", executable, field)
	}
	identityJSON := strings.TrimSuffix(string(executables[executable]), "}")
	identityJSON += `,"` + field + `":` + string(fieldValue) + "}"
	executables[executable] = json.RawMessage(identityJSON)
	executablesJSON, err := json.Marshal(executables)
	if err != nil {
		t.Fatal(err)
	}
	object["executable"] = executablesJSON
	return signalServiceMarshalJSON(t, object)
}

func signalServiceJSONWithoutNestedField(t *testing.T, data []byte, objectKey, field string) []byte {
	t.Helper()
	object := signalServiceJSONObject(t, data)
	nested, ok := object[objectKey].(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object", objectKey)
	}
	delete(nested, field)
	return signalServiceMarshalJSON(t, object)
}

func signalServiceJSONWithoutExecutableField(t *testing.T, data []byte, executable, field string) []byte {
	t.Helper()
	object := signalServiceJSONObject(t, data)
	executables, ok := object["executable"].(map[string]any)
	if !ok {
		t.Fatal("executable is not an object")
	}
	identity, ok := executables[executable].(map[string]any)
	if !ok {
		t.Fatalf("executable.%s is not an object", executable)
	}
	delete(identity, field)
	return signalServiceMarshalJSON(t, object)
}

func signalServiceJSONWithExecutableField(t *testing.T, data []byte, executable, field string, value any) []byte {
	t.Helper()
	object := signalServiceJSONObject(t, data)
	executables, ok := object["executable"].(map[string]any)
	if !ok {
		t.Fatal("executable is not an object")
	}
	identity, ok := executables[executable].(map[string]any)
	if !ok {
		t.Fatalf("executable.%s is not an object", executable)
	}
	identity[field] = value
	return signalServiceMarshalJSON(t, object)
}

func signalServiceEventBefore(events []string, first, second string) bool {
	firstIndex := -1
	secondIndex := -1
	for index, event := range events {
		if firstIndex < 0 && event == first {
			firstIndex = index
		}
		if secondIndex < 0 && strings.HasPrefix(event, second) {
			secondIndex = index
		}
	}
	return firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex
}

func signalServiceTestOutputFile(t *testing.T) *os.File {
	t.Helper()
	file, err := os.OpenFile(filepath.Join(t.TempDir(), "stdout"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	return file
}

func signalServiceTestErrorFile(t *testing.T) *os.File {
	t.Helper()
	file, err := os.OpenFile(filepath.Join(t.TempDir(), "stderr"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	return file
}

func signalServiceReadTestOutput(t *testing.T, file *os.File) []byte {
	t.Helper()
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func signalServiceTestPipe(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reader.Close() })
	t.Cleanup(func() { _ = writer.Close() })
	return reader, writer
}

func assertSignalServiceTestFDClosed(t *testing.T, fd int) {
	t.Helper()
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); !errors.Is(err, syscall.EBADF) {
		t.Fatalf("fd %d still open or unexpected Fstat error: %v", fd, err)
	}
}

func assertSignalServiceProtocolCleanup(t *testing.T, fake *signalServiceTestEnvironment) {
	t.Helper()
	if len(fake.rawCloseFDs) != 0 {
		t.Fatalf("protocol or unknown fds closed through raw close: %v", fake.rawCloseFDs)
	}
	if len(fake.protocolCloseFDs) != 2 ||
		len(fake.protocolCloseNames) != 2 ||
		fake.protocolCloseNames[0] != "sfsc-signal-stdin" ||
		fake.protocolCloseNames[1] != "sfsc-signal-stdout" {
		t.Fatalf(
			"protocol close fds=%v names=%v",
			fake.protocolCloseFDs,
			fake.protocolCloseNames,
		)
	}
	if fake.protocolCloseFDs[0] == fake.protocolCloseFDs[1] {
		t.Fatalf("protocol fds reused before close: %v", fake.protocolCloseFDs)
	}
}

func assertSignalServiceFDCleanup(t *testing.T, fake *signalServiceTestEnvironment) {
	t.Helper()
	opened := make(map[int]bool)
	for fd := range fake.fdPath {
		opened[fd] = true
	}
	counts := make(map[int]int)
	for _, fd := range fake.closedFDs {
		counts[fd]++
	}
	for fd := range opened {
		if counts[fd] != 1 {
			t.Fatalf("fd %d close count=%d openedPaths=%v closed=%v", fd, counts[fd], fake.openedPaths, fake.closedFDs)
		}
	}
	for fd, count := range counts {
		if count != 1 {
			t.Fatalf("fd %d closed %d times", fd, count)
		}
	}
}
