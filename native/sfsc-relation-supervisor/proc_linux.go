//go:build linux && (amd64 || arm64)

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type processIdentity struct {
	PID       string `json:"pid"`
	StartTime string `json:"starttime"`
}

type processParentIdentity struct {
	ParentPID       string `json:"parentPid"`
	ParentStartTime string `json:"parentStarttime"`
	PID             string `json:"pid"`
	StartTime       string `json:"starttime"`
}

type fileIdentity struct {
	Dev    string `json:"dev"`
	Ino    string `json:"ino"`
	Sha256 string `json:"sha256"`
	Size   string `json:"size"`
}

type namespaceIdentity struct {
	BootID         string `json:"bootId"`
	PIDNamespaceID string `json:"pidNamespaceId"`
}

type listenerIdentity struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type observedListener struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Open           bool   `json:"open"`
	OwnedByProcess bool   `json:"ownedByProcess"`
	SocketDev      string `json:"socketDev"`
	SocketIno      string `json:"socketIno"`
}

type sessionTuple struct {
	LocalAddress  string `json:"localAddress"`
	LocalPort     int    `json:"localPort"`
	RemoteAddress string `json:"remoteAddress"`
	RemotePort    int    `json:"remotePort"`
	Inode         string `json:"inode"`
}

type sessionObservation struct {
	Count   int            `json:"count"`
	Tracked bool           `json:"tracked"`
	Tuples  []sessionTuple `json:"tuples"`
}

type childrenObservation struct {
	AllTracked bool `json:"allTracked"`
}

type capabilityObservation struct {
	Ambient     string `json:"ambient"`
	Bounding    string `json:"bounding"`
	Effective   string `json:"effective"`
	Inheritable string `json:"inheritable"`
	Permitted   string `json:"permitted"`
}

type procStat struct {
	PID       uint64
	PPID      uint64
	StartTime uint64
	State     string
}

type tcpEntry struct {
	LocalAddress  string
	LocalPort     int
	RemoteAddress string
	RemotePort    int
	State         string
	Inode         string
}

type processPresence uint8

const (
	processUnknown processPresence = iota
	processExact
	processGone
)

func readProcStat(pid uint64) (procStat, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return procStat{}, err
	}
	closeIndex := strings.LastIndexByte(string(data), ')')
	if closeIndex < 0 || closeIndex+2 >= len(data) {
		return procStat{}, errors.New("proc_stat_invalid")
	}
	fields := strings.Fields(string(data[closeIndex+2:]))
	if len(fields) < 20 {
		return procStat{}, errors.New("proc_stat_short")
	}
	startTime, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || startTime == 0 {
		return procStat{}, errors.New("proc_starttime_invalid")
	}
	ppid, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return procStat{}, errors.New("proc_ppid_invalid")
	}
	return procStat{
		PID:       pid,
		PPID:      ppid,
		StartTime: startTime,
		State:     fields[0],
	}, nil
}

func identityFromStat(stat procStat) processIdentity {
	return processIdentity{
		PID:       strconv.FormatUint(stat.PID, 10),
		StartTime: strconv.FormatUint(stat.StartTime, 10),
	}
}

func parentIdentityFromStats(parent, child procStat) processParentIdentity {
	return processParentIdentity{
		ParentPID:       strconv.FormatUint(parent.PID, 10),
		ParentStartTime: strconv.FormatUint(parent.StartTime, 10),
		PID:             strconv.FormatUint(child.PID, 10),
		StartTime:       strconv.FormatUint(child.StartTime, 10),
	}
}

func verifyProcessIdentity(expected processParentIdentity) (procStat, error) {
	pid, ok := parseCanonicalDecimal(expected.PID)
	if !ok || pid == 0 {
		return procStat{}, errors.New("process_pid_invalid")
	}
	stat, err := readProcStat(pid)
	if err != nil {
		return procStat{}, err
	}
	parentPID, ok := parseCanonicalDecimal(expected.ParentPID)
	if !ok || stat.PPID != parentPID {
		return procStat{}, errors.New("process_parent_mismatch")
	}
	startTime, ok := parseCanonicalDecimal(expected.StartTime)
	if !ok || stat.StartTime != startTime {
		return procStat{}, errors.New("process_starttime_mismatch")
	}
	parentStat, err := readProcStat(parentPID)
	if err != nil {
		return procStat{}, err
	}
	parentStartTime, ok := parseCanonicalDecimal(expected.ParentStartTime)
	if !ok || parentStat.StartTime != parentStartTime {
		return procStat{}, errors.New("parent_starttime_mismatch")
	}
	return stat, nil
}

