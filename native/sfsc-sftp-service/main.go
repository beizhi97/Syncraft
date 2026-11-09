package main

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"hash"
	"io"
	"log"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type options struct {
	root, addr, authorizedKeys, hostKey, user string
}

func parseOptions(args []string) (options, error) {
	fs := flag.NewFlagSet("sfsc-sftp-service", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var o options
	fs.StringVar(&o.root, "root", "", "filesystem root")
	fs.StringVar(&o.addr, "addr", "", "loopback TCP address")
	fs.StringVar(&o.authorizedKeys, "authorized-keys", "", "authorized public keys file")
	fs.StringVar(&o.hostKey, "key", "", "SSH host private key")
	fs.StringVar(&o.user, "user", "", "exact permitted SSH username")
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}
	if fs.NArg() != 0 {
		return options{}, errors.New("unexpected positional arguments")
	}
	if o.root == "" || o.addr == "" || o.authorizedKeys == "" || o.hostKey == "" || o.user == "" {
		return options{}, errors.New("--root, --addr, --authorized-keys, --key, and --user are required")
	}
	if err := requireLoopbackAddr(o.addr); err != nil {
		return options{}, err
	}
	return o, nil
}

func requireLoopbackAddr(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid --addr: %w", err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("--addr host must be a loopback IP address")
	}
	return nil
}

func main() {
	o, err := parseOptions(os.Args[1:])
	if err != nil {
		log.Fatal(err)
	}
	svc, err := newService(o)
	if err != nil {
		log.Fatal(err)
	}
	defer svc.root.Close()
	listener, err := net.Listen("tcp", o.addr)
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	if tcp, ok := listener.Addr().(*net.TCPAddr); !ok || !tcp.IP.IsLoopback() {
		log.Fatal("listener did not bind to a loopback IP")
	}
	if err := writeReady(listener.Addr().String()); err != nil {
		log.Fatal(err)
	}
	if err := svc.serve(listener); err != nil && !errors.Is(err, net.ErrClosed) {
		log.Fatal(err)
	}
}

type service struct {
	root   *os.Root
	config *ssh.ServerConfig
	user   string
}

func newService(o options) (*service, error) {
	root, err := os.OpenRoot(o.root)
	if err != nil {
		return nil, fmt.Errorf("open filesystem root: %w", err)
	}
	cleanup := func(err error) (*service, error) { _ = root.Close(); return nil, err }

	keyBytes, err := os.ReadFile(o.hostKey)
	if err != nil {
		return cleanup(fmt.Errorf("read SSH host key: %w", err))
	}
	hostSigner, err := ssh.ParsePrivateKey(keyBytes)
	if err != nil {
		return cleanup(fmt.Errorf("parse SSH host key: %w", err))
	}
	allowed, err := readAuthorizedKeys(o.authorizedKeys)
	if err != nil {
		return cleanup(err)
	}
	if len(allowed) == 0 {
		return cleanup(errors.New("authorized keys file contains no public keys"))
	}
	config := &ssh.ServerConfig{
		PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if meta.User() != o.user {
				return nil, errors.New("username is not authorized")
			}
			wire := key.Marshal()
			for _, candidate := range allowed {
				if len(wire) == len(candidate) && subtle.ConstantTimeCompare(wire, candidate) == 1 {
					return &ssh.Permissions{}, nil
				}
			}
			return nil, errors.New("public key is not authorized")
		},
	}
	config.AddHostKey(hostSigner)
	return &service{root: root, config: config, user: o.user}, nil
}

func readAuthorizedKeys(filename string) ([][]byte, error) {
	b, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("read authorized keys: %w", err)
	}
	var keys [][]byte
	for len(strings.TrimSpace(string(b))) != 0 {
		key, _, options, rest, err := ssh.ParseAuthorizedKey(b)
		if err != nil {
			return nil, fmt.Errorf("parse authorized keys: %w", err)
		}
		if len(options) != 0 {
			return nil, errors.New("authorized key options are not supported")
		}
		keys = append(keys, key.Marshal())
		if len(rest) >= len(b) {
			return nil, errors.New("authorized keys parser did not advance")
		}
		b = rest
	}
	return keys, nil
}

func (s *service) serve(listener net.Listener) error {
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = s.handleConn(conn)
		}()
	}
}

