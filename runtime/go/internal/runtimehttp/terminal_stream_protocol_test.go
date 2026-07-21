package runtimehttp

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestTerminalStreamFrameMatchesTypeScriptWireLayout(t *testing.T) {
	frame := terminalStreamFrame{
		Opcode: terminalStreamInput, StreamID: 0x01020304,
		Seq: 0x0000000200000003, Payload: []byte("hi"),
	}
	encoded := encodeTerminalStreamFrame(frame)
	const expectedHex = "740107000403020102000000030000006869"
	if hex.EncodeToString(encoded) != expectedHex {
		t.Fatalf("unexpected frame bytes: %x", encoded)
	}
	decoded, err := decodeTerminalStreamFrame(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Opcode != frame.Opcode || decoded.StreamID != frame.StreamID || decoded.Seq != frame.Seq || string(decoded.Payload) != "hi" {
		t.Fatalf("unexpected decoded frame: %#v", decoded)
	}
}

func TestLegacySharedControlSnapshotBudgetKeepsUtf8Suffix(t *testing.T) {
	prefix := strings.Repeat("x", legacySharedControlMobileSnapshotBudget)
	data, truncated := legacySharedControlSnapshotBytes([]runtimecore.OutputChunk{{Content: prefix + "界界"}})
	if !truncated {
		t.Fatal("expected oversized snapshot truncation")
	}
	if len(data) > legacySharedControlMobileSnapshotBudget {
		t.Fatalf("snapshot exceeded byte budget: %d", len(data))
	}
	if !strings.HasSuffix(string(data), "界界") {
		t.Fatalf("snapshot lost UTF-8 suffix: %q", data[len(data)-12:])
	}
}

func TestLegacySharedControlLiveOutputFramesStayBoundedAndPreserveUtf8(t *testing.T) {
	content := strings.Repeat("a", legacySharedControlTerminalStreamChunkBytes-1) + strings.Repeat("界", legacySharedControlTerminalStreamChunkBytes)
	frames := legacySharedControlTerminalOutputFrames(17, 41, []byte(content))
	if len(frames) < 2 {
		t.Fatalf("expected large live output to split, got %d frame(s)", len(frames))
	}
	var rebuilt bytes.Buffer
	for index, frame := range frames {
		if frame.Opcode != terminalStreamOutput || frame.StreamID != 17 || frame.Seq != 41+uint64(index) {
			t.Fatalf("unexpected frame metadata at %d: %#v", index, frame)
		}
		if len(frame.Payload) > legacySharedControlTerminalStreamChunkBytes {
			t.Fatalf("live output frame exceeded byte budget: %d", len(frame.Payload))
		}
		if !utf8.Valid(frame.Payload) {
			t.Fatalf("live output frame split a UTF-8 sequence at %d", index)
		}
		rebuilt.Write(frame.Payload)
	}
	if rebuilt.String() != content {
		t.Fatal("live output frame split changed byte order or content")
	}
}

func TestTerminalSnapshotSuffixDoesNotSplitEscapeSequences(t *testing.T) {
	data := []byte("prefix-\x1b]8;;https://example.com/path\x1b\\linked text\x1b]8;;\x1b\\-tail")
	got, truncated := terminalSnapshotSuffix(data, 28)
	if !truncated {
		t.Fatal("expected truncation")
	}
	if len(got) > 28 {
		t.Fatalf("snapshot exceeded budget: %d", len(got))
	}
	if bytes.HasPrefix(got, []byte("\\")) || bytes.HasPrefix(got, []byte("8;;")) {
		t.Fatalf("snapshot began inside an OSC sequence: %q", got)
	}
}

func TestTerminalSnapshotSuffixRestoresOpenOSC8Link(t *testing.T) {
	open := "\x1b]8;id=docs;https://example.com/docs\x1b\\"
	close := "\x1b]8;;\x1b\\"
	data := []byte(open + strings.Repeat("linked-", 20) + close + "tail")
	got, truncated := terminalSnapshotSuffix(data, len(open)+32)
	if !truncated {
		t.Fatal("expected truncation")
	}
	if !bytes.HasPrefix(got, []byte(open)) {
		t.Fatalf("snapshot did not restore active OSC 8 context: %q", got)
	}
	if !bytes.Contains(got, []byte(close)) {
		t.Fatalf("snapshot lost OSC 8 close sequence: %q", got)
	}
}
