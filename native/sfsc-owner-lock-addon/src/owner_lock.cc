#include <node_api.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <climits>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <initializer_list>
#include <mutex>
#include <stdexcept>
#include <string>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <vector>

namespace {

constexpr const char* kStateBasename = "relation-services.json";
constexpr const char* kLockBasename =
    "relation-services.json.manager-owner.lock";

enum class Lifecycle {
  kEmpty,
  kAcquiring,
  kFailed,
  kLeaseUnverified,
  kActive,
  kStickyInvalid
};

enum class OwnerCall {
  kNone,
  kVerify,
  kSnapshot
};

struct Failure {
  std::string code;
  std::string message;
};

struct OwnerState {
  Lifecycle lifecycle = Lifecycle::kEmpty;
  pid_t owner_tid = 0;
  int parent_fd = -1;
  int lock_fd = -1;
  OwnerCall owner_call = OwnerCall::kNone;
  bool snapshot_consumed = false;
  std::string state_path;
  std::string parent_path;
  dev_t parent_dev = 0;
  ino_t parent_ino = 0;
  dev_t lock_dev = 0;
  ino_t lock_ino = 0;
};

struct Evidence {
  std::string state_path;
  std::string parent_dev;
  std::string parent_ino;
  std::string lock_dev;
  std::string lock_ino;
};

std::mutex g_mutex;
OwnerState g_owner;

class ScopedFd {
 public:
  ScopedFd() = default;
  ScopedFd(const ScopedFd&) = delete;
  ScopedFd& operator=(const ScopedFd&) = delete;

  ~ScopedFd() { Reset(); }

  int Get() const { return fd_; }

  void Reset(int fd = -1) {
    if (fd_ >= 0) {
      close(fd_);
    }
    fd_ = fd;
  }

  int Release() noexcept {
    const int released = fd_;
    fd_ = -1;
    return released;
  }

 private:
  int fd_ = -1;
};

void PublishAcquiredOwner(std::string& state_path, std::string& parent_path,
                          const dev_t parent_dev, const ino_t parent_ino,
                          const dev_t lock_dev, const ino_t lock_ino,
                          ScopedFd& parent, ScopedFd& lock) noexcept {
  g_owner.state_path.swap(state_path);
  g_owner.parent_path.swap(parent_path);
  g_owner.parent_dev = parent_dev;
  g_owner.parent_ino = parent_ino;
  g_owner.lock_dev = lock_dev;
  g_owner.lock_ino = lock_ino;
  g_owner.parent_fd = parent.Release();
  g_owner.lock_fd = lock.Release();
  g_owner.owner_call = OwnerCall::kNone;
  g_owner.snapshot_consumed = false;
  g_owner.lifecycle = Lifecycle::kLeaseUnverified;
}

[[noreturn]] void Raise(const char* code, const char* message) {
  throw Failure{code, message};
}

pid_t CurrentTid() {
  const long tid = syscall(SYS_gettid);
  if (tid < 0) {
    Raise("owner_lock_syscall_failed", "gettid failed");
  }
  return static_cast<pid_t>(tid);
}

void RequireMainThread() {
  if (CurrentTid() != getpid()) {
    Raise("owner_lock_main_thread_required",
          "owner lock calls require the Node main thread");
  }
}

void ClearPendingException(napi_env env) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    napi_value ignored;
    (void)napi_get_and_clear_last_exception(env, &ignored);
  }
}

[[noreturn]] void FatalNapi(const char* message) {
  napi_fatal_error("sfsc_owner_lock", NAPI_AUTO_LENGTH, message,
                   NAPI_AUTO_LENGTH);
  std::abort();
}

napi_value ThrowCode(napi_env env, const std::string& code,
                     const std::string& message) {
  ClearPendingException(env);
  napi_value code_value;
  napi_value message_value;
  napi_value error;
  if (napi_create_string_utf8(env, code.c_str(), code.size(), &code_value) !=
          napi_ok ||
      napi_create_string_utf8(env, message.c_str(), message.size(),
                              &message_value) != napi_ok ||
      napi_create_error(env, nullptr, message_value, &error) != napi_ok ||
      napi_set_named_property(env, error, "code", code_value) != napi_ok ||
      napi_throw(env, error) != napi_ok) {
    FatalNapi("unable to report owner lock failure");
  }
  return nullptr;
}

napi_value ThrowCode(napi_env env, const Failure& failure) {
  return ThrowCode(env, failure.code, failure.message);
}

void CheckNapi(napi_env env, napi_status status, const char* operation) {
  if (status != napi_ok) {
    ClearPendingException(env);
    std::string message = operation;
    message += " failed";
    Raise("owner_lock_napi_failed", message.c_str());
  }
}

napi_value GetNamed(napi_env env, napi_value object, const char* name) {
  napi_value value;
  CheckNapi(env, napi_get_named_property(env, object, name, &value), name);
  return value;
}