func observeProcessPresence(expected processParentIdentity) (processPresence, error) {
	pid, ok := parseCanonicalDecimal(expected.PID)
	if !ok || pid == 0 {
		return processUnknown, errors.New("process_pid_invalid")
	}
	startTime, ok := parseCanonicalDecimal(expected.StartTime)
	if !ok {
		return processUnknown, errors.New("process_starttime_invalid")
	}
	parentPID, ok := parseCanonicalDecimal(expected.ParentPID)
	if !ok || parentPID == 0 {
		return processUnknown, errors.New("process_parent_pid_invalid")
	}
	parentStartTime, ok := parseCanonicalDecimal(expected.ParentStartTime)
	if !ok {
		return processUnknown, errors.New("parent_starttime_invalid")
	}
	stat, err := readProcStat(pid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return processGone, nil
		}
		return processUnknown, err
	}
	if stat.StartTime != startTime || stat.State == "Z" || stat.State == "X" {
		return processGone, nil
	}
	if stat.PPID != parentPID {
		return processUnknown, errors.New("process_parent_mismatch")
	}
	parentStat, err := readProcStat(parentPID)
	if err != nil {
		return processUnknown, err
	}
	if parentStat.StartTime != parentStartTime {
		return processUnknown, errors.New("parent_starttime_mismatch")
	}
	return processExact, nil
}

func readFileIdentity(path string) (fileIdentity, error) {
	file, err := os.Open(path)
	if err != nil {
		return fileIdentity{}, err
	}
	defer file.Close()
	return readOpenFileIdentity(file, nil)
}

func readOpenFileIdentity(
	file *os.File,
	afterHash func(),
) (fileIdentity, error) {
	beforeInfo, err := file.Stat()
	if err != nil {
		return fileIdentity{}, err
	}
	if !beforeInfo.Mode().IsRegular() || beforeInfo.Size() <= 0 {
		return fileIdentity{}, errors.New("file_identity_invalid")
	}
	before, ok := beforeInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, errors.New("file_stat_unavailable")
	}
	digest := sha256.New()
	written, err := io.Copy(digest, file)
	if err != nil {
		return fileIdentity{}, err
	}
	if written != beforeInfo.Size() {
		return fileIdentity{}, errors.New("file_size_changed")
	}
	if afterHash != nil {
		afterHash()
	}
	afterInfo, err := file.Stat()
	if err != nil {
		return fileIdentity{}, err
	}
	after, ok := afterInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, errors.New("file_stat_unavailable")
	}
	if before.Dev != after.Dev ||
		before.Ino != after.Ino ||
		before.Size != after.Size ||
		before.Mode != after.Mode {
		return fileIdentity{}, errors.New("file_identity_changed")
	}
	return fileIdentity{
		Dev:    strconv.FormatUint(uint64(before.Dev), 10),
		Ino:    strconv.FormatUint(before.Ino, 10),
		Sha256: hex.EncodeToString(digest.Sum(nil)),
		Size:   strconv.FormatInt(before.Size, 10),
	}, nil
}

func readNamespaceIdentity() (namespaceIdentity, error) {
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return namespaceIdentity{}, err
	}
	pidNamespace, err := os.Readlink("/proc/self/ns/pid")
	if err != nil {
		return namespaceIdentity{}, err
	}
	bootID := strings.TrimSpace(string(boot))
	if !validLowerUUID(bootID) || !strings.HasPrefix(pidNamespace, "pid:[") ||
		!strings.HasSuffix(pidNamespace, "]") {
		return namespaceIdentity{}, errors.New("namespace_identity_invalid")
	}
	return namespaceIdentity{BootID: bootID, PIDNamespaceID: pidNamespace}, nil
}

