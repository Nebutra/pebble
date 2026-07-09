package runtimecore

import "testing"

const foregroundPsFixture = `  100   100 Ss    -bash
  200   200 Ss+   /bin/zsh
  201   200 S+    node /opt/agent/bin/codex
  300   300 R     background-worker
`

func TestForegroundPrefersPlusMarker(t *testing.T) {
	rows := parsePsRows(foregroundPsFixture)
	// pgid 200 has a `+` child (codex) — the foreground member wins over the leader.
	if got := foregroundProcessNameForPgid(rows, 200); got != "zsh" {
		// The group leader (pid==pgid) is zsh and holds the foreground (Ss+),
		// so it is selected before any child.
		t.Fatalf("foreground for pgid 200 = %q, want zsh", got)
	}
}

func TestForegroundFallsBackToLeaderWithoutPlus(t *testing.T) {
	rows := parsePsRows("  100   100 Ss    -bash\n  101   100 S     sleep 5\n")
	if got := foregroundProcessNameForPgid(rows, 100); got != "bash" {
		t.Fatalf("foreground for pgid 100 = %q, want bash (leader fallback)", got)
	}
}

func TestForegroundUnknownPgid(t *testing.T) {
	rows := parsePsRows(foregroundPsFixture)
	if got := foregroundProcessNameForPgid(rows, 999); got != "" {
		t.Fatalf("foreground for unknown pgid = %q, want empty", got)
	}
}

func TestForegroundChildHoldsTerminal(t *testing.T) {
	// Leader shell backgrounded (no +), a child holds the foreground.
	fixture := "  100   100 Ss    -bash\n  101   100 R+    /usr/bin/htop\n"
	rows := parsePsRows(fixture)
	if got := foregroundProcessNameForPgid(rows, 100); got != "htop" {
		t.Fatalf("foreground = %q, want htop (child holds +)", got)
	}
}

func TestParsePsRowsSkipsMalformed(t *testing.T) {
	rows := parsePsRows("garbage\n  1 1 S init\nnot a row\n  2 x S bad\n")
	if len(rows) != 1 {
		t.Fatalf("expected 1 valid row, got %d: %+v", len(rows), rows)
	}
	if rows[0].pid != 1 || rows[0].comm != "init" {
		t.Fatalf("unexpected row %+v", rows[0])
	}
}

func TestBaseComm(t *testing.T) {
	cases := map[string]string{
		"/bin/bash -il":        "bash",
		"node /opt/agent/x":    "node",
		"htop":                 "htop",
		`C:\Program\thing.exe`: "thing.exe",
	}
	for in, want := range cases {
		if got := baseComm(in); got != want {
			t.Fatalf("baseComm(%q) = %q, want %q", in, got, want)
		}
	}
}
