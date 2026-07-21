package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"unicode/utf8"
)

const (
	terminalArtifactTextLimit    int64 = 512 * 1024
	terminalArtifactPreviewLimit int64 = 10 * 1024 * 1024
)

type terminalArtifactRequest struct {
	AbsolutePath string `json:"absolutePath"`
	Identity     string `json:"identity,omitempty"`
	Content      string `json:"content,omitempty"`
}

type terminalArtifactResult struct {
	AbsolutePath string `json:"absolutePath"`
	IsDirectory  bool   `json:"isDirectory"`
	Identity     string `json:"identity,omitempty"`
	Content      string `json:"content,omitempty"`
	IsBinary     bool   `json:"isBinary,omitempty"`
	IsImage      bool   `json:"isImage,omitempty"`
	MimeType     string `json:"mimeType,omitempty"`
	ByteLength   int    `json:"byteLength,omitempty"`
}

func runTerminalArtifactJSON(args []string, input io.Reader, output io.Writer) error {
	fs := flag.NewFlagSet("terminal-artifact-json", flag.ContinueOnError)
	fs.SetOutput(output)
	operation := fs.String("operation", "", "grant, read, preview, or write")
	if err := fs.Parse(args); err != nil {
		return err
	}
	var request terminalArtifactRequest
	if err := json.NewDecoder(io.LimitReader(input, terminalArtifactPreviewLimit+1024)).Decode(&request); err != nil {
		return err
	}
	result, err := applyTerminalArtifactOperation(*operation, request)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func applyTerminalArtifactOperation(operation string, request terminalArtifactRequest) (terminalArtifactResult, error) {
	path, info, err := resolveAllowedTerminalArtifact(request.AbsolutePath)
	if err != nil {
		return terminalArtifactResult{}, err
	}
	if operation == "grant" {
		if !info.IsDir() {
			if err := rejectHardLinkedArtifact(info); err != nil {
				return terminalArtifactResult{}, err
			}
		}
		return terminalArtifactResult{AbsolutePath: path, IsDirectory: info.IsDir(), Identity: terminalArtifactIdentity(info)}, nil
	}
	if info.IsDir() {
		return terminalArtifactResult{}, errors.New("cannot access a directory")
	}
	if err := validateTerminalArtifactIdentity(info, request.Identity); err != nil {
		return terminalArtifactResult{}, err
	}
	switch operation {
	case "read":
		if isTerminalArtifactBinaryPath(path) {
			return terminalArtifactResult{}, errors.New("binary_file")
		}
		content, err := readTerminalArtifactText(path, info)
		if err != nil {
			return terminalArtifactResult{}, err
		}
		return terminalArtifactResult{AbsolutePath: path, Identity: terminalArtifactIdentity(info), Content: content, ByteLength: len([]byte(content))}, nil
	case "preview":
		if mimeType := terminalArtifactPreviewMime(path); mimeType != "" {
			content, err := readTerminalArtifactBytes(path, info, terminalArtifactPreviewLimit)
			if err != nil {
				return terminalArtifactResult{}, err
			}
			return terminalArtifactResult{AbsolutePath: path, Identity: terminalArtifactIdentity(info), Content: base64.StdEncoding.EncodeToString(content), IsBinary: true, IsImage: true, MimeType: mimeType}, nil
		}
		content, err := readTerminalArtifactText(path, info)
		if err != nil {
			return terminalArtifactResult{}, err
		}
		return terminalArtifactResult{AbsolutePath: path, Identity: terminalArtifactIdentity(info), Content: content}, nil
	case "write":
		if isTerminalArtifactBinaryPath(path) {
			return terminalArtifactResult{}, errors.New("binary_file")
		}
		if int64(len([]byte(request.Content))) > terminalArtifactTextLimit {
			return terminalArtifactResult{}, errors.New("file_too_large")
		}
		if strings.IndexByte(request.Content, 0) >= 0 || !utf8.ValidString(request.Content) {
			return terminalArtifactResult{}, errors.New("binary_file")
		}
		if err := replaceTerminalArtifact(path, info, request.Identity, request.Content); err != nil {
			return terminalArtifactResult{}, err
		}
		nextInfo, err := os.Stat(path)
		if err != nil {
			return terminalArtifactResult{}, err
		}
		return terminalArtifactResult{AbsolutePath: path, Identity: terminalArtifactIdentity(nextInfo)}, nil
	default:
		return terminalArtifactResult{}, errors.New("unsupported terminal artifact operation")
	}
}

func resolveAllowedTerminalArtifact(rawPath string) (string, os.FileInfo, error) {
	path := strings.TrimSpace(rawPath)
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", nil, err
		}
		if path == "~" {
			path = home
		} else {
			path = filepath.Join(home, path[2:])
		}
	}
	if path == "" || !filepath.IsAbs(path) {
		return "", nil, errors.New("not_absolute")
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", nil, err
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return "", nil, err
	}
	allowed := false
	for _, root := range terminalArtifactRoots() {
		if pathInsideRoot(root, canonical) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", nil, errors.New("terminal_file_grant_unavailable")
	}
	info, err := os.Stat(canonical)
	return canonical, info, err
}