func (s *service) handleConn(netConn net.Conn) error {
	defer netConn.Close()
	sshConn, channels, requests, err := ssh.NewServerConn(netConn, s.config)
	if err != nil {
		return err
	}
	defer sshConn.Close()
	go rejectGlobalRequests(requests)
	var sessions sync.WaitGroup
	for channelReq := range channels {
		if channelReq.ChannelType() != "session" {
			_ = channelReq.Reject(ssh.UnknownChannelType, "only session channels are supported")
			continue
		}
		channel, reqs, err := channelReq.Accept()
		if err != nil {
			continue
		}
		sessions.Add(1)
		go func() {
			defer sessions.Done()
			_ = s.handleSession(channel, reqs)
		}()
	}
	sessions.Wait()
	return nil
}

func rejectGlobalRequests(requests <-chan *ssh.Request) {
	for req := range requests {
		if req.WantReply {
			_ = req.Reply(false, nil)
		}
	}
}

func (s *service) handleSession(channel ssh.Channel, requests <-chan *ssh.Request) error {
	defer channel.Close()
	for req := range requests {
		switch req.Type {
		case "subsystem":
			var msg struct{ Name string }
			if err := ssh.Unmarshal(req.Payload, &msg); err != nil || msg.Name != "sftp" {
				_ = req.Reply(false, nil)
				continue
			}
			if err := req.Reply(true, nil); err != nil {
				return err
			}
			server := sftp.NewRequestServer(channel, sftp.Handlers{FileGet: s, FilePut: s, FileCmd: s, FileList: s})
			return server.Serve()
		case "exec":
			var msg struct{ Command string }
			if err := ssh.Unmarshal(req.Payload, &msg); err != nil {
				_ = req.Reply(false, nil)
				continue
			}
			if err := req.Reply(true, nil); err != nil {
				return err
			}
			return s.runExec(channel, msg.Command)
		default:
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
	return nil
}

func (s *service) runExec(channel ssh.Channel, command string) error {
	stdout, err := s.execHash(command)
	status := uint32(0)
	if err != nil {
		status = 1
		_, _ = io.WriteString(channel.Stderr(), err.Error()+"\n")
	} else {
		_, _ = channel.Write(stdout)
	}
	_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
	return nil
}

func (s *service) execHash(command string) ([]byte, error) {
	argv, err := splitCommand(command)
	if err != nil || len(argv) == 0 {
		return nil, errors.New("unsupported command")
	}
	var hashName string
	switch argv[0] {
	case "md5sum":
		hashName = "md5"
	case "sha1sum":
		hashName = "sha1"
	case "sha256sum":
		hashName = "sha256"
	default:
		return nil, fmt.Errorf("%q not implemented", command)
	}
	if len(argv) > 2 {
		return nil, fmt.Errorf("%q not implemented", command)
	}
	label := "-"
	var digest []byte
	if len(argv) == 2 {
		name, err := s.relative(argv[1])
		if err != nil {
			return nil, err
		}
		f, err := s.open(name, os.O_RDONLY|nonblockingFlag(), 0)
		if err != nil {
			return nil, err
		}
		if err := requireRegularFile(f); err != nil {
			_ = f.Close()
			return nil, err
		}
		defer f.Close()
		h := newHash(hashName)
		if _, err := io.Copy(h, f); err != nil {
			return nil, err
		}
		digest = h.Sum(nil)
		label = argv[1]
	} else {
		digest = emptyDigest(hashName)
	}
	return []byte(hex.EncodeToString(digest) + "  " + label + "\n"), nil
}

func newHash(name string) hash.Hash {
	switch name {
	case "md5":
		return md5.New()
	case "sha1":
		return sha1.New()
	default:
		return sha256.New()
	}
}

func emptyDigest(name string) []byte { return newHash(name).Sum(nil) }

// splitCommand parses only the small quoting/escaping vocabulary emitted by
// rclone's Unix SFTP backend. It never evaluates shell metacharacters.
func splitCommand(command string) ([]string, error) {
	var args []string
	var current strings.Builder
	var quote rune
	started := false
	runes := []rune(command)
	for i := 0; i < len(runes); i++ {
		ch := runes[i]
		if ch == '\\' {
			if i+1 >= len(runes) {
				return nil, errors.New("trailing escape")
			}
			i++
			current.WriteRune(runes[i])
			started = true
			continue
		}
		if quote != 0 {
			if ch == quote {
				quote = 0
			} else {
				current.WriteRune(ch)
			}
			started = true
			continue
		}
		if ch == '\'' || ch == '"' {
			quote = ch
			started = true
			continue
		}
		if ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' {
			if started {
				args = append(args, current.String())
				current.Reset()
				started = false
			}
			continue
		}
		current.WriteRune(ch)
		started = true
	}
	if quote != 0 {
		return nil, errors.New("unterminated quote")
	}
	if started {
		args = append(args, current.String())
	}
	return args, nil
}

func (s *service) relative(name string) (string, error) {
	if strings.IndexByte(name, 0) >= 0 || strings.ContainsAny(name, "\r\n") {
		return "", os.ErrInvalid
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", os.ErrPermission
		}
	}
	if filepath.Separator == '\\' && strings.ContainsRune(name, '\\') {
		return "", os.ErrInvalid
	}
	clean := path.Clean("/" + name)
	if clean == "/" {
		return ".", nil
	}
	return strings.TrimPrefix(clean, "/"), nil
}

