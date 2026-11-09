//go:build linux && (amd64 || arm64)

package main

import (
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestParseConfigAcceptsExplicitServiceModeAndPreservesRcloneMode(t *testing.T) {
	base := []string{"--exec-service", "/opt/guard", "--signal-service", "/opt/guard", "--root", "/srv/root", "--authorized-keys", "/etc/sfsc/authorized_keys", "--host-key", "/etc/sfsc/host.key"}
	v2 := append(append([]string{}, base...), "--service", "/opt/sfsc-sftp-service", "--user", "sfsc")
	cfg, err := parseConfig(v2)
	if err != nil || cfg.servicePath != "/opt/sfsc-sftp-service" || cfg.serviceUser != "sfsc" {
		t.Fatalf("V2 config: cfg=%#v err=%v", cfg, err)
	}
	v1 := append(append([]string{}, base...), "--rclone", "/opt/rclone")
	cfg, err = parseConfig(v1)
	if err != nil || cfg.rclonePath != "/opt/rclone" || cfg.servicePath != "" {
		t.Fatalf("V1 config: cfg=%#v err=%v", cfg, err)
	}
	for _, args := range [][]string{append(append([]string{}, base...), "--service", "/opt/service"), append(append([]string{}, v2...), "--rclone", "/opt/rclone"), append(append([]string{}, base...), "--rclone", "/opt/rclone", "--user", "sfsc")} {
		if _, err := parseConfig(args); err == nil {
			t.Errorf("invalid target selection accepted: %v", args)
		}
	}
}

func TestCanonicalNumbersAndTokens(t *testing.T) {
	for _, value := range []string{"0", "1", "42", "9007199254740991"} {
		if _, ok := parseCanonicalDecimal(value); !ok {
			t.Fatalf("expected canonical decimal %q", value)
		}
	}
	for _, value := range []string{"", "00", "01", "-1", "+1", "1x"} {
		if _, ok := parseCanonicalDecimal(value); ok {
			t.Fatalf("unexpected canonical decimal %q", value)
		}
	}
	if !validToken(strings.Repeat("a", 32)) {
		t.Fatal("expected valid token")
	}
	for _, value := range []string{
		"",
		strings.Repeat("a", 31),
		strings.Repeat("a", 33),
		strings.Repeat("A", 32),
		strings.Repeat("g", 32),
	} {
		if validToken(value) {
			t.Fatalf("unexpected valid token %q", value)
		}
	}
}

func TestIdentityValidationMatchesManagerAlphabet(t *testing.T) {
	for _, value := range []string{"a", "A1", "relation.runtime_1:test-name"} {
		if !validIdentity(value) {
			t.Fatalf("expected valid identity %q", value)
		}
	}
	for _, value := range []string{"", "-leading", ".leading", "bad/value", "bad value"} {
		if validIdentity(value) {
			t.Fatalf("unexpected valid identity %q", value)
		}
	}
}

func TestSelfProcessAndNamespaceObservation(t *testing.T) {
	self, err := readProcStat(uint64(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	parent, err := readProcStat(uint64(os.Getppid()))
	if err != nil {
		t.Fatal(err)
	}
	identity := parentIdentityFromStats(parent, self)
	if _, err := verifyProcessIdentity(identity); err != nil {
		t.Fatal(err)
	}
	namespace, err := readNamespaceIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if !validLowerUUID(namespace.BootID) ||
		!strings.HasPrefix(namespace.PIDNamespaceID, "pid:[") {
		t.Fatalf("invalid namespace: %+v", namespace)
	}
}

func TestTCPTablesAndTaskCensusAreReadable(t *testing.T) {
	if _, err := readTCPTables(uint64(os.Getpid())); err != nil {
		t.Fatal(err)
	}
	if _, err := allTaskCensus(); err != nil {
		t.Fatal(err)
	}
}

func TestTCPTableParserFailsClosedOnMalformedRows(t *testing.T) {
	header := "  sl  local_address rem_address   st tx_queue rx_queue " +
		"tr tm->when retrnsmt uid timeout inode\n"
	valid := header +
		"   0: 0100007F:1F90 0100007F:C350 01 00000000:00000000 " +
		"00:00000000 00000000 0 0 61\n"
	entries, err := parseTCPTable([]byte(valid))
	if err != nil || len(entries) != 1 || entries[0].Inode != "61" {
		t.Fatalf("valid table failed: entries=%+v err=%v", entries, err)
	}
	for _, table := range []string{
		"",
		header + "0: short\n",
		header + "0: nothex:1F90 0100007F:C350 01 0:0 0 0 0 0 61\n",
		header + "0: 0100007F:1F90 0100007F:C350 1 0:0 0 0 0 0 61\n",
		header + "0: 0100007F:1F90 0100007F:C350 01 0:0 0 0 0 0 inode\n",
	} {
		if _, err := parseTCPTable([]byte(table)); err == nil {
			t.Fatalf("expected malformed table rejection: %q", table)
		}
	}
	if !tcpStateIsActiveSession("01") {
		t.Fatal("ESTABLISHED must be an active session")
	}
	for _, state := range []string{"06", "08", "0A"} {
		if tcpStateIsActiveSession(state) {
			t.Fatalf("kernel residual state %s must not remain an active session", state)
		}
	}
}

func TestTCPTableParserAcceptsObservedTCP6Header(t *testing.T) {
	header := "  sl  local_address                         remote_address                        " +
		"st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	row := "   0: 00000000000000000000000001000000:1F90 " +
		"00000000000000000000000001000000:C350 01 00000000:00000000 " +
		"00:00000000 00000000 0 0 61\n"
	entries, err := parseTCPTable([]byte(header + row))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("unexpected entry count: %d", len(entries))
	}
	if entries[0].LocalAddress != "00000000000000000000000001000000" ||
		entries[0].LocalPort != 8080 ||
		entries[0].RemoteAddress != "00000000000000000000000001000000" ||
		entries[0].RemotePort != 50000 ||
		entries[0].State != "01" ||
		entries[0].Inode != "61" {
		t.Fatalf("unexpected TCP6 entry: %+v", entries[0])
	}
	for _, label := range []string{
		"remote-address",
		"remoteaddr",
		"Remote_address",
		"remote_addresses",
	} {
		nearMiss := strings.Replace(header, "remote_address", label, 1)
		if _, err := parseTCPTable([]byte(nearMiss + row)); err == nil {
			t.Fatalf("near-miss remote address label %q was accepted", label)
		}
	}
}

func TestSelectListenerEntryRequiresExactlyOne(t *testing.T) {
	listener := listenerIdentity{Host: "127.0.0.1", Port: 42022}
	base := tcpEntry{
		LocalAddress: "0100007F",
		LocalPort:    listener.Port,
		State:        "0A",
		Inode:        "61",
	}
	if _, ok := selectListenerEntry(nil, listener); ok {
		t.Fatal("missing listener must not select an entry")
	}
	if selected, ok := selectListenerEntry([]tcpEntry{base}, listener); !ok ||
		selected.Inode != base.Inode {
		t.Fatalf("single listener not selected: selected=%+v ok=%v", selected, ok)
	}
	for name, entries := range map[string][]tcpEntry{
		"duplicate": {base, base},
		"wrong_port": {
			{
				LocalAddress: "0100007F",
				LocalPort:    listener.Port + 1,
				State:        "0A",
				Inode:        "62",
			},
		},
		"wrong_state": {
			{
				LocalAddress: "0100007F",
				LocalPort:    listener.Port,
				State:        "01",
				Inode:        "62",
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, ok := selectListenerEntry(entries, listener); ok {
				t.Fatalf("unexpected listener selection for %s", name)
			}
		})
	}
}

func TestObserveNetworkDoesNotInferClosedSessionsWithoutListener(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
	})
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.(*net.TCPListener).SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	client, err := net.DialTimeout("tcp4", listener.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.Close()
	})
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = server.Close()
	})
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	waitForListenerPortState(t, port, 0, 1)

	observed, sessions, err := observeNetwork(
		uint64(os.Getpid()),
		listenerIdentity{Host: "127.0.0.1", Port: port},
	)
	if err != nil {
		t.Fatal(err)
	}
	if observed.Open {
		t.Fatal("closed listener was reported open")
	}
	if sessions.Tracked {
		t.Fatal("listener absence plus retained ESTABLISHED socket must remain unconfirmed")
	}

	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	waitForListenerPortState(t, port, 0, 0)
}

