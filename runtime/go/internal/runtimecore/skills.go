package runtimecore

import (
	"crypto/sha1"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maxSkillMarkdownBytes = 256 * 1024
const maxSkillPackageFiles = 200

type SkillDiscoveryRequest struct {
	Cwd string `json:"cwd,omitempty"`
}

type SkillDiscoverySource struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Path          string   `json:"path"`
	SourceKind    string   `json:"sourceKind"`
	Providers     []string `json:"providers"`
	Exists        bool     `json:"exists"`
	SkippedReason string   `json:"skippedReason,omitempty"`
}

type DiscoveredSkill struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Description   *string  `json:"description"`
	Providers     []string `json:"providers"`
	SourceKind    string   `json:"sourceKind"`
	SourceLabel   string   `json:"sourceLabel"`
	RootPath      string   `json:"rootPath"`
	DirectoryPath string   `json:"directoryPath"`
	SkillFilePath string   `json:"skillFilePath"`
	Installed     bool     `json:"installed"`
	FileCount     int      `json:"fileCount"`
	UpdatedAt     *int64   `json:"updatedAt"`
}

type SkillDiscoveryResult struct {
	Skills    []DiscoveredSkill      `json:"skills"`
	Sources   []SkillDiscoverySource `json:"sources"`
	ScannedAt int64                  `json:"scannedAt"`
}

func (m *Manager) DiscoverSkills(req SkillDiscoveryRequest) SkillDiscoveryResult {
	home, _ := os.UserHomeDir()
	cwd := strings.TrimSpace(req.Cwd)
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	roots := []SkillDiscoverySource{
		{ID: "home-codex", Label: "Codex home", Path: filepath.Join(home, ".codex", "skills"), SourceKind: "home", Providers: []string{"codex"}},
		{ID: "home-agents", Label: "Agent skills home", Path: filepath.Join(home, ".agents", "skills"), SourceKind: "home", Providers: []string{"agent-skills"}},
		{ID: "home-claude", Label: "Claude home", Path: filepath.Join(home, ".claude", "skills"), SourceKind: "home", Providers: []string{"claude"}},
		{ID: "codex-plugin-cache", Label: "Codex plugin cache", Path: filepath.Join(home, ".codex", "plugins", "cache"), SourceKind: "plugin", Providers: []string{"codex", "agent-skills"}},
	}
	projectPaths := map[string]bool{cwd: true}
	for _, project := range m.ListProjects() {
		if project.HostID == "" || project.HostID == "local" {
			projectPaths[project.Path] = true
		}
	}
	for path := range projectPaths {
		label := "Repo " + filepath.Base(path)
		id := stableSkillPathID(path)
		roots = append(roots,
			SkillDiscoverySource{ID: "repo-agents-" + id, Label: label + " .agents", Path: filepath.Join(path, ".agents", "skills"), SourceKind: "repo", Providers: []string{"agent-skills"}},
			SkillDiscoverySource{ID: "repo-claude-" + id, Label: label + " .claude", Path: filepath.Join(path, ".claude", "skills"), SourceKind: "repo", Providers: []string{"claude"}},
		)
	}
	result := SkillDiscoveryResult{Skills: []DiscoveredSkill{}, Sources: roots, ScannedAt: time.Now().UnixMilli()}
	seen := map[string]bool{}
	for index := range result.Sources {
		root := &result.Sources[index]
		if _, err := os.Stat(root.Path); err != nil {
			root.SkippedReason = "missing"
			continue
		}
		root.Exists = true
		depth := 4
		if root.SourceKind == "plugin" {
			depth = 9
		}
		for _, path := range findSkillFiles(root.Path, depth) {
			if seen[path] {
				continue
			}
			seen[path] = true
			result.Skills = append(result.Skills, describeSkill(*root, path))
		}
	}
	sort.Slice(result.Skills, func(i, j int) bool {
		left, right := result.Skills[i], result.Skills[j]
		return strings.ToLower(left.Name)+left.SourceLabel+left.SkillFilePath < strings.ToLower(right.Name)+right.SourceLabel+right.SkillFilePath
	})
	sort.Slice(result.Sources, func(i, j int) bool {
		return strings.ToLower(result.Sources[i].Label) < strings.ToLower(result.Sources[j].Label)
	})
	return result
}