std::string ReadString(napi_env env, napi_value value, const char* code,
                       const char* message) {
  napi_valuetype type;
  CheckNapi(env, napi_typeof(env, value, &type), "napi_typeof");
  if (type != napi_string) {
    Raise(code, message);
  }
  size_t length = 0;
  CheckNapi(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length),
            "napi_get_value_string_utf8 length");
  std::vector<char> buffer(length + 1, '\0');
  size_t copied = 0;
  CheckNapi(env, napi_get_value_string_utf8(env, value, buffer.data(),
                                            buffer.size(), &copied),
            "napi_get_value_string_utf8");
  return std::string(buffer.data(), copied);
}

bool IsPlainObject(napi_env env, napi_value value) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) {
    return false;
  }
  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || is_array) {
    return false;
  }
  napi_value null_value;
  if (napi_get_null(env, &null_value) != napi_ok) {
    return false;
  }
  bool equal = false;
  if (napi_strict_equals(env, value, null_value, &equal) != napi_ok) {
    return false;
  }
  return !equal;
}

void RequireExactKeys(napi_env env, napi_value object,
                      std::initializer_list<const char*> expected,
                      const char* code, const char* message) {
  if (!IsPlainObject(env, object)) {
    Raise(code, message);
  }
  napi_value names;
  CheckNapi(env,
            napi_get_all_property_names(
                env, object, napi_key_own_only, napi_key_all_properties,
                napi_key_numbers_to_strings, &names),
            "napi_get_all_property_names");
  uint32_t count = 0;
  CheckNapi(env, napi_get_array_length(env, names, &count),
            "napi_get_array_length");
  std::vector<std::string> actual;
  actual.reserve(count);
  for (uint32_t index = 0; index < count; ++index) {
    napi_value key;
    CheckNapi(env, napi_get_element(env, names, index, &key),
              "napi_get_element");
    napi_valuetype key_type;
    CheckNapi(env, napi_typeof(env, key, &key_type), "napi_typeof key");
    if (key_type != napi_string) {
      Raise(code, message);
    }
    actual.push_back(ReadString(env, key, code, message));
  }
  std::vector<std::string> wanted;
  wanted.reserve(expected.size());
  for (const char* key : expected) {
    wanted.emplace_back(key);
  }
  std::sort(actual.begin(), actual.end());
  std::sort(wanted.begin(), wanted.end());
  if (actual != wanted) {
    Raise(code, message);
  }
}

std::string RequireString(napi_env env, napi_value object, const char* name,
                          const char* code, const char* message) {
  return ReadString(env, GetNamed(env, object, name), code, message);
}

void RequireDecimal(const std::string& value, const char* message) {
  if (value.empty() ||
      (value.size() > 1 && value.front() == '0') ||
      !std::all_of(value.begin(), value.end(),
                   [](unsigned char ch) { return ch >= '0' && ch <= '9'; })) {
    Raise("owner_lock_evidence_invalid", message);
  }
}

bool IsCanonicalStatePath(const std::string& value) {
  if (value.empty() || value.front() != '/' || value.back() == '/' ||
      value.find('\0') != std::string::npos ||
      value.find("//") != std::string::npos) {
    return false;
  }
  const size_t last_slash = value.rfind('/');
  if (last_slash == std::string::npos ||
      value.substr(last_slash + 1) != kStateBasename) {
    return false;
  }
  size_t start = 1;
  while (start <= value.size()) {
    const size_t end = value.find('/', start);
    const size_t length =
        (end == std::string::npos ? value.size() : end) - start;
    if (length == 0) {
      return false;
    }
    const std::string component = value.substr(start, length);
    if (component == "." || component == "..") {
      return false;
    }
    if (end == std::string::npos) {
      break;
    }
    start = end + 1;
  }
  return true;
}

std::string CanonicalParent(const std::string& state_path) {
  const size_t last_slash = state_path.rfind('/');
  if (last_slash == 0) {
    return "/";
  }
  return state_path.substr(0, last_slash);
}

std::string RealpathOrRaise(const std::string& path, const char* code,
                            const char* message) {
  char* resolved = realpath(path.c_str(), nullptr);
  if (resolved == nullptr) {
    Raise(code, message);
  }
  std::string result(resolved);
  free(resolved);
  return result;
}

void CloseProvisionalOwner() {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_owner.lifecycle == Lifecycle::kAcquiring) {
    g_owner.lifecycle = Lifecycle::kFailed;
    g_owner.owner_tid = 0;
  }
}

void MarkOwnerStickyAndClearCall() {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_owner.lifecycle == Lifecycle::kLeaseUnverified ||
      g_owner.lifecycle == Lifecycle::kActive) {
    g_owner.lifecycle = Lifecycle::kStickyInvalid;
  }
  g_owner.owner_call = OwnerCall::kNone;
}

