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

// Why: agent homes like ~/.claude/skills are commonly symlinked into a dotfiles
// repo. The renderer decides which agent covers a skill by matching path
// segments on RootPath, so discovery must report the root it was asked to scan
// rather than the symlink target — otherwise a symlinked home reads as an
// uncovered agent.
func TestSkillScannerReportsTheUnresolvedRootForASymlinkedHome(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "dotfiles", "skills")
	skillDir := filepath.Join(target, "orchestration")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	markdown := "---\nname: Orchestration\ndescription: Coordinate agents.\n---\n"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(markdown), 0o644); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(base, ".claude", "skills")
	if err := os.MkdirAll(filepath.Dir(home), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, home); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	files := findSkillFiles(home, 4)
	if len(files) != 1 {
		t.Fatalf("expected one skill file through the symlinked home, got %#v", files)
	}
	skill := describeSkill(SkillDiscoverySource{
		ID: "home-claude", Label: "Claude home", Path: home, SourceKind: "home", Providers: []string{"claude"},
	}, files[0])
	if skill.RootPath != home {
		t.Fatalf("expected the unresolved root %q, got %q", home, skill.RootPath)
	}
	if skill.Name != "Orchestration" || !skill.Installed {
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

// Why: FileCount is shown to the user as "this skill has N files". Counting
// OS- and VCS-generated entries reports a number nobody can reconcile with what
// they see, and those entries spend the maxSkillPackageFiles budget.
func TestSkillFileCountIgnoresSidecarAndVcsEntries(t *testing.T) {
	skillDir := t.TempDir()
	for _, name := range []string{"SKILL.md", "reference.md"} {
		if err := os.WriteFile(filepath.Join(skillDir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sidecars := []string{".DS_Store", "Thumbs.db", "desktop.ini", "ehthumbs.db", "._reference.md"}
	for _, name := range sidecars {
		if err := os.WriteFile(filepath.Join(skillDir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, dir := range []string{".git", "__MACOSX"} {
		nested := filepath.Join(skillDir, dir, "objects")
		if err := os.MkdirAll(nested, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nested, "blob"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if count := countSkillFiles(skillDir); count != 2 {
		t.Fatalf("expected only the two authored files, got %d", count)
	}
}

func TestSkillFileCountStillFollowsNestedContentAndFileSymlinks(t *testing.T) {
	skillDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(skillDir, "examples")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(nested, "case.md")
	if err := os.WriteFile(target, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(skillDir, "link.md")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	if count := countSkillFiles(skillDir); count != 3 {
		t.Fatalf("expected SKILL.md, the nested file, and the file symlink, got %d", count)
	}
}

// Why: a skill directory that is itself named .git must still be counted; only
// nested VCS metadata is noise.
func TestSkillFileCountDoesNotSkipTheScannedRoot(t *testing.T) {
	base := t.TempDir()
	skillDir := filepath.Join(base, ".git")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if count := countSkillFiles(skillDir); count != 1 {
		t.Fatalf("expected the root itself to be scanned, got %d", count)
	}
}