func findSkillFiles(root string, maxDepth int) []string {
	root = filepath.Clean(root)
	visited := map[string]bool{}
	files := []string{}
	var visit func(string, int)
	visit = func(path string, depth int) {
		if depth > maxDepth {
			return
		}
		real, err := filepath.EvalSymlinks(path)
		if err != nil || visited[real] {
			return
		}
		visited[real] = true
		entries, err := os.ReadDir(path)
		if err != nil {
			return
		}
		for _, entry := range entries {
			child := filepath.Join(path, entry.Name())
			if entry.Name() == "SKILL.md" {
				if info, err := os.Stat(child); err == nil && !info.IsDir() {
					files = append(files, child)
				}
				continue
			}
			if info, err := os.Stat(child); err == nil && info.IsDir() {
				visit(child, depth+1)
			}
		}
	}
	visit(root, 0)
	return files
}

func describeSkill(root SkillDiscoverySource, skillPath string) DiscoveredSkill {
	directory := filepath.Dir(skillPath)
	content, _ := os.ReadFile(skillPath)
	if len(content) > maxSkillMarkdownBytes {
		content = content[:maxSkillMarkdownBytes]
	}
	name, description := summarizeSkillMarkdown(string(content))
	if name == "" {
		name = filepath.Base(directory)
	}
	sourceKind, sourceLabel := root.SourceKind, root.Label
	if root.SourceKind == "home" {
		if relative, err := filepath.Rel(root.Path, skillPath); err == nil && strings.Split(relative, string(filepath.Separator))[0] == ".system" {
			sourceKind, sourceLabel = "bundled", root.Label+" bundled"
		}
	}
	var updatedAt *int64
	if info, err := os.Stat(skillPath); err == nil {
		value := info.ModTime().UnixMilli()
		updatedAt = &value
	}
	return DiscoveredSkill{ID: stableSkillPathID(skillPath), Name: name, Description: description, Providers: root.Providers, SourceKind: sourceKind, SourceLabel: sourceLabel, RootPath: root.Path, DirectoryPath: directory, SkillFilePath: skillPath, Installed: true, FileCount: countSkillFiles(directory), UpdatedAt: updatedAt}
}

func summarizeSkillMarkdown(markdown string) (string, *string) {
	markdown = strings.TrimPrefix(markdown, "\ufeff")
	name, description, body := "", "", markdown
	if strings.HasPrefix(markdown, "---\n") {
		if end := strings.Index(markdown[4:], "\n---"); end >= 0 {
			frontmatter := markdown[4 : 4+end]
			body = markdown[4+end+4:]
			metadata := parseSkillFrontmatter(frontmatter)
			name, description = metadata["name"], metadata["description"]
		}
	}
	paragraph := []string{}
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if name == "" && strings.HasPrefix(trimmed, "# ") {
			name = strings.TrimSpace(trimmed[2:])
		}
		if description != "" {
			continue
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "```") {
			if len(paragraph) > 0 {
				break
			}
			continue
		}
		paragraph = append(paragraph, trimmed)
		if len(strings.Join(paragraph, " ")) > 240 {
			break
		}
	}
	if description == "" {
		description = strings.Join(paragraph, " ")
	}
	if description == "" {
		return name, nil
	}
	return name, &description
}

func parseSkillFrontmatter(frontmatter string) map[string]string {
	result := map[string]string{}
	lines := strings.Split(strings.ReplaceAll(frontmatter, "\r\n", "\n"), "\n")
	for index := 0; index < len(lines); index++ {
		key, raw, ok := strings.Cut(lines[index], ":")
		if !ok {
			continue
		}
		key, raw = strings.TrimSpace(key), strings.TrimSpace(raw)
		if raw == "|" || raw == "|-" || raw == ">" || raw == ">-" {
			block := []string{}
			for index+1 < len(lines) && (strings.HasPrefix(lines[index+1], "  ") || strings.TrimSpace(lines[index+1]) == "") {
				index++
				block = append(block, strings.TrimPrefix(lines[index], "  "))
			}
			separator := "\n"
			if strings.HasPrefix(raw, ">") {
				separator = " "
			}
			result[key] = strings.Join(strings.Fields(strings.Join(block, separator)), " ")
			continue
		}
		result[key] = strings.Trim(raw, "\"'")
	}
	return result
}

func countSkillFiles(root string) int {
	count := 0
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && count < maxSkillPackageFiles {
			if entry.Type()&os.ModeSymlink == 0 {
				count++
			} else if info, statErr := os.Stat(path); statErr == nil && !info.IsDir() {
				count++
			}
		}
		if count >= maxSkillPackageFiles && entry.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	return count
}

func stableSkillPathID(path string) string {
	sum := sha1.Sum([]byte(path))
	return hex.EncodeToString(sum[:])[:16]
}