void VerifyPathIdentity(const std::string& parent_path,
                        const int parent_fd, const int lock_fd,
                        const dev_t parent_dev, const ino_t parent_ino,
                        const dev_t lock_dev, const ino_t lock_ino) {
  struct stat parent_stat {};
  struct stat lock_stat {};
  if (fstat(parent_fd, &parent_stat) != 0 || fstat(lock_fd, &lock_stat) != 0 ||
      parent_stat.st_dev != parent_dev || parent_stat.st_ino != parent_ino ||
      lock_stat.st_dev != lock_dev || lock_stat.st_ino != lock_ino) {
    Raise("owner_lock_replaced", "owner file identity changed");
  }

  struct stat entry_stat {};
  if (fstatat(parent_fd, kLockBasename, &entry_stat, AT_SYMLINK_NOFOLLOW) !=
          0 ||
      entry_stat.st_dev != lock_dev || entry_stat.st_ino != lock_ino) {
    Raise("owner_lock_replaced", "owner lock directory entry changed");
  }

  const std::string resolved =
      RealpathOrRaise(parent_path, "owner_lock_replaced",
                      "canonical parent no longer resolves");
  if (resolved != parent_path) {
    Raise("owner_lock_replaced", "canonical parent string changed");
  }
  ScopedFd reopened;
  const int fd = open(parent_path.c_str(),
                      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    Raise("owner_lock_replaced", "canonical parent cannot be reopened");
  }
  reopened.Reset(fd);
  struct stat reopened_stat {};
  if (fstat(reopened.Get(), &reopened_stat) != 0 ||
      reopened_stat.st_dev != parent_dev ||
      reopened_stat.st_ino != parent_ino) {
    Raise("owner_lock_replaced", "canonical parent object changed");
  }
}

void VerifyOwnerTrust() {
  struct stat parent_stat {};
  struct stat lock_stat {};
  if (fstat(g_owner.parent_fd, &parent_stat) != 0 ||
      fstat(g_owner.lock_fd, &lock_stat) != 0) {
    Raise("owner_lock_syscall_failed", "owner trust fstat failed");
  }
  if (parent_stat.st_dev != g_owner.parent_dev ||
      parent_stat.st_ino != g_owner.parent_ino ||
      lock_stat.st_dev != g_owner.lock_dev ||
      lock_stat.st_ino != g_owner.lock_ino) {
    Raise("owner_lock_replaced", "owner file identity changed");
  }
  if (!S_ISDIR(parent_stat.st_mode) ||
      parent_stat.st_uid != geteuid() ||
      (parent_stat.st_mode & 0022) != 0) {
    Raise("owner_state_untrusted",
          "owner parent trust predicates changed");
  }
  if (!S_ISREG(lock_stat.st_mode) || lock_stat.st_uid != geteuid() ||
      (lock_stat.st_mode & 07777) != 0600 || lock_stat.st_nlink != 1) {
    Raise("owner_state_untrusted",
          "owner lock trust predicates changed");
  }

  struct stat entry_stat {};
  if (fstatat(g_owner.parent_fd, kLockBasename, &entry_stat,
              AT_SYMLINK_NOFOLLOW) != 0) {
    Raise("owner_lock_replaced", "owner lock directory entry changed");
  }
  if (entry_stat.st_dev != g_owner.lock_dev ||
      entry_stat.st_ino != g_owner.lock_ino) {
    Raise("owner_lock_replaced", "owner lock directory identity changed");
  }
  if (!S_ISREG(entry_stat.st_mode) || entry_stat.st_uid != geteuid() ||
      (entry_stat.st_mode & 07777) != 0600 ||
      entry_stat.st_nlink != 1) {
    Raise("owner_state_untrusted",
          "owner lock directory trust predicates changed");
  }

  const std::string resolved =
      RealpathOrRaise(g_owner.parent_path, "owner_lock_replaced",
                      "canonical parent no longer resolves");
  if (resolved != g_owner.parent_path) {
    Raise("owner_lock_replaced", "canonical parent string changed");
  }
  ScopedFd reopened;
  const int fd = open(g_owner.parent_path.c_str(),
                      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    Raise("owner_lock_replaced", "canonical parent cannot be reopened");
  }
  reopened.Reset(fd);
  struct stat reopened_stat {};
  if (fstat(reopened.Get(), &reopened_stat) != 0 ||
      reopened_stat.st_dev != g_owner.parent_dev ||
      reopened_stat.st_ino != g_owner.parent_ino) {
    Raise("owner_lock_replaced", "canonical parent object changed");
  }
  if (!S_ISDIR(reopened_stat.st_mode) ||
      reopened_stat.st_uid != geteuid() ||
      (reopened_stat.st_mode & 0022) != 0) {
    Raise("owner_state_untrusted",
          "reopened owner parent trust predicates changed");
  }
}

struct StateMetadata {
  dev_t dev = 0;
  ino_t ino = 0;
  mode_t mode = 0;
  uid_t uid = 0;
  nlink_t nlink = 0;
  off_t size = 0;
  struct timespec mtime {};
  struct timespec ctime {};
};

StateMetadata CaptureStateMetadata(const struct stat& metadata) {
  StateMetadata snapshot;
  snapshot.dev = metadata.st_dev;
  snapshot.ino = metadata.st_ino;
  snapshot.mode = metadata.st_mode;
  snapshot.uid = metadata.st_uid;
  snapshot.nlink = metadata.st_nlink;
  snapshot.size = metadata.st_size;
  snapshot.mtime = metadata.st_mtim;
  snapshot.ctime = metadata.st_ctim;
  return snapshot;
}