func TestIncompleteCleanupCensusCannotProveSessionsClosed(t *testing.T) {
	closed, err := sessionClosureAfterCleanup(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if closed {
		t.Fatal("incomplete cleanup census must not prove sessions closed")
	}
}

func TestProcessPresenceDistinguishesGoneFromIdentityError(t *testing.T) {
	self, err := readProcStat(uint64(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	parent, err := readProcStat(uint64(os.Getppid()))
	if err != nil {
		t.Fatal(err)
	}
	exact := parentIdentityFromStats(parent, self)
	presence, err := observeProcessPresence(exact)
	if err != nil || presence != processExact {
		t.Fatalf("exact process not observed: presence=%v err=%v", presence, err)
	}
	reusedPID := exact
	reusedPID.StartTime = strconv.FormatUint(self.StartTime+1, 10)
	presence, err = observeProcessPresence(reusedPID)
	if err != nil || presence != processGone {
		t.Fatalf("starttime drift must be gone: presence=%v err=%v", presence, err)
	}
	wrongParent := exact
	wrongParent.ParentPID = strconv.FormatUint(parent.PID+1, 10)
	presence, err = observeProcessPresence(wrongParent)
	if err == nil || presence != processUnknown {
		t.Fatalf("parent drift must be unknown: presence=%v err=%v", presence, err)
	}
}

func TestWaitForSpecificChildDoesNotReapUnrelatedChild(t *testing.T) {
	if delay := os.Getenv("SFSC_WAIT_TEST_DELAY_MS"); delay != "" {
		milliseconds, err := strconv.Atoi(delay)
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Duration(milliseconds) * time.Millisecond)
		return
	}
	first := spawnWaitTestChild(t, 0)
	second := spawnWaitTestChild(t, 300)
	t.Cleanup(func() {
		_ = syscall.Kill(first, syscall.SIGKILL)
		_ = syscall.Kill(second, syscall.SIGKILL)
		reapWaitTestChild(first)
		reapWaitTestChild(second)
	})
	if err := waitForSpecificChild(uint64(second), 2*time.Second); err != nil {
		t.Fatal(err)
	}
	_ = syscall.Kill(first, syscall.SIGKILL)
	var status syscall.WaitStatus
	reaped, err := syscall.Wait4(first, &status, 0, nil)
	if err != nil {
		t.Fatalf("unrelated child was reaped early: %v", err)
	}
	if reaped != first {
		t.Fatalf("reaped pid %d, want %d", reaped, first)
	}
}

func TestSignalDirectChildUsesUnreapedPID(t *testing.T) {
	pid := spawnWaitTestChild(t, 5000)
	stat, err := readProcStat(uint64(pid))
	if err != nil {
		t.Fatal(err)
	}
	if err := signalDirectChild(uint64(pid), stat.StartTime, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := waitForSpecificChild(uint64(pid), 2*time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestStableErrorCodes(t *testing.T) {
	if got := stableErrorCode(os.ErrNotExist); got != "runtime_error" {
		t.Fatalf("unexpected stable error code %q", got)
	}
	if got := stableErrorCode(os.ErrPermission); got != "runtime_error" {
		t.Fatalf("unexpected stable error code %q", got)
	}
	if got := stableErrorCode(&testCodeError{"exact_code"}); got != "exact_code" {
		t.Fatalf("unexpected stable code %q", got)
	}
}

func TestClosedSupervisorAllowsOnlyInspectAndRelease(t *testing.T) {
	self, err := readProcStat(uint64(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	instance := &supervisor{
		self: self,
		state: &relationState{
			token:              strings.Repeat("a", 32),
			relationID:         "relation-test",
			generation:         "1",
			startOperationID:   "operation-start",
			disableOperationID: "operation-disable",
			closureOperationID: "operation-disable",
			closureFenceDigest: strings.Repeat("b", 64),
			phase:              "closed",
			manager:            identityFromStat(self),
			childrenExited:     true,
			processExited:      true,
			listenerClosed:     true,
			sessionsClosed:     true,
		},
	}
	if _, _, err := instance.handle(protocolRequest{
		Version:     protocolVersion,
		RequestID:   "go-after-close",
		Operation:   "go",
		Token:       strings.Repeat("a", 32),
		Generation:  "1",
		RelationID:  "relation-test",
		OperationID: "operation-start",
		FenceDigest: strings.Repeat("a", 64),
	}); err == nil {
		t.Fatal("expected go rejection after closure")
	}
	result, exit, err := instance.handle(protocolRequest{
		Version:     protocolVersion,
		RequestID:   "release-after-close",
		Operation:   "release",
		Token:       strings.Repeat("a", 32),
		Generation:  "1",
		RelationID:  "relation-test",
		OperationID: "operation-disable",
		FenceDigest: strings.Repeat("b", 64),
	})
	if err != nil || !exit {
		t.Fatalf("release failed: exit=%v err=%v", exit, err)
	}
	released, ok := result.(releaseResult)
	if !ok || released.Phase != "releasing" {
		t.Fatalf("unexpected release result: %#v", result)
	}
}

func TestReadFileIdentityUsesRegularExecutable(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	identity, err := readFileIdentity(executable)
	if err != nil {
		t.Fatal(err)
	}
	size, err := strconv.ParseInt(identity.Size, 10, 64)
	if err != nil || size <= 0 || len(identity.Sha256) != 64 {
		t.Fatalf("invalid identity: %+v", identity)
	}
}

func TestReadFileIdentityUsesSingleOpenDescriptor(t *testing.T) {
	directory := t.TempDir()
	firstPath := directory + "/first"
	secondPath := directory + "/second"
	if err := os.WriteFile(firstPath, []byte("first"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondPath, []byte("second-content"), 0o700); err != nil {
		t.Fatal(err)
	}
	firstIdentity, err := readFileIdentity(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := os.Rename(secondPath, firstPath); err != nil {
		t.Fatal(err)
	}
	observed, err := readOpenFileIdentity(file, nil)
	if err != nil {
		t.Fatal(err)
	}
	if observed != firstIdentity {
		t.Fatalf("open descriptor identity changed: observed=%+v want=%+v", observed, firstIdentity)
	}
	replacement, err := readFileIdentity(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	if replacement == firstIdentity {
		t.Fatal("path replacement produced the original identity")
	}
}

func TestReadFileIdentityRejectsPostHashMetadataChange(t *testing.T) {
	path := t.TempDir() + "/identity"
	if err := os.WriteFile(path, []byte("stable"), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	_, err = readOpenFileIdentity(file, func() {
		if truncateErr := file.Truncate(7); truncateErr != nil {
			t.Fatal(truncateErr)
		}
	})
	if err == nil || err.Error() != "file_identity_changed" {
		t.Fatalf("metadata change was not rejected: %v", err)
	}
}

func TestInitialStartupLauncherRequiresFreshCommonGates(t *testing.T) {
	state := testStartupState()
	dependencies := testStartupDependencies(state)
	dependencies.readFileIdentity = func(string) (fileIdentity, error) {
		return state.launcher, nil
	}
	instance := &supervisor{
		state:               state,
		startupDependencies: &dependencies,
	}
	result, err := instance.initialRunningObservation(state)
	if err != nil {
		t.Fatal(err)
	}
	starting, ok := result.(startingResult)
	if !ok || starting.Reason != "launcher_exact" ||
		starting.ObservedExecutable != state.launcher {
		t.Fatalf("unexpected launcher observation: %#v", result)
	}

	tests := map[string]func(*startupObservationDependencies){
		"process": func(value *startupObservationDependencies) {
			value.observeProcessPresence = func(processParentIdentity) (processPresence, error) {
				return processUnknown, nil
			}
		},
		"namespace": func(value *startupObservationDependencies) {
			value.readNamespaceIdentity = func() (namespaceIdentity, error) {
				return namespaceIdentity{
					BootID:         "00000000-0000-0000-0000-000000000000",
					PIDNamespaceID: state.namespace.PIDNamespaceID,
				}, nil
			}
		},
		"token": func(value *startupObservationDependencies) {
			value.readProcessEnvironmentToken = func(uint64) (string, error) {
				return strings.Repeat("0", 32), nil
			}
		},
		"security": func(value *startupObservationDependencies) {
			value.readProcessSecurity = func(uint64) (capabilityObservation, bool, error) {
				return testZeroCapabilities(), false, nil
			}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			failing := testStartupDependencies(state)
			failing.readFileIdentity = func(string) (fileIdentity, error) {
				return state.launcher, nil
			}
			mutate(&failing)
			failingInstance := &supervisor{
				state:               state,
				startupDependencies: &failing,
			}
			observed, err := failingInstance.initialRunningObservation(state)
			if err == nil {
				t.Fatalf("invalid %s evidence returned %#v", name, observed)
			}
			if _, ok := observed.(startingResult); ok {
				t.Fatalf("invalid %s evidence produced a starting result", name)
			}
		})
	}
}

func TestStartupExecutableReadErrorDiffersFromSuccessfulMismatch(t *testing.T) {
	state := testStartupState()
	readFailure := testStartupDependencies(state)
	readFailure.readFileIdentity = func(string) (fileIdentity, error) {
		return fileIdentity{}, errors.New("unreadable")
	}
	instance := &supervisor{
		state:               state,
		startupDependencies: &readFailure,
	}
	if _, err := instance.initialRunningObservation(state); err == nil ||
		err.Error() != "startup_executable_read_failed" {
		t.Fatalf("unexpected read failure code: %v", err)
	}

	mismatch := testStartupDependencies(state)
	mismatch.readFileIdentity = func(string) (fileIdentity, error) {
		return testFileIdentity("33"), nil
	}
	instance.startupDependencies = &mismatch
	if _, err := instance.initialRunningObservation(state); err == nil ||
		err.Error() != "target_executable_mismatch" {
		t.Fatalf("unexpected mismatch code: %v", err)
	}
}

func TestStartupListenerCountZeroOneAndAmbiguous(t *testing.T) {
	listener := listenerIdentity{Host: "127.0.0.1", Port: 42022}
	listenerEntry := tcpEntry{
		LocalAddress: "0100007F",
		LocalPort:    listener.Port,
		State:        "0A",
		Inode:        "61",
	}

	t.Run("zero", func(t *testing.T) {
		state := testStartupState()
		dependencies := testStartupDependencies(state)
		dependencies.readTCPTables = func(uint64) ([]tcpEntry, error) {
			return nil, nil
		}
		instance := &supervisor{
			state:               state,
			startupDependencies: &dependencies,
		}
		result, err := instance.initialRunningObservation(state)
		if err != nil {
			t.Fatal(err)
		}
		starting, ok := result.(startingResult)
		if !ok || starting.Reason != "listener_absent" {
			t.Fatalf("zero listeners did not produce listener_absent: %#v", result)
		}
	})

	t.Run("one", func(t *testing.T) {
		state := testStartupState()
		dependencies := testStartupDependencies(state)
		instance := &supervisor{
			state:               state,
			startupDependencies: &dependencies,
		}
		result, err := instance.initialRunningObservation(state)
		if err != nil {
			t.Fatal(err)
		}
		if running, ok := result.(runningResult); !ok || running.Phase != "running" {
			t.Fatalf("one listener did not reach running: %#v", result)
		}
		if state.phase != "running" || !state.sessionCensusKnown {
			t.Fatalf("running evidence was not committed: %+v", state)
		}
	})

	t.Run("ambiguous", func(t *testing.T) {
		state := testStartupState()
		dependencies := testStartupDependencies(state)
		dependencies.readTCPTables = func(uint64) ([]tcpEntry, error) {
			return []tcpEntry{listenerEntry, listenerEntry}, nil
		}
		instance := &supervisor{
			state:               state,
			startupDependencies: &dependencies,
		}
		if _, err := instance.initialRunningObservation(state); err == nil ||
			err.Error() != "startup_listener_ambiguous" {
			t.Fatalf("unexpected ambiguous listener result: %v", err)
		}
	})
}

func TestStartupOwnershipSessionsAndChildrenFailClosed(t *testing.T) {
	tests := map[string]struct {
		mutate func(*startupObservationDependencies)
		code   string
	}{
		"unowned": {
			mutate: func(value *startupObservationDependencies) {
				value.observeNetworkSnapshot = func(
					uint64,
					listenerIdentity,
					[]tcpEntry,
				) (observedListener, sessionObservation, error) {
					return observedListener{
						Host: "127.0.0.1", Port: 42022, Open: true,
					}, sessionObservation{}, nil
				}
			},
			code: "startup_listener_not_owned",
		},
		"sessions": {
			mutate: func(value *startupObservationDependencies) {
				value.observeNetworkSnapshot = func(
					uint64,
					listenerIdentity,
					[]tcpEntry,
				) (observedListener, sessionObservation, error) {
					return observedListener{
						Host: "127.0.0.1", Port: 42022, Open: true,
						OwnedByProcess: true,
					}, sessionObservation{Tracked: false}, nil
				}
			},
			code: "startup_session_census_incomplete",
		},
		"census-error": {
			mutate: func(value *startupObservationDependencies) {
				value.allTaskCensus = func() (bool, error) {
					return false, errors.New("census failed")
				}
			},
			code: "startup_children_census_failed",
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			state := testStartupState()
			dependencies := testStartupDependencies(state)
			test.mutate(&dependencies)
			instance := &supervisor{
				state:               state,
				startupDependencies: &dependencies,
			}
			if _, err := instance.initialRunningObservation(state); err == nil ||
				err.Error() != test.code {
				t.Fatalf("unexpected %s result: %v", name, err)
			}
		})
	}

	state := testStartupState()
	dependencies := testStartupDependencies(state)
	dependencies.allTaskCensus = func() (bool, error) {
		return false, nil
	}
	instance := &supervisor{
		state:               state,
		startupDependencies: &dependencies,
	}
	result, err := instance.initialRunningObservation(state)
	if err != nil {
		t.Fatal(err)
	}
	starting, ok := result.(startingResult)
	if !ok || starting.Reason != "children_census_unstable" {
		t.Fatalf("unstable census did not produce its exact transient: %#v", result)
	}
	if state.phase != "go-returned" {
		t.Fatalf("transient startup committed running phase: %s", state.phase)
	}
}

func TestRunningInspectNeverReturnsStarting(t *testing.T) {
	state := testStartupState()
	dependencies := testStartupDependencies(state)
	instance := &supervisor{
		state:               state,
		startupDependencies: &dependencies,
	}
	result, err := instance.initialRunningObservation(state)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := result.(runningResult); !ok {
		t.Fatalf("initial evidence did not establish running: %#v", result)
	}
	dependencies.readTCPTables = func(uint64) ([]tcpEntry, error) {
		return nil, nil
	}
	request := protocolRequest{
		Version:     protocolVersion,
		RequestID:   "running-no-starting",
		Operation:   "inspect",
		Purpose:     "running",
		Token:       state.token,
		RelationID:  state.relationID,
		Generation:  state.generation,
		OperationID: state.startOperationID,
		FenceDigest: strings.Repeat("a", 64),
	}
	observed, _, err := instance.inspect(request)
	if err == nil {
		t.Fatalf("running drift returned %#v", observed)
	}
	if _, ok := observed.(startingResult); ok {
		t.Fatal("running drift regressed to starting")
	}
	if state.phase != "running" {
		t.Fatalf("running phase changed on failed inspect: %s", state.phase)
	}
}

type testCodeError struct {
	code string
}

func (e *testCodeError) Error() string {
	return e.code
}

func spawnWaitTestChild(t *testing.T, delayMilliseconds int) int {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer devNull.Close()
	pid, err := syscall.ForkExec(
		executable,
		[]string{
			executable,
			"-test.run=^TestWaitForSpecificChildDoesNotReapUnrelatedChild$",
		},
		&syscall.ProcAttr{
			Dir: "/",
			Env: append(
				os.Environ(),
				"SFSC_WAIT_TEST_DELAY_MS="+strconv.Itoa(delayMilliseconds),
			),
			Files: []uintptr{devNull.Fd(), devNull.Fd(), devNull.Fd()},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

func reapWaitTestChild(pid int) {
	var status syscall.WaitStatus
	_, _ = syscall.Wait4(pid, &status, 0, nil)
}

func waitForListenerPortState(t *testing.T, port, wantListeners, wantActive int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		entries, err := readTCPTables(uint64(os.Getpid()))
		if err != nil {
			t.Fatal(err)
		}
		listeners := 0
		active := 0
		for _, entry := range entries {
			if entry.LocalPort != port {
				continue
			}
			switch entry.State {
			case "0A":
				listeners++
			case "01":
				active++
			}
		}
		if listeners == wantListeners && active == wantActive {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf(
				"listener port %d state timeout: listeners=%d active=%d want listeners=%d active=%d",
				port,
				listeners,
				active,
				wantListeners,
				wantActive,
			)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func testStartupState() *relationState {
	return &relationState{
		token:            strings.Repeat("a", 32),
		relationID:       "relation-test",
		generation:       "1",
		startOperationID: "operation-start",
		phase:            "go-returned",
		manager: processIdentity{
			PID:       "300",
			StartTime: "200",
		},
		process: processParentIdentity{
			ParentPID:       "300",
			ParentStartTime: "200",
			PID:             "310",
			StartTime:       "210",
		},
		namespace: namespaceIdentity{
			BootID:         "12345678-1234-1234-1234-123456789abc",
			PIDNamespaceID: "pid:[4026532000]",
		},
		launcher: testFileIdentity("11"),
		target:   testFileIdentity("22"),
		listener: listenerIdentity{
			Host: "127.0.0.1",
			Port: 42022,
		},
		helper: &helperProcess{PID: 310},
	}
}

func testStartupDependencies(state *relationState) startupObservationDependencies {
	listenerEntry := tcpEntry{
		LocalAddress:  "0100007F",
		LocalPort:     state.listener.Port,
		RemoteAddress: "00000000",
		RemotePort:    0,
		State:         "0A",
		Inode:         "61",
	}
	return startupObservationDependencies{
		observeProcessPresence: func(processParentIdentity) (processPresence, error) {
			return processExact, nil
		},
		readNamespaceIdentity: func() (namespaceIdentity, error) {
			return state.namespace, nil
		},
		readProcessEnvironmentToken: func(uint64) (string, error) {
			return state.token, nil
		},
		readProcessSecurity: func(uint64) (capabilityObservation, bool, error) {
			return testZeroCapabilities(), true, nil
		},
		readFileIdentity: func(string) (fileIdentity, error) {
			return state.target, nil
		},
		readTCPTables: func(uint64) ([]tcpEntry, error) {
			return []tcpEntry{listenerEntry}, nil
		},
		observeNetworkSnapshot: func(
			uint64,
			listenerIdentity,
			[]tcpEntry,
		) (observedListener, sessionObservation, error) {
			return observedListener{
					Host:           state.listener.Host,
					Port:           state.listener.Port,
					Open:           true,
					OwnedByProcess: true,
					SocketDev:      "50",
					SocketIno:      "61",
				}, sessionObservation{
					Count: 0, Tracked: true, Tuples: []sessionTuple{},
				}, nil
		},
		allTaskCensus: func() (bool, error) {
			return true, nil
		},
		nowTimestamp: func() string {
			return "2026-10-21T12:00:00.000Z"
		},
	}
}

func testZeroCapabilities() capabilityObservation {
	zero := "0000000000000000"
	return capabilityObservation{
		Ambient:     zero,
		Bounding:    zero,
		Effective:   zero,
		Inheritable: zero,
		Permitted:   zero,
	}
}

func testFileIdentity(seed string) fileIdentity {
	return fileIdentity{
		Dev:    seed,
		Ino:    seed + "0",
		Sha256: strings.Repeat(seed, 32),
		Size:   seed + "00",
	}
}