func (s *service) open(name string, flags int, mode os.FileMode) (*os.File, error) {
	name, err := s.relative(name)
	if err != nil {
		return nil, err
	}
	if name == "." {
		return nil, os.ErrInvalid
	}

	info, statErr := s.root.Lstat(name)
	if statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, errors.New("only regular files may be opened")
		}
		if flags&os.O_CREATE != 0 && flags&os.O_EXCL != 0 {
			return nil, os.ErrExist
		}
		flags &^= os.O_CREATE
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return nil, statErr
	} else if flags&os.O_CREATE != 0 {
		// Exclusive creation avoids opening a raced-in symlink or special file.
		created, createErr := s.root.OpenFile(name, flags|os.O_EXCL|nonblockingFlag(), mode)
		if createErr == nil {
			if err := requireRegularFile(created); err != nil {
				_ = created.Close()
				_ = s.root.Remove(name)
				return nil, err
			}
			return created, nil
		}
		if flags&os.O_EXCL != 0 || !errors.Is(createErr, os.ErrExist) {
			return nil, createErr
		}
		info, statErr = s.root.Lstat(name)
		if statErr != nil {
			return nil, statErr
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, errors.New("only regular files may be opened")
		}
		flags &^= os.O_CREATE
	} else {
		return nil, statErr
	}
	f, err := s.root.OpenFile(name, flags|nonblockingFlag(), mode)
	if err != nil {
		return nil, err
	}
	if err := requireRegularFile(f); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func requireRegularFile(f *os.File) error {
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("only regular files may be opened")
	}
	return requireSingleLink(f)
}

func (s *service) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	flags := r.Pflags()
	if !flags.Read || flags.Write || flags.Creat || flags.Trunc {
		return nil, os.ErrPermission
	}
	return s.open(r.Filepath, os.O_RDONLY, 0)
}

func (s *service) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	flags := r.Pflags()
	if !flags.Write {
		return nil, os.ErrPermission
	}
	return s.openWrite(r.Filepath, flags)
}

func (s *service) OpenFile(r *sftp.Request) (sftp.WriterAtReaderAt, error) {
	flags := r.Pflags()
	if !flags.Read || !flags.Write {
		return nil, os.ErrPermission
	}
	return s.openWrite(r.Filepath, flags)
}

func (s *service) openWrite(name string, flags sftp.FileOpenFlags) (*rootFile, error) {
	openFlags := os.O_RDWR
	if !flags.Read {
		openFlags = os.O_WRONLY
	}
	if flags.Creat {
		openFlags |= os.O_CREATE
	}
	if flags.Excl {
		openFlags |= os.O_EXCL
	}
	f, err := s.open(name, openFlags, 0666)
	if err != nil {
		return nil, err
	}
	if flags.Trunc {
		if err := f.Truncate(0); err != nil {
			_ = f.Close()
			return nil, err
		}
	}
	return &rootFile{File: f, append: flags.Append}, nil
}

type rootFile struct {
	*os.File
	append bool
	mu     sync.Mutex
}