bool SameTimespec(const struct timespec& left, const struct timespec& right) {
  return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}

bool SameStateMetadata(const StateMetadata& left,
                       const StateMetadata& right) {
  return left.dev == right.dev && left.ino == right.ino &&
         left.mode == right.mode && left.uid == right.uid &&
         left.nlink == right.nlink && left.size == right.size &&
         SameTimespec(left.mtime, right.mtime) &&
         SameTimespec(left.ctime, right.ctime);
}

void ValidateInitialStateTrust(const struct stat& metadata,
                               const uint64_t max_bytes) {
  if (!S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid() ||
      (metadata.st_mode & 07777) != 0600 || metadata.st_nlink != 1) {
    Raise("owner_state_untrusted",
          "state type, owner, mode or link count is untrusted");
  }
  if (metadata.st_size < 0) {
    Raise("owner_state_untrusted", "state size is negative");
  }
  if (static_cast<uint64_t>(metadata.st_size) > max_bytes) {
    Raise("owner_state_too_large", "state exceeds the requested byte limit");
  }
}

StateMetadata OpenStateSnapshot(const int parent_fd, const uint64_t max_bytes,
                                ScopedFd& state) {
  const int fd = openat(parent_fd, kStateBasename,
                        O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT) {
      Raise("owner_state_missing", "state entry is absent");
    }
    if (errno == ELOOP) {
      Raise("owner_state_untrusted", "state entry is a symbolic link");
    }
    Raise("owner_state_unreadable", "state entry cannot be opened");
  }
  state.Reset(fd);

  struct stat metadata {};
  if (fstat(state.Get(), &metadata) != 0) {
    Raise("owner_state_unreadable", "state metadata cannot be read");
  }
  ValidateInitialStateTrust(metadata, max_bytes);
  return CaptureStateMetadata(metadata);
}

std::vector<unsigned char> ReadStateBytes(const int fd,
                                          const StateMetadata& initial) {
  std::vector<unsigned char> bytes(static_cast<size_t>(initial.size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count =
        read(fd, bytes.data() + offset, bytes.size() - offset);
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      Raise("owner_state_unreadable", "state content cannot be read");
    }
    if (count == 0) {
      Raise("owner_quiescence_snapshot_changed",
            "state reached EOF before its initial size");
    }
    offset += static_cast<size_t>(count);
  }
  return bytes;
}

void ValidateStateDirectoryEntry(const int parent_fd,
                                 const StateMetadata& initial) {
  struct stat entry_stat {};
  if (fstatat(parent_fd, kStateBasename, &entry_stat,
              AT_SYMLINK_NOFOLLOW) != 0) {
    Raise("owner_quiescence_snapshot_changed",
          "state directory entry disappeared");
  }
  if (!SameStateMetadata(initial, CaptureStateMetadata(entry_stat))) {
    Raise("owner_quiescence_snapshot_changed",
          "state directory entry changed");
  }
}

void ValidateStateAfterRead(const int parent_fd, const int state_fd,
                            const StateMetadata& initial) {
  struct stat state_stat {};
  if (fstat(state_fd, &state_stat) != 0) {
    Raise("owner_quiescence_snapshot_changed",
          "state metadata disappeared after reading");
  }
  if (!SameStateMetadata(initial, CaptureStateMetadata(state_stat))) {
    Raise("owner_quiescence_snapshot_changed",
          "state metadata changed while reading");
  }
  ValidateStateDirectoryEntry(parent_fd, initial);
}

