package runtimecore

import (
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
	request, err := manager.resolveSessionStartRequest(StartSessionRequest{
		ProjectID: project.ID,
		Cwd:       "/srv/work dir/repo",
		Command:   []string{"printf", "%s", "hello; touch /tmp/escaped"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.Cwd != "/srv/work dir/repo" || request.launchCwd == request.Cwd {
		t.Fatalf("cwd routing = remote %q local %q", request.Cwd, request.launchCwd)
	}
	if len(request.launchCommand) < 2 || request.launchCommand[0] == "printf" {
		t.Fatalf("launch command = %#v", request.launchCommand)
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
	_, err := manager.resolveSessionStartRequest(StartSessionRequest{ProjectID: project.ID, Cwd: "../escape"})
	if err == nil || err.Error() != "remote session cwd must be absolute" {
		t.Fatalf("unexpected error: %v", err)
	}
	_, err = manager.resolveSessionStartRequest(StartSessionRequest{ProjectID: project.ID, Cwd: "/srv/other"})
	if err == nil || err.Error() != "remote session cwd escapes its workspace" {
		t.Fatalf("unexpected containment error: %v", err)
	}
}
