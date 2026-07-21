package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type detectedPort struct {
	Port        int    `json:"port"`
	Host        string `json:"host"`
	PID         int    `json:"pid,omitempty"`
	ProcessName string `json:"processName,omitempty"`
}

func runPortsDetect(output io.Writer) error {
	var ports []detectedPort
	var err error
	switch runtime.GOOS {
	case "linux":
		ports, err = detectLinuxPorts()
	case "darwin":
		ports, err = detectDarwinPorts()
	default:
		return errors.New("port detection is unsupported on this remote platform")
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"ports": ports, "platform": runtime.GOOS})
}

func detectLinuxPorts() ([]detectedPort, error) {
	ports := map[string]detectedPort{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		first := true
		for scanner.Scan() {
			if first {
				first = false
				continue
			}
			fields := strings.Fields(scanner.Text())
			if len(fields) < 4 || fields[3] != "0A" {
				continue
			}
			host, port, ok := parseProcAddress(fields[1])
			if !ok || port == 22 {
				continue
			}
			ports[host+":"+strconv.Itoa(port)] = detectedPort{Port: port, Host: host}
		}
		_ = file.Close()
	}
	return sortedDetectedPorts(ports), nil
}

func parseProcAddress(value string) (string, int, bool) {
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return "", 0, false
	}
	port, err := strconv.ParseInt(parts[1], 16, 32)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, false
	}
	raw, err := hex.DecodeString(parts[0])
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return "", 0, false
	}
	if len(raw) == 4 {
		raw[0], raw[3] = raw[3], raw[0]
		raw[1], raw[2] = raw[2], raw[1]
	}
	return net.IP(raw).String(), int(port), true
}

func detectDarwinPorts() ([]detectedPort, error) {
	data, err := exec.Command("lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn").Output()
	if err != nil {
		return nil, err
	}
	ports := map[string]detectedPort{}
	pid, name := 0, ""
	for _, line := range strings.Split(string(data), "\n") {
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
		case 'c':
			name = line[1:]
		case 'n':
			host, port, ok := parseLsofAddress(line[1:])
			if ok && port != 22 {
				ports[host+":"+strconv.Itoa(port)] = detectedPort{Port: port, Host: host, PID: pid, ProcessName: name}
			}
		}
	}
	return sortedDetectedPorts(ports), nil
}

func parseLsofAddress(value string) (string, int, bool) {
	value = strings.TrimSuffix(value, " (LISTEN)")
	index := strings.LastIndex(value, ":")
	if index < 1 {
		return "", 0, false
	}
	host := strings.Trim(value[:index], "[]")
	port, err := strconv.Atoi(value[index+1:])
	return host, port, err == nil && port > 0 && port <= 65535
}

func sortedDetectedPorts(values map[string]detectedPort) []detectedPort {
	result := make([]detectedPort, 0, len(values))
	for _, port := range values {
		result = append(result, port)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Port == result[j].Port {
			return result[i].Host < result[j].Host
		}
		return result[i].Port < result[j].Port
	})
	if len(result) > 50 {
		result = result[:50]
	}
	return result
}