Evidence AcquireCandidate(const std::string& state_path, ScopedFd& parent,
                          ScopedFd& lock) {
  const std::string parent_path = CanonicalParent(state_path);
  const std::string resolved =
      RealpathOrRaise(parent_path, "owner_lock_path_invalid",
                      "canonical parent does not resolve");
  if (resolved != parent_path) {
    Raise("owner_lock_path_invalid",
          "parent path is not a canonical string");
  }

  const int parent_fd =
      open(parent_path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent_fd < 0) {
    Raise("owner_lock_path_invalid", "canonical parent cannot be opened");
  }
  parent.Reset(parent_fd);

  struct stat parent_stat {};
  if (fstat(parent.Get(), &parent_stat) != 0) {
    Raise("owner_lock_syscall_failed", "fstat parent failed");
  }
  if (!S_ISDIR(parent_stat.st_mode) || parent_stat.st_uid != geteuid() ||
      (parent_stat.st_mode & 0022) != 0) {
    Raise("owner_lock_parent_untrusted",
          "parent owner, type or write permissions are untrusted");
  }

  const int lock_fd =
      openat(parent.Get(), kLockBasename,
             O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (lock_fd < 0) {
    Raise("owner_lock_file_untrusted", "owner lock cannot be opened");
  }
  lock.Reset(lock_fd);

  struct stat lock_stat {};
  if (fstat(lock.Get(), &lock_stat) != 0) {
    Raise("owner_lock_syscall_failed", "fstat owner lock failed");
  }
  if (!S_ISREG(lock_stat.st_mode) || lock_stat.st_uid != geteuid() ||
      (lock_stat.st_mode & 07777) != 0600 || lock_stat.st_nlink != 1) {
    Raise("owner_lock_file_untrusted",
          "owner lock type, owner, mode or link count is untrusted");
  }

  if (flock(lock.Get(), LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) {
      Raise("owner_lock_busy", "owner lock is already held");
    }
    Raise("owner_lock_syscall_failed", "flock failed");
  }

  VerifyPathIdentity(parent_path, parent.Get(), lock.Get(), parent_stat.st_dev,
                     parent_stat.st_ino, lock_stat.st_dev, lock_stat.st_ino);

  Evidence evidence;
  evidence.state_path = state_path;
  evidence.parent_dev = std::to_string(parent_stat.st_dev);
  evidence.parent_ino = std::to_string(parent_stat.st_ino);
  evidence.lock_dev = std::to_string(lock_stat.st_dev);
  evidence.lock_ino = std::to_string(lock_stat.st_ino);
  return evidence;
}

Evidence ReadAcquireArguments(napi_env env, napi_callback_info info,
                              pid_t& tid) {
  size_t argc = 1;
  napi_value argv[1];
  CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
            "napi_get_cb_info");
  if (argc != 1 || !IsPlainObject(env, argv[0])) {
    Raise("owner_lock_input_invalid",
          "acquireOwnerLock expects one object argument");
  }
  RequireExactKeys(env, argv[0], {"statePath"}, "owner_lock_input_invalid",
                   "acquireOwnerLock expects exactly { statePath }");
  const std::string state_path =
      RequireString(env, argv[0], "statePath", "owner_lock_path_invalid",
                    "statePath must be a canonical absolute string");
  if (!IsCanonicalStatePath(state_path)) {
    Raise("owner_lock_path_invalid",
          "statePath must be a canonical relation-services.json path");
  }
  Evidence evidence;
  evidence.state_path = state_path;
  tid = CurrentTid();
  return evidence;
}

Evidence ReadEvidence(napi_env env, napi_value evidence_object) {
  RequireExactKeys(
      env, evidence_object,
      {"schemaVersion", "statePath", "parentDev", "parentIno", "lockDev",
       "lockIno"},
      "owner_lock_evidence_invalid", "owner evidence keys are not exact");
  Evidence evidence;
  evidence.state_path =
      RequireString(env, evidence_object, "statePath",
                    "owner_lock_evidence_invalid",
                    "owner evidence statePath is invalid");
  evidence.parent_dev =
      RequireString(env, evidence_object, "parentDev",
                    "owner_lock_evidence_invalid",
                    "owner evidence parentDev is invalid");
  evidence.parent_ino =
      RequireString(env, evidence_object, "parentIno",
                    "owner_lock_evidence_invalid",
                    "owner evidence parentIno is invalid");
  evidence.lock_dev =
      RequireString(env, evidence_object, "lockDev",
                    "owner_lock_evidence_invalid",
                    "owner evidence lockDev is invalid");
  evidence.lock_ino =
      RequireString(env, evidence_object, "lockIno",
                    "owner_lock_evidence_invalid",
                    "owner evidence lockIno is invalid");
  RequireDecimal(evidence.parent_dev, "parentDev must be canonical decimal");
  RequireDecimal(evidence.parent_ino, "parentIno must be canonical decimal");
  RequireDecimal(evidence.lock_dev, "lockDev must be canonical decimal");
  RequireDecimal(evidence.lock_ino, "lockIno must be canonical decimal");
  const std::string schema =
      RequireString(env, evidence_object, "schemaVersion",
                    "owner_lock_evidence_invalid",
                    "owner evidence schemaVersion is invalid");
  if (schema != "1") {
    Raise("owner_lock_evidence_invalid",
          "owner evidence schemaVersion must be 1");
  }
  return evidence;
}

Evidence ReadVerifyArguments(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
            "napi_get_cb_info");
  if (argc != 1 || !IsPlainObject(env, argv[0])) {
    Raise("owner_lock_evidence_invalid",
          "verifyOwnerLock expects one object argument");
  }
  RequireExactKeys(env, argv[0], {"evidence"},
                   "owner_lock_evidence_invalid",
                   "verifyOwnerLock expects exactly { evidence }");
  return ReadEvidence(env, GetNamed(env, argv[0], "evidence"));
}

uint64_t ReadSnapshotMaxBytes(napi_env env, napi_value value) {
  napi_valuetype type;
  CheckNapi(env, napi_typeof(env, value, &type), "napi_typeof maxBytes");
  if (type != napi_number) {
    Raise("owner_lock_input_invalid",
          "maxBytes must be a positive safe integer");
  }
  double max_bytes = 0;
  CheckNapi(env, napi_get_value_double(env, value, &max_bytes),
            "napi_get_value_double maxBytes");
  constexpr double kMaxSnapshotBytes = 16.0 * 1024.0 * 1024.0;
  if (!std::isfinite(max_bytes) || max_bytes <= 0 ||
      std::floor(max_bytes) != max_bytes ||
      max_bytes > kMaxSnapshotBytes) {
    Raise("owner_lock_input_invalid",
          "maxBytes must be a positive safe integer at most 16 MiB");
  }
  return static_cast<uint64_t>(max_bytes);
}

