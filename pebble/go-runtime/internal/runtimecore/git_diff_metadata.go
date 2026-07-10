package runtimecore

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"strings"
)

// Why: binary diff previews were originally image-only in the reference shell,
// so the renderer still gates previews on `isImage`; PDFs ride the same flag.
var previewableBinaryMimeTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".svg":  "image/svg+xml",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".pdf":  "application/pdf",
}

// binaryGitFileDiffResult packages a binary diff: base64 payloads, per-side
// binary flags, byte sizes in place of text hunks, and preview MIME metadata.
func binaryGitFileDiffResult(original []byte, modified []byte, originalBinary bool, modifiedBinary bool, filePath string) GitFileDiffResult {
	result := GitFileDiffResult{
		Kind:             "binary",
		OriginalContent:  base64.StdEncoding.EncodeToString(original),
		ModifiedContent:  base64.StdEncoding.EncodeToString(modified),
		OriginalIsBinary: originalBinary,
		ModifiedIsBinary: modifiedBinary,
		OriginalByteSize: len(original),
		ModifiedByteSize: len(modified),
	}
	if mimeType, ok := previewableBinaryMimeTypes[strings.ToLower(filepath.Ext(filePath))]; ok {
		result.IsImage = true
		result.MimeType = mimeType
	}
	return result
}

// gitNumstatReportsBinary asks git itself whether the change is binary — the
// numstat dash markers ("-\t-\t<path>") cover files whose leading bytes look
// textual, which the content heuristic's bounded scan window misses.
func gitNumstatReportsBinary(ctx context.Context, repoPath string, filePath string, staged bool) bool {
	args := []string{"diff", "--numstat"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", filePath)
	output, err := readGitOutput(ctx, repoPath, args...)
	if err != nil {
		return false
	}
	return strings.HasPrefix(output, "-\t-\t")
}

// gitlinkDiffOids resolves the old/new submodule pointer for the same
// staged/compareAgainstHead routes the file differ uses.
func gitlinkDiffOids(ctx context.Context, repoPath string, submodulePath string, submoduleWorktreePath string, staged bool, compareAgainstHead bool) (string, string) {
	switch {
	case staged:
		return readGitlinkOidFromTree(ctx, repoPath, "HEAD", submodulePath),
			readGitlinkOidFromIndex(ctx, repoPath, submodulePath)
	case compareAgainstHead:
		return readGitlinkOidFromTree(ctx, repoPath, "HEAD", submodulePath),
			readWorkingSubmoduleHead(ctx, submoduleWorktreePath)
	default:
		left := readGitlinkOidFromIndex(ctx, repoPath, submodulePath)
		if left == "" {
			left = readGitlinkOidFromTree(ctx, repoPath, "HEAD", submodulePath)
		}
		return left, readWorkingSubmoduleHead(ctx, submoduleWorktreePath)
	}
}

// buildSubmodulePointerDiff synthesizes the gitlink diff. Git represents
// submodule commit changes as a one-line "Subproject commit <oid>" swap, so
// producing exactly that text matches git's own rendering; the structured
// metadata rides alongside for consumers that want the raw SHAs.
func buildSubmodulePointerDiff(ctx context.Context, repoPath string, submodulePath string, staged bool, compareAgainstHead bool) (GitFileDiffResult, bool) {
	if !gitPathIsGitlink(ctx, repoPath, submodulePath) {
		return GitFileDiffResult{}, false
	}
	submoduleWorktreePath := filepath.Join(repoPath, filepath.FromSlash(submodulePath))
	oldSHA, newSHA := gitlinkDiffOids(ctx, repoPath, submodulePath, submoduleWorktreePath, staged, compareAgainstHead)
	return GitFileDiffResult{
		Kind:             "text",
		OriginalContent:  formatSubprojectCommitLine(oldSHA),
		ModifiedContent:  formatSubprojectCommitLine(newSHA),
		OriginalIsBinary: false,
		ModifiedIsBinary: false,
		Submodule: &GitSubmoduleDiffChange{
			OldSHA: oldSHA,
			NewSHA: newSHA,
			Dirty:  submoduleWorktreeDirty(ctx, submoduleWorktreePath),
		},
	}, true
}

func formatSubprojectCommitLine(oid string) string {
	if oid == "" {
		return ""
	}
	return "Subproject commit " + oid + "\n"
}

// gitPathIsGitlink reports whether the path is a submodule pointer (mode
// 160000) in the index or, for paths dropped from the index, in HEAD.
func gitPathIsGitlink(ctx context.Context, repoPath string, path string) bool {
	if output, err := readGitOutput(ctx, repoPath, "ls-files", "-s", "--", path); err == nil && strings.HasPrefix(output, "160000 ") {
		return true
	}
	if output, err := readGitOutput(ctx, repoPath, "ls-tree", "HEAD", "--", path); err == nil && strings.HasPrefix(output, "160000 ") {
		return true
	}
	return false
}

func readGitlinkOidFromTree(ctx context.Context, repoPath string, ref string, path string) string {
	output, err := readGitOutput(ctx, repoPath, "ls-tree", ref, "--", path)
	if err != nil {
		return ""
	}
	// ls-tree format: "<mode> <type> <oid>\t<path>"
	fields := strings.Fields(output)
	if len(fields) >= 3 && fields[0] == "160000" {
		return fields[2]
	}
	return ""
}

func readGitlinkOidFromIndex(ctx context.Context, repoPath string, path string) string {
	output, err := readGitOutput(ctx, repoPath, "ls-files", "-s", "--", path)
	if err != nil {
		return ""
	}
	// ls-files -s format: "<mode> <oid> <stage>\t<path>"
	fields := strings.Fields(output)
	if len(fields) >= 2 && fields[0] == "160000" {
		return fields[1]
	}
	return ""
}

func readWorkingSubmoduleHead(ctx context.Context, submoduleWorktreePath string) string {
	output, err := readGitOutput(ctx, submoduleWorktreePath, "rev-parse", "HEAD")
	if err != nil {
		return ""
	}
	return output
}

// submoduleWorktreeDirty reports uncommitted tracked/untracked changes inside
// the submodule's own worktree; an uninitialized submodule reads as clean.
func submoduleWorktreeDirty(ctx context.Context, submoduleWorktreePath string) bool {
	output, err := readGitOutput(ctx, submoduleWorktreePath, "status", "--porcelain")
	if err != nil {
		return false
	}
	return output != ""
}
