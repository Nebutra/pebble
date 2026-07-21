package runtimehttp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

const (
	legacySharedControlFileReadLimit    int64 = 512 * 1024
	legacySharedControlFilePreviewLimit int64 = 10 * 1024 * 1024
)

type legacySharedControlFileParams struct {
	Worktree                string   `json:"worktree"`
	RelativePath            string   `json:"relativePath"`
	OldRelativePath         string   `json:"oldRelativePath"`
	NewRelativePath         string   `json:"newRelativePath"`
	SourceRelativePath      string   `json:"sourceRelativePath"`
	DestinationRelativePath string   `json:"destinationRelativePath"`
	TempRelativePath        string   `json:"tempRelativePath"`
	FinalRelativePath       string   `json:"finalRelativePath"`
	Content                 string   `json:"content"`
	ContentBase64           string   `json:"contentBase64"`
	Append                  bool     `json:"append"`
	Recursive               bool     `json:"recursive"`
	Offset                  int64    `json:"offset"`
	Length                  int64    `json:"length"`
	ExcludePaths            []string `json:"excludePaths"`
	Query                   string   `json:"query"`
	CaseSensitive           bool     `json:"caseSensitive"`
	WholeWord               bool     `json:"wholeWord"`
	UseRegex                bool     `json:"useRegex"`
	IncludePattern          string   `json:"includePattern"`
	ExcludePattern          string   `json:"excludePattern"`
	MaxResults              int      `json:"maxResults"`
	Terminal                string   `json:"terminal"`
	PathText                string   `json:"pathText"`
	Cwd                     string   `json:"cwd"`
	GrantID                 string   `json:"grantId"`
	AbsolutePath            string   `json:"absolutePath"`
}

