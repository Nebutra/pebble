package runtimecore

import (
	"errors"
	"reflect"
	"testing"
)

func TestDetectHostAgentsUsesCanonicalBinaryNamesAndAliases(t *testing.T) {
	installed := map[string]bool{"codex": true, "auggie": true, "mistral-vibe": true, "cn": true}
	detected := detectHostAgents(func(command string) (string, error) {
		if installed[command] {
			return "/bin/" + command, nil
		}
		return "", errors.New("not found")
	})
	want := []string{"aug", "codex", "continue", "mistral-vibe"}
	if !reflect.DeepEqual(detected, want) {
		t.Fatalf("detected agents = %#v, want %#v", detected, want)
	}
}

func TestDetectHostAgentsReturnsEachAgentOnce(t *testing.T) {
	detected := detectHostAgents(func(command string) (string, error) {
		if command == "vibe" || command == "mistral-vibe" {
			return command, nil
		}
		return "", errors.New("not found")
	})
	if !reflect.DeepEqual(detected, []string{"mistral-vibe"}) {
		t.Fatalf("detected agents = %#v", detected)
	}
}