struct SnapshotRequest {
  Evidence evidence;
  uint64_t max_bytes = 0;
};

SnapshotRequest ReadSnapshotArguments(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
            "napi_get_cb_info");
  if (argc != 1 || !IsPlainObject(env, argv[0])) {
    Raise("owner_lock_input_invalid",
          "readOwnerStateSnapshot expects one object argument");
  }
  RequireExactKeys(
      env, argv[0], {"evidence", "maxBytes"}, "owner_lock_input_invalid",
      "readOwnerStateSnapshot expects exactly { evidence, maxBytes }");
  SnapshotRequest request;
  request.evidence = ReadEvidence(env, GetNamed(env, argv[0], "evidence"));
  request.max_bytes =
      ReadSnapshotMaxBytes(env, GetNamed(env, argv[0], "maxBytes"));
  return request;
}

napi_value SetString(napi_env env, napi_value object, const char* name,
                     const std::string& value) {
  napi_value string;
  CheckNapi(env,
            napi_create_string_utf8(env, value.c_str(), value.size(), &string),
            "napi_create_string_utf8");
  CheckNapi(env, napi_set_named_property(env, object, name, string),
            "napi_set_named_property");
  return object;
}

napi_value BuildEvidence(napi_env env, const Evidence& evidence) {
  napi_value object;
  CheckNapi(env, napi_create_object(env, &object), "napi_create_object");
  SetString(env, object, "schemaVersion", "1");
  SetString(env, object, "statePath", evidence.state_path);
  SetString(env, object, "parentDev", evidence.parent_dev);
  SetString(env, object, "parentIno", evidence.parent_ino);
  SetString(env, object, "lockDev", evidence.lock_dev);
  SetString(env, object, "lockIno", evidence.lock_ino);
  return object;
}

napi_value BuildVerification(napi_env env, const Evidence& evidence) {
  napi_value object = BuildEvidence(env, evidence);
  napi_value valid;
  CheckNapi(env, napi_get_boolean(env, true, &valid), "napi_get_boolean");
  CheckNapi(env, napi_set_named_property(env, object, "valid", valid),
            "napi_set_named_property valid");
  return object;
}

bool EvidenceMatches(const Evidence& expected) {
  return expected.state_path == g_owner.state_path &&
         expected.parent_dev == std::to_string(g_owner.parent_dev) &&
         expected.parent_ino == std::to_string(g_owner.parent_ino) &&
         expected.lock_dev == std::to_string(g_owner.lock_dev) &&
         expected.lock_ino == std::to_string(g_owner.lock_ino);
}

napi_value AcquireOwnerLock(napi_env env, napi_callback_info info) {
  bool reserved = false;
  pid_t tid = 0;
  ScopedFd parent;
  ScopedFd lock;
  try {
    RequireMainThread();
    tid = CurrentTid();
    {
      std::lock_guard<std::mutex> guard(g_mutex);
      switch (g_owner.lifecycle) {
        case Lifecycle::kEmpty:
          g_owner.lifecycle = Lifecycle::kAcquiring;
          g_owner.owner_tid = tid;
          reserved = true;
          break;
        case Lifecycle::kAcquiring:
        case Lifecycle::kLeaseUnverified:
        case Lifecycle::kActive:
          Raise("owner_lock_already_admitted",
                "this process already reserved the owner lock");
        case Lifecycle::kFailed:
          Raise("owner_lock_retry_forbidden",
                "the single owner-lock attempt has already failed");
        case Lifecycle::kStickyInvalid:
          Raise("owner_lock_sticky_invalid",
                "the owner lock is permanently invalid");
      }
    }

    Evidence request = ReadAcquireArguments(env, info, tid);
    if (tid != CurrentTid()) {
      Raise("owner_lock_thread_mismatch",
            "acquireOwnerLock changed OS thread");
    }
    {
      std::lock_guard<std::mutex> guard(g_mutex);
      if (g_owner.lifecycle != Lifecycle::kAcquiring ||
          g_owner.owner_tid != tid) {
        Raise("owner_lock_already_admitted",
              "owner acquisition was reentered or changed");
      }
    }

    Evidence evidence = AcquireCandidate(request.state_path, parent, lock);
    std::string published_state_path = evidence.state_path;
    std::string published_parent_path = CanonicalParent(evidence.state_path);
    const dev_t published_parent_dev =
        static_cast<dev_t>(std::stoull(evidence.parent_dev));
    const ino_t published_parent_ino =
        static_cast<ino_t>(std::stoull(evidence.parent_ino));
    const dev_t published_lock_dev =
        static_cast<dev_t>(std::stoull(evidence.lock_dev));
    const ino_t published_lock_ino =
        static_cast<ino_t>(std::stoull(evidence.lock_ino));
    napi_value result = BuildEvidence(env, evidence);

    {
      std::lock_guard<std::mutex> guard(g_mutex);
      if (g_owner.lifecycle != Lifecycle::kAcquiring ||
          g_owner.owner_tid != tid) {
        Raise("owner_lock_already_admitted",
              "owner acquisition state changed before publication");
      }
      PublishAcquiredOwner(published_state_path, published_parent_path,
                           published_parent_dev, published_parent_ino,
                           published_lock_dev, published_lock_ino, parent,
                           lock);
      reserved = false;
    }
    return result;
  } catch (const Failure& failure) {
    if (reserved) {
      CloseProvisionalOwner();
    }
    return ThrowCode(env, failure);
  } catch (const std::exception&) {
    if (reserved) {
      CloseProvisionalOwner();
    }
    return ThrowCode(env, "owner_lock_syscall_failed",
                     "owner acquisition raised an internal exception");
  } catch (...) {
    if (reserved) {
      CloseProvisionalOwner();
    }
    return ThrowCode(env, "owner_lock_syscall_failed",
                     "owner acquisition raised an unknown exception");
  }
}