func (s *Server) runLegacySharedControlFileMethod(ctx context.Context, method string, raw json.RawMessage) (interface{}, bool, error) {
	if !strings.HasPrefix(method, "files.") {
		return nil, false, nil
	}
	var params legacySharedControlFileParams
	if json.Unmarshal(raw, &params) != nil {
		return nil, true, errors.New("invalid file operation parameters")
	}
	worktree, found := s.findLegacySharedControlWorktree(params.Worktree)
	if !found {
		return nil, true, runtimecore.ErrNotFound
	}
	scope := runtimecore.ReadFileRequest{ProjectID: worktree.ProjectID, WorktreeID: worktree.ID, Path: params.RelativePath}

	switch method {
	case "files.resolveTerminalPath":
		result, err := s.resolveLegacySharedControlTerminalPath(ctx, worktree, params)
		return result, true, err
	case "files.readTerminalArtifact":
		result, err := s.manager.ReadLocalTerminalArtifact(runtimecore.TerminalArtifactAccessRequest{WorktreeID: worktree.ID, GrantID: params.GrantID, AbsolutePath: params.AbsolutePath})
		return result, true, err
	case "files.readTerminalArtifactPreview":
		result, err := s.manager.PreviewLocalTerminalArtifact(runtimecore.TerminalArtifactAccessRequest{WorktreeID: worktree.ID, GrantID: params.GrantID, AbsolutePath: params.AbsolutePath})
		return result, true, err
	case "files.writeTerminalArtifact":
		err := s.manager.WriteLocalTerminalArtifact(runtimecore.TerminalArtifactAccessRequest{WorktreeID: worktree.ID, GrantID: params.GrantID, AbsolutePath: params.AbsolutePath, Content: params.Content})
		return map[string]bool{"ok": true}, true, err
	case "files.readDir":
		entries, err := s.manager.ListFilesContext(ctx, runtimecore.ListFilesRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path, MaxDepth: 1})
		if err != nil {
			return nil, true, err
		}
		projected := make([]map[string]interface{}, 0, len(entries))
		for _, entry := range entries {
			projected = append(projected, map[string]interface{}{"name": entry.Name, "isDirectory": entry.Kind == runtimecore.FileEntryDirectory, "isSymlink": entry.Kind == runtimecore.FileEntrySymlink})
		}
		return projected, true, nil
	case "files.read":
		return s.readLegacySharedControlFile(ctx, worktree, params.RelativePath)
	case "files.readPreview":
		return s.previewLegacySharedControlFile(ctx, scope)
	case "files.readChunk":
		result, err := s.manager.ReadFileChunkContext(ctx, runtimecore.ReadFileChunkRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path, Offset: params.Offset, Length: params.Length})
		return result, true, err
	case "files.stat":
		result, err := s.manager.StatFileContext(ctx, scope)
		return result, true, err
	case "files.list":
		result, err := s.manager.ListAllFilesContext(ctx, runtimecore.ListAllFilesRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, ExcludePaths: params.ExcludePaths})
		if err != nil {
			return nil, true, err
		}
		const limit = 5000
		files := make([]map[string]interface{}, 0, min(len(result.Files), limit))
		for index, entry := range result.Files {
			if index >= limit {
				break
			}
			kind := "text"
			if legacySharedControlBinaryExtension(filepath.Ext(entry.RelativePath)) {
				kind = "binary"
			}
			files = append(files, map[string]interface{}{"relativePath": entry.RelativePath, "basename": filepath.Base(entry.RelativePath), "kind": kind})
		}
		return map[string]interface{}{"worktree": worktree.ID, "rootPath": worktree.Path, "files": files, "totalCount": result.TotalCount, "truncated": result.Truncated || result.TotalCount > limit}, true, nil
	case "files.listAll":
		result, err := s.manager.ListAllFilesContext(ctx, runtimecore.ListAllFilesRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, ExcludePaths: params.ExcludePaths})
		return result, true, err
	case "files.search":
		result, err := s.manager.SearchFilesContext(ctx, runtimecore.FileSearchRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Query: params.Query, CaseSensitive: params.CaseSensitive, WholeWord: params.WholeWord, UseRegex: params.UseRegex, IncludePattern: params.IncludePattern, ExcludePattern: params.ExcludePattern, MaxResults: params.MaxResults})
		return result, true, err
	case "files.listMarkdownDocuments":
		result, err := s.manager.ListMarkdownDocuments(runtimecore.ListAllFilesRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID})
		return result, true, err
	case "files.write":
		_, err := s.manager.WriteFileContext(ctx, runtimecore.WriteFileRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path, Content: params.Content, CreateDirs: true})
		return map[string]bool{"ok": true}, true, err
	case "files.writeBase64", "files.writeBase64Chunk":
		err := s.manager.WriteFileBase64Context(ctx, runtimecore.WriteFileBase64Request{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path, ContentBase64: params.ContentBase64, Append: method == "files.writeBase64Chunk" && params.Append})
		return map[string]bool{"ok": true}, true, err
	case "files.createFile":
		err := s.manager.CreateFileContext(ctx, runtimecore.FileMutationRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path})
		return map[string]bool{"ok": true}, true, err
	case "files.createDir", "files.createDirNoClobber":
		err := s.manager.CreateDirectoryContext(ctx, runtimecore.FileMutationRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path})
		return map[string]bool{"ok": true}, true, err
	case "files.rename":
		err := s.manager.RenamePathContext(ctx, runtimecore.FileRenameRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, OldPath: params.OldRelativePath, NewPath: params.NewRelativePath})
		return map[string]bool{"ok": true}, true, err
	case "files.copy":
		err := s.manager.CopyPathContext(ctx, runtimecore.FileRenameRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, SourcePath: params.SourceRelativePath, DestinationPath: params.DestinationRelativePath})
		return map[string]bool{"ok": true}, true, err
	case "files.delete":
		err := s.manager.DeletePathContext(ctx, runtimecore.FileMutationRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path, Recursive: params.Recursive})
		return map[string]bool{"ok": true}, true, err
	case "files.commitUpload":
		err := s.manager.CommitUploadContext(ctx, runtimecore.FileRenameRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, SourcePath: params.TempRelativePath, DestinationPath: params.FinalRelativePath})
		return map[string]bool{"ok": true}, true, err
	default:
		return nil, false, nil
	}
}

