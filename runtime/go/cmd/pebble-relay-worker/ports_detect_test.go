package main

import "testing"

func TestParseProcAddress(t *testing.T) {
	host, port, ok := parseProcAddress("0100007F:0BB8")
	if !ok || host != "127.0.0.1" || port != 3000 {
		t.Fatalf("unexpected parsed address: %s:%d %v", host, port, ok)
	}
	if _, _, ok := parseProcAddress("invalid"); ok {
		t.Fatal("expected invalid address to be rejected")
	}
}

func TestParseLsofAddress(t *testing.T) {
	host, port, ok := parseLsofAddress("[::1]:4175")
	if !ok || host != "::1" || port != 4175 {
		t.Fatalf("unexpected parsed address: %s:%d %v", host, port, ok)
	}
}