func (f *rootFile) WriteAt(p []byte, off int64) (int, error) {
	if !f.append {
		return f.File.WriteAt(p, off)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	info, err := f.File.Stat()
	if err != nil {
		return 0, err
	}
	return f.File.WriteAt(p, info.Size())
}

func (s *service) Filecmd(r *sftp.Request) error {
	name, err := s.relative(r.Filepath)
	if err != nil {
		return err
	}
	switch r.Method {
	case "Setstat":
		attrs := r.Attributes()
		flags := r.AttrFlags()
		if flags.UidGid {
			return errors.New("chown is not supported")
		}
		if flags.Size || flags.Permissions || flags.Acmodtime {
			f, err := s.openForSetstat(name)
			if err != nil {
				return err
			}
			defer f.Close()
			if flags.Size {
				info, err := f.Stat()
				if err != nil {
					return err
				}
				if !info.Mode().IsRegular() {
					return errors.New("size updates require a regular file")
				}
				if err := f.Truncate(int64(attrs.Size)); err != nil {
					return err
				}
			}
			if flags.Permissions {
				info, err := f.Stat()
				if err != nil {
					return err
				}
				if err := setFileMode(s.root, name, f, os.FileMode(attrs.Mode).Perm(), info.IsDir()); err != nil {
					return err
				}
			}
			if flags.Acmodtime {
				info, err := f.Stat()
				if err != nil {
					return err
				}
				atime, mtime := time.Unix(int64(attrs.Atime), 0), time.Unix(int64(attrs.Mtime), 0)
				if info.IsDir() {
					return setDirectoryTimes(s.root, name, f, atime, mtime)
				}
				return setFileTimes(f, atime, mtime)
			}
		}
		return nil
	case "Rename", "PosixRename":
		target, err := s.relative(r.Target)
		if err != nil {
			return err
		}
		if err := s.requireSupportedEntry(name); err != nil {
			return err
		}
		if err := s.requireSupportedEntry(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return s.root.Rename(name, target)
	case "Mkdir":
		mode := os.FileMode(r.Attributes().Mode).Perm()
		if mode == 0 {
			mode = 0777
		}
		return s.root.Mkdir(name, mode)
	case "Remove", "Rmdir":
		if r.Method == "Remove" {
			err = s.requireRegularEntry(name)
		} else {
			err = s.requireDirectoryEntry(name)
		}
		if err != nil {
			return err
		}
		return s.root.Remove(name)
	case "Symlink", "Link":
		return errors.New("link creation is not supported")
	default:
		return fmt.Errorf("unsupported SFTP operation %q", r.Method)
	}
}

func (s *service) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	name, err := s.relative(r.Filepath)
	if err != nil {
		return nil, err
	}
	var entries []os.FileInfo
	if r.Method == "List" {
		info, err := s.root.Lstat(name)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, errors.New("only directories may be listed")
		}
		f, err := s.root.Open(name)
		if err != nil {
			return nil, err
		}
		entries, err = f.Readdir(-1)
		closeErr := f.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		filtered := entries[:0]
		for _, entry := range entries {
			if entry.IsDir() || entry.Mode().IsRegular() {
				if entry.Mode().IsRegular() {
					child, openErr := s.open(path.Join(name, entry.Name()), os.O_RDONLY, 0)
					if openErr != nil {
						continue
					}
					_ = child.Close()
				}
				filtered = append(filtered, entry)
			}
		}
		entries = filtered
	} else {
		var info os.FileInfo
		if r.Method == "Lstat" {
			info, err = s.root.Lstat(name)
		} else {
			info, err = s.root.Stat(name)
		}
		if err != nil {
			return nil, err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return nil, errors.New("unsupported file type")
		}
		if info.Mode().IsRegular() {
			f, openErr := s.open(name, os.O_RDONLY, 0)
			if openErr != nil {
				return nil, openErr
			}
			_ = f.Close()
		}
		entries = []os.FileInfo{info}
	}
	return infoList(entries), nil
}

func (s *service) openForSetstat(name string) (*os.File, error) {
	info, err := s.root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("symlinks are not supported")
	}
	if info.Mode().IsRegular() {
		return s.open(name, os.O_RDWR, 0)
	}
	if !info.IsDir() {
		return nil, errors.New("unsupported file type")
	}
	f, err := s.root.Open(name)
	if err != nil {
		return nil, err
	}
	openedInfo, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if !openedInfo.IsDir() {
		_ = f.Close()
		return nil, errors.New("directory changed during setstat")
	}
	return f, nil
}

func (s *service) requireSupportedEntry(name string) error {
	info, err := s.root.Lstat(name)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || (!info.Mode().IsRegular() && !info.IsDir()) {
		return errors.New("unsupported file type")
	}
	if info.Mode().IsRegular() {
		f, err := s.open(name, os.O_RDONLY, 0)
		if err != nil {
			return err
		}
		return f.Close()
	}
	return nil
}

func (s *service) requireRegularEntry(name string) error {
	info, err := s.root.Lstat(name)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("operation requires a regular file")
	}
	f, err := s.open(name, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	return f.Close()
}

func (s *service) requireDirectoryEntry(name string) error {
	info, err := s.root.Lstat(name)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("operation requires a directory")
	}
	return nil
}

type infoList []os.FileInfo

func (items infoList) ListAt(dst []os.FileInfo, offset int64) (int, error) {
	if offset < 0 || offset >= int64(len(items)) {
		return 0, io.EOF
	}
	n := copy(dst, items[offset:])
	if n < len(dst) {
		return n, io.EOF
	}
	return n, nil
}

func (s *service) Readlink(string) (string, error) {
	return "", errors.New("readlink is not supported")
}

func writeReady(addr string) error {
	_, err := fmt.Fprintf(os.Stderr, "READY sfsc-sftp-service %s\n", addr)
	return err
}