func readProcessEnvironmentToken(pid uint64) (string, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
	if err != nil {
		return "", err
	}
	const prefix = "SFSC_SERVICE_TOKEN="
	for _, entry := range strings.Split(string(data), "\x00") {
		if strings.HasPrefix(entry, prefix) {
			token := strings.TrimPrefix(entry, prefix)
			if validToken(token) {
				return token, nil
			}
			return "", errors.New("process_token_invalid")
		}
	}
	return "", errors.New("process_token_missing")
}

func readProcessSecurity(pid uint64) (capabilityObservation, bool, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return capabilityObservation{}, false, err
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	caps := capabilityObservation{
		Ambient:     values["CapAmb"],
		Bounding:    values["CapBnd"],
		Effective:   values["CapEff"],
		Inheritable: values["CapInh"],
		Permitted:   values["CapPrm"],
	}
	for _, value := range []string{
		caps.Ambient, caps.Bounding, caps.Effective, caps.Inheritable, caps.Permitted,
	} {
		if len(value) != 16 || strings.Trim(value, "0") != "" {
			return capabilityObservation{}, false, errors.New("process_capabilities_nonzero")
		}
	}
	return caps, values["NoNewPrivs"] == "1", nil
}

func observeNetwork(pid uint64, listener listenerIdentity) (observedListener, sessionObservation, error) {
	entries, err := readTCPTables(pid)
	if err != nil {
		return observedListener{}, sessionObservation{}, err
	}
	return observeNetworkSnapshot(pid, listener, entries)
}

func observeNetworkSnapshot(
	pid uint64,
	listener listenerIdentity,
	entries []tcpEntry,
) (observedListener, sessionObservation, error) {
	listenerEntry, listenerPresent := selectListenerEntry(entries, listener)
	if !listenerPresent {
		return observedListener{
			Host: listener.Host, Port: listener.Port, Open: false,
		}, sessionObservation{Tracked: false, Tuples: []sessionTuple{}}, nil
	}
	owned, dev, err := findOwnedSocket(pid, listenerEntry.Inode)
	if err != nil {
		return observedListener{}, sessionObservation{}, err
	}
	observed := observedListener{
		Host:           listener.Host,
		Port:           listener.Port,
		Open:           true,
		OwnedByProcess: owned,
		SocketDev:      dev,
		SocketIno:      listenerEntry.Inode,
	}
	tuples := make([]sessionTuple, 0)
	for _, entry := range entries {
		if entry.State != "01" || entry.LocalPort != listener.Port {
			continue
		}
		connectionOwned, _, err := findOwnedSocket(pid, entry.Inode)
		if err != nil || !connectionOwned {
			return observed, sessionObservation{Tracked: false, Tuples: []sessionTuple{}}, nil
		}
		tuples = append(tuples, sessionTuple{
			LocalAddress:  entry.LocalAddress,
			LocalPort:     entry.LocalPort,
			RemoteAddress: entry.RemoteAddress,
			RemotePort:    entry.RemotePort,
			Inode:         entry.Inode,
		})
	}
	sort.Slice(tuples, func(i, j int) bool {
		if tuples[i].RemoteAddress == tuples[j].RemoteAddress {
			return tuples[i].RemotePort < tuples[j].RemotePort
		}
		return tuples[i].RemoteAddress < tuples[j].RemoteAddress
	})
	return observed, sessionObservation{
		Count: len(tuples), Tracked: true, Tuples: tuples,
	}, nil
}

func selectListenerEntry(entries []tcpEntry, listener listenerIdentity) (tcpEntry, bool) {
	var selected tcpEntry
	count := listenerEntryCount(entries, listener)
	for _, entry := range entries {
		if entry.State == "0A" && entry.LocalPort == listener.Port &&
			isIPv4LoopbackHex(entry.LocalAddress) {
			selected = entry
		}
	}
	return selected, count == 1
}

func listenerEntryCount(entries []tcpEntry, listener listenerIdentity) int {
	count := 0
	for _, entry := range entries {
		if entry.State == "0A" && entry.LocalPort == listener.Port &&
			isIPv4LoopbackHex(entry.LocalAddress) {
			count++
		}
	}
	return count
}

func readTCPTables(pid uint64) ([]tcpEntry, error) {
	result := make([]tcpEntry, 0)
	for _, name := range []string{"tcp", "tcp6"} {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/net/%s", pid, name))
		if err != nil {
			return nil, err
		}
		entries, err := parseTCPTable(data)
		if err != nil {
			return nil, fmt.Errorf("%s_table_invalid: %w", name, err)
		}
		result = append(result, entries...)
	}
	return result, nil
}