func terminalArtifactRoots() []string {
	roots := []string{os.TempDir()}
	if filepath.Separator == '/' {
		roots = append(roots, "/tmp", "/private/tmp")
	}
	result := make([]string, 0, len(roots)*2)
	for _, root := range roots {
		absolute, err := filepath.Abs(root)
		if err == nil {
			result = append(result, absolute)
		}
		if canonical, err := filepath.EvalSymlinks(root); err == nil {
			result = append(result, canonical)
		}
	}
	return result
}

func pathInsideRoot(root string, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func terminalArtifactIdentity(info os.FileInfo) string {
	return fmt.Sprintf("%d:%d:%d", info.Size(), info.ModTime().UnixNano(), info.Mode())
}

func validateTerminalArtifactIdentity(info os.FileInfo, expected string) error {
	if expected == "" || terminalArtifactIdentity(info) != expected {
		return errors.New("terminal_file_grant_stale")
	}
	return rejectHardLinkedArtifact(info)
}

func rejectHardLinkedArtifact(info os.FileInfo) error {
	value := reflect.ValueOf(info.Sys())
	if value.IsValid() && value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if value.IsValid() {
		field := value.FieldByName("Nlink")
		if field.IsValid() && field.CanUint() && field.Uint() > 1 {
			return errors.New("terminal_file_grant_unavailable")
		}
	}
	return nil
}

func readTerminalArtifactText(path string, info os.FileInfo) (string, error) {
	content, err := readTerminalArtifactBytes(path, info, terminalArtifactTextLimit)
	if err != nil {
		return "", err
	}
	if strings.IndexByte(string(content), 0) >= 0 || !utf8.Valid(content) {
		return "", errors.New("binary_file")
	}
	return string(content), nil
}

func isTerminalArtifactBinaryPath(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".7z", ".mp3", ".mp4", ".mov", ".wav", ".woff", ".woff2", ".ttf", ".otf", ".exe", ".dll", ".dylib", ".so":
		return true
	default:
		return false
	}
}

func readTerminalArtifactBytes(path string, info os.FileInfo, limit int64) ([]byte, error) {
	if info.Size() > limit {
		return nil, errors.New("file_too_large")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) > limit {
		return nil, errors.New("file_too_large")
	}
	return content, nil
}

func replaceTerminalArtifact(path string, info os.FileInfo, expectedIdentity string, content string) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".pebble-terminal-artifact-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(info.Mode().Perm()); err != nil {
		temp.Close()
		return err
	}
	if _, err := io.WriteString(temp, content); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	currentPath, currentInfo, err := resolveAllowedTerminalArtifact(path)
	if err != nil || currentPath != path {
		return errors.New("terminal_file_grant_stale")
	}
	if err := validateTerminalArtifactIdentity(currentInfo, expectedIdentity); err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}

func terminalArtifactPreviewMime(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".ico":
		return "image/x-icon"
	case ".svg":
		return "image/svg+xml"
	case ".pdf":
		return "application/pdf"
	default:
		return ""
	}
}