napi_value VerifyOwnerLock(napi_env env, napi_callback_info info) {
  bool verification_reserved = false;
  pid_t tid = 0;
  try {
    RequireMainThread();
    tid = CurrentTid();
    {
      std::lock_guard<std::mutex> guard(g_mutex);
      switch (g_owner.lifecycle) {
        case Lifecycle::kEmpty:
        case Lifecycle::kAcquiring:
          Raise("owner_lock_not_acquired", "owner lock is not acquired");
        case Lifecycle::kFailed:
          Raise("owner_lock_retry_forbidden",
                "the single owner-lock attempt has already failed");
        case Lifecycle::kStickyInvalid:
          Raise("owner_lock_sticky_invalid",
                "the owner lock is permanently invalid");
        case Lifecycle::kLeaseUnverified:
        case Lifecycle::kActive:
          if (g_owner.owner_tid != tid) {
            Raise("owner_lock_thread_mismatch",
                  "owner verification must use the owner thread");
          }
          if (g_owner.owner_call != OwnerCall::kNone) {
            g_owner.lifecycle = Lifecycle::kStickyInvalid;
            g_owner.owner_call = OwnerCall::kNone;
            Raise("owner_lock_verification_in_progress",
                  "cross or nested owner calls are forbidden");
          }
          g_owner.owner_call = OwnerCall::kVerify;
          verification_reserved = true;
          break;
      }
    }

    Evidence expected = ReadVerifyArguments(env, info);
    {
      std::lock_guard<std::mutex> guard(g_mutex);
      if (g_owner.lifecycle == Lifecycle::kStickyInvalid) {
        Raise("owner_lock_sticky_invalid",
              "the owner lock is permanently invalid");
      }
      if ((g_owner.lifecycle != Lifecycle::kLeaseUnverified &&
           g_owner.lifecycle != Lifecycle::kActive) ||
          g_owner.owner_call != OwnerCall::kVerify) {
        Raise("owner_lock_verification_in_progress",
              "owner verification reservation changed");
      }
    }
    if (!EvidenceMatches(expected)) {
      Raise("owner_lock_evidence_invalid",
            "owner evidence does not match the native owner");
    }

    VerifyOwnerTrust();
    napi_value result = BuildVerification(env, expected);

    {
      std::lock_guard<std::mutex> guard(g_mutex);
      if (g_owner.lifecycle == Lifecycle::kStickyInvalid) {
        Raise("owner_lock_sticky_invalid",
              "the owner lock became permanently invalid");
      }
      if (g_owner.lifecycle != Lifecycle::kLeaseUnverified &&
          g_owner.lifecycle != Lifecycle::kActive) {
        Raise("owner_lock_verification_in_progress",
              "owner verification lifecycle changed");
      }
      if (g_owner.owner_call != OwnerCall::kVerify) {
        Raise("owner_lock_verification_in_progress",
              "owner verification reservation changed");
      }
      g_owner.lifecycle = Lifecycle::kActive;
      g_owner.owner_call = OwnerCall::kNone;
      verification_reserved = false;
    }
    return result;
  } catch (const Failure& failure) {
    if (verification_reserved) {
      MarkOwnerStickyAndClearCall();
    }
    return ThrowCode(env, failure);
  } catch (const std::exception&) {
    if (verification_reserved) {
      MarkOwnerStickyAndClearCall();
    }
    return ThrowCode(env, "owner_lock_syscall_failed",
                     "owner verification raised an internal exception");
  } catch (...) {
    if (verification_reserved) {
      MarkOwnerStickyAndClearCall();
    }
    return ThrowCode(env, "owner_lock_syscall_failed",
                     "owner verification raised an unknown exception");
  }
}

