package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestListGitHubPRCommentsMapsThreadsAndReviewSummaries(t *testing.T) {
	dir := githubPRCommentsCLI(t)
	withPath(t, dir)
	comments := ListGitHubPRComments(context.Background(), t.TempDir(), 7, "upstream")
	if len(comments) != 3 {
		t.Fatalf("expected three comments, got %#v", comments)
	}
	inline := comments[1]
	if inline.ThreadID != "thread-1" || inline.Path != "src/app.ts" || inline.Line == nil || *inline.Line != 12 || inline.IsOutdated == nil || !*inline.IsOutdated || len(inline.Reactions) != 1 || inline.Reactions[0].Content != "+1" {
		t.Fatalf("unexpected inline comment: %+v", inline)
	}
	if comments[2].Body != "Approved" || comments[2].CreatedAt != "2026-07-15T03:00:00Z" {
		t.Fatalf("unexpected review summary: %+v", comments[2])
	}
}

func githubPRCommentsCLI(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir := t.TempDir()
	gitScript := `#!/bin/sh
case "$*" in
  "remote get-url origin") printf '%s' 'git@github.com:fork/pebble.git';;
  "remote get-url upstream") printf '%s' 'https://github.com/nebutra/pebble.git';;
  *) exit 1;;
esac
`
	ghScript := `#!/bin/sh
case "$*" in
  *"api graphql"*) cat <<'EOF'
{"data":{"repository":{"pullRequest":{"comments":{"nodes":[{"databaseId":1,"author":{"__typename":"User","login":"alice","avatarUrl":"a"},"body":"Top","createdAt":"2026-07-15T01:00:00Z","url":"u1"}]},"reviewThreads":{"nodes":[{"id":"thread-1","isResolved":false,"line":null,"startLine":null,"originalLine":12,"originalStartLine":10,"comments":{"nodes":[{"databaseId":2,"author":{"__typename":"Bot","login":"reviewbot","avatarUrl":"b"},"body":"Inline","createdAt":"2026-07-15T02:00:00Z","url":"u2","path":"src/app.ts","reactionGroups":[{"content":"THUMBS_UP","reactors":{"totalCount":2}}]}]}}]}}}}}
EOF
  ;;
  *"pulls/7/reviews"*) printf '%s' '[{"id":3,"body":"Approved","submitted_at":"2026-07-15T03:00:00Z","html_url":"u3","user":{"login":"bob","avatar_url":"c","type":"User"}}]';;
  *) exit 1;;
esac
`
	for name, script := range map[string]string{"git": gitScript, "gh": ghScript} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}
