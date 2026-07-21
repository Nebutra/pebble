package runtimecore

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSkillScannerFindsMetadataAndAvoidsSymlinkLoops(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, "review")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	markdown := "---\nname: Design Review\ndescription: Check visual parity.\n---\n# Ignored\n"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(markdown), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(root, filepath.Join(skillDir, "loop")); err != nil {
		t.Logf("symlink unavailable: %v", err)
	}
	files := findSkillFiles(root, 4)
	if len(files) != 1 {
		t.Fatalf("expected one skill file, got %#v", files)
	}
	skill := describeSkill(SkillDiscoverySource{
		ID: "repo", Label: "Repo demo", Path: root, SourceKind: "repo", Providers: []string{"agent-skills"},
	}, files[0])
	if skill.Name != "Design Review" || skill.Description == nil || *skill.Description != "Check visual parity." {
		t.Fatalf("unexpected skill metadata: %#v", skill)
	}
	if skill.FileCount != 1 || !skill.Installed || len(skill.ID) != 16 {
		t.Fatalf("unexpected skill projection: %#v", skill)
	}
}

func TestSkillMarkdownFallsBackToHeadingAndParagraph(t *testing.T) {
	name, description := summarizeSkillMarkdown("# Browser Tools\n\nAutomate the browser\nsafely.\n")
	if name != "Browser Tools" || description == nil || *description != "Automate the browser safely." {
		t.Fatalf("unexpected fallback metadata: %q %#v", name, description)
	}
}

func TestSkillMarkdownParsesFoldedDescription(t *testing.T) {
	name, description := summarizeSkillMarkdown("---\nname: 'Review'\ndescription: >-\n  Check pixel parity\n  across desktop shells.\n---\n")
	if name != "Review" || description == nil || *description != "Check pixel parity across desktop shells." {
		t.Fatalf("unexpected folded metadata: %q %#v", name, description)
	}
}
