package runtimecore

import "testing"

func TestParseLsofWorkspacePorts(t *testing.T) {
	ports := parseLsofWorkspacePorts("p42\ncnode\nn*:5173\nn[::1]:8080\n")
	if len(ports) != 2 {
		t.Fatalf("expected two ports, got %#v", ports)
	}
	if ports[0].pid != 42 || ports[0].processName != "node" || ports[0].host != "*" || ports[0].port != 5173 {
		t.Fatalf("unexpected first port: %#v", ports[0])
	}
	if ports[1].host != "::1" || ports[1].port != 8080 {
		t.Fatalf("unexpected IPv6 port: %#v", ports[1])
	}
}

func TestAttributeWorkspacePortPrefersDeepestCwd(t *testing.T) {
	owner := attributeWorkspacePort(rawWorkspacePort{cwd: "/repo/packages/app"}, []workspacePortProbe{
		{id: "root", repoID: "repo", displayName: "Root", path: "/repo"},
		{id: "app", repoID: "repo", displayName: "App", path: "/repo/packages/app"},
	})
	if owner == nil || owner.WorktreeID != "app" || owner.Confidence != "cwd" {
		t.Fatalf("unexpected owner: %#v", owner)
	}
}

func TestEnrichWorkspacePortNormalizesWildcardAndProtocol(t *testing.T) {
	port := enrichWorkspacePort(rawWorkspacePort{host: "0.0.0.0", port: 5173, pid: 42, cwd: "/repo"}, []workspacePortProbe{{id: "wt", repoID: "repo", displayName: "Repo", path: "/repo"}})
	if port.ConnectHost != "localhost" || port.Protocol != "http" || port.Kind != "workspace" {
		t.Fatalf("unexpected port: %#v", port)
	}
}