func parseTCPTable(data []byte) ([]tcpEntry, error) {
	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return nil, errors.New("header_missing")
	}
	header := strings.Fields(lines[0])
	if len(header) < 10 ||
		header[0] != "sl" ||
		header[1] != "local_address" ||
		!validRemoteAddressHeader(header[2]) ||
		header[3] != "st" ||
		header[len(header)-1] != "inode" {
		return nil, errors.New("header_invalid")
	}
	result := make([]tcpEntry, 0)
	for index, line := range lines[1:] {
		if line == "" {
			if index == len(lines)-2 {
				continue
			}
			return nil, errors.New("row_empty")
		}
		fields := strings.Fields(line)
		if len(fields) < 10 {
			return nil, errors.New("row_short")
		}
		localAddress, localPort, ok := parseTCPAddress(fields[1])
		if !ok {
			return nil, errors.New("local_address_invalid")
		}
		remoteAddress, remotePort, ok := parseTCPAddress(fields[2])
		if !ok {
			return nil, errors.New("remote_address_invalid")
		}
		if !validTCPState(fields[3]) {
			return nil, errors.New("state_invalid")
		}
		if _, ok := parseCanonicalDecimal(fields[9]); !ok {
			return nil, errors.New("inode_invalid")
		}
		result = append(result, tcpEntry{
			LocalAddress:  localAddress,
			LocalPort:     localPort,
			RemoteAddress: remoteAddress,
			RemotePort:    remotePort,
			State:         strings.ToUpper(fields[3]),
			Inode:         fields[9],
		})
	}
	return result, nil
}

func validRemoteAddressHeader(value string) bool {
	return value == "rem_address" || value == "remote_address"
}

func parseTCPAddress(value string) (string, int, bool) {
	address, portText, ok := strings.Cut(value, ":")
	if !ok || strings.Contains(portText, ":") {
		return "", 0, false
	}
	if len(address) != 8 && len(address) != 32 {
		return "", 0, false
	}
	if _, err := hex.DecodeString(address); err != nil {
		return "", 0, false
	}
	if len(portText) != 4 {
		return "", 0, false
	}
	port, err := strconv.ParseUint(portText, 16, 16)
	if err != nil {
		return "", 0, false
	}
	return strings.ToUpper(address), int(port), true
}

func validTCPState(value string) bool {
	if len(value) != 2 {
		return false
	}
	_, err := strconv.ParseUint(value, 16, 8)
	return err == nil
}

func findOwnedSocket(pid uint64, inode string) (bool, string, error) {
	var lastTransient error
	for attempt := 0; attempt < 3; attempt++ {
		owned, dev, found, err := findOwnedSocketOnce(pid, inode)
		if err == nil && found {
			return owned, dev, nil
		}
		if err != nil {
			if !isTransientProcError(err) {
				return false, "", err
			}
			lastTransient = err
		}
		time.Sleep(2 * time.Millisecond)
	}
	if lastTransient != nil {
		return false, "", errors.New("proc_fd_observation_unstable")
	}
	return false, "", nil
}

func findOwnedSocketOnce(pid uint64, inode string) (bool, string, bool, error) {
	directory := fmt.Sprintf("/proc/%d/fd", pid)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return false, "", false, err
	}
	for _, entry := range entries {
		if _, err := strconv.ParseUint(entry.Name(), 10, 64); err != nil {
			return false, "", false, errors.New("proc_fd_name_invalid")
		}
		fdPath := filepath.Join(directory, entry.Name())
		link, err := os.Readlink(fdPath)
		if err != nil {
			return false, "", false, err
		}
		if link != "socket:["+inode+"]" {
			continue
		}
		info, err := os.Stat(fdPath)
		if err != nil {
			return false, "", false, err
		}
		typed, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return false, "", false, errors.New("proc_fd_stat_unavailable")
		}
		return true, strconv.FormatUint(uint64(typed.Dev), 10), true, nil
	}
	return false, "", false, nil
}

func isTransientProcError(err error) bool {
	return errors.Is(err, os.ErrNotExist) ||
		errors.Is(err, syscall.ESRCH) ||
		errors.Is(err, syscall.ESTALE)
}

