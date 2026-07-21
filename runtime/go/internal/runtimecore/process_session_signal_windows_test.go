//go:build windows

package runtimecore

import (
	"bytes"
	"testing"
)

func TestWindowsSessionSignalsUseConPtyControlCharacters(t *testing.T) {
	for _, testCase := range []struct {
		signal string
		want   byte
	}{
		{signal: "SIGINT", want: 0x03},
		{signal: "SIGQUIT", want: 0x1c},
		{signal: "SIGHUP", want: 0x04},
	} {
		var terminal bytes.Buffer
		if err := signalPlatformSessionProcess(42, &terminal, testCase.signal); err != nil {
			t.Fatalf("%s: %v", testCase.signal, err)
		}
		if got := terminal.Bytes(); len(got) != 1 || got[0] != testCase.want {
			t.Fatalf("%s bytes = %v, want [%d]", testCase.signal, got, testCase.want)
		}
	}
}

func TestWindowsSessionSignalRejectsUnsupportedPosixSignal(t *testing.T) {
	if err := signalPlatformSessionProcess(42, &bytes.Buffer{}, "SIGUSR1"); err == nil {
		t.Fatal("expected unsupported signal error")
	}
}