func (s *Server) resolveLegacySharedControlTerminalPath(ctx context.Context, worktree runtimecore.Worktree, params legacySharedControlFileParams) (interface{}, error) {
	pathText := strings.TrimSpace(params.PathText)
	if pathText == "" {
		return nil, errors.New("path text is required")
	}
	expanded := legacySharedControlTerminalURIPath(pathText)
	if expanded == "" {
		expanded = pathText
	}
	if strings.HasPrefix(expanded, "~/") || strings.HasPrefix(expanded, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		expanded = filepath.Join(home, expanded[2:])
	}
	base := strings.TrimSpace(params.Cwd)
	var session runtimecore.Session
	for _, candidate := range s.manager.ListSessions() {
		if candidate.ID == strings.TrimSpace(params.Terminal) {
			session = candidate
			if candidate.Cwd != "" {
				base = candidate.Cwd
			}
			break
		}
	}
	if base == "" {
		base = worktree.Path
	}
	absolute := expanded
	if !filepath.IsAbs(absolute) {
		absolute = filepath.Join(base, expanded)
	}
	absolute = filepath.Clean(absolute)
	relative, inside := legacySharedControlPathInside(worktree.Path, absolute)
	empty := map[string]interface{}{"worktree": worktree.ID, "relativePath": nullableLegacyPath(relative, inside), "absolutePath": absolute, "exists": false, "isDirectory": false}
	if inside && relative != "" {
		stat, err := s.manager.StatFileContext(ctx, runtimecore.ReadFileRequest{ProjectID: worktree.ProjectID, WorktreeID: worktree.ID, Path: relative})
		if err != nil {
			return empty, nil
		}
		result := map[string]interface{}{"worktree": worktree.ID, "relativePath": relative, "absolutePath": absolute, "exists": true, "isDirectory": stat.IsDirectory}
		if !stat.IsDirectory {
			result["openTarget"] = map[string]interface{}{"kind": "worktree-file", "provider": "local", "relativePath": relative, "absolutePath": absolute}
		}
		return result, nil
	}
	if session.ID == "" || session.WorktreeID != worktree.ID || !s.legacySharedControlSessionOutputContainsPath(session.ID, pathText, absolute) {
		return empty, nil
	}
	grant, err := s.manager.GrantLocalTerminalArtifact(runtimecore.TerminalArtifactGrantRequest{ProjectID: worktree.ProjectID, WorktreeID: worktree.ID, AbsolutePath: absolute})
	if err != nil {
		return empty, nil
	}
	result := map[string]interface{}{"worktree": worktree.ID, "relativePath": nil, "absolutePath": grant.AbsolutePath, "exists": true, "isDirectory": grant.IsDirectory}
	if grant.GrantID != "" && !grant.IsDirectory {
		result["openTarget"] = map[string]interface{}{"kind": "absolute-file", "provider": "local", "absolutePath": grant.AbsolutePath, "grantId": grant.GrantID}
	}
	return result, nil
}

func (s *Server) legacySharedControlSessionOutputContainsPath(sessionID, pathText, absolutePath string) bool {
	tail, err := s.manager.TailSession(sessionID, 2000)
	if err != nil {
		return false
	}
	var output strings.Builder
	for _, chunk := range tail.Chunks {
		output.WriteString(chunk.Content)
	}
	joined := output.String()
	for _, candidate := range []string{pathText, absolutePath, legacySharedControlTerminalURIPath(pathText)} {
		candidate = strings.TrimSpace(candidate)
		if candidate != "" && strings.Contains(joined, candidate) {
			return true
		}
	}
	return false
}

