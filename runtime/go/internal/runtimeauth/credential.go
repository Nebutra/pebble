package runtimeauth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	credentialFileName = "runtime-credential.json"
	credentialSchema   = 1
	maxCredentialBytes = 16 * 1024
)

type Credential struct {
	SchemaVersion int    `json:"schemaVersion"`
	PID           int    `json:"pid"`
	Endpoint      string `json:"endpoint"`
	Token         string `json:"token"`
	StartedAt     int64  `json:"startedAt"`
}

func DefaultDataDir() string {
	if configured := strings.TrimSpace(os.Getenv("PEBBLE_RUNTIME_DATA_DIR")); configured != "" {
		return configured
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".pebble")
	}
	return ".pebble"
}

func EndpointForListen(listen string) (string, error) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(listen))
	if err != nil {
		return "", fmt.Errorf("invalid runtime listen address %q: %w", listen, err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port), nil
}

func Publish(dataDir, endpoint, token string) (func(), error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return func() {}, nil
	}
	if !isLocalEndpoint(endpoint) {
		return nil, fmt.Errorf("invalid local runtime endpoint %q", endpoint)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dataDir, 0o700); err != nil && !errors.Is(err, os.ErrPermission) {
		return nil, err
	}
	credential := Credential{
		SchemaVersion: credentialSchema,
		PID:           os.Getpid(),
		Endpoint:      strings.TrimRight(endpoint, "/"),
		Token:         token,
		StartedAt:     time.Now().UnixMilli(),
	}
	content, err := json.Marshal(credential)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dataDir, credentialFileName)
	temporary, err := os.CreateTemp(dataDir, ".runtime-credential-*.tmp")
	if err != nil {
		return nil, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return nil, err
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return nil, err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return nil, err
	}
	if err := temporary.Close(); err != nil {
		return nil, err
	}
	if err := replaceCredentialFile(temporaryPath, path); err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, err
	}
	return func() { removeIfOwned(path, credential) }, nil
}

func Discover(dataDir string) (Credential, error) {
	path := filepath.Join(dataDir, credentialFileName)
	file, err := os.Open(path)
	if err != nil {
		return Credential{}, err
	}
	defer file.Close()
	if err := validateCredentialFile(file); err != nil {
		return Credential{}, err
	}
	content, err := io.ReadAll(io.LimitReader(file, maxCredentialBytes+1))
	if err != nil {
		return Credential{}, err
	}
	if len(content) > maxCredentialBytes {
		return Credential{}, errors.New("runtime credential file is too large")
	}
	var credential Credential
	if err := json.Unmarshal(content, &credential); err != nil {
		return Credential{}, err
	}
	if credential.SchemaVersion != credentialSchema || credential.PID <= 0 ||
		strings.TrimSpace(credential.Token) == "" || !isLocalEndpoint(credential.Endpoint) {
		return Credential{}, errors.New("runtime credential file is invalid")
	}
	if !processAlive(credential.PID) {
		removeIfOwned(path, credential)
		return Credential{}, errors.New("runtime credential is stale")
	}
	return credential, nil
}

func removeIfOwned(path string, expected Credential) {
	content, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var current Credential
	if json.Unmarshal(content, &current) == nil && current.PID == expected.PID && current.Token == expected.Token {
		_ = os.Remove(path)
	}
}

func isLocalEndpoint(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" {
		return false
	}
	host := parsed.Hostname()
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}
