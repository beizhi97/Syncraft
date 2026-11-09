//go:build linux && (amd64 || arm64)

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	protocolVersion     = 1
	maxFrameBytes       = 1024 * 1024
	prSetPDeathSig      = 0x1
	prSetChildSubreaper = 0x24
)

type supervisorConfig struct {
	execServicePath    string
	signalServicePath  string
	rclonePath         string
	servicePath        string
	serviceUser        string
	rootPath           string
	authorizedKeysPath string
	hostKeyPath        string
}

type serviceV2GuardReady struct {
	Version       int    `json:"version"`
	HelperVersion string `json:"helperVersion"`
	Operation     string `json:"operation"`
	OK            bool   `json:"ok"`
	State         string `json:"state"`
	Token         string `json:"token"`
	PID           string `json:"pid"`
	StartTime     string `json:"starttime"`
	ParentPID     string `json:"parentPid"`
	Service       struct {
		Dev    string `json:"dev"`
		Ino    string `json:"ino"`
		Size   string `json:"size"`
		SHA256 string `json:"sha256"`
	} `json:"service"`
	Listener     listenerIdentity `json:"listener"`
	Capabilities execCapabilities `json:"capabilities"`
}

type protocolRequest struct {
	Version     int              `json:"version"`
	RequestID   string           `json:"requestId"`
	Operation   string           `json:"operation"`
	Purpose     string           `json:"purpose"`
	Mode        string           `json:"mode"`
	Token       string           `json:"token"`
	RelationID  string           `json:"relationId"`
	Generation  string           `json:"generation"`
	OperationID string           `json:"operationId"`
	FenceDigest string           `json:"fenceDigest"`
	Listener    listenerIdentity `json:"listener"`
}

type protocolResponse struct {
	Version   int           `json:"version"`
	RequestID string        `json:"requestId"`
	OK        bool          `json:"ok"`
	Result    any           `json:"result,omitempty"`
	Error     responseError `json:"error,omitempty"`
}

type responseError struct {
	Code string `json:"code"`
}

type execReadyResponse struct {
	Version      int              `json:"version"`
	Operation    string           `json:"operation"`
	OK           bool             `json:"ok"`
	State        string           `json:"state"`
	Token        string           `json:"token"`
	PID          string           `json:"pid"`
	StartTime    string           `json:"starttime"`
	ParentPID    string           `json:"parentPid"`
	Rclone       fileIdentity     `json:"rclone"`
	Listener     listenerIdentity `json:"listener"`
	Capabilities execCapabilities `json:"capabilities"`
}

type execCapabilities struct {
	Effective      string `json:"effective"`
	Permitted      string `json:"permitted"`
	Inheritable    string `json:"inheritable"`
	Bounding       string `json:"bounding"`
	Ambient        string `json:"ambient"`
	NoNewPrivs     bool   `json:"noNewPrivs"`
	ParentDeathSig string `json:"parentDeathSignal"`
}

type preparedResult struct {
	Operation           string                `json:"operation"`
	Phase               string                `json:"phase"`
	Namespace           namespaceIdentity     `json:"namespace"`
	Manager             processIdentity       `json:"manager"`
	Process             processParentIdentity `json:"process"`
	Launcher            fileIdentity          `json:"launcher"`
	Target              fileIdentity          `json:"target"`
	Listener            listenerIdentity      `json:"listener"`
	ListenerOpen        bool                  `json:"listenerOpen"`
	CapabilitiesCleared bool                  `json:"capabilitiesCleared"`
	NoNewPrivs          bool                  `json:"noNewPrivs"`
	ParentDeathSignal   string                `json:"parentDeathSignal"`
}

type goResult struct {
	Operation string `json:"operation"`
	Phase     string `json:"phase"`
}

type runningResult struct {
	Operation         string                `json:"operation"`
	Phase             string                `json:"phase"`
	Namespace         namespaceIdentity     `json:"namespace"`
	Manager           processIdentity       `json:"manager"`
	Process           processParentIdentity `json:"process"`
	Launcher          fileIdentity          `json:"launcher"`
	Target            fileIdentity          `json:"target"`
	Listener          observedListener      `json:"listener"`
	Sessions          sessionObservation    `json:"sessions"`
	Children          childrenObservation   `json:"children"`
	Capabilities      capabilityObservation `json:"capabilities"`
	NoNewPrivs        bool                  `json:"noNewPrivs"`
	ParentDeathSignal string                `json:"parentDeathSignal"`
	ObservedAt        string                `json:"observedAt"`
}