func legacySharedControlTerminalURIPath(value string) string {
	if !strings.HasPrefix(value, "file://") {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "" && host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return ""
	}
	decoded, err := url.PathUnescape(parsed.EscapedPath())
	if err != nil {
		return ""
	}
	if len(decoded) >= 3 && decoded[0] == '/' && decoded[2] == ':' {
		return decoded[1:]
	}
	return decoded
}

func legacySharedControlPathInside(root, path string) (string, bool) {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(relative), true
}

func nullableLegacyPath(relative string, inside bool) interface{} {
	if !inside {
		return nil
	}
	return relative
}

func (s *Server) readLegacySharedControlFile(ctx context.Context, worktree runtimecore.Worktree, relativePath string) (interface{}, bool, error) {
	scope := runtimecore.ReadFileRequest{ProjectID: worktree.ProjectID, WorktreeID: worktree.ID, Path: relativePath}
	stat, err := s.manager.StatFileContext(ctx, scope)
	if err != nil {
		return nil, true, err
	}
	truncated := stat.Size > legacySharedControlFileReadLimit
	var content string
	if truncated {
		chunk, chunkErr := s.manager.ReadFileChunkContext(ctx, runtimecore.ReadFileChunkRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path, Length: legacySharedControlFileReadLimit})
		if chunkErr != nil {
			return nil, true, chunkErr
		}
		decoded, decodeErr := base64.StdEncoding.DecodeString(chunk.ContentBase64)
		if decodeErr != nil {
			return nil, true, decodeErr
		}
		content = string(decoded)
	} else {
		file, readErr := s.manager.ReadFileContext(ctx, runtimecore.ReadFileRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path, MaxBytes: legacySharedControlFileReadLimit})
		if readErr != nil {
			return nil, true, readErr
		}
		content = file.Content
	}
	if strings.ContainsRune(content, '\x00') {
		return nil, true, errors.New("binary_file")
	}
	return map[string]interface{}{"worktree": worktree.ID, "relativePath": relativePath, "content": content, "truncated": truncated, "byteLength": stat.Size}, true, nil
}

func (s *Server) previewLegacySharedControlFile(ctx context.Context, scope runtimecore.ReadFileRequest) (interface{}, bool, error) {
	stat, err := s.manager.StatFileContext(ctx, scope)
	if err != nil {
		return nil, true, err
	}
	if stat.Size > legacySharedControlFilePreviewLimit {
		return nil, true, errors.New("file_too_large")
	}
	if mimeType := legacySharedControlPreviewMIME(filepath.Ext(scope.Path)); mimeType != "" {
		content := ""
		if stat.Size > 0 {
			chunk, chunkErr := s.manager.ReadFileChunkContext(ctx, runtimecore.ReadFileChunkRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path, Length: stat.Size})
			if chunkErr != nil {
				return nil, true, chunkErr
			}
			content = chunk.ContentBase64
		}
		return map[string]interface{}{"content": content, "isBinary": true, "isImage": true, "mimeType": mimeType}, true, nil
	}
	if legacySharedControlBinaryExtension(filepath.Ext(scope.Path)) {
		return map[string]interface{}{"content": "", "isBinary": true}, true, nil
	}
	file, err := s.manager.ReadFileContext(ctx, runtimecore.ReadFileRequest{ProjectID: scope.ProjectID, WorktreeID: scope.WorktreeID, Path: scope.Path, MaxBytes: legacySharedControlFilePreviewLimit})
	if err != nil {
		return nil, true, err
	}
	isBinary := strings.ContainsRune(file.Content, '\x00')
	content := file.Content
	if isBinary {
		content = ""
	}
	return map[string]interface{}{"content": content, "isBinary": isBinary}, true, nil
}

func legacySharedControlPreviewMIME(extension string) string {
	return map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".pdf": "application/pdf"}[strings.ToLower(extension)]
}

func legacySharedControlBinaryExtension(extension string) bool {
	switch strings.ToLower(extension) {
	case ".avif", ".bmp", ".gif", ".heic", ".ico", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".pdf", ".png", ".webp", ".zip":
		return true
	default:
		return false
	}
}