napi_value ReadOwnerStateSnapshot(napi_env env, napi_callback_info info) {
  bool snapshot_reserved = false;
  pid_t tid = 0;
  try {
    RequireMainThread();
    tid = CurrentTid();
    {
      std::lock_guard<std::mutex> guard(g_mutex);
      switch (g_owner.lifecycle) {
        case Lifecycle::kEmpty:
        case Lifecycle::kAcquiring:
          Raise("owner_lock_not_acquired", "owner lock is not acquired");
        case Lifecycle::kFailed:
          Raise("owner_lock_retry_forbidden",
                "the single owner-lock attempt has already failed");
        case Lifecycle::kStickyInvalid:
          Raise("owner_lock_sticky_invalid",
                "the owner lock is permanently invalid");
        case Lifecycle::kLeaseUnverified:
          Raise("owner_lock_not_verified",
                "owner lock must be verified before snapshot");
        case Lifecycle::kActive:
          if (g_owner.owner_tid != tid) {
            Raise("owner_lock_thread_mismatch",
                  "owner snapshot must use the owner thread");
          }
          if (g_owner.snapshot_consumed) {
            Raise("owner_state_snapshot_consumed",
                  "owner state snapshot was already consumed");
          }
          if (g_owner.owner_call != OwnerCall::kNone) {
            g_owner.lifecycle = Lifecycle::kStickyInvalid;
            g_owner.owner_call = OwnerCall::kNone;
            Raise("owner_lock_verification_in_progress",
                  "cross or nested owner calls are forbidden");
          }
          g_owner.owner_call = OwnerCall::kSnapshot;
          snapshot_reserved = true;
          break;
      }
    }

    const SnapshotRequest request = ReadSnapshotArguments(env, info);
    {
      std::lock_guard<std::mutex> guard(g_mutex);
      if (g_owner.lifecycle == Lifecycle::kStickyInvalid) {
        Raise("owner_lock_sticky_invalid",
              "the owner lock became permanently invalid");
      }
      if (g_owner.lifecycle != Lifecycle::kActive ||
          g_owner.owner_call != OwnerCall::kSnapshot ||
          g_owner.owner_tid != tid) {
        Raise("owner_lock_verification_in_progress",
              "owner snapshot reservation changed");
      }
    }
    if (!EvidenceMatches(request.evidence)) {
      Raise("owner_lock_evidence_invalid",
            "owner evidence does not match the native owner");
    }

    VerifyOwnerTrust();
    ScopedFd state;
    const StateMetadata initial =
        OpenStateSnapshot(g_owner.parent_fd, request.max_bytes, state);
    ValidateStateDirectoryEntry(g_owner.parent_fd, initial);
    const std::vector<unsigned char> bytes =
        ReadStateBytes(state.Get(), initial);
    ValidateStateAfterRead(g_owner.parent_fd, state.Get(), initial);
    VerifyOwnerTrust();

    {
      std::lock_guard<std::mutex> guard(g_mutex);
      if (g_owner.lifecycle == Lifecycle::kStickyInvalid) {
        Raise("owner_lock_sticky_invalid",
              "the owner lock became permanently invalid");
      }
      if (g_owner.lifecycle != Lifecycle::kActive ||
          g_owner.owner_call != OwnerCall::kSnapshot ||
          g_owner.owner_tid != tid) {
        Raise("owner_lock_verification_in_progress",
              "owner snapshot lifecycle changed");
      }
    }

    napi_value result;
    void* copied = nullptr;
    CheckNapi(
        env,
        napi_create_buffer_copy(env, bytes.size(),
                                bytes.empty() ? nullptr : bytes.data(),
                                &copied, &result),
        "napi_create_buffer_copy");

    {
      std::lock_guard<std::mutex> guard(g_mutex);
      if (g_owner.lifecycle == Lifecycle::kStickyInvalid) {
        Raise("owner_lock_sticky_invalid",
              "the owner lock became permanently invalid");
      }
      if (g_owner.lifecycle != Lifecycle::kActive ||
          g_owner.owner_call != OwnerCall::kSnapshot ||
          g_owner.owner_tid != tid) {
        Raise("owner_lock_verification_in_progress",
              "owner snapshot publication reservation changed");
      }
      g_owner.snapshot_consumed = true;
      g_owner.owner_call = OwnerCall::kNone;
      snapshot_reserved = false;
    }
    return result;
  } catch (const Failure& failure) {
    if (snapshot_reserved) {
      MarkOwnerStickyAndClearCall();
    }
    return ThrowCode(env, failure);
  } catch (const std::exception&) {
    if (snapshot_reserved) {
      MarkOwnerStickyAndClearCall();
    }
    return ThrowCode(env, "owner_lock_syscall_failed",
                     "owner snapshot raised an internal exception");
  } catch (...) {
    if (snapshot_reserved) {
      MarkOwnerStickyAndClearCall();
    }
    return ThrowCode(env, "owner_lock_syscall_failed",
                     "owner snapshot raised an unknown exception");
  }
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"acquireOwnerLock", nullptr, AcquireOwnerLock, nullptr, nullptr, nullptr,
       napi_enumerable, nullptr},
      {"readOwnerStateSnapshot", nullptr, ReadOwnerStateSnapshot, nullptr,
       nullptr, nullptr, napi_enumerable, nullptr},
      {"verifyOwnerLock", nullptr, VerifyOwnerLock, nullptr, nullptr, nullptr,
       napi_enumerable, nullptr},
  };
  if (napi_define_properties(env, exports,
                             sizeof(properties) / sizeof(properties[0]),
                             properties) != napi_ok) {
    FatalNapi("unable to initialize owner lock addon");
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