type startingResult struct {
	Operation          string                `json:"operation"`
	Phase              string                `json:"phase"`
	Manager            processIdentity       `json:"manager"`
	Namespace          namespaceIdentity     `json:"namespace"`
	Process            processParentIdentity `json:"process"`
	ObservedExecutable fileIdentity          `json:"observedExecutable"`
	Reason             string                `json:"reason"`
	ObservedAt         string                `json:"observedAt"`
}

type stoppedResult struct {
	Operation      string                `json:"operation"`
	Phase          string                `json:"phase"`
	Manager        processIdentity       `json:"manager"`
	Process        processParentIdentity `json:"process"`
	ProcessExited  bool                  `json:"processExited"`
	ListenerClosed bool                  `json:"listenerClosed"`
	SessionsClosed bool                  `json:"sessionsClosed"`
	ChildrenExited bool                  `json:"childrenExited"`
	ObservedAt     string                `json:"observedAt"`
}

type cleanupResult struct {
	Operation            string                `json:"operation"`
	Phase                string                `json:"phase"`
	Manager              processIdentity       `json:"manager"`
	Process              processParentIdentity `json:"process"`
	ProcessExited        bool                  `json:"processExited"`
	ListenerClosed       bool                  `json:"listenerClosed"`
	SessionsClosed       bool                  `json:"sessionsClosed"`
	ChildrenExited       bool                  `json:"childrenExited"`
	ContainmentConfirmed bool                  `json:"containmentConfirmed"`
	ObservedAt           string                `json:"observedAt"`
}

type releaseResult struct {
	Operation string `json:"operation"`
	Phase     string `json:"phase"`
}

type relationState struct {
	token              string
	relationID         string
	generation         string
	startOperationID   string
	disableOperationID string
	closureOperationID string
	closureFenceDigest string
	phase              string
	manager            processIdentity
	process            processParentIdentity
	namespace          namespaceIdentity
	launcher           fileIdentity
	target             fileIdentity
	listener           listenerIdentity
	helper             *helperProcess
	goReturned         bool
	sessionTuples      []sessionTuple
	sessionCensusKnown bool
	cleanupRequested   bool
	childrenExited     bool
	processExited      bool
	listenerClosed     bool
	sessionsClosed     bool
}

type supervisor struct {
	config              supervisorConfig
	self                procStat
	state               *relationState
	startupDependencies *startupObservationDependencies
}

type startupObservationDependencies struct {
	observeProcessPresence      func(processParentIdentity) (processPresence, error)
	readNamespaceIdentity       func() (namespaceIdentity, error)
	readProcessEnvironmentToken func(uint64) (string, error)
	readProcessSecurity         func(uint64) (capabilityObservation, bool, error)
	readFileIdentity            func(string) (fileIdentity, error)
	readTCPTables               func(uint64) ([]tcpEntry, error)
	observeNetworkSnapshot      func(uint64, listenerIdentity, []tcpEntry) (observedListener, sessionObservation, error)
	allTaskCensus               func() (bool, error)
	nowTimestamp                func() string
}

type commonStartupEvidence struct {
	namespace    namespaceIdentity
	executable   fileIdentity
	capabilities capabilityObservation
	noNewPrivs   bool
}

