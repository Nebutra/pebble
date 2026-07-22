package main

import (
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseServeOptionsPreservesNativeContract(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "workspace", "repo")
	options, err := parseServeOptions([]string{
		"--port", "6768", "--pairing-address", "wss://sandbox.example.com",
		"--project-root", root, "--recipe-json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if options.port != 6768 || options.pairingAddress != "wss://sandbox.example.com" || options.projectRoot != root || !options.recipeJSON {
		t.Fatalf("unexpected options: %+v", options)
	}
}

func TestParseServeOptionsRejectsConflictsAndRelativeRecipeRoot(t *testing.T) {
	for _, args := range [][]string{
		{"--no-pairing", "--mobile-pairing"},
		{"--recipe-json", "--project-root", "relative/path"},
		{"--recipe-json", "--project-root", filepath.Join(string(filepath.Separator), "repo"), "--mobile-pairing"},
	} {
		if _, err := parseServeOptions(args); err == nil {
			t.Fatalf("expected rejection for %v", args)
		}
	}
}

func TestSharedControlEndpointSupportsHostsIPv6AndTunnelURLs(t *testing.T) {
	cases := map[string]string{
		"":                            "ws://127.0.0.1:6768/v1/shared-control",
		"100.64.1.20":                 "ws://100.64.1.20:6768/v1/shared-control",
		"2001:db8::1":                 "ws://[2001:db8::1]:6768/v1/shared-control",
		"wss://sandbox.example.com":   "wss://sandbox.example.com/v1/shared-control",
		"https://example.com/runtime": "wss://example.com/runtime",
	}
	for input, expected := range cases {
		actual, err := sharedControlEndpoint(input, 6768)
		if err != nil {
			t.Fatalf("%q: %v", input, err)
		}
		if actual != expected {
			t.Fatalf("%q: got %q, want %q", input, actual, expected)
		}
	}
}

func TestEncodePairingOfferMatchesVersionTwoWireShape(t *testing.T) {
	encoded, err := encodePairingOffer(pairingOffer{
		Version: 2, Endpoint: "ws://127.0.0.1:6768/v1/shared-control",
		DeviceToken: "token", PublicKeyB64: "public-key", Scope: "runtime",
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := strings.TrimPrefix(encoded, "pebble://pair?code=")
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatal(err)
	}
	var offer map[string]interface{}
	if err := json.Unmarshal(raw, &offer); err != nil {
		t.Fatal(err)
	}
	if offer["v"] != float64(2) || offer["deviceToken"] != "token" || offer["scope"] != "runtime" {
		t.Fatalf("unexpected offer: %#v", offer)
	}
}

func TestSiblingRuntimeCandidatesCoverPreparedAndBundledLayouts(t *testing.T) {
	candidates := siblingRuntimeCandidates(filepath.Join("tmp", "pebble-control-aarch64-apple-darwin"))
	if candidates[0] != filepath.Join("tmp", "pebble-runtime") || candidates[1] != filepath.Join("tmp", "pebble-runtime-aarch64-apple-darwin") {
		t.Fatalf("unexpected candidates: %#v", candidates)
	}
}