func listenerClosed(pid uint64, listener listenerIdentity) (bool, error) {
	entries, err := readTCPTables(pid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			entries, err = readTCPTables(uint64(os.Getpid()))
		}
		if err != nil {
			return false, err
		}
	}
	for _, entry := range entries {
		if entry.State == "0A" && entry.LocalPort == listener.Port &&
			isIPv4LoopbackHex(entry.LocalAddress) {
			return false, nil
		}
	}
	return true, nil
}

func sessionTuplesClosed(tuples []sessionTuple) (bool, error) {
	entries, err := readTCPTables(uint64(os.Getpid()))
	if err != nil {
		return false, err
	}
	for _, expected := range tuples {
		for _, entry := range entries {
			if entry.LocalAddress == expected.LocalAddress &&
				entry.LocalPort == expected.LocalPort &&
				entry.RemoteAddress == expected.RemoteAddress &&
				entry.RemotePort == expected.RemotePort &&
				tcpStateIsActiveSession(entry.State) {
				return false, nil
			}
		}
	}
	return true, nil
}

func sessionClosureAfterCleanup(censusKnown bool, tuples []sessionTuple) (bool, error) {
	if !censusKnown {
		return false, nil
	}
	return sessionTuplesClosed(tuples)
}

func tcpStateIsActiveSession(state string) bool {
	return state == "01"
}

func allTaskCensus() (bool, error) {
	before, err := listTaskDirectories(os.Getpid())
	if err != nil {
		return false, err
	}
	first, err := collectDescendants(uint64(os.Getpid()))
	if err != nil {
		return false, err
	}
	after, err := listTaskDirectories(os.Getpid())
	if err != nil {
		return false, err
	}
	if !sameStringSet(before, after) {
		return false, nil
	}
	second, err := collectDescendants(uint64(os.Getpid()))
	if err != nil {
		return false, err
	}
	if !sameUint64Set(first, second) {
		return false, nil
	}
	return true, nil
}

func collectDescendants(root uint64) ([]uint64, error) {
	seen := map[uint64]bool{}
	queue := []uint64{root}
	result := make([]uint64, 0)
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		tasks, err := listTaskDirectories(int(pid))
		if err != nil {
			return nil, err
		}
		children := map[uint64]bool{}
		for _, task := range tasks {
			data, err := os.ReadFile(filepath.Join(
				fmt.Sprintf("/proc/%d/task", pid),
				task,
				"children",
			))
			if err != nil {
				return nil, err
			}
			for _, text := range strings.Fields(string(data)) {
				child, err := strconv.ParseUint(text, 10, 64)
				if err != nil || child == 0 {
					return nil, errors.New("task_children_invalid")
				}
				children[child] = true
			}
		}
		ordered := make([]uint64, 0, len(children))
		for child := range children {
			ordered = append(ordered, child)
		}
		sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
		for _, child := range ordered {
			if seen[child] {
				continue
			}
			seen[child] = true
			result = append(result, child)
			queue = append(queue, child)
		}
	}
	return result, nil
}

func listTaskDirectories(pid int) ([]string, error) {
	entries, err := os.ReadDir(fmt.Sprintf("/proc/%d/task", pid))
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			result = append(result, entry.Name())
		}
	}
	sort.Strings(result)
	return result, nil
}

func directChildren() ([]uint64, error) {
	children := map[uint64]bool{}
	tasks, err := listTaskDirectories(os.Getpid())
	if err != nil {
		return nil, err
	}
	for _, task := range tasks {
		data, err := os.ReadFile(filepath.Join("/proc/self/task", task, "children"))
		if err != nil {
			return nil, err
		}
		for _, text := range strings.Fields(string(data)) {
			child, err := strconv.ParseUint(text, 10, 64)
			if err != nil || child == 0 {
				return nil, errors.New("task_children_invalid")
			}
			children[child] = true
		}
	}
	result := make([]uint64, 0, len(children))
	for child := range children {
		result = append(result, child)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, nil
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func sameUint64Set(left, right []uint64) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func isIPv4LoopbackHex(value string) bool {
	return value == "0100007F"
}

func validLowerUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range value {
		switch index {
		case 8, 13, 18, 23:
			if char != '-' {
				return false
			}
		default:
			if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
				return false
			}
		}
	}
	return true
}