func main() {
	config, err := parseConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := setParentDeathSignal(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if _, _, errno := syscall.RawSyscall6(
		syscall.SYS_PRCTL,
		prSetChildSubreaper,
		1,
		0,
		0,
		0,
		0,
	); errno != 0 {
		fmt.Fprintln(os.Stderr, "subreaper_failed")
		os.Exit(2)
	}
	self, err := readProcStat(uint64(os.Getpid()))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	requests := make(chan protocolRequest)
	readErrors := make(chan error, 1)
	go readRequests(os.Stdin, requests, readErrors)
	instance := &supervisor{
		config: config,
		self:   self,
	}
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()
	for {
		var request protocolRequest
		select {
		case request = <-requests:
		case err := <-readErrors:
			if errors.Is(err, io.EOF) {
				os.Exit(2)
			}
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		result, exit, handleErr := instance.handle(request)
		response := protocolResponse{
			Version:   protocolVersion,
			RequestID: request.RequestID,
			OK:        handleErr == nil,
			Result:    result,
		}
		if handleErr != nil {
			response.Error = responseError{Code: stableErrorCode(handleErr)}
		}
		data, err := json.Marshal(response)
		if err != nil {
			os.Exit(2)
		}
		if _, err := writer.Write(append(data, '\n')); err != nil {
			os.Exit(2)
		}
		if err := writer.Flush(); err != nil {
			os.Exit(2)
		}
		if exit {
			os.Exit(0)
		}
	}
}

func (s *supervisor) handle(request protocolRequest) (any, bool, error) {
	if request.Version != protocolVersion || !validRequestID(request.RequestID) {
		return nil, false, errors.New("request_invalid")
	}
	if s.state != nil && s.state.childrenExited &&
		request.Operation != "inspect" && request.Operation != "release" {
		return nil, false, errors.New("supervisor_closed")
	}
	switch request.Operation {
	case "prepare":
		return s.prepare(request)
	case "go":
		return s.goReady(request)
	case "inspect":
		return s.inspect(request)
	case "cleanup":
		return s.cleanup(request)
	case "release":
		return s.release(request)
	default:
		return nil, false, errors.New("operation_invalid")
	}
}

func (s *supervisor) prepare(request protocolRequest) (any, bool, error) {
	if s.state != nil {
		return nil, false, errors.New("relation_already_prepared")
	}
	if !validToken(request.Token) ||
		!validIdentity(request.RelationID) ||
		!validCanonicalDecimal(request.Generation) ||
		!validIdentity(request.OperationID) ||
		!validDigest(request.FenceDigest) ||
		request.Listener.Host != "127.0.0.1" ||
		request.Listener.Port < 1 || request.Listener.Port > 65535 {
		return nil, false, errors.New("prepare_request_invalid")
	}
	namespace, err := readNamespaceIdentity()
	if err != nil {
		return nil, false, err
	}
	manager := identityFromStat(s.self)
	launcher, err := readFileIdentity(s.config.execServicePath)
	if err != nil {
		return nil, false, err
	}
	targetPath := s.config.rclonePath
	if s.config.servicePath != "" {
		targetPath = s.config.servicePath
	}
	target, err := readFileIdentity(targetPath)
	if err != nil {
		return nil, false, err
	}
	var helper *helperProcess
	if s.config.servicePath != "" {
		helper, err = startHelperV2(s.config.execServicePath, s.config.servicePath, s.config.rootPath, s.config.authorizedKeysPath, s.config.hostKeyPath, s.config.serviceUser, request.Listener, request.Token, manager)
	} else {
		helper, err = startHelper(
			s.config.execServicePath,
			s.config.rclonePath,
			s.config.rootPath,
			s.config.authorizedKeysPath,
			s.config.hostKeyPath,
			request.Listener,
			request.Token,
			manager,
		)
	}
	if err != nil {
		return nil, false, err
	}
	readyMap, err := readHelperReady(helper, 5*time.Second)
	if err != nil {
		return nil, false, cleanupPreparedHelper(helper, err)
	}
	data, _ := json.Marshal(readyMap)
	var ready execReadyResponse
	if s.config.servicePath != "" {
		var v2 serviceV2GuardReady
		if err := json.Unmarshal(data, &v2); err != nil || v2.Version != 2 || v2.Operation != "exec-service-v2" || !v2.OK || v2.State != "ready" || v2.Token != request.Token || v2.PID != strconv.FormatUint(helper.PID, 10) || v2.StartTime != strconv.FormatUint(helper.Start.StartTime, 10) || v2.ParentPID != manager.PID || v2.Service.Dev != target.Dev || v2.Service.Ino != target.Ino || v2.Service.Size != target.Size || v2.Service.SHA256 != fileSHA256(targetPath) || v2.Listener != request.Listener || !v2.Capabilities.NoNewPrivs || v2.Capabilities.ParentDeathSig != "SIGKILL" {
			return nil, false, cleanupPreparedHelper(helper, errors.New("helper_ready_invalid"))
		}
		ready = execReadyResponse{Version: protocolVersion, Operation: "exec-service-v2", OK: true, State: "ready", Token: request.Token, PID: v2.PID, StartTime: v2.StartTime, ParentPID: v2.ParentPID, Rclone: target, Listener: v2.Listener, Capabilities: v2.Capabilities}
	} else if err := json.Unmarshal(data, &ready); err != nil {
		return nil, false, cleanupPreparedHelper(helper, err)
	}
	wantOperation := "exec-service"
	if s.config.servicePath != "" {
		wantOperation = "exec-service-v2"
	}
	if ready.Version != protocolVersion || ready.Operation != wantOperation ||
		!ready.OK || ready.State != "ready" || ready.Token != request.Token ||
		ready.PID != strconv.FormatUint(helper.PID, 10) ||
		ready.StartTime != strconv.FormatUint(helper.Start.StartTime, 10) ||
		ready.ParentPID != manager.PID ||
		ready.Rclone != target || ready.Listener != request.Listener ||
		ready.Capabilities.NoNewPrivs != true ||
		ready.Capabilities.ParentDeathSig != "SIGKILL" {
		return nil, false, cleanupPreparedHelper(helper, errors.New("helper_ready_invalid"))
	}
	process := parentIdentityFromStats(s.self, helper.Start)
	observed, sessions, networkErr := observeNetwork(helper.PID, request.Listener)
	if networkErr != nil || observed.Open || sessions.Count != 0 {
		return nil, false, cleanupPreparedHelper(helper, errors.New("prepared_listener_unexpected"))
	}
	capabilities, noNewPrivs, err := readProcessSecurity(helper.PID)
	if err != nil || !isZeroCapabilities(capabilities) || !noNewPrivs {
		return nil, false, cleanupPreparedHelper(helper, errors.New("helper_security_invalid"))
	}
	s.state = &relationState{
		token:            request.Token,
		relationID:       request.RelationID,
		generation:       request.Generation,
		startOperationID: request.OperationID,
		phase:            "prepared",
		manager:          manager,
		process:          process,
		namespace:        namespace,
		launcher:         launcher,
		target:           target,
		listener:         request.Listener,
		helper:           helper,
	}
	return preparedResult{
		Operation:           "prepare",
		Phase:               "prepared",
		Namespace:           namespace,
		Manager:             manager,
		Process:             process,
		Launcher:            launcher,
		Target:              target,
		Listener:            request.Listener,
		ListenerOpen:        false,
		CapabilitiesCleared: true,
		NoNewPrivs:          true,
		ParentDeathSignal:   "SIGKILL",
	}, false, nil
}

func cleanupPreparedHelper(helper *helperProcess, cause error) error {
	if err := terminateHelper(helper); err != nil {
		return errors.New("helper_cleanup_failed")
	}
	return cause
}

func (s *supervisor) goReady(request protocolRequest) (any, bool, error) {
	state, err := s.requireState(request.Token)
	if err != nil {
		return nil, false, err
	}
	if request.RelationID != state.relationID ||
		request.Generation != state.generation ||
		request.OperationID != state.startOperationID ||
		!validDigest(request.FenceDigest) {
		return nil, false, errors.New("go_fence_mismatch")
	}
	if state.phase != "prepared" {
		return nil, false, errors.New("go_state_invalid")
	}
	if err := sendHelperGo(state.helper, state.token); err != nil {
		return nil, false, err
	}
	state.phase = "go-returned"
	state.goReturned = true
	return goResult{Operation: "go", Phase: "go-returned"}, false, nil
}

func (s *supervisor) inspect(request protocolRequest) (any, bool, error) {
	state, err := s.requireState(request.Token)
	if err != nil {
		return nil, false, err
	}
	if request.RelationID != state.relationID ||
		request.Generation != state.generation ||
		!validIdentity(request.OperationID) ||
		!validDigest(request.FenceDigest) {
		return nil, false, errors.New("inspect_fence_mismatch")
	}
	if request.Purpose != "running" && request.Purpose != "disable" && request.Purpose != "cleanup" {
		return nil, false, errors.New("inspect_purpose_invalid")
	}
	if request.Purpose == "disable" {
		if state.disableOperationID == "" {
			state.disableOperationID = request.OperationID
		} else if state.disableOperationID != request.OperationID {
			return nil, false, errors.New("disable_fence_mismatch")
		}
	} else if request.OperationID != state.startOperationID {
		return nil, false, errors.New("inspect_fence_mismatch")
	}
	if state.childrenExited {
		return s.stoppedObservation(state), false, nil
	}
	if state.phase != "prepared" && state.phase != "go-returned" && state.phase != "running" {
		return nil, false, errors.New("inspect_state_invalid")
	}
	if request.Purpose == "running" {
		if state.phase == "go-returned" {
			observed, err := s.initialRunningObservation(state)
			return observed, false, err
		}
		if state.phase != "running" {
			return nil, false, errors.New("inspect_state_invalid")
		}
		observed, err := s.runningObservation(state)
		return observed, false, err
	}
	if request.Purpose == "disable" {
		if observed, err := s.runningObservation(state); err == nil {
			return observed, false, nil
		}
	}
	if request.Purpose == "cleanup" {
		return cleanupResult{
			Operation:            "inspect",
			Phase:                "unconfirmed",
			Manager:              state.manager,
			Process:              state.process,
			ProcessExited:        state.processExited,
			ListenerClosed:       state.listenerClosed,
			SessionsClosed:       state.sessionsClosed,
			ChildrenExited:       false,
			ContainmentConfirmed: false,
			ObservedAt:           nowTimestamp(),
		}, false, nil
	}
	return nil, false, errors.New("inspect_unconfirmed")
}

func (s *supervisor) cleanup(request protocolRequest) (any, bool, error) {
	state, err := s.requireState(request.Token)
	if err != nil {
		return nil, false, err
	}
	if request.RelationID != state.relationID ||
		request.Generation != state.generation ||
		!validIdentity(request.OperationID) ||
		!validDigest(request.FenceDigest) {
		return nil, false, errors.New("cleanup_fence_mismatch")
	}
	if request.Mode != "abort" && request.Mode != "stop" {
		return nil, false, errors.New("cleanup_mode_invalid")
	}
	expectedOperationID := state.startOperationID
	if request.Mode == "stop" {
		expectedOperationID = state.disableOperationID
	}
	if expectedOperationID == "" || request.OperationID != expectedOperationID {
		return nil, false, errors.New("cleanup_fence_mismatch")
	}
	if state.childrenExited {
		if state.closureOperationID != "" && request.OperationID != state.closureOperationID {
			return nil, false, errors.New("cleanup_fence_mismatch")
		}
		return cleanupResult{
			Operation:      "cleanup",
			Phase:          "closed",
			Manager:        state.manager,
			Process:        state.process,
			ProcessExited:  state.processExited,
			ListenerClosed: state.listenerClosed,
			SessionsClosed: state.sessionsClosed,
			ChildrenExited: state.childrenExited,
			ContainmentConfirmed: state.processExited && state.listenerClosed &&
				state.sessionsClosed && state.childrenExited,
			ObservedAt: nowTimestamp(),
		}, false, nil
	}
	state.cleanupRequested = true
	state.sessionCensusKnown = false
	if observed, sessions, observeErr := observeNetwork(
		state.helper.PID,
		state.listener,
	); observeErr == nil && sessions.Tracked {
		state.sessionTuples = append([]sessionTuple(nil), sessions.Tuples...)
		state.sessionCensusKnown = true
		_ = observed
	}
	if err := s.stopExactProcess(state, syscall.SIGTERM); err != nil {
		return nil, false, err
	}
	exited, err := waitForExactProcessExit(state.process, 750*time.Millisecond)
	if err != nil {
		return nil, false, err
	}
	if !exited {
		if err := s.stopExactProcess(state, syscall.SIGKILL); err != nil {
			return nil, false, err
		}
		exited, err = waitForExactProcessExit(state.process, 2*time.Second)
		if err != nil {
			return nil, false, err
		}
		if !exited {
			return nil, false, errors.New("process_wait_timeout")
		}
	}
	if err := waitForHelperExit(state.helper.PID, 5*time.Second); err != nil {
		return nil, false, err
	}
	closeFiles(state.helper.Stdin, state.helper.Stdout, state.helper.Stderr)
	state.helper.Stdin = nil
	state.helper.Stdout = nil
	state.helper.Stderr = nil
	childrenExited, err := drainAdoptedChildren(8 * time.Second)
	if err != nil {
		return nil, false, err
	}
	if !childrenExited {
		return nil, false, errors.New("children_wait_timeout")
	}
	state.childrenExited = true
	state.closureOperationID = request.OperationID
	state.closureFenceDigest = request.FenceDigest
	state.processExited = true
	state.listenerClosed, err = listenerClosed(state.helper.PID, state.listener)
	if err != nil {
		return nil, false, err
	}
	state.sessionsClosed = false
	if sessionsClosed, censusErr := sessionClosureAfterCleanup(
		state.sessionCensusKnown,
		state.sessionTuples,
	); censusErr == nil {
		state.sessionsClosed = sessionsClosed
	}
	state.phase = "closed"
	return cleanupResult{
		Operation:      "cleanup",
		Phase:          "closed",
		Manager:        state.manager,
		Process:        state.process,
		ProcessExited:  state.processExited,
		ListenerClosed: state.listenerClosed,
		SessionsClosed: state.sessionsClosed,
		ChildrenExited: state.childrenExited,
		ContainmentConfirmed: state.processExited && state.listenerClosed &&
			state.sessionsClosed && state.childrenExited,
		ObservedAt: nowTimestamp(),
	}, false, nil
}

func (s *supervisor) release(request protocolRequest) (any, bool, error) {
	state, err := s.requireState(request.Token)
	if err != nil {
		return nil, false, err
	}
	if request.RelationID != state.relationID ||
		request.Generation != state.generation ||
		request.OperationID != state.closureOperationID ||
		request.FenceDigest != state.closureFenceDigest ||
		state.closureOperationID == "" ||
		state.closureFenceDigest == "" {
		return nil, false, errors.New("release_fence_mismatch")
	}
	if !state.childrenExited || state.phase != "closed" {
		return nil, false, errors.New("release_before_closure")
	}
	state.phase = "released"
	return releaseResult{Operation: "release", Phase: "releasing"}, true, nil
}

func (s *supervisor) initialRunningObservation(state *relationState) (any, error) {
	if state.phase != "go-returned" {
		return nil, errors.New("inspect_state_invalid")
	}
	dependencies := s.startupObservationDependencies()
	common, err := observeCommonStartupEvidence(state, dependencies)
	if err != nil {
		return nil, err
	}
	if common.executable == state.launcher {
		return startupObservation(
			state,
			common,
			state.launcher,
			"launcher_exact",
			dependencies.nowTimestamp,
		), nil
	}
	if common.executable != state.target {
		return nil, errors.New("target_executable_mismatch")
	}
	pid, ok := parseCanonicalDecimal(state.process.PID)
	if !ok || pid == 0 {
		return nil, errors.New("process_pid_invalid")
	}
	entries, err := dependencies.readTCPTables(pid)
	if err != nil {
		return nil, errors.New("startup_listener_observation_failed")
	}
	count := listenerEntryCount(entries, state.listener)
	if count == 0 {
		return startupObservation(
			state,
			common,
			state.target,
			"listener_absent",
			dependencies.nowTimestamp,
		), nil
	}
	if count > 1 {
		return nil, errors.New("startup_listener_ambiguous")
	}
	listener, sessions, err := dependencies.observeNetworkSnapshot(
		pid,
		state.listener,
		entries,
	)
	if err != nil {
		return nil, errors.New("startup_listener_observation_failed")
	}
	if !listener.Open || !listener.OwnedByProcess {
		return nil, errors.New("startup_listener_not_owned")
	}
	if !sessions.Tracked {
		return nil, errors.New("startup_session_census_incomplete")
	}
	allTracked, err := dependencies.allTaskCensus()
	if err != nil {
		return nil, errors.New("startup_children_census_failed")
	}
	if !allTracked {
		return startupObservation(
			state,
			common,
			state.target,
			"children_census_unstable",
			dependencies.nowTimestamp,
		), nil
	}
	return commitRunningObservation(
		state,
		common,
		listener,
		sessions,
		allTracked,
		dependencies.nowTimestamp,
	), nil
}

func (s *supervisor) runningObservation(state *relationState) (runningResult, error) {
	dependencies := s.startupObservationDependencies()
	common, err := observeCommonStartupEvidence(state, dependencies)
	if err != nil {
		return runningResult{}, err
	}
	if common.executable != state.target {
		return runningResult{}, errors.New("target_executable_mismatch")
	}
	pid, ok := parseCanonicalDecimal(state.process.PID)
	if !ok || pid == 0 {
		return runningResult{}, errors.New("process_pid_invalid")
	}
	entries, err := dependencies.readTCPTables(pid)
	if err != nil {
		return runningResult{}, errors.New("target_listener_observation_failed")
	}
	count := listenerEntryCount(entries, state.listener)
	if count == 0 {
		return runningResult{}, errors.New("target_listener_absent")
	}
	if count > 1 {
		return runningResult{}, errors.New("startup_listener_ambiguous")
	}
	listener, sessions, err := dependencies.observeNetworkSnapshot(
		pid,
		state.listener,
		entries,
	)
	if err != nil {
		return runningResult{}, errors.New("target_listener_observation_failed")
	}
	if !listener.Open || !listener.OwnedByProcess {
		return runningResult{}, errors.New("startup_listener_not_owned")
	}
	if !sessions.Tracked {
		return runningResult{}, errors.New("startup_session_census_incomplete")
	}
	allTracked, err := dependencies.allTaskCensus()
	if err != nil || !allTracked {
		return runningResult{}, errors.New("children_census_unstable")
	}
	return commitRunningObservation(
		state,
		common,
		listener,
		sessions,
		allTracked,
		dependencies.nowTimestamp,
	), nil
}

func (s *supervisor) startupObservationDependencies() startupObservationDependencies {
	dependencies := startupObservationDependencies{}
	if s.startupDependencies != nil {
		dependencies = *s.startupDependencies
	}
	if dependencies.observeProcessPresence == nil {
		dependencies.observeProcessPresence = observeProcessPresence
	}
	if dependencies.readNamespaceIdentity == nil {
		dependencies.readNamespaceIdentity = readNamespaceIdentity
	}
	if dependencies.readProcessEnvironmentToken == nil {
		dependencies.readProcessEnvironmentToken = readProcessEnvironmentToken
	}
	if dependencies.readProcessSecurity == nil {
		dependencies.readProcessSecurity = readProcessSecurity
	}
	if dependencies.readFileIdentity == nil {
		dependencies.readFileIdentity = readFileIdentity
	}
	if dependencies.readTCPTables == nil {
		dependencies.readTCPTables = readTCPTables
	}
	if dependencies.observeNetworkSnapshot == nil {
		dependencies.observeNetworkSnapshot = observeNetworkSnapshot
	}
	if dependencies.allTaskCensus == nil {
		dependencies.allTaskCensus = allTaskCensus
	}
	if dependencies.nowTimestamp == nil {
		dependencies.nowTimestamp = nowTimestamp
	}
	return dependencies
}

func observeCommonStartupEvidence(
	state *relationState,
	dependencies startupObservationDependencies,
) (commonStartupEvidence, error) {
	presence, err := dependencies.observeProcessPresence(state.process)
	if err != nil || presence != processExact {
		return commonStartupEvidence{}, errors.New("startup_process_not_exact")
	}
	namespace, err := dependencies.readNamespaceIdentity()
	if err != nil || namespace != state.namespace {
		return commonStartupEvidence{}, errors.New("startup_namespace_mismatch")
	}
	pid, ok := parseCanonicalDecimal(state.process.PID)
	if !ok || pid == 0 {
		return commonStartupEvidence{}, errors.New("process_pid_invalid")
	}
	token, err := dependencies.readProcessEnvironmentToken(pid)
	if err != nil || token != state.token {
		return commonStartupEvidence{}, errors.New("startup_token_mismatch")
	}
	capabilities, noNewPrivs, err := dependencies.readProcessSecurity(pid)
	if err != nil || !isZeroCapabilities(capabilities) || !noNewPrivs {
		return commonStartupEvidence{}, errors.New("startup_security_invalid")
	}
	executable, err := dependencies.readFileIdentity(
		fmt.Sprintf("/proc/%d/exe", pid),
	)
	if err != nil {
		return commonStartupEvidence{}, errors.New("startup_executable_read_failed")
	}
	return commonStartupEvidence{
		namespace:    namespace,
		executable:   executable,
		capabilities: capabilities,
		noNewPrivs:   noNewPrivs,
	}, nil
}

func startupObservation(
	state *relationState,
	common commonStartupEvidence,
	executable fileIdentity,
	reason string,
	timestamp func() string,
) startingResult {
	return startingResult{
		Operation:          "inspect",
		Phase:              "starting",
		Manager:            state.manager,
		Namespace:          common.namespace,
		Process:            state.process,
		ObservedExecutable: executable,
		Reason:             reason,
		ObservedAt:         timestamp(),
	}
}

func commitRunningObservation(
	state *relationState,
	common commonStartupEvidence,
	listener observedListener,
	sessions sessionObservation,
	allTracked bool,
	timestamp func() string,
) runningResult {
	state.phase = "running"
	state.sessionTuples = append([]sessionTuple(nil), sessions.Tuples...)
	state.sessionCensusKnown = sessions.Tracked
	return runningResult{
		Operation:         "inspect",
		Phase:             "running",
		Namespace:         common.namespace,
		Manager:           state.manager,
		Process:           state.process,
		Launcher:          state.launcher,
		Target:            state.target,
		Listener:          listener,
		Sessions:          sessions,
		Children:          childrenObservation{AllTracked: allTracked},
		Capabilities:      common.capabilities,
		NoNewPrivs:        common.noNewPrivs,
		ParentDeathSignal: "SIGKILL",
		ObservedAt:        timestamp(),
	}
}

func (s *supervisor) stoppedObservation(state *relationState) stoppedResult {
	return stoppedResult{
		Operation:      "inspect",
		Phase:          "stopped",
		Manager:        state.manager,
		Process:        state.process,
		ProcessExited:  state.processExited,
		ListenerClosed: state.listenerClosed,
		SessionsClosed: state.sessionsClosed,
		ChildrenExited: state.childrenExited,
		ObservedAt:     nowTimestamp(),
	}
}

func (s *supervisor) stopExactProcess(state *relationState, signal syscall.Signal) error {
	presence, err := observeProcessPresence(state.process)
	if err != nil {
		return err
	}
	if presence == processGone {
		return nil
	}
	if presence != processExact {
		return errors.New("process_not_exact")
	}
	signalName := "SIGTERM"
	if signal == syscall.SIGKILL {
		signalName = "SIGKILL"
	}
	return sendExactSignal(
		s.config.signalServicePath,
		signalName,
		state.namespace,
		state.manager,
		state.process,
		state.token,
		state.launcher,
		state.target,
		5*time.Second,
	)
}

func waitForExactProcessExit(
	identity processParentIdentity,
	timeout time.Duration,
) (bool, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		presence, err := observeProcessPresence(identity)
		if err != nil {
			return false, err
		}
		if presence == processGone {
			return true, nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	presence, err := observeProcessPresence(identity)
	if err != nil {
		return false, err
	}
	return presence == processGone, nil
}

func (s *supervisor) requireState(token string) (*relationState, error) {
	if s.state == nil || token == "" || token != s.state.token {
		return nil, errors.New("runtime_token_unknown")
	}
	return s.state, nil
}

func isZeroCapabilities(caps capabilityObservation) bool {
	for _, value := range []string{
		caps.Ambient,
		caps.Bounding,
		caps.Effective,
		caps.Inheritable,
		caps.Permitted,
	} {
		if value != "0000000000000000" {
			return false
		}
	}
	return true
}

func parseConfig(args []string) (supervisorConfig, error) {
	flags := flag.NewFlagSet("sfsc-relation-supervisor", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	config := supervisorConfig{}
	flags.StringVar(&config.execServicePath, "exec-service", "", "")
	flags.StringVar(&config.signalServicePath, "signal-service", "", "")
	flags.StringVar(&config.rclonePath, "rclone", "", "")
	flags.StringVar(&config.servicePath, "service", "", "")
	flags.StringVar(&config.serviceUser, "user", "", "")
	flags.StringVar(&config.rootPath, "root", "", "")
	flags.StringVar(&config.authorizedKeysPath, "authorized-keys", "", "")
	flags.StringVar(&config.hostKeyPath, "host-key", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return supervisorConfig{}, errors.New("config_invalid")
	}
	for _, value := range []string{
		config.execServicePath,
		config.signalServicePath,
		config.rootPath,
		config.authorizedKeysPath,
		config.hostKeyPath,
	} {
		if !filepath.IsAbs(value) {
			return supervisorConfig{}, errors.New("config_path_invalid")
		}
	}
	if (config.servicePath == "") == (config.rclonePath == "") {
		return supervisorConfig{}, errors.New("target_mode_invalid")
	}
	if config.servicePath != "" {
		if !filepath.IsAbs(config.servicePath) || !validServiceV2Username(config.serviceUser) {
			return supervisorConfig{}, errors.New("service_config_invalid")
		}
	} else if config.serviceUser != "" || !filepath.IsAbs(config.rclonePath) {
		return supervisorConfig{}, errors.New("service_config_invalid")
	}
	return config, nil
}

func readRequests(reader io.Reader, requests chan<- protocolRequest, failures chan<- error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maxFrameBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 || !utf8.Valid(line) {
			failures <- errors.New("request_invalid")
			return
		}
		decoder := json.NewDecoder(strings.NewReader(string(line)))
		decoder.DisallowUnknownFields()
		var request protocolRequest
		if err := decoder.Decode(&request); err != nil {
			failures <- errors.New("request_invalid")
			return
		}
		if err := ensureJSONEOF(decoder); err != nil {
			failures <- errors.New("request_invalid")
			return
		}
		requests <- request
	}
	if err := scanner.Err(); err != nil {
		failures <- err
		return
	}
	failures <- io.EOF
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("trailing_json")
	}
	return nil
}

func setParentDeathSignal() error {
	parent := os.Getppid()
	if parent <= 0 {
		return errors.New("parent_missing")
	}
	if _, _, errno := syscall.RawSyscall6(
		syscall.SYS_PRCTL,
		prSetPDeathSig,
		uintptr(syscall.SIGKILL),
		0,
		0,
		0,
		0,
	); errno != 0 {
		return errors.New("parent_death_signal_failed")
	}
	if os.Getppid() != parent {
		return errors.New("parent_changed")
	}
	return nil
}

func validRequestID(value string) bool {
	return value != "" && len(value) <= 256 && !strings.ContainsAny(value, "\r\n\x00")
}

func validIdentity(value string) bool {
	if value == "" || len(value) > 256 {
		return false
	}
	first := value[0]
	if !((first >= 'A' && first <= 'Z') ||
		(first >= 'a' && first <= 'z') ||
		(first >= '0' && first <= '9')) {
		return false
	}
	for _, char := range value {
		if !((char >= 'A' && char <= 'Z') ||
			(char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') ||
			char == '.' || char == '_' || char == ':' || char == '-') {
			return false
		}
	}
	return true
}

func validCanonicalDecimal(value string) bool {
	_, ok := parseCanonicalDecimal(value)
	return ok
}

func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}

func nowTimestamp() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func stableErrorCode(err error) string {
	text := err.Error()
	if text == "" || len(text) > 128 || strings.ContainsAny(text, "\r\n\x00") {
		return "runtime_error"
	}
	for _, char := range text {
		if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '_') {
			return "runtime_error"
		}
	}
	return text
}
