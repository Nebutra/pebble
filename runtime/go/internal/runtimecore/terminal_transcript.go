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
	completedLines []string
	// partialLine accumulates bytes rather than a string: it is appended to once
	// per rune of PTY output, and `+= string(char)` made that quadratic in the
	// length of the line being built.
	partialLine        []byte
	completedChars     int
	completedLineCount uint64
	bufferTruncated    bool
	pendingCR          bool
	pendingUTF8        []byte
	decodeBuffer       []byte
}

func (t *terminalTranscript) append(content string) {
	t.decodeBuffer = append(append(t.decodeBuffer[:0], t.pendingUTF8...), content...)
	t.appendJoined()
}

func (t *terminalTranscript) appendBytes(content []byte) {
	t.decodeBuffer = append(append(t.decodeBuffer[:0], t.pendingUTF8...), content...)
	t.appendJoined()
}

// appendJoined consumes decodeBuffer \u2014 the partial rune held back from the
// previous read plus the bytes just read \u2014 holding back any trailing partial
// rune in turn. The buffer is reused so joining costs no allocation per read.
func (t *terminalTranscript) appendJoined() {
	data := t.decodeBuffer
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
	t.appendNormalized(data)
}

func (t *terminalTranscript) appendNormalized(content []byte) {
	if len(content) == 0 {
		return
	}
	// Why: decoding straight from the read buffer drops the two whole-chunk
	// copies a string + ToValidUTF8 round trip cost per read. invalidRun keeps
	// ToValidUTF8's rule that a run of undecodable bytes collapses into a single
	// replacement rune instead of one per byte.
	invalidRun := false
	for i := 0; i < len(content); {
		// Why: terminal output is mostly long runs of plain ASCII. Copying such a
		// run in one go keeps the common case off the per-rune path, which only
		// the cursor controls and multi-byte runes actually need.
		if !t.pendingCR {
			run := i
			for run < len(content) && isPlainTranscriptByte(content[run]) {
				run++
			}
			if run > i {
				t.partialLine = append(t.partialLine, content[i:run]...)
				invalidRun = false
				i = run
				continue
			}
		}
		char, size := utf8.DecodeRune(content[i:])
		if char == utf8.RuneError && size <= 1 {
			i++
			if invalidRun {
				continue
			}
			invalidRun = true
		} else {
			invalidRun = false
			i += size
		}
		if t.pendingCR {
			t.pendingCR = false
			if char == '\n' {
				t.completeLine()
				continue
			}
			// Bare carriage return moves the terminal cursor to column zero. The
			// next printable text redraws the current line instead of appending it.
			t.partialLine = t.partialLine[:0]
		}
		switch char {
		case '\r':
			t.pendingCR = true
		case '\n':
			t.completeLine()
		case '\b':
			t.partialLine = trimLastRune(t.partialLine)
		default:
			t.partialLine = utf8.AppendRune(t.partialLine, char)
		}
	}
	if len(t.partialLine) > maxTerminalTranscriptPartialChars {
		t.trimPartialLineHead(maxTerminalTranscriptPartialChars)
		t.bufferTruncated = true
	}
	t.prune()
}

func (t *terminalTranscript) completeLine() {
	line := strings.TrimRight(string(t.partialLine), " \t")
	t.completedLines = append(t.completedLines, line)
	t.completedChars += len(line)
	t.completedLineCount++
	t.partialLine = t.partialLine[:0]
}

// trimPartialLineHead drops the oldest bytes of a runaway line in place, so
// bounding the line does not hand back a fresh buffer on every read.
func (t *terminalTranscript) trimPartialLineHead(maxBytes int) {
	start := len(t.partialLine) - maxBytes
	for start < len(t.partialLine) && !utf8.RuneStart(t.partialLine[start]) {
		start++
	}
	t.partialLine = t.partialLine[:copy(t.partialLine, t.partialLine[start:])]
}

// isPlainTranscriptByte reports bytes that carry straight into the current
// line: single-byte runes that are none of the cursor controls the transcript
// interprets.
func isPlainTranscriptByte(b byte) bool {
	return b < utf8.RuneSelf && b != '\r' && b != '\n' && b != '\b'
}

func trimLastRune(value []byte) []byte {
	if len(value) == 0 {
		return value
	}
	_, size := utf8.DecodeLastRune(value)
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
	if len(t.partialLine) > 0 {
		all = append(all, string(t.partialLine))
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
		t.dropOldestCompletedLines(overflow)
	}
	// Why: completedChars is carried rather than re-summed. prune runs once per
	// PTY read, so re-adding every retained line's length made each read scale
	// with the whole retained transcript.
	totalChars := t.completedChars + len(t.partialLine)
	trim := 0
	for trim < len(t.completedLines) && totalChars > maxTerminalTranscriptChars {
		totalChars -= len(t.completedLines[trim])
		trim++
	}
	if trim > 0 {
		t.dropOldestCompletedLines(trim)
	}
}

// dropOldestCompletedLines compacts in place instead of reallocating the whole
// retained slice per read. Clearing the vacated tail matters: those slots would
// otherwise keep retired lines reachable for as long as the session lives.
func (t *terminalTranscript) dropOldestCompletedLines(count int) {
	for _, line := range t.completedLines[:count] {
		t.completedChars -= len(line)
	}
	kept := copy(t.completedLines, t.completedLines[count:])
	clear(t.completedLines[kept:])
	t.completedLines = t.completedLines[:kept]
	t.bufferTruncated = true
}

func (t *terminalTranscript) snapshot() TerminalTranscriptSnapshot {
	return TerminalTranscriptSnapshot{
		CompletedLines:     append([]string(nil), t.completedLines...),
		PartialLine:        string(t.partialLine),
		CompletedLineCount: t.completedLineCount,
		BufferTruncated:    t.bufferTruncated,
	}
}

func (t *terminalTranscript) clear() {
	*t = terminalTranscript{}
}
