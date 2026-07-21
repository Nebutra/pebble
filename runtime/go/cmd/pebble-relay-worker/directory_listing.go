package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	maxDirectoryBrowsePathBytes = 32 << 10
	maxDirectoryBrowseNameBytes = 4 << 10
	maxDirectoryBrowseRequest   = 256 << 10
	maxDirectoryBrowseEntries   = 10_000
)

type directoryListingEntry struct {
	Name        string `json:"name"`
	IsDirectory bool   `json:"isDirectory"`
}

type directoryListingResult struct {
	Entries      []directoryListingEntry `json:"entries"`
	ResolvedPath string                  `json:"resolvedPath"`
}

func runDirectoryListJSON(input io.Reader, output io.Writer) error {
	var request struct {
		Path string `json:"path"`
	}
	payload, err := io.ReadAll(io.LimitReader(input, maxDirectoryBrowseRequest+1))
	if err != nil {
		return fmt.Errorf("read directory listing request: %w", err)
	}
	if len(payload) > maxDirectoryBrowseRequest {
		return errors.New("directory listing request exceeds limit")
	}
	if err := json.Unmarshal(payload, &request); err != nil {
		return fmt.Errorf("decode directory listing request: %w", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve remote home directory: %w", err)
	}
	result, err := listRemoteDirectory(request.Path, home)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func listRemoteDirectory(requestedPath, home string) (directoryListingResult, error) {
	resolved, err := resolveRemoteBrowsePath(requestedPath, home)
	if err != nil {
		return directoryListingResult{}, err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return directoryListingResult{}, fmt.Errorf("inspect remote directory: %w", err)
	}
	if !info.IsDir() {
		return directoryListingResult{}, errors.New("remote path is not a directory")
	}
	canonical, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		return directoryListingResult{}, fmt.Errorf("resolve remote directory: %w", err)
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return directoryListingResult{}, fmt.Errorf("resolve remote directory: %w", err)
	}
	directory, err := os.Open(canonical)
	if err != nil {
		return directoryListingResult{}, fmt.Errorf("list remote directory: %w", err)
	}
	defer directory.Close()
	// Why: ReadDir(path) materializes an unbounded directory before we can
	// enforce the relay response limit; read only one sentinel entry beyond it.
	entries, err := directory.ReadDir(maxDirectoryBrowseEntries + 1)
	if err != nil {
		return directoryListingResult{}, fmt.Errorf("list remote directory: %w", err)
	}
	if len(entries) > maxDirectoryBrowseEntries {
		return directoryListingResult{}, fmt.Errorf("remote directory exceeds %d entry limit", maxDirectoryBrowseEntries)
	}
	result := directoryListingResult{
		Entries:      make([]directoryListingEntry, 0, len(entries)),
		ResolvedPath: canonical,
	}
	for _, entry := range entries {
		if err := validateRemoteDirectoryEntryName(entry.Name()); err != nil {
			return directoryListingResult{}, err
		}
		isDirectory := entry.IsDir()
		if entry.Type()&os.ModeSymlink != 0 {
			if target, statErr := os.Stat(filepath.Join(canonical, entry.Name())); statErr == nil {
				isDirectory = target.IsDir()
			}
		}
		result.Entries = append(result.Entries, directoryListingEntry{
			Name:        entry.Name(),
			IsDirectory: isDirectory,
		})
	}
	return result, nil
}

func validateRemoteDirectoryEntryName(name string) error {
	if name == "" || name == "." || name == ".." {
		return errors.New("remote directory contained an invalid entry name")
	}
	if len(name) > maxDirectoryBrowseNameBytes {
		return errors.New("remote directory entry name exceeds limit")
	}
	for _, value := range name {
		if value == 0 || value == '\r' || value == '\n' {
			return errors.New("remote directory entry name contains control characters")
		}
	}
	return nil
}

func resolveRemoteBrowsePath(requestedPath, home string) (string, error) {
	if requestedPath == "" || requestedPath == "~" {
		requestedPath = home
	} else if strings.HasPrefix(requestedPath, "~/") || strings.HasPrefix(requestedPath, `~\`) {
		requestedPath = filepath.Join(home, requestedPath[2:])
	} else if strings.HasPrefix(requestedPath, "~") {
		return "", errors.New("remote user-home aliases are not supported")
	}
	if len(requestedPath) > maxDirectoryBrowsePathBytes {
		return "", errors.New("remote directory path exceeds limit")
	}
	for _, value := range requestedPath {
		if value == 0 || value == '\r' || value == '\n' {
			return "", errors.New("remote directory path contains control characters")
		}
	}
	if volume := filepath.VolumeName(requestedPath); volume != "" && !filepath.IsAbs(requestedPath) {
		// Why: C:foo depends on process-local drive state; requiring an absolute
		// path keeps remote browsing deterministic on Windows SSH hosts.
		return "", errors.New("remote Windows drive-relative paths are not supported")
	}
	if !filepath.IsAbs(requestedPath) {
		requestedPath = filepath.Join(home, requestedPath)
	}
	return filepath.Clean(requestedPath), nil
}
