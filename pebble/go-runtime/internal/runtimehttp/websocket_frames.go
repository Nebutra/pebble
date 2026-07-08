package runtimehttp

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const maxWebSocketPayloadBytes = 1024 * 1024

var errWebSocketClosed = errors.New("websocket closed")

type websocketConn struct {
	conn   net.Conn
	reader *bufio.Reader
	mu     sync.Mutex
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		headerHasToken(r.Header.Get("Connection"), "upgrade")
}

func upgradeWebSocket(w http.ResponseWriter, r *http.Request) (*websocketConn, error) {
	if r.Method != http.MethodGet {
		return nil, errors.New("websocket upgrade requires GET")
	}
	if !isWebSocketUpgrade(r) {
		return nil, errors.New("missing websocket upgrade headers")
	}
	if strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")) != "13" {
		return nil, errors.New("unsupported websocket version")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if !isValidWebSocketKey(key) {
		return nil, errors.New("invalid websocket key")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("websocket hijack unsupported")
	}
	conn, readWriter, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}
	accept := websocketAcceptKey(key)
	_, _ = fmt.Fprintf(readWriter, "HTTP/1.1 101 Switching Protocols\r\n")
	_, _ = fmt.Fprintf(readWriter, "Upgrade: websocket\r\n")
	_, _ = fmt.Fprintf(readWriter, "Connection: Upgrade\r\n")
	_, _ = fmt.Fprintf(readWriter, "Sec-WebSocket-Accept: %s\r\n\r\n", accept)
	if err := readWriter.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &websocketConn{conn: conn, reader: readWriter.Reader}, nil
}

func (c *websocketConn) close() error {
	return c.conn.Close()
}

func (c *websocketConn) readText(requireMasked bool) (string, error) {
	var message []byte
	for {
		fin, opcode, payload, err := c.readFrame(requireMasked)
		if err != nil {
			return "", err
		}
		switch opcode {
		case 0x0:
			if message == nil {
				return "", errors.New("unexpected websocket continuation frame")
			}
			if len(message)+len(payload) > maxWebSocketPayloadBytes {
				return "", errors.New("websocket payload too large")
			}
			message = append(message, payload...)
			if fin {
				return string(message), nil
			}
		case 0x1:
			if message != nil {
				return "", errors.New("websocket text frame interrupted fragmented message")
			}
			if fin {
				return string(payload), nil
			}
			message = append(message, payload...)
		case 0x8:
			_ = c.writeClose()
			return "", errWebSocketClosed
		case 0x9:
			if !fin {
				return "", errors.New("fragmented websocket control frame")
			}
			_ = c.writeFrame(0xA, payload)
		case 0xA:
			if !fin {
				return "", errors.New("fragmented websocket control frame")
			}
			continue
		default:
			return "", fmt.Errorf("unsupported websocket opcode %d", opcode)
		}
	}
}

func (c *websocketConn) writeText(text string) error {
	return c.writeFrame(0x1, []byte(text))
}

func (c *websocketConn) writeClose() error {
	return c.writeFrame(0x8, nil)
}

func (c *websocketConn) readFrame(requireMasked bool) (bool, byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(c.reader, header); err != nil {
		if errors.Is(err, io.EOF) {
			return false, 0, nil, errWebSocketClosed
		}
		return false, 0, nil, err
	}
	fin := header[0]&0x80 != 0
	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	if requireMasked && !masked {
		return false, 0, nil, errors.New("client websocket frames must be masked")
	}
	payloadLen := uint64(header[1] & 0x7F)
	switch payloadLen {
	case 126:
		var lengthBytes [2]byte
		if _, err := io.ReadFull(c.reader, lengthBytes[:]); err != nil {
			return false, 0, nil, err
		}
		payloadLen = uint64(binary.BigEndian.Uint16(lengthBytes[:]))
	case 127:
		var lengthBytes [8]byte
		if _, err := io.ReadFull(c.reader, lengthBytes[:]); err != nil {
			return false, 0, nil, err
		}
		payloadLen = binary.BigEndian.Uint64(lengthBytes[:])
	}
	if payloadLen > maxWebSocketPayloadBytes {
		return false, 0, nil, errors.New("websocket payload too large")
	}
	if isWebSocketControlOpcode(opcode) && payloadLen > 125 {
		return false, 0, nil, errors.New("websocket control frame payload too large")
	}
	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(c.reader, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return false, 0, nil, err
	}
	if masked {
		for index := range payload {
			payload[index] ^= maskKey[index%4]
		}
	}
	return fin, opcode, payload, nil
}

func (c *websocketConn) writeFrame(opcode byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	header := []byte{0x80 | opcode}
	length := len(payload)
	switch {
	case length <= 125:
		header = append(header, byte(length))
	case length <= 65535:
		header = append(header, 126, byte(length>>8), byte(length))
	default:
		var lengthBytes [8]byte
		binary.BigEndian.PutUint64(lengthBytes[:], uint64(length))
		header = append(header, 127)
		header = append(header, lengthBytes[:]...)
	}
	if _, err := c.conn.Write(header); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := c.conn.Write(payload)
	return err
}

func websocketAcceptKey(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func isValidWebSocketKey(key string) bool {
	decoded, err := base64.StdEncoding.DecodeString(key)
	return err == nil && len(decoded) == 16
}

func isWebSocketControlOpcode(opcode byte) bool {
	return opcode == 0x8 || opcode == 0x9 || opcode == 0xA
}

func headerHasToken(value string, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}
