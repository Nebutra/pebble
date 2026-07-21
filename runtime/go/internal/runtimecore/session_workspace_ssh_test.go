package runtimecore

import (
	"context"
	"strings"
	"testing"
)

func TestResolveSshSessionWrapsRemoteCommandWithoutLocalPathAccess(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, err := manager.CreateSshTarget(SshTargetInput{
		Label:    "Build host",
		Host:     "build.example",
		Username: "dev",
	})
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{
		Name:         "remote",
		Path:         "/srv/work dir/repo",
		LocationKind: "ssh",
		HostID:       target.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := manager.resolveSshSessionStartRequestForPlatform(StartSessionRequest{
		ProjectID: project.ID,
		Cwd:       "/srv/work dir/repo",
		Command:   []string{"printf", "%s", "hello; touch /tmp/escaped"},
	}, project, target, "ssh", relayPlatform{goos: "linux", goarch: "amd64"})
	if err != nil {
		t.Fatal(err)
	}
	if request.Cwd != "/srv/work dir/repo" || request.launchCwd == request.Cwd {
		t.Fatalf("cwd routing = remote %q local %q", request.Cwd, request.launchCwd)
	}
	if len(request.launchCommand) < 2 || request.launchCommand[0] == "printf" {
		t.Fatalf("launch command = %#v", request.launchCommand)
	}
	if request.launchCommand[1] != "-tt" {
		t.Fatalf("interactive SSH session did not force remote PTY allocation: %#v", request.launchCommand)
	}
	remoteCommand := request.launchCommand[len(request.launchCommand)-1]
	if !strings.Contains(remoteCommand, `'hello; touch /tmp/escaped'`) || !strings.Contains(remoteCommand, `'/srv/work dir/repo'`) {
		t.Fatalf("unsafe remote command = %q", remoteCommand)
	}
	if request.Command[0] != "printf" {
		t.Fatalf("visible command metadata changed: %#v", request.Command)
	}
}

func TestResolveSshSessionRejectsRelativeRemoteCwd(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, _ := manager.CreateSshTarget(SshTargetInput{Label: "Remote", Host: "example.invalid"})
	project, _ := manager.CreateProject(CreateProjectRequest{Name: "remote", Path: "/srv/repo", LocationKind: "ssh", HostID: target.ID})
	_, err := manager.resolveSshSessionStartRequestForPlatform(StartSessionRequest{ProjectID: project.ID, Cwd: "../escape"}, project, target, "ssh", relayPlatform{goos: "linux"})
	if err == nil || err.Error() != "remote session cwd must be absolute" {
		t.Fatalf("unexpected error: %v", err)
	}
	_, err = manager.resolveSshSessionStartRequestForPlatform(StartSessionRequest{ProjectID: project.ID, Cwd: "/srv/other"}, project, target, "ssh", relayPlatform{goos: "linux"})
	if err == nil || err.Error() != "remote session cwd escapes its workspace" {
		t.Fatalf("unexpected containment error: %v", err)
	}
}

func TestResolveWindowsSshSessionPreservesCwdAndLiteralArguments(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, _ := manager.CreateSshTarget(SshTargetInput{Label: "Windows", Host: "windows.example"})
	project, _ := manager.CreateProject(CreateProjectRequest{Name: "remote", Path: `C:\Work Trees\Pebble`, LocationKind: "ssh", HostID: target.ID})
	request, err := manager.resolveSshSessionStartRequestForPlatform(StartSessionRequest{
		ProjectID: project.ID,
		Cwd:       `c:\work trees\pebble\feature`,
		Command:   []string{"tool.exe", `two words`, `it's literal; Remove-Item C:\temp`},
	}, project, target, "ssh", relayPlatform{goos: "windows", goarch: "amd64"})
	if err != nil {
		t.Fatal(err)
	}
	script := decodePowerShellCommandForTest(t, request.launchCommand[len(request.launchCommand)-1])
	for _, literal := range []string{`Set-Location -LiteralPath 'c:\work trees\pebble\feature'`, `& 'tool.exe' 'two words'`, `'it''s literal; Remove-Item C:\temp'`, `exit $LASTEXITCODE`} {
		if !strings.Contains(script, literal) {
			t.Fatalf("Windows session command omitted %q: %s", literal, script)
		}
	}
	if request.launchCommand[0] != "ssh" || request.launchCwd == request.Cwd {
		t.Fatalf("SSH session fell back to remote/local cwd metadata: %#v", request)
	}
}

func TestResolveWindowsSshSessionAcceptsContainedUNCPath(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, _ := manager.CreateSshTarget(SshTargetInput{Label: "Windows", Host: "windows.example"})
	project, _ := manager.CreateProject(CreateProjectRequest{Name: "remote", Path: `\\server\Projects\Pebble`, LocationKind: "ssh", HostID: target.ID})
	request, err := manager.resolveSshSessionStartRequestForPlatform(StartSessionRequest{
		ProjectID: project.ID,
		Cwd:       `\\SERVER\projects\pebble\feature`,
	}, project, target, "ssh", relayPlatform{goos: "windows", goarch: "amd64"})
	if err != nil {
		t.Fatal(err)
	}
	if request.Cwd != `\\SERVER\projects\pebble\feature` {
		t.Fatalf("UNC cwd changed unexpectedly: %q", request.Cwd)
	}
}

func TestResolveWindowsSshSessionRejectsDriveAndUNCPathEscapes(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, _ := manager.CreateSshTarget(SshTargetInput{Label: "Windows", Host: "windows.example"})
	project, _ := manager.CreateProject(CreateProjectRequest{Name: "remote", Path: `C:\repo`, LocationKind: "ssh", HostID: target.ID})
	for _, cwd := range []string{`D:\repo`, `C:\repo-other`, `C:\repo\..\outside`, `relative\path`} {
		_, err := manager.resolveSshSessionStartRequestForPlatform(StartSessionRequest{ProjectID: project.ID, Cwd: cwd}, project, target, "ssh", relayPlatform{goos: "windows"})
		if err == nil {
			t.Fatalf("Windows cwd %q escaped workspace", cwd)
		}
	}
}

func TestResolveSshSessionCancellationDoesNotStartLocalShell(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, _ := manager.CreateSshTarget(SshTargetInput{Label: "Remote", Host: "example.invalid"})
	project, _ := manager.CreateProject(CreateProjectRequest{Name: "remote", Path: "/srv/repo", LocationKind: "ssh", HostID: target.ID})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := manager.resolveSessionStartRequest(ctx, StartSessionRequest{ProjectID: project.ID})
	if err == nil || !strings.Contains(err.Error(), "detect SSH session platform") {
		t.Fatalf("cancelled SSH resolution must fail closed, got %v", err)
	}
}
