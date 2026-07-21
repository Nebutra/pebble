package runtimecore

import (
	"fmt"
	"strings"
	"sync"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/vt"
)

type terminalScreen struct {
	mu            sync.Mutex
	terminal      *vt.Emulator
	cursorVisible bool
}

type TerminalScreenSnapshot struct {
	ANSI      string
	Cols      int
	Rows      int
	Alternate bool
}

func newTerminalScreen(cols, rows int) *terminalScreen {
	screen := &terminalScreen{
		terminal:      vt.NewEmulator(cols, rows),
		cursorVisible: true,
	}
	screen.terminal.SetCallbacks(vt.Callbacks{
		CursorVisibility: func(visible bool) {
			screen.cursorVisible = visible
		},
	})
	return screen
}

func (s *terminalScreen) Write(data []byte) {
	if s == nil || s.terminal == nil || len(data) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.terminal.Write(data)
}

func (s *terminalScreen) Resize(cols, rows int) {
	if s == nil || s.terminal == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.terminal.Resize(cols, rows)
}

func (s *terminalScreen) Snapshot() TerminalScreenSnapshot {
	if s == nil || s.terminal == nil {
		return TerminalScreenSnapshot{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cols, rows := s.terminal.Width(), s.terminal.Height()
	var output strings.Builder
	// Why: a rendered snapshot replaces the client screen; replaying it on top
	// of stale cells would leave artifacts where the new frame contains blanks.
	output.WriteString("\x1b[2J\x1b[H")
	for y := 0; y < rows; y++ {
		writeTerminalScreenLine(&output, s.terminal, y, cols)
		if y+1 < rows {
			output.WriteString("\x1b[0m\r\n")
		}
	}
	output.WriteString("\x1b[0m")
	cursor := s.terminal.CursorPosition()
	output.WriteString(fmt.Sprintf("\x1b[%d;%dH", cursor.Y+1, cursor.X+1))
	if s.cursorVisible {
		output.WriteString("\x1b[?25h")
	} else {
		output.WriteString("\x1b[?25l")
	}
	return TerminalScreenSnapshot{
		ANSI: output.String(), Cols: cols, Rows: rows,
		Alternate: s.terminal.IsAltScreen(),
	}
}

func writeTerminalScreenLine(output *strings.Builder, terminal *vt.Emulator, y, cols int) {
	last := -1
	for x := cols - 1; x >= 0; x-- {
		cell := terminal.CellAt(x, y)
		if cell != nil && cell.Width > 0 && cell.Content != "" && cell.Content != " " {
			last = x
			break
		}
	}
	var previous *uv.Style
	for x := 0; x <= last; x++ {
		cell := terminal.CellAt(x, y)
		if cell != nil && cell.Width == 0 {
			continue
		}
		style := uv.Style{}
		if cell != nil {
			style = cell.Style
		}
		if previous == nil || !style.Equal(previous) {
			output.WriteString(style.String())
			copy := style
			previous = &copy
		}
		if cell == nil || cell.Content == "" {
			output.WriteByte(' ')
		} else {
			output.WriteString(cell.Content)
		}
	}
}
