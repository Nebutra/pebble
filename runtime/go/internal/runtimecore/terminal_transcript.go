package runtimecore

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxTerminalTranscriptLines         = 2000
	maxTerminalTranscriptChars         = 256 * 1024
	maxTerminalTranscriptPartialChars  = 4000
	maxTerminalTranscriptReadLimit     = 2000
	defaultTerminalTranscriptReadLimit = 120
	maxTerminalTranscriptPreviewChars  = 32 * 1024
)

type terminalTranscript struct {
	completedLines     []string
	partialLine        string
	completedLineCount uint64
	bufferTruncated    bool
	pendingCR          bool
	pendingUTF8        []byte
}

func (t *terminalTranscript) append(content string) {
	t.appendBytes([]byte(content))
}

func (t *terminalTranscript) appendBytes(content []byte) {
	data := append(append([]byte(nil), t.pendingUTF8...), content...)
	t.pendingUTF8 = t.pendingUTF8[:0]
	for held := 1; held <= 3 && held <= len(data); held++ {
		prefix := data[:len(data)-held]
		suffix := data[len(data)-held:]
		if utf8.Valid(prefix) && !utf8.FullRune(suffix) {
			t.pendingUTF8 = append(t.pendingUTF8, suffix...)
			data = prefix
			break
		}
	}
	t.appendNormalized(strings.ToValidUTF8(string(data), "\uFFFD"))
}

func (t *terminalTranscript) appendNormalized(content string) {
	if content == "" {
		return
	}
	for _, char := range content {
		if t.pendingCR {
			t.pendingCR = false
			if char == '\n' {
				t.completeLine()
				continue
			}
			// Bare carriage return moves the terminal cursor to column zero. The
			// next printable text redraws the current line instead of appending it.
			t.partialLine = ""
		}
		switch char {
		case '\r':
			t.pendingCR = true
		case '\n':
			t.completeLine()
		case '\b':
			t.partialLine = trimLastRune(t.partialLine)
		default:
			t.partialLine += string(char)
		}
	}
	if len(t.partialLine) > maxTerminalTranscriptPartialChars {
		t.partialLine = utf8SafeSuffix(t.partialLine, maxTerminalTranscriptPartialChars)
		t.bufferTruncated = true
	}
	t.prune()
}

func (t *terminalTranscript) completeLine() {
	t.completedLines = append(t.completedLines, strings.TrimRight(t.partialLine, " \t"))
	t.completedLineCount++
	t.partialLine = ""
}

func trimLastRune(value string) string {
	if value == "" {
		return value
	}
	_, size := utf8.DecodeLastRuneInString(value)
	return value[:len(value)-size]
}

func (t *terminalTranscript) read(cursor *uint64, requestedLimit int) TerminalTranscriptRead {
	limit := requestedLimit
	if limit < 1 {
		limit = defaultTerminalTranscriptReadLimit
	}
	if limit > maxTerminalTranscriptReadLimit {
		limit = maxTerminalTranscriptReadLimit
	}
	oldest := t.completedLineCount - uint64(len(t.completedLines))
	latest := t.completedLineCount
	if cursor != nil {
		if *cursor > latest {
			return terminalTranscriptReadResult(nil, false, false, oldest, latest, latest)
		}
		start := max(*cursor, oldest)
		available := t.completedLines[start-oldest:]
		count := min(limit, len(available))
		return terminalTranscriptReadResult(
			append([]string(nil), available[:count]...),
			*cursor < oldest,
			count < len(available),
			oldest,
			start+uint64(count),
			latest,
		)
	}

	all := append([]string(nil), t.completedLines...)
	if t.partialLine != "" {
		all = append(all, t.partialLine)
	}
	limited := len(all) > limit
	if limited {
		all = all[len(all)-limit:]
	}
	var sliced bool
	all, sliced = trimTerminalTranscriptPreview(all, maxTerminalTranscriptPreviewChars)
	return terminalTranscriptReadResult(all, t.bufferTruncated || sliced, limited || sliced, oldest, latest, latest)
}

func terminalTranscriptReadResult(tail []string, truncated, limited bool, oldest, next, latest uint64) TerminalTranscriptRead {
	return TerminalTranscriptRead{
		Tail:              tail,
		Truncated:         truncated,
		Limited:           limited,
		OldestCursor:      strconv.FormatUint(oldest, 10),
		NextCursor:        strconv.FormatUint(next, 10),
		LatestCursor:      strconv.FormatUint(latest, 10),
		ReturnedLineCount: len(tail),
	}
}

func trimTerminalTranscriptPreview(lines []string, byteBudget int) ([]string, bool) {
	total := 0
	for _, line := range lines {
		total += len(line)
	}
	if total <= byteBudget {
		return lines, false
	}
	start := 0
	for start < len(lines) && total-len(lines[start]) >= byteBudget {
		total -= len(lines[start])
		start++
	}
	lines = append([]string(nil), lines[start:]...)
	if len(lines) > 0 && total > byteBudget {
		lines[0] = utf8SafeSuffix(lines[0], byteBudget-(total-len(lines[0])))
	}
	return lines, true
}

func utf8SafeSuffix(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	start := len(value) - maxBytes
	for start < len(value) && !utf8.RuneStart(value[start]) {
		start++
	}
	return value[start:]
}

func (t *terminalTranscript) prune() {
	if overflow := len(t.completedLines) - maxTerminalTranscriptLines; overflow > 0 {
		t.completedLines = append([]string(nil), t.completedLines[overflow:]...)
		t.bufferTruncated = true
	}
	totalChars := len(t.partialLine)
	for _, line := range t.completedLines {
		totalChars += len(line)
	}
	trim := 0
	for trim < len(t.completedLines) && totalChars > maxTerminalTranscriptChars {
		totalChars -= len(t.completedLines[trim])
		trim++
	}
	if trim > 0 {
		t.completedLines = append([]string(nil), t.completedLines[trim:]...)
		t.bufferTruncated = true
	}
}

func (t *terminalTranscript) snapshot() TerminalTranscriptSnapshot {
	return TerminalTranscriptSnapshot{
		CompletedLines:     append([]string(nil), t.completedLines...),
		PartialLine:        t.partialLine,
		CompletedLineCount: t.completedLineCount,
		BufferTruncated:    t.bufferTruncated,
	}
}

func (t *terminalTranscript) clear() {
	*t = terminalTranscript{}
}
