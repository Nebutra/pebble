package runtimehttp

import "bytes"

const maxRestoredOSC8Bytes = 4096

type terminalEscapeScanner struct {
	state      byte
	escapeFrom int
	activeOSC8 []byte
}

func terminalSnapshotSuffix(data []byte, budget int) ([]byte, bool) {
	if budget < 1 || len(data) <= budget {
		return data, false
	}
	minimum := len(data) - budget
	scanner := terminalEscapeScanner{}
	cut, restored := -1, []byte(nil)
	for index, value := range data {
		scanner.feed(data, index, value)
		boundary := index + 1
		if boundary < minimum || scanner.state != 0 || !isUTF8Boundary(data, boundary) {
			continue
		}
		prefix := scanner.restorePrefix()
		if len(prefix)+len(data)-boundary <= budget {
			cut, restored = boundary, prefix
			break
		}
	}
	if cut < 0 {
		return nil, true
	}
	result := make([]byte, 0, len(restored)+len(data)-cut)
	result = append(result, restored...)
	result = append(result, data[cut:]...)
	return result, true
}

func (s *terminalEscapeScanner) feed(data []byte, index int, value byte) {
	switch s.state {
	case 0:
		if value == 0x1b {
			s.state, s.escapeFrom = 1, index
		}
	case 1:
		switch value {
		case '[':
			s.state = 2
		case ']':
			s.state = 3
		default:
			s.state = 0
		}
	case 2:
		if value >= 0x40 && value <= 0x7e {
			s.state = 0
		}
	case 3:
		if value == 0x07 {
			s.finishOSC(data, index+1)
		} else if value == 0x1b {
			s.state = 4
		}
	case 4:
		if value == '\\' {
			s.finishOSC(data, index+1)
		} else {
			s.state = 3
		}
	}
}

func (s *terminalEscapeScanner) finishOSC(data []byte, end int) {
	sequence := data[s.escapeFrom:end]
	payload := sequence[2:]
	payload = bytes.TrimSuffix(payload, []byte{0x07})
	payload = bytes.TrimSuffix(payload, []byte{0x1b, '\\'})
	if bytes.HasPrefix(payload, []byte("8;")) {
		parts := bytes.SplitN(payload, []byte(";"), 3)
		if len(parts) == 3 && len(parts[2]) > 0 && len(sequence) <= maxRestoredOSC8Bytes {
			s.activeOSC8 = append(s.activeOSC8[:0], sequence...)
		} else if len(parts) == 3 {
			s.activeOSC8 = nil
		}
	}
	s.state = 0
}

func (s *terminalEscapeScanner) restorePrefix() []byte {
	if len(s.activeOSC8) == 0 {
		return nil
	}
	return s.activeOSC8
}

func isUTF8Boundary(data []byte, index int) bool {
	return index >= len(data) || data[index]&0xc0 != 0x80
}
