package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGitHubProjectFieldMutationsPreserveTypedValues(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir, logPath := t.TempDir(), filepath.Join(t.TempDir(), "calls.log")
	script := `#!/bin/sh
echo "$*" >> "` + logPath + `"
case "$*" in
  *"repository(owner:"*) printf '%s' '{"data":{"repository":{"issue":{"id":"I1"}}}}';;
  *) printf '%s' '{"data":{}}';;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	withPath(t, dir)
	ctx := context.Background()
	if !UpdateGitHubProjectItemField(ctx, "P1", "PVTI1", "F1", GitHubProjectFieldMutationValue{Kind: "single-select", OptionID: "O1"}).OK {
		t.Fatal("single select update failed")
	}
	if !ClearGitHubProjectItemField(ctx, "P1", "PVTI1", "F1").OK {
		t.Fatal("field clear failed")
	}
	issueType := "IT1"
	if !UpdateGitHubIssueTypeBySlug(ctx, "acme", "widgets", 7, &issueType).OK {
		t.Fatal("issue type update failed")
	}
	calls, _ := os.ReadFile(logPath)
	text := string(calls)
	for _, expected := range []string{"singleSelectOptionId:\"O1\"", "clearProjectV2ItemFieldValue", "issueTypeId:$type", "type=IT1"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q in calls:\n%s", expected, text)
		}
	}
}
